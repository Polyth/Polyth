import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRuntime, HarnessProvider, SessionProjection } from "@polyth/contracts";
import { createHarnessPool, createHarnessRegistry } from "../src/index.ts";
const context = { spaceId: "a", projectId: "p", cwd: "/tmp" };
const provider = (id: string, priority: number, broken = false): HarnessProvider => ({
    descriptor: { id, name: id, priority, integration: "test" },
    probe: async () => { if (broken)
        throw new Error("bad executable"); return { harnessId: id, installed: true, authenticated: true, healthy: true }; },
    createRuntime: async () => ({ dispose: async () => { } } as AgentRuntime),
});
test("Auto is deterministic and sticky; explicit pin and disabled policy never fall back", async () => {
    const r = createHarnessRegistry();
    r.register(provider("b", 1));
    r.register(provider("a", 1));
    r.register(provider("broken", 0, true));
    assert.equal((await r.probe(context)).find((p) => p.harnessId === "broken")?.healthy, false);
    assert.equal((await r.resolve(context, { mode: "auto" })).descriptor.id, "a");
    assert.equal((await r.resolve(context, { mode: "auto" }, "b")).descriptor.id, "b");
    await assert.rejects(r.resolve(context, { mode: "pinned", harnessId: "broken" }), { code: "runtime-unavailable" });
    r.configurePolicy(async () => ({ a: { enabled: false }, b: { priority: -1 } }));
    assert.equal((await r.resolve(context, { mode: "auto" })).descriptor.id, "b");
    await assert.rejects(r.resolve(context, { mode: "pinned", harnessId: "a" }));
});
test("factory fallback is before native creation only; persisted routes remain exact and Space caches are isolated", async () => {
    const r = createHarnessRegistry();
    const a = provider("a", 0);
    a.createRuntime = async () => { throw new Error("startup failed"); };
    r.register(a);
    r.register(provider("b", 1));
    const pool = createHarnessPool({ registry: r, legacyHarnessId: "a", context: async (projectId, cwd, sessionId) => ({ ...context, projectId, sessionId, cwd: cwd!, spaceId: projectId }) });
    const projection = { id: "s", projectId: "p", title: "s", createdAt: 0, updatedAt: 0, status: "idle" } as SessionProjection;
    assert.equal((await pool.forSession(projection, "/tmp")).harnessId, "b");
    await assert.rejects(pool.forSession({ ...projection, resolvedHarnessId: "a" }, "/tmp"), /startup failed/);
    await assert.rejects(pool.forSession({ ...projection, harness: { mode: "pinned", harnessId: "a" } }, "/tmp"), /startup failed/);
    const one = await pool.forSession({ ...projection, resolvedHarnessId: "b" }, "/tmp");
    const two = await pool.forSession({ ...projection, projectId: "other", resolvedHarnessId: "b" }, "/tmp");
    assert.notEqual(one, two);
    await pool.dispose();
});
test("beforeCreate runs once inside the coalesced creation flight", async () => {
    const r = createHarnessRegistry();
    const seen: string[] = [];
    r.register(provider("a", 0));
    const pool = createHarnessPool({
        registry: r,
        legacyHarnessId: "a",
        context: async (projectId, cwd, sessionId) => ({ ...context, projectId, sessionId, cwd: cwd!, spaceId: projectId }),
        beforeCreate: async (p, ctx) => { seen.push(`${p.descriptor.id}:${ctx.projectId}`); },
    });
    const projection = { id: "s", projectId: "p", title: "s", createdAt: 0, updatedAt: 0, status: "idle" } as SessionProjection;
    await pool.forSession({ ...projection, resolvedHarnessId: "a" }, "/tmp");
    await pool.forSession({ ...projection, resolvedHarnessId: "a" }, "/tmp");
    assert.deepEqual(seen, ["a:p"]);
    await pool.dispose();
});

