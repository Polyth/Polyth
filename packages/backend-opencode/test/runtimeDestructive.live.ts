// Live destructive checks against a REAL OpenCode process. Kept outside the
// default `*.test.ts` glob; run explicitly:
//
//   node --experimental-strip-types --test packages/backend-opencode/test/runtimeDestructive.live.ts
//
// Provider credentials are not required. Session create is the confirmed
// operation. Never opens the user global OpenCode DB.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  injectLocalIdentityBreak,
  readLocalRuntimeMetadata,
} from "./localRuntimeFailure.ts";
import {
  LIVE_OPENCODE,
  LIVE_OPENCODE_SKIP,
  assertGlobalOpenCodeDbUntouched,
  createRealOwnedLiveFixture,
  inspectLiveOpenCodeEngine,
  isolatedDatabasePath,
  listDeletedDatabaseFds,
  snapshotPath,
} from "./realOpenCodeLiveHarness.ts";

const LIVE = { skip: LIVE_OPENCODE_SKIP, timeout: 120_000 };

test("live: isolated OPENCODE_DB equals opencode db path under the lease", LIVE, async () => {
  assert.ok(LIVE_OPENCODE);
  const fixture = await createRealOwnedLiveFixture({ prefix: "polyth-oc-live-dbpath-" });
  try {
    const boot = await fixture.boot();
    const expected = isolatedDatabasePath(fixture.runtimeDir);
    const reported = execFileSync(LIVE_OPENCODE.bin, ["db", "path"], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        OPENCODE_DB: expected,
        OPENCODE_DISABLE_AUTOUPDATE: "true",
      },
    }).trim().split(/\r?\n/).at(-1)?.trim();
    assert.equal(resolve(reported ?? ""), resolve(expected));
    assert.equal(snapshotPath(expected).exists, true);
    const sessionId = await boot.runtime.ensureSession({
      projectId: "live-destructive",
      sessionId: "canonical-dbpath",
      title: "db path probe",
      cwd: fixture.directory,
    });
    assert.match(sessionId, /^ses_/);
    assertGlobalOpenCodeDbUntouched(fixture.globalDbBefore);
  } finally {
    await fixture.dispose();
  }
});

test("live: compatible reopen keeps authority and the backend session", LIVE, async () => {
  const fixture = await createRealOwnedLiveFixture({ prefix: "polyth-oc-live-warm-" });
  try {
    const first = await fixture.boot();
    const backendSessionId = await first.runtime.ensureSession({
      projectId: "live-destructive",
      sessionId: "canonical-warm",
      title: "warm reopen",
      cwd: fixture.directory,
    });
    const firstAuthority = first.endpoint.authorityId;
    const firstStorage = first.metadata?.storageId;
    assert.ok(firstStorage);
    await fixture.disposeActive();

    const second = await fixture.boot();
    assert.equal(second.endpoint.authorityId, firstAuthority);
    assert.equal(second.metadata?.storageId, firstStorage);
    assert.equal(second.endpoint.generation, 2);
    const sessions = await second.runtime.sessions();
    assert.equal(sessions.some((session) => session.id === backendSessionId), true);
    assertGlobalOpenCodeDbUntouched(fixture.globalDbBefore);
  } finally {
    await fixture.dispose();
  }
});

test("live: uncreatable runtimeDir fails closed and does not touch the global DB", LIVE, async () => {
  const fixture = await createRealOwnedLiveFixture({ prefix: "polyth-oc-live-nodir-" });
  try {
    await mkdir(resolve(fixture.runtimeDir, ".."), { recursive: true });
    await writeFile(fixture.runtimeDir, "occupied-by-a-file");
    await assert.rejects(
      () => fixture.boot(),
      (error: Error & { code?: string }) =>
        error.code === "unavailable"
        && /could not create isolated OpenCode runtime directory/.test(error.message),
    );
    assertGlobalOpenCodeDbUntouched(fixture.globalDbBefore);
  } finally {
    await fixture.dispose();
  }
});

