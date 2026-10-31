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
test("a starting harness is visible but never execution-runnable", async () => {
    const registry = createHarnessRegistry();
    registry.register({
        ...provider("starting", 0),
        probe: async () => ({
            harnessId: "starting", installed: true, healthy: true,
            authenticated: "unknown" as const, state: "starting" as const,
        }),
    });
    assert.equal((await registry.snapshots(context))[0]?.availability.state, "starting");
    await assert.rejects(registry.resolve(context, { mode: "pinned", harnessId: "starting" }), {
        code: "runtime-unavailable",
    });
});

test("detail evidence atomically replaces the cheap probe message", async () => {
    const registry = createHarnessRegistry();
    registry.register({
        ...provider("message", 0),
        probe: async () => ({
            harnessId: "message", installed: true, healthy: true,
            authenticated: "unknown" as const, message: "cheap probe has not checked sign-in",
        }),
        discover: async () => ({
            state: "ready" as const, authenticated: true, message: "catalog proved sign-in",
        }),
    });
    const [snapshot] = await registry.snapshots(context, { harnessId: "message", detail: true });
    assert.equal(snapshot?.availability.authenticated, true);
    assert.equal(snapshot?.availability.message, "catalog proved sign-in");
    assert.equal(snapshot?.message, "catalog proved sign-in");
});

test("a failed detail sign-in check overrides an earlier authenticated probe", async () => {
    const registry = createHarnessRegistry();
    registry.register({
        ...provider("signed-out", 0),
        discover: async () => { throw new Error("Please sign in to view models"); },
    });
    const [snapshot] = await registry.snapshots(context, { detail: true });
    assert.equal(snapshot?.availability.state, "auth-required");
    assert.equal(snapshot?.availability.authenticated, false);
    await assert.rejects(registry.resolve(context, { mode: "pinned", harnessId: "signed-out" }), {
        code: "runtime-unavailable",
    });
});

