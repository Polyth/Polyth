import assert from "node:assert/strict";
import { test } from "node:test";
import { createAcpRuntime } from "../../backend-acp/src/index.ts";
import { configureAcpClientRequestHandling } from "../../backend-acp/src/profile.ts";
import { fakeRpc } from "../../harness-runtime/test/rpcPeer.ts";
import { cursorClientRequest } from "../src/serverEntry.ts";

const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };

test("Cursor blocking client requests cannot strand a follow-up turn", async () => {
    const f = fakeRpc();
    configureAcpClientRequestHandling(f.rpc, cursorClientRequest);
    const prompts: string[] = [];
    f.handle(async (method, params) => {
        if (method === "session/new") return { sessionId: "native" };
        if (method === "session/prompt") {
            prompts.push(params.prompt[0]?.text ?? "");
            if (prompts.length === 1) {
                assert.deepEqual(await f.request("cursor/create_plan", { toolCallId: "plan" }), {
                    outcome: { outcome: "cancelled" },
                });
                assert.deepEqual(await f.request("cursor/ask_question", { toolCallId: "question" }), {
                    outcome: {
                        outcome: "skipped",
                        reason: "Interactive Cursor questions are not exposed by Polyth",
                    },
                });
            }
            return { stopReason: "end_turn" };
        }
        return {};
    });

    const rt = createAcpRuntime(context, f.rpc, "cursor");
    await rt.createSessionOperation!(
        { projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" },
        "create",
    );
    assert.equal((await rt.startTurnOperation!(
        { sessionId: "canonical", text: "first" },
        "first",
    )).kind, "confirmed");
    assert.equal((await rt.startTurnOperation!(
        { sessionId: "canonical", text: "follow up" },
        "follow-up",
    )).kind, "confirmed");
    assert.deepEqual(prompts, ["first", "follow up"]);
    await rt.dispose();
});

test("Cursor client request handling leaves standard ACP requests untouched", () => {
    assert.deepEqual(cursorClientRequest("session/request_permission"), { handled: false });
});