test("shared physical runtimes are cached per session and forgotten by session id", async () => {
    let physical = 0;
    const owner = {
        dispose: async () => { physical += 1; },
        models: async () => [],
    } as AgentRuntime;
    const r = createHarnessRegistry();
    r.register({
        descriptor: { id: "shared", name: "shared", priority: 0, integration: "test" },
        probe: async () => ({ harnessId: "shared", installed: true, authenticated: true, healthy: true }),
        createRuntime: async () => owner,
    });
    const pool = createHarnessPool({
        registry: r,
        legacyHarnessId: "shared",
        context: async (projectId, cwd, sessionId) => ({ ...context, projectId, sessionId, cwd: cwd!, spaceId: projectId }),
    });
    const one = await pool.forSession({ id: "s1", projectId: "p", title: "s", createdAt: 0, updatedAt: 0, status: "idle" } as SessionProjection, "/tmp");
    const two = await pool.forSession({ id: "s2", projectId: "p", title: "s", createdAt: 0, updatedAt: 0, status: "idle" } as SessionProjection, "/tmp");
    assert.equal(one, owner);
    assert.equal(two, owner);
    pool.forgetSession("s1");
    const oneAgain = await pool.forSession({ id: "s1", projectId: "p", title: "s", createdAt: 0, updatedAt: 0, status: "idle" } as SessionProjection, "/tmp");
    const twoAgain = await pool.forSession({ id: "s2", projectId: "p", title: "s", createdAt: 0, updatedAt: 0, status: "idle" } as SessionProjection, "/tmp");
    assert.equal(oneAgain, owner);
    assert.equal(twoAgain, two);
    pool.forgetRuntime(owner);
    const afterPhysical = await pool.forSession({ id: "s2", projectId: "p", title: "s", createdAt: 0, updatedAt: 0, status: "idle" } as SessionProjection, "/tmp");
    assert.equal(afterPhysical, owner);
    await pool.dispose();
    assert.equal(physical, 1);
});

test("harness pool dispose surfaces runtime disposal failures", async () => {
    const r = createHarnessRegistry();
    r.register({
        descriptor: { id: "broken", name: "broken", priority: 0, integration: "test" },
        probe: async () => ({ harnessId: "broken", installed: true, authenticated: true, healthy: true }),
        createRuntime: async () => ({
            dispose: async () => { throw new Error("kill failed"); },
            models: async () => [],
        } as AgentRuntime),
    });
    const pool = createHarnessPool({
        registry: r,
        legacyHarnessId: "broken",
        context: async (projectId, cwd, sessionId) => ({ ...context, projectId, sessionId, cwd: cwd!, spaceId: projectId }),
    });
    await pool.forSession({ id: "s", projectId: "p", title: "s", createdAt: 0, updatedAt: 0, status: "idle" } as SessionProjection, "/tmp");
    await assert.rejects(() => pool.dispose(), /kill failed/);
});

test("registry.get is exact lookup without probe", async () => {
  const r = createHarnessRegistry();
  let probed = false;
  const p = provider("opencode", 0);
  p.probe = async () => {
    probed = true;
    return { harnessId: "opencode", installed: true, authenticated: true, healthy: true };
  };
  r.register(p);
  assert.equal(r.get("opencode")?.descriptor.id, "opencode");
  assert.equal(r.get("missing"), undefined);
  assert.equal(probed, false);
});

test("snapshots are cached by target, retain last-good discovery, and invalidate explicitly", async () => {
    const registry = createHarnessRegistry();
    let discoveries = 0;
    let failDiscovery = false;
    registry.register({
        descriptor: { id: "catalog", name: "Catalog", integration: "test", priority: 4, setupUrl: "https://example.invalid/setup" },
        probe: async () => ({ harnessId: "catalog", installed: true, authenticated: true, healthy: true }),
        discover: async () => {
            discoveries += 1;
            if (failDiscovery)
                throw new Error("temporary outage");
            return { catalog: { models: [{ providerID: "p", modelID: "m", name: "Model" }] } };
        },
        createRuntime: async () => ({ dispose: async () => { } } as AgentRuntime),
    });
    registry.configurePolicy(async () => ({ catalog: { enabled: true, priority: 2 } }));
    const first = (await registry.snapshots(context, { detail: true }))[0]!;
    const cached = (await registry.snapshots(context, { detail: true }))[0]!;
    assert.equal(discoveries, 1);
    assert.equal(cached.context.revision, first.context.revision);
    assert.equal(first.policy.priority, 2);
    assert.equal(first.setup?.setupUrl, "https://example.invalid/setup");
    assert.equal(first.catalog?.models?.[0]?.harnessId, "catalog");

    const probeRefresh = (await registry.snapshots(context, { force: true }))[0]!;
    assert.equal(discoveries, 1);
    assert.equal(probeRefresh.catalog?.models?.[0]?.modelID, "m");

    failDiscovery = true;
    const stale = (await registry.snapshots(context, { detail: true, force: true }))[0]!;
    assert.equal(stale.availability.state, "degraded");
    assert.equal(stale.stale, true);
    assert.equal(stale.catalog?.models?.[0]?.modelID, "m");

    failDiscovery = false;
    registry.invalidate({ projectId: context.projectId, harnessId: "catalog" });
    const refreshed = (await registry.snapshots(context, { detail: true }))[0]!;
    assert.equal(discoveries, 3);
    assert.notEqual(refreshed.context.revision, stale.context.revision);
});

