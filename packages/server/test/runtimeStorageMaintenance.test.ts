import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink, utimes, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStore } from "@polyth/session";
import { createOpenCodeStorageMaintenance, type OpenCodeRuntimeMetadata } from "@polyth/backend-opencode";
import { hasDurableProcessRelease } from "@polyth/harness-runtime";
import { createKeyedRuntimeOwner } from "../src/runtimeOccupancy.ts";
import { createRuntimeStorageMaintenance } from "../src/runtimeStorageMaintenance.ts";

const old = Date.now() - 14 * 24 * 60 * 60 * 1000;
async function fixture(opened = Date.now()) {
  const root = await mkdtemp(join(tmpdir(), "polyth-maintenance-"));
  const runtime = join(root, "runtime");
  await mkdir(runtime);
  const metadata: OpenCodeRuntimeMetadata = {
    engine: "opencode", version: "fixture", binaryDigest: "a".repeat(64), protocolGeneration: 1,
    storageId: "11111111-1111-4111-8111-111111111111", runtimeAuthority: "authority", runtimeGeneration: 4,
    runtimeLocation: { projectId: "project", cwd: join(root, "missing-cwd") },
    createdAt: new Date(old).toISOString(), lastOpenedAt: new Date(opened).toISOString(),
  };
  const record = join(runtime, "opencode.pid.json.supervisor.json");
  await writeFile(join(runtime, "runtime.json"), JSON.stringify(metadata));
  await writeFile(record, JSON.stringify({ authorityId: "authority", generation: 4, released: true }));
  await writeFile(join(runtime, "opencode.db"), "active cache must survive");
  const add = async (name: string, timestamp = old) => {
    const path = join(runtime, "quarantine", `${timestamp}-${name}`);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "opencode.db"), "quarantined cache");
    await utimes(join(path, "opencode.db"), timestamp / 1000, timestamp / 1000);
    return path;
  };
  const store = createStore(":memory:");
  const pool = createKeyedRuntimeOwner<object>();
  const owner = createRuntimeStorageMaintenance({ root, pool, storageKey: () => "runtime", poolKey: () => "key",
    withReferencesLease: (id, cwd, work) => store.withRuntimeStorageLease(id, cwd, work), shuttingDown: () => false, maxEntries: 8 });
  const cycle = async () => { for (let i = 0; i < 10; i++) await owner.step(); };
  const close = async () => { await owner.dispose(); await pool.disposeAll(); await store.close(); await rm(root, { recursive: true, force: true }); };
  return { root, runtime, metadata, record, add, store, pool, owner, cycle, close };
}

test("maintenance requires exact durable release; PID absence, stale generation and symlinks do not prove it", async () => {
  const f = await fixture();
  try {
    const proof = { authorityId: "authority", generation: 4 };
    assert.equal(hasDurableProcessRelease(f.record, proof), true);
    assert.equal(hasDurableProcessRelease(f.record, { ...proof, generation: 3 }), false);
    await writeFile(f.record, JSON.stringify({ ...proof, released: false }));
    assert.equal(hasDurableProcessRelease(f.record, proof), false);
    // The supervisor's exact receipt proves release even when `released` was never persisted.
    const receipt = `${f.record}.authority.4.released`;
    await writeFile(f.record, JSON.stringify({ ...proof, released: false, receiptFile: receipt }));
    assert.equal(hasDurableProcessRelease(f.record, proof), false, "a named but missing receipt proves nothing");
    await writeFile(receipt, JSON.stringify({ ...proof, generation: 3 }));
    assert.equal(hasDurableProcessRelease(f.record, proof), false);
    await writeFile(receipt, JSON.stringify(proof));
    assert.equal(hasDurableProcessRelease(f.record, proof), true);
    await writeFile(f.record, JSON.stringify({ ...proof, released: false, receiptFile: join(f.root, "elsewhere.released") }));
    assert.equal(hasDurableProcessRelease(f.record, proof), false, "only the receipt beside the state file counts");
    await rm(receipt);
    await symlink(join(f.root, "foreign-receipt.json"), receipt);
    await writeFile(join(f.root, "foreign-receipt.json"), JSON.stringify(proof));
    await writeFile(f.record, JSON.stringify({ ...proof, released: false, receiptFile: receipt }));
    assert.equal(hasDurableProcessRelease(f.record, proof), false);
    await rm(receipt);
    await rm(f.record);
    assert.equal(hasDurableProcessRelease(f.record, proof), false);
    const other = join(f.root, "foreign.json");
    await writeFile(other, JSON.stringify({ ...proof, released: true }));
    await symlink(other, f.record);
    assert.equal(hasDurableProcessRelease(f.record, proof), false);
  } finally { await f.close(); }
});

