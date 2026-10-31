import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RouteHandler, SpaceContext, SpaceStorage } from "@polyth/contracts";
import { createServerServiceRegistry, discoverServerPackages, type ServerPackageHost } from "@polyth/plugins";
import registerPackage from "../src/serverEntry.ts";
import { JUDGMENT_SERVICE } from "../src/server.ts";
import { createFakeJudgmentEngine } from "../src/testing.ts";
import { noul } from "../src/index.ts";
import type { JudgmentSettingsSnapshot } from "../src/settings.ts";
import { readSettings, writeSettings } from "../src/settingsStore.ts";

const scratch = resolve(import.meta.dirname, "../../../.scratch/judgment");
function fixture(t: test.TestContext) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "server-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = { spaceId: "space-a" } as SpaceContext, b = { spaceId: "space-b" } as SpaceContext;
  const services = createServerServiceRegistry();
  const host = {
    services,
    spaceStorage(space: SpaceContext): SpaceStorage {
      return { root: join(root, space.spaceId), packageDir(id) { const path = join(root, space.spaceId, id); mkdirSync(path, { recursive: true }); return path; }, path(relative) { return join(root, space.spaceId, relative); } };
    },
    forSpace(space: SpaceContext) { return { projects: { async get(id: string) { return id === `project-${space.spaceId}` ? { id } : undefined; } } }; },
  } as unknown as ServerPackageHost;
  const pkg = registerPackage(host);
  const service = services.require(JUDGMENT_SERVICE);
  const context = (space = a) => ({ space, projectId: `project-${space.spaceId}` });
  const request = async (space: SpaceContext, path: string, method = "GET", body: unknown = {}, projectId = context(space).projectId) => {
    let value: unknown;
    const handled = await pkg.routes!({ space, path, method, url: new URL(`http://localhost${path}?projectId=${projectId}`),
      body: async () => body, json: (status: number, data: unknown) => { assert.equal(status, 200); value = data; } } as Parameters<RouteHandler>[0]);
    assert.equal(handled, true);
    return value as JudgmentSettingsSnapshot;
  };
  t.after(() => pkg.onDisable?.());
  return { root, host, pkg, service, context, request, a, b };
}
const input = () => ({ scope: "test.v1", state: { evidence: "private" }, questions: { q: noul("Done?") } });
const answer = { answers: { q: { type: "noul" as const, probability: 0.5, confidence: 0.5 } } };

test("both packages are discovered without host registries", async () => {
  const entries = await discoverServerPackages(resolve(import.meta.dirname, "../.."));
  for (const id of ["judgment", "judgment-jev"]) assert.ok(entries.some((entry) => entry.id === id));
});

test("settings isolate Spaces, validate known-valid foreign projects and enforce revisions", async (t) => {
  const f = fixture(t); await f.pkg.onEnable?.();
  const first = await f.request(f.a, "/api/judgment/settings");
  assert.deepEqual(first.global, { enabled: true });
  await f.request(f.a, "/api/judgment/settings", "PUT", { revision: 0, level: "global", config: { enabled: false, providerId: "configured" } });
  const other = await f.request(f.b, "/api/judgment/settings");
  assert.deepEqual(other.global, { enabled: true }); assert.equal(other.revision, 0);
  await assert.rejects(f.request(f.a, "/api/judgment/settings", "GET", {}, f.context(f.b).projectId), /Project not found/);
  await assert.rejects(f.service.createRun({ space: f.a, projectId: f.context(f.b).projectId }), /Project not found/);
  await assert.rejects(f.request(f.a, "/api/judgment/settings", "PUT", { revision: 0, level: "global", config: { enabled: true } }), /settings changed/);
  await assert.rejects(f.request(f.a, "/api/judgment/settings", "PUT", { revision: 1, level: "global", config: { enabled: true, apiKey: "must not persist" } }), /Invalid Judgment/);
  const disk = readFileSync(join(f.root, f.a.spaceId, "judgment", "settings.json"), "utf8");
  assert.doesNotMatch(disk, /apiKey|must not persist/);
  assert.deepEqual(f.pkg.remoteAccess, { routeScopes: ["judgment"], http: [] });
});

test("settings persistence survives a new package instance, project values remain independent", async (t) => {
  const f = fixture(t);
  await f.request(f.a, "/api/judgment/settings", "PUT", { revision: 0, level: "global", config: { enabled: true, engineId: "one", providerId: "global" } });
  const saved = await f.request(f.a, "/api/judgment/settings", "PUT", { revision: 1, level: "project", config: { modelId: "project", scopes: { "smoke.v1": { providerId: "scope" } } } });
  const settingsFile = join(f.root, f.a.spaceId, "judgment", "settings.json");
  assert.deepEqual(readSettings(settingsFile).projects[f.context().projectId], saved.project);
  for (const invalid of [{ enabled: true, limits: { timeoutMs: 0 } }, { enabled: true, scopes: { "bad scope": {} } }, { enabled: true, scopes: { "s.v1": { enabled: false } } }]) {
    assert.throws(() => writeSettings(settingsFile, invalid, 2), /Invalid Judgment/);
  }
});

