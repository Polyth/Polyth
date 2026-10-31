import assert from "node:assert/strict";
import { test } from "node:test";
import { createCodexRuntime } from "../src/index.ts";
import { fakeRpc } from "../../harness-runtime/test/rpcPeer.ts";

const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };
const binding = { canonicalSessionId: "canonical", backendSessionId: "native", authorityId: "authority", generation: 1, continuity: "generation-only" as const, location: { directory: "/tmp" } };

/** Codex 0.163 answers an ephemeral thread like this (live App Server probe):
 *  no turn listing, no rollout to resume. */
const ephemeralAppServer = () => {
    const f = fakeRpc();
    f.handle(async (method, params) => {
        if (method === "thread/start") return { thread: { id: "native", ephemeral: params.ephemeral === true } };
        if (method === "thread/read" && params.includeTurns) throw new Error("ephemeral threads do not support includeTurns");
        if (method === "thread/read") return { thread: { id: "native", ephemeral: true, status: { type: "idle" }, historyMode: "paginated", turns: [] } };
        if (method === "thread/resume") throw new Error("no rollout found for thread id native");
        return {};
    });
    return f;
};

test("a private session starts an ephemeral Codex thread that Polyth never expects to reattach", async () => {
    const f = ephemeralAppServer();
    const rt = await createCodexRuntime({ ...context, privateSession: true }, f.rpc);
    assert.equal((await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create")).kind, "confirmed");
    assert.equal(f.calls.find((call) => call.method === "thread/start")?.params.ephemeral, true);
    // A later App Server generation cannot resume it: the binding is
    // generation-only, so a new process means a fresh thread from history.
    assert.equal((await rt.endpoint!()).continuity, "generation-only");
    await rt.dispose();
});

test("an ephemeral thread reconciles from its live status even though it lists no turns", async () => {
    const f = ephemeralAppServer();
    const rt = await createCodexRuntime({ ...context, privateSession: true }, f.rpc);
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    const snapshot = await rt.reconcile!({ ...binding, reconciliationOrdinal: 1 });
    assert.equal(snapshot.state.value, "idle");
    assert.equal(snapshot.completeness.events, "partial");
    assert.deepEqual(await rt.history("canonical"), []);
    await rt.dispose();
});

test("a private Codex thread is never resumed on a new runtime", async () => {
    const f = ephemeralAppServer();
    const rt = await createCodexRuntime({ ...context, privateSession: true }, f.rpc);
    await assert.rejects(
        rt.ensureSession({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp", backendSessionId: "native" }),
        { code: "unknown-session" },
    );
    assert.equal(f.calls.some((call) => call.method === "thread/resume"), false);
    await rt.dispose();
});

test("an ordinary session keeps a persisted, verified Codex thread", async () => {
    const f = fakeRpc();
    f.handle(async (method) => method === "thread/start" ? { thread: { id: "native" } } : {});
    const rt = await createCodexRuntime(context, f.rpc);
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    assert.equal("ephemeral" in f.calls.find((call) => call.method === "thread/start")!.params, false);
    assert.equal((await rt.endpoint!()).continuity, "verified");
    await rt.dispose();
});