test("quarantine maintenance holds active, referenced and uncertain caches despite missing cwd", async () => {
  const f = await fixture();
  try {
    const stale = await f.add("stale");
    const young = await f.add("young", Date.now());
    const active = await f.pool.acquire("key", async () => ({ value: {}, dispose: async () => {} }));
    active.occupancy.acquireBinding("session");
    await f.cycle();
    assert.ok(await lstat(stale));
    active.occupancy.releaseBinding("session");
    await f.pool.dispose("key");
    await f.store.upsertProjection({ id: "session", projectId: "project", title: "x", status: "idle", createdAt: 1, updatedAt: 1 });
    await f.cycle();
    assert.ok(await lstat(stale));
    await f.store.deleteSession("session");
    const pending = await f.store.prepareOperation({ sessionId: "unrelated", mutationKind: "turn-submit", intentEvent: { type: "user/message", data: { text: "fixture" } } });
    await f.cycle();
    assert.ok(await lstat(stale), "unlocated unresolved operations conservatively hold recovery evidence");
    await f.store.settleOperation(pending.operation.operationId, { kind: "rejected", code: "fixture", message: "not executed" });
    await f.cycle();
    if (process.platform === "linux") await assert.rejects(lstat(stale), { code: "ENOENT" });
    else assert.equal(f.owner.snapshot().state, "blocked");
    assert.ok(await lstat(young));
    assert.equal(await readFile(join(f.runtime, "opencode.db"), "utf8"), "active cache must survive");
    assert.equal(hasDurableProcessRelease(f.record, { authorityId: "authority", generation: 4 }), true);
  } finally { await f.close(); }
});

test("only uncertain operations located at the checkout, or unlocated, hold its cache", async () => {
  const f = await fixture();
  const held = () => f.store.withRuntimeStorageLease("project", f.metadata.runtimeLocation.cwd, async () => {}).then((ok) => !ok);
  try {
    // A transient runtime task is never reconciled; an in-flight one occupies its runtime instead.
    await f.store.prepareOperation({ sessionId: "oneshot-task", mutationKind: "turn-submit",
      intentEvent: { type: "runtime-task/create-intended", data: { task: "oneshot" }, ignorable: true } });
    assert.equal(await held(), false);
    const binding = (id: string, directory: string) => ({ canonicalSessionId: id, authorityId: "authority", generation: 1,
      location: { directory }, backendSessionId: `native-${id}` });
    await f.store.prepareSessionDeletion({ binding: binding("deleted-elsewhere", join(f.root, "other-checkout")) });
    assert.equal(await held(), false, "a tombstone names the only directory its native leg used");
    await f.store.prepareSessionDeletion({ binding: binding("deleted-here", f.metadata.runtimeLocation.cwd) });
    assert.equal(await held(), true);
  } finally { await f.close(); }
});