test("an explicit auth-required state is never executable even with conflicting probe fields", async () => {
    const registry = createHarnessRegistry();
    registry.register({
        ...provider("signed-out", 0),
        probe: async () => ({
            harnessId: "signed-out", installed: true, healthy: true,
            authenticated: true, state: "auth-required",
        }),
    });
    await assert.rejects(registry.resolve(context, { mode: "pinned", harnessId: "signed-out" }), {
        code: "runtime-unavailable",
    });
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
test("registry and runtime always suppress harness-native subagents", async () => {
    const registry = createHarnessRegistry();
    registry.register({
        descriptor: { id: "native-agents", name: "native-agents", integration: "test", priority: 0 },
        staticFeatures: { subagents: true } as any,
        probe: async () => ({ harnessId: "native-agents", installed: true, authenticated: true, healthy: true }),
        discover: async () => ({
            capabilities: { subagents: true } as any,
            catalog: {
                agents: [
                    { name: "worker", mode: "subagent" as const },
                    { name: "primary", mode: "primary" as const },
                ],
            },
        }),
        createRuntime: async () => ({
            dispose: async () => {},
            capabilities: async () => ({ subagents: true } as any),
            agents: async () => [
                { name: "worker", mode: "subagent" as const },
                { name: "primary", mode: "primary" as const },
            ],
        } as AgentRuntime),
    });
    const snapshot = (await registry.snapshots(context, { detail: true }))[0]!;
    assert.equal(snapshot.capabilities?.subagents, false);
    assert.deepEqual(snapshot.catalog?.agents?.map((agent) => agent.name), ["primary"]);

    const pool = createHarnessPool({
        registry,
        legacyHarnessId: "native-agents",
        context: async (projectId, cwd, sessionId) => ({ ...context, projectId, cwd: cwd!, sessionId }),
    });
    const runtime = await pool.forSession({
        id: "s", projectId: "p", title: "s", createdAt: 0, updatedAt: 0, status: "idle",
        resolvedHarnessId: "native-agents",
    } as SessionProjection, "/tmp");
    assert.equal((await runtime.capabilities()).subagents, false);
    assert.deepEqual((await runtime.agents()).map((agent) => agent.name), ["primary"]);
    await pool.dispose();
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
test("project utility runtimes honor an explicit harness", async () => {
    const r = createHarnessRegistry();
    r.register(provider("auto", 0));
    r.register(provider("selected", 1));
    const pool = createHarnessPool({ registry: r, legacyHarnessId: "auto", context: async (projectId, cwd) => ({ ...context, projectId, cwd: cwd! }) });
    assert.equal((await pool.forProject("p", "/tmp")).harnessId, "auto");
    assert.equal((await pool.forProject("p", "/tmp", "selected")).harnessId, "selected");
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

test("provider unregister is fenced while a canonical runtime lease still exists", async () => {
    const registry = createHarnessRegistry();
    const registration = registry.register(provider("leased", 0));
    const pool = createHarnessPool({
        registry,
        legacyHarnessId: "leased",
        context: async (projectId, cwd, sessionId) => ({ ...context, projectId, cwd: cwd!, sessionId }),
    });
    const projection = {
        id: "s", projectId: "p", title: "s", createdAt: 0, updatedAt: 0, status: "idle",
        resolvedHarnessId: "leased",
    } as SessionProjection;
    const runtime = await pool.forSession(projection, "/tmp");
    await assert.rejects(Promise.resolve(registration.dispose()), { code: "conflict" });
    assert.equal(registry.get("leased")?.descriptor.id, "leased");
    assert.equal(await pool.forSession(projection, "/tmp"), runtime);

    await pool.retireSession("s");
    await registration.dispose();
    assert.equal(registry.get("leased"), undefined);
    await pool.dispose();
});

test("provider removal during an asynchronous probe cannot launch a runtime", async () => {
    const registry = createHarnessRegistry();
    let finishProbe!: () => void;
    let probeStarted!: () => void;
    const started = new Promise<void>((resolve) => { probeStarted = resolve; });
    const gate = new Promise<void>((resolve) => { finishProbe = resolve; });
    let launches = 0;
    const registration = registry.register({
        ...provider("pending", 0),
        async probe() {
            probeStarted();
            await gate;
            return { harnessId: "pending", installed: true, authenticated: true, healthy: true };
        },
        async createRuntime() {
            launches += 1;
            return { dispose: async () => {} } as AgentRuntime;
        },
    });
    const pool = createHarnessPool({
        registry, legacyHarnessId: "pending",
        context: async (projectId, cwd) => ({ ...context, projectId, cwd: cwd! }),
    });
    const lookup = pool.forProject("p", "/tmp", "pending");
    const rejected = assert.rejects(lookup, { code: "runtime-unavailable" });
    await started;
    await registration.dispose();
    finishProbe();
    await rejected;
    assert.equal(launches, 0);
    await pool.dispose();
});

test("provider unregister remains fenced throughout runtime retirement", async () => {
    const registry = createHarnessRegistry();
    let finishDisposal!: () => void;
    let disposalStarted!: () => void;
    const started = new Promise<void>((resolve) => { disposalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { finishDisposal = resolve; });
    const registration = registry.register({
        ...provider("retiring", 0),
        createRuntime: async () => ({ dispose: async () => { disposalStarted(); await gate; } } as AgentRuntime),
    });
    const pool = createHarnessPool({
        registry, legacyHarnessId: "retiring",
        context: async (projectId, cwd, sessionId) => ({ ...context, projectId, cwd: cwd!, sessionId }),
    });
    await pool.forSession({ id: "s", projectId: "p", resolvedHarnessId: "retiring" } as SessionProjection, "/tmp");
    const retiring = pool.retireSession("s");
    await started;
    try {
        await assert.rejects(pool.forSession({ id: "s", projectId: "p", resolvedHarnessId: "retiring" } as SessionProjection, "/new"), {
            code: "runtime-unavailable",
        });
        await assert.rejects(Promise.resolve(registration.dispose()), { code: "conflict" });
    } finally {
        finishDisposal();
        await retiring;
        await pool.dispose();
    }
    await registration.dispose();
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

test("retiring a per-session runtime disposes it once and a new cwd gets a fresh runtime", async () => {
    let created = 0;
    const disposed: number[] = [];
    const r = createHarnessRegistry();
    r.register({
        descriptor: { id: "native", name: "native", priority: 0, integration: "test" },
        probe: async () => ({ harnessId: "native", installed: true, authenticated: true, healthy: true }),
        createRuntime: async () => {
            const id = ++created;
            return { dispose: async () => { disposed.push(id); } } as AgentRuntime;
        },
    });
    const pool = createHarnessPool({
        registry: r,
        legacyHarnessId: "native",
        context: async (projectId, cwd, sessionId) => ({ ...context, projectId, sessionId, cwd: cwd!, spaceId: projectId }),
    });
    const projection = { id: "s", projectId: "p", title: "s", createdAt: 0, updatedAt: 0, status: "idle" } as SessionProjection;
    const old = await pool.forSession(projection, "/old");
    await pool.retireSession("s");
    assert.deepEqual(disposed, [1]);
    const fresh = await pool.forSession(projection, "/new");
    assert.notEqual(fresh, old);
    assert.equal(created, 2);
    await pool.dispose();
    assert.deepEqual(disposed, [1, 2]);
});

test("retiring one lease never disposes a shared workspace runtime", async () => {
    let disposals = 0;
    const shared = { dispose: async () => { disposals += 1; } } as AgentRuntime;
    const r = createHarnessRegistry();
    r.register({
        descriptor: { id: "shared", name: "shared", priority: 0, integration: "test" },
        runtimeLifetime: "workspace",
        probe: async () => ({ harnessId: "shared", installed: true, authenticated: true, healthy: true }),
        createRuntime: async () => shared,
    });
    const pool = createHarnessPool({
        registry: r,
        legacyHarnessId: "shared",
        context: async (projectId, cwd, sessionId) => ({ ...context, projectId, sessionId, cwd: cwd!, spaceId: projectId }),
    });
    const projection = (id: string) => ({ id, projectId: "p", title: id, createdAt: 0, updatedAt: 0, status: "idle" }) as SessionProjection;
    await Promise.all([pool.forSession(projection("s1"), "/same"), pool.forSession(projection("s2"), "/same")]);
    await pool.retireSession("s1");
    assert.equal(disposals, 0);
    assert.equal(await pool.forSession(projection("s2"), "/same"), shared);
    await pool.retireSession("s2");
    assert.equal(disposals, 0);
    await pool.dispose();
    assert.equal(disposals, 0);
});

test("retiring a session does not await an unrelated pending factory", async () => {
    let releasePending!: (runtime: AgentRuntime) => void;
    const pending = new Promise<AgentRuntime>((resolve) => { releasePending = resolve; });
    const disposed: string[] = [];
    const r = createHarnessRegistry();
    r.register({
        descriptor: { id: "native", name: "native", priority: 0, integration: "test" },
        probe: async () => ({ harnessId: "native", installed: true, authenticated: true, healthy: true }),
        createRuntime: async (context) => context.sessionId === "hung"
            ? pending
            : ({ dispose: async () => { disposed.push(context.sessionId!); } } as AgentRuntime),
    });
    const pool = createHarnessPool({
        registry: r,
        legacyHarnessId: "native",
        context: async (projectId, cwd, sessionId) => ({ ...context, projectId, sessionId, cwd: cwd!, spaceId: projectId }),
    });
    const projection = (id: string) => ({ id, projectId: "p", title: id, createdAt: 0, updatedAt: 0, status: "idle" }) as SessionProjection;
    void pool.forSession(projection("hung"), "/hung");
    await pool.forSession(projection("ready"), "/ready");
    await pool.retireSession("ready");
    assert.deepEqual(disposed, ["ready"]);
    releasePending({ dispose: async () => {} } as AgentRuntime);
    await pool.retireSession("hung");
});

test("failed per-session disposal remains retryable", async () => {
    let attempts = 0;
    const r = createHarnessRegistry();
    r.register({
        descriptor: { id: "native", name: "native", priority: 0, integration: "test" },
        probe: async () => ({ harnessId: "native", installed: true, authenticated: true, healthy: true }),
        createRuntime: async () => ({
            dispose: async () => {
                attempts += 1;
                if (attempts === 1) throw new Error("injected disposal failure");
            },
        }) as AgentRuntime,
    });
    const pool = createHarnessPool({
        registry: r,
        legacyHarnessId: "native",
        context: async (projectId, cwd, sessionId) => ({ ...context, projectId, sessionId, cwd: cwd!, spaceId: projectId }),
    });
    const projection = { id: "s", projectId: "p", title: "s", createdAt: 0, updatedAt: 0, status: "idle" } as SessionProjection;
    await pool.forSession(projection, "/old");
    await assert.rejects(() => pool.retireSession("s"), /injected disposal failure/);
    await assert.rejects(pool.forSession(projection, "/new"), { code: "runtime-unavailable" });
    await pool.retireSession("s");
    assert.equal(attempts, 2);
});

test("one runtime facade cannot be reused across workspace locations", async () => {
    const shared = { dispose: async () => {} } as AgentRuntime;
    const r = createHarnessRegistry();
    r.register({
        descriptor: { id: "shared", name: "shared", priority: 0, integration: "test" },
        runtimeLifetime: "workspace",
        probe: async () => ({ harnessId: "shared", installed: true, authenticated: true, healthy: true }),
        createRuntime: async () => shared,
    });
    const pool = createHarnessPool({
        registry: r,
        legacyHarnessId: "shared",
        context: async (projectId, cwd, sessionId) => ({ ...context, projectId, sessionId, cwd: cwd!, spaceId: projectId }),
    });
    const projection = (id: string) => ({ id, projectId: "p", title: id, createdAt: 0, updatedAt: 0, status: "idle" }) as SessionProjection;
    await pool.forSession(projection("s1"), "/one");
    await assert.rejects(
        () => pool.forSession(projection("s2"), "/two"),
        /reused one runtime facade across workspace locations/,
    );
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

test("a native readiness check answers for a cheap unknown probe of the same install", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const registry = createHarnessRegistry();
    let version = "1.0.0";
    let discoveries = 0;
    registry.register({
        descriptor: { id: "native", name: "Native", integration: "test", priority: 0 },
        probe: async () => ({
            harnessId: "native", installed: true, healthy: true, authenticated: "unknown" as const,
            state: "unknown" as const, version, message: "The cheap probe cannot see sign-in",
        }),
        discover: async () => {
            discoveries += 1;
            return { state: "ready" as const, authenticated: true };
        },
        createRuntime: async () => ({ dispose: async () => { } } as AgentRuntime),
    });
    assert.equal((await registry.snapshots(context))[0]?.availability.state, "unknown");
    const [verified] = await registry.snapshots(context, { harnessId: "native", detail: true, verify: true });
    assert.equal(verified?.availability.state, "ready");
    assert.equal(discoveries, 1);

    // The listing's own cache expired: a cheap probe runs again and still
    // cannot see sign-in, but the check of this exact version answers.
    t.mock.timers.tick(20_000);
    const [listed] = await registry.snapshots(context);
    assert.equal(listed?.availability.state, "ready");
    assert.equal(listed?.availability.authenticated, true);
    assert.equal(listed?.message, undefined, "the probe's note about its unknown answer no longer applies");
    assert.equal(discoveries, 1, "listing never starts native discovery");

    // Carried evidence is presentation only: execution still checks natively.
    assert.equal((await registry.resolve(context, { mode: "pinned", harnessId: "native" })).descriptor.id, "native");
    assert.equal(discoveries, 2);

    // An update to the CLI is a new install: its readiness is unknown again.
    version = "1.1.0";
    t.mock.timers.tick(20_000);
    assert.equal((await registry.snapshots(context))[0]?.availability.state, "unknown");

    // The evidence lasts only as long as the detail trust window.
    version = "1.0.0";
    await registry.snapshots(context, { harnessId: "native", detail: true, verify: true, force: true });
    t.mock.timers.tick(5 * 60_000 + 1);
    assert.equal((await registry.snapshots(context))[0]?.availability.state, "unknown");
});

test("a forced recheck drops carried readiness and negative checks carry too", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const registry = createHarnessRegistry();
    let signedIn = false;
    registry.register({
        descriptor: { id: "native", name: "Native", integration: "test", priority: 0 },
        probe: async () => ({ harnessId: "native", installed: true, healthy: true, authenticated: "unknown" as const, state: "unknown" as const, version: "2" }),
        discover: async () => signedIn
            ? { state: "ready" as const, authenticated: true }
            : { state: "auth-required" as const, authenticated: false, message: "Sign in to Native" },
        createRuntime: async () => ({ dispose: async () => { } } as AgentRuntime),
    });
    await registry.snapshots(context, { harnessId: "native", detail: true, verify: true });
    t.mock.timers.tick(20_000);
    const [signedOut] = await registry.snapshots(context);
    assert.equal(signedOut?.availability.state, "auth-required");
    assert.equal(signedOut?.availability.authenticated, false);
    assert.equal(signedOut?.message, "Sign in to Native");

    signedIn = true;
    const [forced] = await registry.snapshots(context, { force: true });
    assert.equal(forced?.availability.state, "unknown", "Check again asks the cheap probe afresh");
    const [rechecked] = await registry.snapshots(context, { harnessId: "native", detail: true, verify: true });
    assert.equal(rechecked?.availability.state, "ready");
});

test("a failed native check revokes carried readiness", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const registry = createHarnessRegistry();
    let broken = false;
    registry.register({
        descriptor: { id: "native", name: "Native", integration: "test", priority: 0 },
        probe: async () => ({ harnessId: "native", installed: true, healthy: true, authenticated: "unknown" as const, state: "unknown" as const }),
        discover: async () => {
            if (broken) throw new Error("model listing timed out");
            return { state: "ready" as const, authenticated: true };
        },
        createRuntime: async () => ({ dispose: async () => { } } as AgentRuntime),
    });
    await registry.snapshots(context, { harnessId: "native", detail: true, verify: true });
    t.mock.timers.tick(20_000);
    assert.equal((await registry.snapshots(context))[0]?.availability.state, "ready");

    broken = true;
    t.mock.timers.tick(20_000);
    await assert.rejects(registry.resolve(context, { mode: "pinned", harnessId: "native" }), { code: "runtime-unavailable" });
    t.mock.timers.tick(20_000);
    assert.equal((await registry.snapshots(context))[0]?.availability.state, "unknown", "the failed check is the latest answer");
});

test("a verifying detail read waits for the native answer instead of the last-known catalog", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const registry = createHarnessRegistry();
    let signedIn = true;
    registry.register({
        descriptor: { id: "catalog", name: "Catalog", integration: "test", priority: 0 },
        probe: async () => ({ harnessId: "catalog", installed: true, healthy: true, authenticated: "unknown" as const, state: "unknown" as const }),
        discover: async () => signedIn
            ? { state: "ready" as const, authenticated: true, catalog: { models: [{ providerID: "p", modelID: "m", name: "Model" }] } }
            : { state: "auth-required" as const, authenticated: false },
        createRuntime: async () => ({ dispose: async () => { } } as AgentRuntime),
    });
    await registry.snapshots(context, { harnessId: "catalog", detail: true });
    signedIn = false;
    t.mock.timers.tick(5 * 60_000 + 1);
    const [verified] = await registry.snapshots(context, { harnessId: "catalog", detail: true, verify: true });
    assert.equal(verified?.stale, undefined);
    assert.equal(verified?.availability.state, "auth-required");
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


test("physical acquisition evidence belongs to the exact session lease", async () => {
    const registry = createHarnessRegistry();
    const runtime = { dispose: async () => {} } as AgentRuntime;
    registry.register({ ...provider("shared-timing", 0), runtimeLifetime: "workspace", createRuntime: async () => runtime });
    const pool = createHarnessPool({
        registry, legacyHarnessId: "shared-timing",
        context: async (projectId, cwd, sessionId) => ({ ...context, projectId, cwd: cwd!, sessionId }),
        acquisitionInfo: (_provider, context) => context.sessionId === "cold"
            ? { warmRuntimeHit: false, runtimeSpawnMs: 25 }
            : { warmRuntimeHit: true },
    });
    const projection = { projectId: "p", resolvedHarnessId: "shared-timing" } as SessionProjection;
    await pool.forSession({ ...projection, id: "cold" }, "/source");
    await pool.forSession({ ...projection, id: "warm" }, "/source");
    assert.deepEqual(pool.acquisitionInfo(runtime, "cold"), { warmRuntimeHit: false, runtimeSpawnMs: 25 });
    assert.deepEqual(pool.acquisitionInfo(runtime, "warm"), { warmRuntimeHit: true });
    const snapshot = pool.acquisitionInfo(runtime, "cold")!;
    snapshot.warmRuntimeHit = true;
    assert.equal(pool.acquisitionInfo(runtime, "cold")?.warmRuntimeHit, false);
    assert.equal(pool.acquisitionInfo(runtime, "unknown"), undefined);
    pool.forgetSession("cold");
    assert.equal(pool.acquisitionInfo(runtime, "cold"), undefined);
    await pool.dispose();
});

test("failed acquisition telemetry cannot change a successful runtime factory", async () => {
    const registry = createHarnessRegistry();
    registry.register(provider("new-runtime", 0));
    const pool = createHarnessPool({
        registry, legacyHarnessId: "new-runtime",
        context: async (projectId, cwd, sessionId) => ({ ...context, projectId, cwd: cwd!, sessionId }),
        acquisitionInfo: () => { throw new Error("observer failed"); },
    });
    const runtime = await pool.forSession({ id: "s", projectId: "p", resolvedHarnessId: "new-runtime" } as SessionProjection, "/source");
    assert.deepEqual(pool.acquisitionInfo(runtime, "s"), { warmRuntimeHit: false });
    await pool.dispose();
});

test("a canonical lease protects native startup while a catalog lease permits idle cleanup", async () => {
    const registry = createHarnessRegistry();
    let disposals = 0;
    const runtime = { dispose: async () => { disposals += 1; } } as AgentRuntime;
    registry.register({ ...provider("workspace", 0), runtimeLifetime: "workspace", createRuntime: async () => runtime });
    const pool = createHarnessPool({ registry, legacyHarnessId: "workspace", context: async (projectId, cwd, sessionId) => ({ ...context, projectId, cwd: cwd!, sessionId }) });
    await pool.forProject("p", "/source", "workspace");
    assert.equal(pool.hasSessionLease(runtime), false);
    await pool.forSession({ id: "child", projectId: "p", resolvedHarnessId: "workspace" } as SessionProjection, "/source");
    assert.equal(pool.hasSessionLease(runtime), true, "native creation has not wired an event subscription yet");
    await pool.retireSession("child");
    assert.equal(pool.hasSessionLease(runtime), false);
    assert.equal(disposals, 0, "retiring a workspace lease does not destroy the shared physical owner");
    await pool.dispose();
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
test("liveSessionIds names only this Space's canonical leases on one harness", async () => {
    const r = createHarnessRegistry();
    r.register(provider("a", 0));
    r.register(provider("b", 1));
    const pool = createHarnessPool({ registry: r, legacyHarnessId: "a", context: async (projectId, cwd, sessionId) => ({ ...context, projectId, sessionId, cwd: cwd!, spaceId: projectId }) });
    const session = (id: string, projectId: string, harnessId: string) =>
        ({ id, projectId, title: id, createdAt: 0, updatedAt: 0, status: "idle", resolvedHarnessId: harnessId }) as SessionProjection;
    await pool.forSession(session("s1", "space-1", "a"), "/tmp");
    await pool.forSession(session("s2", "space-1", "b"), "/tmp");
    await pool.forSession(session("s3", "space-2", "a"), "/tmp");
    await pool.forProject("space-1", "/tmp", "a");
    assert.deepEqual(pool.liveSessionIds("space-1", "a"), ["s1"]);
    assert.deepEqual(pool.liveSessionIds("space-2", "a"), ["s3"]);
    await pool.dispose();
});
test("a pinned harness that cannot be selected says why, not just that it is unavailable", async () => {
    const stuck = createHarnessRegistry();
    stuck.register({
        ...provider("stuck", 0),
        probe: async () => ({ harnessId: "stuck", installed: true, authenticated: "unknown" as const, healthy: true, state: "unknown" as const }),
        discover: async () => { throw new Error("runtime was not ready within 20000ms"); },
    });
    await assert.rejects(stuck.resolve(context, { mode: "pinned", harnessId: "stuck" }), {
        code: "runtime-unavailable",
        message: "Selected harness stuck is unavailable (runtime was not ready within 20000ms)",
    });
    const gone = createHarnessRegistry();
    gone.register({
        ...provider("gone", 0),
        probe: async () => ({ harnessId: "gone", installed: false, authenticated: "unknown" as const, healthy: false, message: "Install gone to enable this harness" }),
    });
    await assert.rejects(gone.resolve(context, { mode: "pinned", harnessId: "gone" }), {
        message: "Selected harness gone is unavailable (Install gone to enable this harness)",
    });
});

test("retiring a workspace disposes only its project-scoped utility runtimes", async () => {
    const registry = createHarnessRegistry();
    const disposed: string[] = [];
    registry.register({
        ...provider("utility", 0),
        createRuntime: async (ctx) => ({
            dispose: async () => { disposed.push(`${ctx.cwd}:${ctx.sessionId ?? ""}`); },
        } as AgentRuntime),
    });
    const pool = createHarnessPool({
        registry,
        legacyHarnessId: "utility",
        context: async (projectId, cwd, sessionId) => ({ ...context, projectId, cwd: cwd!, sessionId }),
    });
    const projection = {
        id: "s", projectId: "p", title: "s", createdAt: 0, updatedAt: 0, status: "idle",
        resolvedHarnessId: "utility",
    } as SessionProjection;
    const gone = await pool.forProject("p", "/work/isolate");
    const kept = await pool.forProject("p", "/work/main");
    const session = await pool.forSession(projection, "/work/isolate");
    await pool.retireWorkspace("/work/isolate/");
    assert.deepEqual(disposed, ["/work/isolate:"]);
    assert.notEqual(await pool.forProject("p", "/work/isolate"), gone, "a later utility call starts a fresh runtime");
    assert.equal(await pool.forProject("p", "/work/main"), kept);
    assert.equal(await pool.forSession(projection, "/work/isolate"), session, "canonical session leases stay with the session lifecycle");
    await pool.dispose();
});