test("live: delete DB while OpenCode is alive is not immediately detectable", LIVE, async () => {
  // Detection boundary (OpenCode 1.18.18, Linux): unlinking opencode.db,
  // opencode.db-wal, and opencode.db-shm while serve is alive removes the
  // directory entries, but the process keeps those inodes open
  // (`…/opencode.db (deleted)` in /proc/<pid>/fd). /global/health stays 200
  // and POST /session still succeeds against the open inode. Polyth does not
  // poll the DB path on a live lease — prepareOpenCodeRuntime runs only on
  // start/restart — so a live unlink cannot mint a new storageId. Loss is
  // observed on the next prepare after the process releases the inode.
  const fixture = await createRealOwnedLiveFixture({ prefix: "polyth-oc-live-livedel-" });
  try {
    const first = await fixture.boot();
    const firstStorage = first.metadata?.storageId;
    const firstAuthority = first.endpoint.authorityId;
    assert.ok(firstStorage);
    const originalSession = await first.runtime.ensureSession({
      projectId: "live-destructive",
      sessionId: "canonical-live-delete",
      title: "alive unlink",
      cwd: fixture.directory,
    });

    await injectLocalIdentityBreak(fixture.runtimeDir, { kind: "delete-database" });
    const pid = await fixture.childPid();
    assert.ok(pid);
    const deletedFds = listDeletedDatabaseFds(pid);
    assert.ok(
      deletedFds.some((target) => /opencode\.db \(deleted\)/.test(target)),
      `expected an open deleted inode, got ${JSON.stringify(deletedFds)}`,
    );
    assert.equal(snapshotPath(isolatedDatabasePath(fixture.runtimeDir)).exists, false);

    const health = await fetch(`${first.endpoint.url}/global/health`);
    assert.equal(health.status, 200);
    const stillAliveSession = await first.runtime.ensureSession({
      projectId: "live-destructive",
      sessionId: "canonical-live-delete-2",
      title: "after live unlink",
      cwd: fixture.directory,
    });
    assert.match(stillAliveSession, /^ses_/);
    assert.notEqual(stillAliveSession, originalSession);
    assert.equal((await readLocalRuntimeMetadata(fixture.runtimeDir))?.storageId, firstStorage);
    assert.equal((await first.lease.endpoint()).authorityId, firstAuthority);

    await fixture.disposeActive();
    assert.equal(snapshotPath(isolatedDatabasePath(fixture.runtimeDir)).exists, false);

    const second = await fixture.boot();
    assert.notEqual(second.metadata?.storageId, firstStorage);
    assert.notEqual(second.endpoint.authorityId, firstAuthority);
    assert.equal(second.endpoint.generation, 1);
    assert.ok(fixture.diagnostics.some((message) => /missing or unsafe|new runtime epoch/i.test(message)));
    assert.deepEqual(await second.runtime.sessions(), []);
    assertGlobalOpenCodeDbUntouched(fixture.globalDbBefore);
  } finally {
    await fixture.dispose();
  }
});

test("live: incompatible schema is not repaired; spawn fails closed", LIVE, async () => {
  const fixture = await createRealOwnedLiveFixture({ prefix: "polyth-oc-live-schema-" });
  const junk = "NOT A SQLITE DATABASE — incompatible junk\n";
  try {
    const first = await fixture.boot();
    await first.runtime.ensureSession({
      projectId: "live-destructive",
      sessionId: "canonical-schema",
      title: "schema",
      cwd: fixture.directory,
    });
    const firstStorage = first.metadata?.storageId;
    await fixture.disposeActive();

    const db = isolatedDatabasePath(fixture.runtimeDir);
    await rm(`${db}-wal`, { force: true });
    await rm(`${db}-shm`, { force: true });
    await fixture.inject({ kind: "replace-database", content: junk });
    await assert.rejects(
      () => fixture.boot(),
      (error: Error & { code?: string }) =>
        error.code === "unavailable"
        && /file is not a database|malformed|exited 1/i.test(error.message),
    );
    assert.equal(await readFile(db, "utf8"), junk);
    assert.equal((await readdir(fixture.runtimeDir)).includes("quarantine"), false);
    assert.equal((await readLocalRuntimeMetadata(fixture.runtimeDir))?.storageId, firstStorage);
    assertGlobalOpenCodeDbUntouched(fixture.globalDbBefore);
  } finally {
    await fixture.dispose();
  }
});

test("live: engine identity change quarantines the old DB and mints a new authority", LIVE, async () => {
  const fixture = await createRealOwnedLiveFixture({ prefix: "polyth-oc-live-engine-" });
  try {
    const first = await fixture.boot();
    const firstStorage = first.metadata?.storageId;
    const firstAuthority = first.endpoint.authorityId;
    const firstDigest = first.metadata?.binaryDigest;
    assert.ok(firstStorage);
    assert.ok(firstDigest);
    await first.runtime.ensureSession({
      projectId: "live-destructive",
      sessionId: "canonical-engine",
      title: "engine A",
      cwd: fixture.directory,
    });
    await fixture.disposeActive();

    const engineBDigest = "b".repeat(64);
    const real = await inspectLiveOpenCodeEngine();
    const second = await fixture.boot({
      inspectEngine: async () => ({ ...real, binaryDigest: engineBDigest }),
    });
    assert.notEqual(second.endpoint.authorityId, firstAuthority);
    assert.notEqual(second.metadata?.storageId, firstStorage);
    assert.equal(second.metadata?.binaryDigest, engineBDigest);
    assert.equal(second.endpoint.generation, 1);
    assert.ok(fixture.diagnostics.some((message) => /engine identity changed|quarantined/i.test(message)));
    const quarantine = await readdir(join(fixture.runtimeDir, "quarantine"));
    assert.equal(quarantine.length, 1);
    assert.match(quarantine[0] ?? "", /incompatible-engine/);
    assert.equal(snapshotPath(isolatedDatabasePath(fixture.runtimeDir)).exists, true);
    assertGlobalOpenCodeDbUntouched(fixture.globalDbBefore);
  } finally {
    await fixture.dispose();
  }
});

