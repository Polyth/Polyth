import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createRemoteOpenCodeRuntime } from "../src/index.ts";
import {
  createLocalOwnedFixture,
  TEST_LOCAL_DIGEST_B,
} from "./localRuntimeFailure.ts";
import {
  createFakeRemoteHost,
  TEST_REMOTE_DIGEST_B,
} from "./fakeRemoteRuntime.ts";
import { createRemoteOwnedFixture } from "./remoteRuntimeFailure.ts";

test("matrix: owned local / DB missing → new authority and storageId", async () => {
  const fixture = await createLocalOwnedFixture();
  try {
    const first = await fixture.boot();
    const originalStorageId = first.metadata?.storageId;
    assert.ok(originalStorageId);
    await fixture.inject({ kind: "delete-database" });
    const second = await fixture.boot();
    assert.notEqual(second.metadata?.storageId, originalStorageId);
    assert.notEqual(second.endpoint.authorityId, first.endpoint.authorityId);
    assert.equal(second.endpoint.generation, 1);
    assert.equal(
      await readFile(fixture.globalDb, "utf8"),
      "user global OpenCode DB must stay untouched",
    );
    assert.ok(fixture.spawnedDbs.every((db) => db.startsWith(fixture.runtimeDir)));
  } finally {
    await fixture.dispose();
  }
});

test("matrix: owned local / identity mismatch → quarantine + new authority", async () => {
  const fixture = await createLocalOwnedFixture();
  try {
    const first = await fixture.boot();
    await fixture.inject({ kind: "change-binary-identity", digest: TEST_LOCAL_DIGEST_B });
    const second = await fixture.boot();
    assert.notEqual(second.endpoint.authorityId, first.endpoint.authorityId);
    assert.notEqual(second.metadata?.storageId, first.metadata?.storageId);
    assert.equal(second.metadata?.binaryDigest, TEST_LOCAL_DIGEST_B);
    assert.ok(fixture.diagnostics.some((message) => /quarantined/i.test(message)));
    const quarantineNames = await readdir(join(fixture.runtimeDir, "quarantine"));
    assert.equal(quarantineNames.length, 1);
    assert.match(
      await readFile(join(fixture.runtimeDir, "quarantine", quarantineNames[0]!, "opencode.db"), "utf8"),
      /^opaque database/,
    );
  } finally {
    await fixture.dispose();
  }
});

test("matrix: owned local / runtimeDir uncreatable → spawn fail, global DB untouched", async () => {
  const fixture = await createLocalOwnedFixture();
  try {
    await fixture.inject({ kind: "uncreatable-dir" });
    await assert.rejects(
      () => fixture.boot(),
      (error: Error & { code?: string }) =>
        error.code === "unavailable"
        && /could not create isolated OpenCode runtime directory/.test(error.message),
    );
    assert.equal(fixture.spawnedDbs.length, 0);
    assert.equal(
      await readFile(fixture.globalDb, "utf8"),
      "user global OpenCode DB must stay untouched",
    );
  } finally {
    await fixture.dispose();
  }
});

test("matrix: owned local / worktrees cannot share one runtime process or DB", async () => {
  const first = await createLocalOwnedFixture({ projectId: "project-a", prefix: "polyth-wt-a-" });
  const second = await createLocalOwnedFixture({ projectId: "project-b", prefix: "polyth-wt-b-" });
  try {
    const bootA = await first.boot();
    const bootB = await second.boot();
    assert.notEqual(bootA.endpoint.authorityId, bootB.endpoint.authorityId);
    assert.notEqual(first.spawnedDbs[0], second.spawnedDbs[0]);
    assert.ok(first.spawnedDbs[0]?.startsWith(first.runtimeDir));
    assert.ok(second.spawnedDbs[0]?.startsWith(second.runtimeDir));
  } finally {
    await first.dispose();
    await second.dispose();
  }
});

test("matrix: owned local / symlink DB is not followed", async () => {
  const fixture = await createLocalOwnedFixture();
  try {
    const first = await fixture.boot();
    const foreign = join(fixture.directory, "foreign.db");
    await writeFile(foreign, "foreign newer database", { mode: 0o600 });
    await fixture.inject({ kind: "symlink-database", target: foreign });
    const second = await fixture.boot();
    assert.notEqual(second.endpoint.authorityId, first.endpoint.authorityId);
    assert.equal(await readFile(foreign, "utf8"), "foreign newer database");
    assert.equal(
      await readFile(fixture.globalDb, "utf8"),
      "user global OpenCode DB must stay untouched",
    );
  } finally {
    await fixture.dispose();
  }
});

