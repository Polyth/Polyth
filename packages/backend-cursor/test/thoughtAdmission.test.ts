import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeEvent } from "@polyth/contracts";
import { createAcpRuntime } from "../../backend-acp/src/index.ts";
import { fakeRpc } from "../../harness-runtime/test/rpcPeer.ts";

const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };

test("Cursor private thought admits a follow-up before visible activity without exposing reasoning", async () => {
    const f = fakeRpc();
    let finishPrompt!: (value: unknown) => void;
    f.handle(async (method) => {
        if (method === "session/new") return { sessionId: "native" };
        if (method === "session/prompt") {
            return new Promise((resolve) => { finishPrompt = resolve; });
        }
        return {};
    });

    const rt = createAcpRuntime(context, f.rpc, "cursor");
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!(
        { projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" },
        "create",
    );

    const admission = rt.startTurnOperation!(
        { sessionId: "canonical", text: "follow up" },
        "follow-up",
    );
    f.emit("session/update", {
        sessionId: "native",
        update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "private cursor reasoning" },
        },
    });

    assert.equal((await admission).kind, "confirmed");
    assert.deepEqual(events, [{ type: "turn/started", turnId: "follow-up" }]);
    assert.doesNotMatch(JSON.stringify(events), /private cursor reasoning/);

    finishPrompt({ stopReason: "end_turn" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events.filter((event) => event.type === "turn/stopped"), [{
        type: "turn/stopped",
        turnId: "follow-up",
        reason: "completed",
    }]);
    await rt.dispose();
});