test("service disable/re-enable, engine cleanup and settings changes revoke existing runs", async (t) => {
  const f = fixture(t), engine = createFakeJudgmentEngine(answer);
  const remove = f.service.registerEngine({ metadata: engine.metadata, create: () => engine, catalog: () => [] });
  const disabled = await f.service.createRun(f.context());
  const off = await disabled.judge(input()); assert.ok(!off.ok); assert.equal(off.reason, "disabled"); disabled.dispose();
  await f.pkg.onEnable?.();
  const run = await f.service.createRun(f.context());
  assert.ok((await run.judge(input())).ok);
  await f.request(f.a, "/api/judgment/settings", "PUT", { revision: 0, level: "global", config: { enabled: false } });
  const stale = await run.judge(input()); assert.ok(!stale.ok); assert.equal(stale.reason, "cancelled");
  await f.request(f.a, "/api/judgment/settings", "PUT", { revision: 1, level: "global", config: { enabled: true } });
  const next = await f.service.createRun(f.context());
  assert.ok((await next.judge(input())).ok); remove();
  const missing = await next.judge(input()); assert.ok(!missing.ok); assert.equal(missing.reason, "engine-unavailable");
  await f.pkg.onDisable?.(); await f.pkg.onEnable?.();
  const empty = await f.service.createRun(f.context());
  const result = await empty.judge(input()); assert.ok(!result.ok); assert.equal(result.reason, "engine-unavailable");
});

test("Space concurrency is shared across separate runs and respects configured limits", async (t) => {
  const f = fixture(t); await f.pkg.onEnable?.();
  await f.request(f.a, "/api/judgment/settings", "PUT", { revision: 0, level: "global", config: { enabled: true, limits: { maxConcurrentCalls: 1 } } });
  let active = 0, peak = 0;
  const engine = createFakeJudgmentEngine({ script: Array.from({ length: 4 }, () => async () => {
    active++; peak = Math.max(active, peak); await new Promise((resolve) => setTimeout(resolve, 5)); active--; return answer;
  }) });
  f.service.registerEngine({ metadata: engine.metadata, create: () => engine, catalog: () => [] });
  const runs = await Promise.all(Array.from({ length: 4 }, () => f.service.createRun(f.context())));
  assert.ok((await Promise.all(runs.map((run) => run.judge(input())))).every((r) => r.ok)); assert.equal(peak, 1);
});

test("registered uses resolve defaults, all-project and project values, and reject values their descriptor refuses", async (t) => {
  const f = fixture(t); await f.pkg.onEnable?.();
  const off = f.service.registerUse({ id: "test.use", packageId: "test", title: "Test use", description: "Asks a test question.",
    effect: "Shows a chip.", scope: "test.use.v1", evidence: "short", defaultEnabled: false,
    params: [{ id: "threshold", label: "Threshold", kind: "probability", default: 0.7 },
      { id: "mode", label: "Mode", kind: "choice", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], default: "a" }] });
  const listed = (await f.request(f.a, "/api/judgment/settings")).uses!;
  assert.deepEqual(listed.map((use) => use.id), ["test.use"]);
  assert.throws(() => f.service.registerUse({ ...listed[0]! }), /Duplicate/);
  assert.deepEqual(await f.service.resolveUse(f.context(), "test.use"),
    { useId: "test.use", scope: "test.use.v1", enabled: false, reason: "use-off", params: { threshold: 0.7, mode: "a" } });
  await f.request(f.a, "/api/judgment/settings", "PUT", { revision: 0, level: "global", config: { enabled: true, uses: { "test.use": { enabled: true, params: { threshold: 0.9 } } } } });
  await f.request(f.a, "/api/judgment/settings", "PUT", { revision: 1, level: "project", config: { uses: { "test.use": { params: { mode: "b" } } } } });
  assert.deepEqual(await f.service.resolveUse(f.context(), "test.use"),
    { useId: "test.use", scope: "test.use.v1", enabled: true, params: { threshold: 0.9, mode: "b" } });
  await assert.rejects(f.request(f.a, "/api/judgment/settings", "PUT", { revision: 2, level: "global", config: { enabled: true, uses: { "test.use": { params: { threshold: 2 } } } } }), /Invalid value/);
  // Another Space sees none of this Space's values.
  assert.equal((await f.service.resolveUse(f.context(f.b), "test.use")).enabled, false);
  await f.request(f.a, "/api/judgment/settings", "PUT", { revision: 2, level: "global", config: { enabled: false, uses: { "test.use": { enabled: true } } } });
  assert.equal((await f.service.resolveUse(f.context(), "test.use")).reason, "judgment-off");
  off();
  assert.equal((await f.service.resolveUse(f.context(), "test.use")).reason, "unknown-use");
  // Values of an unregistered use survive a save untouched.
  await f.request(f.a, "/api/judgment/settings", "PUT", { revision: 3, level: "global", config: { enabled: true, uses: { "test.use": { params: { threshold: 5 } } } } });
});