test("legacy sessions hold the project's caches only without a recorded binding directory", async () => {
  const f = await fixture();
  const held = () => f.store.withRuntimeStorageLease("project", f.metadata.runtimeLocation.cwd, async () => {}).then((ok) => !ok);
  try {
    const legacy = { id: "legacy", projectId: "project", title: "x", status: "idle" as const, createdAt: 1, updatedAt: 1 };
    await f.store.upsertProjection(legacy);
    assert.equal(await held(), true);
    await f.store.upsertProjection({ ...legacy, runtimeBinding: { harnessId: "opencode", authorityId: "authority", generation: 1,
      backendSessionId: "native", location: { directory: join(f.root, "project-checkout") } } } as never);
    assert.equal(await held(), false);
  } finally { await f.close(); }
});

test("a stale store whose checkout is gone is retired whole under the same lease", async () => {
  const f = await fixture(old);
  try {
    await f.add("stale");
    await f.store.upsertProjection({ id: "session", projectId: "project", title: "x", status: "idle", createdAt: 1, updatedAt: 1,
      worktreePath: f.metadata.runtimeLocation.cwd });
    await f.cycle();
    assert.ok(await lstat(f.runtime), "a referenced checkout keeps its cache");
    await f.store.deleteSession("session");
    await writeFile(f.record, JSON.stringify({ authorityId: "authority", generation: 4, released: false }));
    await f.cycle();
    assert.ok(await lstat(f.runtime), "an unproven release keeps its cache");
    await writeFile(f.record, JSON.stringify({ authorityId: "authority", generation: 4, released: true }));
    await mkdir(f.metadata.runtimeLocation.cwd);
    await f.cycle();
    assert.ok(await lstat(f.runtime), "an existing checkout keeps its cache");
    await rm(f.metadata.runtimeLocation.cwd, { recursive: true });
    await f.cycle();
    if (process.platform === "linux") assert.deepEqual(await readdir(f.root), []);
    // A crash between the rename and the removal is finished on the next pass.
    await mkdir(join(f.root, ".retired-crashed", "quarantine"), { recursive: true });
    await f.cycle();
    if (process.platform === "linux") assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test("maintenance is single-flight, paged, cancellation-safe and refuses symlink payloads", async () => {
  const f = await fixture();
  try {
    const foreign = join(f.root, "foreign.db");
    await writeFile(foreign, "foreign");
    const linked = await f.add("linked");
    await rm(join(linked, "opencode.db"));
    await symlink(foreign, join(linked, "opencode.db"));
    for (let i = 0; i < 30; i++) await f.add(`old-${i}`);
    const first = f.owner.step();
    assert.equal(f.owner.step(), first);
    await first;
    assert.ok(f.owner.snapshot().inspected <= 8);
    for (let i = 0; i < 30; i++) {
      await f.owner.step();
      assert.ok(f.owner.snapshot().inspected <= 8);
    }
    assert.equal(await readFile(foreign, "utf8"), "foreign");
    if (process.platform === "linux") assert.deepEqual(await readdir(join(f.runtime, "quarantine")), [linked.split("/").at(-1)]);
    await f.owner.dispose();
    await f.add("after-dispose");
    await f.owner.step();
    assert.equal(f.owner.snapshot().state, "stopped");
    assert.ok(await lstat(join(f.runtime, "quarantine", `${old}-after-dispose`)));
  } finally { await f.close(); }
});

test("generation changes and failed evidence persistence block removal", async () => {
  const f = await fixture();
  let owner: ReturnType<typeof createOpenCodeStorageMaintenance> | undefined;
  try {
    const stale = await f.add("stale");
    owner = createOpenCodeStorageMaintenance({ root: f.root, withRemovalLease: async (_path, metadata, remove) => {
      await writeFile(join(f.runtime, "runtime.json"), JSON.stringify({ ...f.metadata, runtimeGeneration: metadata.runtimeGeneration! + 1 }));
      await remove();
    } });
    for (let i = 0; i < 10; i++) await owner.step();
    assert.ok(await lstat(stale));
    await owner.dispose();
    owner = createOpenCodeStorageMaintenance({ root: f.root, withRemovalLease: async () => { throw Object.assign(new Error("fixture"), { code: "ENOSPC" }); } });
    for (let i = 0; i < 10 && !owner.snapshot().error; i++) await owner.step();
    assert.ok(await lstat(stale));
    if (process.platform === "linux") assert.equal(owner.snapshot().error, "ENOSPC");
  } finally { await owner?.dispose(); await f.close(); }
});

test("canonical create/rebind cannot race a removal lease; failed work releases the fence", async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const done = new Promise<void>((resolve) => { release = resolve; });
    const lease = f.store.withRuntimeStorageLease("project", f.metadata.runtimeLocation.cwd, async () => { entered(); await done; });
    await ready;
    const foreign = { id: "foreign-session", spaceId: "foreign-space", projectId: "other-project", worktreePath: f.metadata.runtimeLocation.cwd,
      title: "fixture", status: "idle" as const, createdAt: 1, updatedAt: 1 };
    await assert.rejects(async () => f.store.upsertProjection(foreign), { code: "storage-maintenance" });
    assert.equal(await f.store.projection(foreign.id), undefined);
    release();
    assert.equal(await lease, true);
    await f.store.upsertProjection(foreign);
    assert.equal(await f.store.withRuntimeStorageLease("project", f.metadata.runtimeLocation.cwd, async () => assert.fail("foreign reference")), false);
    await f.store.deleteSession(foreign.id);
    await assert.rejects(f.store.withRuntimeStorageLease("project", f.metadata.runtimeLocation.cwd, async () => { throw new Error("fixture failure"); }), /fixture failure/);
    await f.store.upsertProjection(foreign);
  } finally { await f.close(); }
});

test("replacing a quarantine parent during lease verification cannot redirect deletion", async () => {
  const f = await fixture();
  let owner: ReturnType<typeof createOpenCodeStorageMaintenance> | undefined;
  try {
    const stale = await f.add("stale");
    const foreign = join(f.root, "foreign", `${old}-stale`);
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, "opencode.db"), "foreign");
    let moved = false;
    owner = createOpenCodeStorageMaintenance({ root: f.root, withRemovalLease: async (_path, _metadata, remove) => {
      if (!moved) {
        await rename(join(f.runtime, "quarantine"), join(f.runtime, "quarantine-old"));
        await symlink(join(f.root, "foreign"), join(f.runtime, "quarantine"));
        moved = true;
      }
      await remove();
    } });
    for (let i = 0; i < 10; i++) await owner.step();
    assert.equal(await readFile(join(foreign, "opencode.db"), "utf8"), "foreign");
    if (process.platform === "linux") {
      assert.equal(moved, true, "fixture must replace the parent inside the lease");
      assert.ok(await lstat(stale.replace("/quarantine/", "/quarantine-old/")));
    }
  } finally { await owner?.dispose(); await f.close(); }
});

