import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_OPENCODE_RUNTIME_POLICY, type OpenCodeRuntimePolicyStateDto, type SpaceContext } from "@polyth/contracts";
import { createServerServiceRegistry, SERVER_OPENCODE_RUNTIME_POLICY, type ServerPackageHost } from "@polyth/plugins";
import { createSpaceStorage } from "@polyth/tenancy";
import { parseOpenCodeRuntimePolicy } from "../src/runtimePolicy.ts";
import { createOpenCodeRuntimePolicyStore } from "../src/runtimePolicyStore.ts";
import registerPackage from "../src/serverEntry.ts";

const context = (spaceId: string, root: string): SpaceContext => {
  const storageDir = join(root, spaceId);
  mkdirSync(storageDir, { recursive: true });
  return { spaceId, spaceSlug: spaceId, userId: "owner", role: "owner", deployment: "local-trusted", storageDir };
};
const kept = { mode: "keep-warm" as const, idleTtlMinutes: 90, maxWarmWorkspaces: 3 };
const hasCode = (code: string) => (cause: unknown): boolean => (cause as { code?: string })?.code === code;

test("policy accepts bounded values and rejects malformed or coerced settings", () => {
  assert.deepEqual(parseOpenCodeRuntimePolicy(kept), kept);
  for (const value of [null, [], {}, { ...kept, mode: "always" }, { ...kept, idleTtlMinutes: "90" }, { ...kept, idleTtlMinutes: 0 }, { ...kept, idleTtlMinutes: 1_441 }, { ...kept, idleTtlMinutes: NaN }, { ...kept, maxWarmWorkspaces: 0 }, { ...kept, maxWarmWorkspaces: 17 }, { ...kept, maxWarmWorkspaces: 1.5 }]) {
    assert.throws(() => parseOpenCodeRuntimePolicy(value), hasCode("invalid-input"));
  }
  assert.deepEqual(parseOpenCodeRuntimePolicy({ ...kept, spaceId: "foreign-space", extra: "ignored" }), kept);
});

test("Space settings survive reopen, isolate known foreign Spaces and fence stale writes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-warm-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = context("space-a", root);
  const b = context("space-b", root);
  const storeFor = () => createOpenCodeRuntimePolicyStore((space) => createSpaceStorage(space.storageDir));
  const store = storeFor();
  assert.deepEqual(store.read(a), { revision: 0, settings: DEFAULT_OPENCODE_RUNTIME_POLICY });
  const initial = store.read(a);
  initial.settings.mode = "off";
  assert.equal(store.read(a).settings.mode, "default", "snapshots must be detached");
  assert.deepEqual(store.save(a, kept, 0), { revision: 1, settings: kept });
  assert.equal(store.read(b).settings.mode, "default");
  assert.deepEqual(storeFor().read(a), { revision: 1, settings: kept });
  assert.equal(store.save(a, kept, 1).revision, 1, "an unchanged preference does not advance the revision");
  assert.throws(() => store.save(a, { ...kept, mode: "off" }, 0), hasCode("conflict"));
  for (const revision of [-1, 0.5, "1", null]) assert.throws(() => store.save(a, kept, revision), hasCode("invalid-input"));
  const file = join(a.storageDir, "packages/opencode/runtime-policy.json");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("unreadable settings and a symlink escape cannot silently reset or overwrite policy", (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-warm-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const space = context("space-a", root);
  const store = createOpenCodeRuntimePolicyStore((value) => createSpaceStorage(value.storageDir));
  const directory = join(space.storageDir, "packages/opencode");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "runtime-policy.json");
  for (const content of ["{", JSON.stringify({ version: 2, revision: 1, settings: kept }), JSON.stringify({ version: 1, revision: 1, settings: { ...kept, idleTtlMinutes: -1 } })]) {
    writeFileSync(file, content);
    assert.throws(() => store.read(space), hasCode("storage-unavailable"));
    assert.throws(() => store.save(space, kept, 0), hasCode("storage-unavailable"));
    assert.equal(readFileSync(file, "utf8"), content);
  }
  rmSync(file);
  const outside = join(root, "foreign-policy.json");
  writeFileSync(outside, JSON.stringify({ version: 1, revision: 1, settings: kept }));
  symlinkSync(outside, file);
  assert.throws(() => store.read(space), hasCode("storage-unavailable"));
  assert.throws(() => store.save(space, kept, 0), hasCode("storage-unavailable"));
  assert.equal(JSON.parse(readFileSync(outside, "utf8")).revision, 1);
  const missing = context("missing", root);
  rmSync(missing.storageDir, { recursive: true });
  assert.throws(() => store.read(missing), hasCode("storage-unavailable"));
});

test("package routes use validated request Space and publish only successful preferences", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-warm-routes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const services = createServerServiceRegistry();
  const host = { services, spaceStorage: (space: SpaceContext) => createSpaceStorage(space.storageDir) } as unknown as ServerPackageHost;
  const pkg = registerPackage(host);
  const policy = services.require(SERVER_OPENCODE_RUNTIME_POLICY);
  const changes: Array<string | undefined> = [];
  const subscription = policy.onChange((spaceId) => { changes.push(spaceId); });
  policy.onChange(() => { throw new Error("observer failed"); });
  await pkg.onEnable?.();
  assert.deepEqual(changes, [undefined]);
  const a = context("space-a", root);
  const b = context("space-b", root);
  const request = async (space: SpaceContext, method: string, payload?: unknown) => {
    let status = 0;
    let value: unknown;
    const handled = await pkg.routes!({ path: "/api/opencode/runtime-policy", method, space, body: async () => payload, json: (code, body) => { status = code; value = body; } } as Parameters<NonNullable<typeof pkg.routes>>[0]);
    assert.equal(handled, true);
    return { status, value: value as OpenCodeRuntimePolicyStateDto };
  };
  assert.equal((await request(a, "PUT", { settings: kept, expectedRevision: 0 })).status, 200);
  assert.deepEqual(policy.read(a), kept);
  assert.equal((await request(b, "GET")).value.settings.mode, "default");
  assert.equal((await request(b, "PUT", { spaceId: a.spaceId, settings: { ...kept, mode: "off" }, expectedRevision: 0 })).status, 200);
  assert.equal(policy.read(a).mode, "keep-warm", "a known foreign id in the payload has no authority");
  const count = changes.length;
  assert.equal((await request(a, "PUT", { settings: kept, expectedRevision: 0 })).status, 409);
  assert.equal((await request(a, "PUT", { settings: kept, expectedRevision: "1" })).status, 400);
  assert.equal(changes.length, count);
  await pkg.onDisable?.();
  assert.equal(policy.read(a).mode, "default");
  await pkg.onEnable?.();
  assert.equal(policy.read(a).mode, "keep-warm", "disable preserves the saved policy");
  subscription.dispose();
  const finalCount = changes.length;
  await pkg.onDisable?.();
  assert.equal(changes.length, finalCount);
});
