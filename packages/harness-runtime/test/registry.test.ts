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