test("repeated maintenance teardown returns directory descriptors to the warm baseline", async (context) => {
  const f = await fixture();
  try {
    await f.add("kept");
    const counts: number[] = [];
    for (let cycle = 0; cycle < 101; cycle++) {
      const owner = createOpenCodeStorageMaintenance({ root: f.root, maxEntries: 2, withRemovalLease: async () => {} });
      owner.start(); owner.start();
      await owner.step();
      await owner.dispose();
      await owner.step();
      assert.equal(owner.snapshot().state, "stopped");
      assert.equal(owner.snapshot().scheduled, false);
      assert.equal(owner.snapshot().running, false);
      assert.equal(owner.snapshot().pendingScan, false);
      if (process.platform === "linux") counts.push((await readdir("/proc/self/fd")).length);
    }
    if (counts.length) {
      const warm = counts.shift()!;
      context.diagnostic(`descriptors: warm=${warm}, min=${Math.min(...counts)}, max=${Math.max(...counts)}, final=${counts.at(-1)}, samples=${counts.length}`);
      assert.ok(Math.max(...counts) <= warm + 2, `directory descriptors grew after warmup: ${warm} -> ${Math.max(...counts)}`);
      assert.ok(counts.at(-1)! <= warm + 2);
    }
  } finally { await f.close(); }
});