test("execution resolution refines unknown readiness without probing native details during listing", async () => {
    const registry = createHarnessRegistry();
    let discoveries = 0;
    registry.register({
        descriptor: { id: "setup", name: "Setup", integration: "test", priority: 0 },
        probe: async () => ({ harnessId: "setup", installed: true, authenticated: "unknown", healthy: true, state: "unknown" }),
        discover: async () => {
            discoveries += 1;
            return { state: "setup-required", authenticated: "unknown" };
        },
        createRuntime: async () => ({ dispose: async () => { } } as AgentRuntime),
    });
    registry.register(provider("ready", 1));

    await registry.probe(context);
    assert.equal(discoveries, 0);
    assert.equal((await registry.resolve(context, { mode: "auto" })).descriptor.id, "ready");
    assert.equal(discoveries, 1);
    await assert.rejects(
        registry.resolve(context, { mode: "pinned", harnessId: "setup" }),
        { code: "runtime-unavailable" },
    );
    assert.equal(discoveries, 2);
});


test("session release waits for pending creation and disposes its runtime exactly once", async () => {
    const registry = createHarnessRegistry();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let disposals = 0;
    const factory = provider("native", 0);
    factory.createRuntime = async () => { await gate; return { dispose: async () => { disposals++; } } as AgentRuntime; };
    registry.register(factory);
    const pool = createHarnessPool({ registry, legacyHarnessId: "native", context: async (projectId, cwd, sessionId) => ({ ...context, projectId, cwd: cwd!, sessionId }) });
    const projection = { id: "s", projectId: "p", resolvedHarnessId: "native" } as SessionProjection;
    const creating = pool.forSession(projection, "/source");
    await new Promise(resolve => setImmediate(resolve));
    const release = pool.releaseSession("s");
    const concurrentRelease = pool.releaseSession("s");
    const refused = assert.rejects(creating, /runtime was released/);
    finish();
    await refused;
    await Promise.all([release, concurrentRelease]);
    assert.equal(disposals, 1);
    await pool.forSession(projection, "/destination");
    await pool.dispose();
    assert.equal(disposals, 2);
});

test("failed physical release fences source lookup and cannot double-dispose or start replacement", async () => {
    const registry = createHarnessRegistry();
    let creates = 0;
    let disposals = 0;
    const factory = provider("native", 0);
    factory.createRuntime = async () => { creates++; return { dispose: async () => { disposals++; throw new Error("physical teardown failed"); } } as AgentRuntime; };
    registry.register(factory);
    const pool = createHarnessPool({ registry, legacyHarnessId: "native", context: async (projectId, cwd, sessionId) => ({ ...context, projectId, cwd: cwd!, sessionId }) });
    const projection = { id: "s", projectId: "p", resolvedHarnessId: "native" } as SessionProjection;
    await pool.forSession(projection, "/source");
    await assert.rejects(pool.releaseSession("s"), /release failed/);
    await assert.rejects(pool.forSession(projection, "/source"), /physical teardown failed/);
    await assert.rejects(pool.releaseSession("s"), /release failed/);
    await assert.rejects(pool.forSession(projection, "/destination"), /physical teardown failed/);
    assert.equal(creates, 1);
    assert.equal(disposals, 1);
    await assert.rejects(pool.dispose(), /physical teardown failed/);
    assert.equal(disposals, 1);
});


test("configured physical release cannot dispose a generic facade still cached by another session", async () => {
    const registry = createHarnessRegistry();
    let disposed = 0;
    const runtime = { dispose: async () => { disposed++; } } as AgentRuntime;
    const factory = provider("shared", 0);
    factory.createRuntime = async () => runtime;
    registry.register(factory);
    const pool = createHarnessPool({
        registry, legacyHarnessId: "shared",
        context: async (projectId, cwd, sessionId) => ({ ...context, projectId, cwd: cwd!, sessionId }),
        releaseRuntime: async (_runtime, dispose) => dispose(),
    });
    const projection = { projectId: "p", resolvedHarnessId: "shared" } as SessionProjection;
    await pool.forSession({ ...projection, id: "one" }, "/source");
    await pool.forSession({ ...projection, id: "two" }, "/source");
    await pool.releaseSession("one");
    assert.equal(disposed, 0);
    assert.equal(await pool.forSession({ ...projection, id: "two" }, "/source"), runtime);
    await pool.releaseSession("two");
    assert.equal(disposed, 1);
});
