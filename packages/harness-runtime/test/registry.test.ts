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
