import assert from "node:assert/strict";
import { test } from "node:test";
import { createCodexRuntime } from "../src/index.ts";
import { fakeRpc } from "../../harness-runtime/test/rpcPeer.ts";
import type { RuntimeEvent } from "@polyth/contracts";
const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };
const binding = { canonicalSessionId: "canonical", backendSessionId: "native", authorityId: "authority", generation: 1, continuity: "verified" as const, location: { directory: "/tmp" } };
test("Codex uses native thread ids and turn receipts, reconciles stable observations, and excludes reasoning", async () => {
    const f = fakeRpc();
    let turnItems: any[] = [];
    f.handle(async (method, params) => {
        if (method === "thread/start")
            return { thread: { id: "native" } };
        if (method === "turn/start") {
            turnItems = [{ type: "userMessage", id: "u", clientId: params.clientUserMessageId }, { type: "reasoning", id: "private", text: "scratch" }, { type: "agentMessage", id: "a", text: "done" }];
            return { turn: { id: "t" } };
        }
        if (method === "thread/read")
            return { thread: { id: "native", status: { type: "idle" }, historyMode: "legacy", turns: [{ id: "t", status: "completed", itemsView: "full", items: turnItems }] } };
        return {};
    });
    const rt = await createCodexRuntime(context, f.rpc);
    assert.equal((await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create")).kind, "confirmed");
    assert.equal(f.rpc.receipts.create, "native");
    assert.equal((await rt.startTurnOperation!({ sessionId: "canonical", text: "task" }, "submit")).kind, "confirmed");
    const snapshot = await rt.reconcile!({ ...binding, reconciliationOrdinal: 9 });
    assert.equal(snapshot.acceptedOperations?.[0]?.operationId, "submit");
    assert.equal(snapshot.completeness.events, "complete");
    assert.doesNotMatch(JSON.stringify(snapshot), /scratch/);
    const events: RuntimeEvent[] = [];
    rt.onObservation!((_sid, o) => { assert.equal(o.reconciliationOrdinal, 9); events.push(...o.events); });
    f.emit("item/started", { threadId: "native", item: { type: "agentMessage", id: "reply", text: "" } });
    assert.equal(events.length, 0, "an empty started item is not a finalized canonical answer");
    f.emit("item/completed", { threadId: "native", item: { type: "agentMessage", id: "reply", text: "confirmed answer" } });
    assert.equal(events.length, 1);
    f.emit("item/completed", { threadId: "native", item: { type: "fileChange", id: "file", status: "failed" } });
    assert.match(JSON.stringify(events), /not confirmed/);
    assert.equal(events.find(event => "callId" in event && event.callId === "file")?.type, "tool/error");
    const approval = f.request("item/commandExecution/requestApproval", { threadId: "native", itemId: "tool", command: "git status" });
    assert.ok(events.some(e => e.type === "permission/requested"));
    await rt.replyPermission("canonical", "tool", "once");
    assert.deepEqual(await approval, { decision: "accept" });
    assert.equal((await rt.releaseExecution!(binding, "switch")).kind, "confirmed");
});
test("Codex transport loss and partial histories remain uncertain, and unsupported attachments are rejected", async () => {
    const f = fakeRpc();
    f.handle(async (method) => {
        if (method === "thread/start")
            throw Object.assign(new Error("response lost"), { code: "outcome-unknown" });
        if (method === "thread/read")
            return { thread: { id: "native", status: { type: "systemError" }, historyMode: "paginated", turns: [{ id: "t", status: "completed", itemsView: "summary", items: [] }] } };
        return {};
    });
    const rt = await createCodexRuntime(context, f.rpc);
    assert.equal((await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create")).kind, "unknown");
    assert.deepEqual(await rt.sessions(), []);
    const snapshot = await rt.reconcile!(binding);
    assert.equal(snapshot.state?.value, "unknown");
    assert.equal(snapshot.completeness.events, "partial");
    assert.equal((await rt.startTurnOperation!({ sessionId: "canonical", text: "x", attachments: [{} as never] }, "turn")).kind, "rejected");
    assert.equal((await rt.releaseExecution!({ ...binding, generation: 2 }, "switch")).kind, "unknown");
});