test("matrix: owned SSH / DB missing → new authority", async () => {
  const fixture = await createRemoteOwnedFixture();
  try {
    const first = await fixture.boot();
    const originalStorageId = first.prepared.storageId;
    fixture.inject({ kind: "delete-database" });
    const second = await fixture.boot();
    assert.notEqual(second.prepared.storageId, originalStorageId);
    assert.notEqual(second.endpoint.authorityId, first.endpoint.authorityId);
    assert.equal(second.endpoint.generation, 1);
  } finally {
    await fixture.dispose();
  }
});

test("matrix: owned SSH / metadata missing → recover with a new storageId", async () => {
  const fixture = await createRemoteOwnedFixture();
  try {
    const first = await fixture.boot();
    fixture.inject({ kind: "delete-metadata" });
    const second = await fixture.boot();
    assert.notEqual(second.prepared.storageId, first.prepared.storageId);
    assert.notEqual(second.endpoint.authorityId, first.endpoint.authorityId);
    assert.ok(second.prepared.storageId);
  } finally {
    await fixture.dispose();
  }
});

test("matrix: owned SSH / engine mismatch → no silent reuse", async () => {
  const fixture = await createRemoteOwnedFixture();
  try {
    const first = await fixture.boot();
    fixture.inject({ kind: "digest-change", digest: TEST_REMOTE_DIGEST_B });
    const second = await fixture.boot();
    assert.notEqual(second.prepared.storageId, first.prepared.storageId);
    assert.notEqual(second.endpoint.authorityId, first.endpoint.authorityId);
    assert.equal(second.prepared.engineIdentity.binaryDigest, TEST_REMOTE_DIGEST_B);
    assert.ok(second.prepared.diagnostic);
    assert.match(second.prepared.diagnostic ?? "", /quarantined/i);
  } finally {
    await fixture.dispose();
  }
});

test("matrix: owned SSH / missing db path fails closed without serve", async () => {
  const fake = createFakeRemoteHost({
    stubPort: 1,
    runtimeDir: "/var/lib/polyth/runtimes/db-path",
  });
  fake.inject({ kind: "missing-db-path" });
  await assert.rejects(
    () => createRemoteOpenCodeRuntime({
      host: fake.host,
      remotePath: "/srv/app",
      runtimeDir: "/var/lib/polyth/runtimes/db-path",
    }),
    (error: Error & { code?: string }) =>
      error.code === "unavailable"
      && /does not honor OPENCODE_DB/.test(error.message),
  );
  assert.equal(fake.startCommands.length, 0);
  assert.equal(fake.forwards.length, 0);

  const wrong = createFakeRemoteHost({
    stubPort: 1,
    runtimeDir: "/var/lib/polyth/runtimes/wrong-db",
  });
  wrong.inject({ kind: "wrong-db-path", path: "/home/dev/.local/share/opencode/opencode.db" });
  await assert.rejects(
    () => createRemoteOpenCodeRuntime({
      host: wrong.host,
      remotePath: "/srv/app",
      runtimeDir: "/var/lib/polyth/runtimes/wrong-db",
    }),
    /does not honor OPENCODE_DB/,
  );
  assert.equal(wrong.startCommands.length, 0);
});

test("matrix: owned local / Polyth restart keeps authority when storage is intact", async () => {
  const fixture = await createLocalOwnedFixture();
  try {
    const first = await fixture.boot();
    await first.lease.dispose();
    const second = await fixture.boot();
    assert.equal(second.endpoint.authorityId, first.endpoint.authorityId);
    assert.equal(second.endpoint.generation, first.endpoint.generation + 1);
    assert.equal(second.metadata?.storageId, first.metadata?.storageId);
  } finally {
    await fixture.dispose();
  }
});

test("race: concurrent worktree boots isolate storage", async () => {
  const left = await createLocalOwnedFixture({ projectId: "left", prefix: "polyth-race-l-" });
  const right = await createLocalOwnedFixture({ projectId: "right", prefix: "polyth-race-r-" });
  try {
    const [bootL, bootR] = await Promise.all([left.boot(), right.boot()]);
    assert.notEqual(bootL.endpoint.authorityId, bootR.endpoint.authorityId);
    assert.notEqual(left.spawnedDbs[0], right.spawnedDbs[0]);
    assert.equal(
      await readFile(left.globalDb, "utf8"),
      "user global OpenCode DB must stay untouched",
    );
    assert.equal(
      await readFile(right.globalDb, "utf8"),
      "user global OpenCode DB must stay untouched",
    );
  } finally {
    await left.dispose();
    await right.dispose();
  }
});
