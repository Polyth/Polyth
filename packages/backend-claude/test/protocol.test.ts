import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { RuntimeEvent } from "@polyth/contracts";
import { createClaudeRuntime } from "../src/index.ts";
import type { createProcessAuthority } from "@polyth/harness-runtime";
const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };
test("Claude SDK keeps one native session over turns, exposes permissions, drops thinking, and requires owned release", async () => {
    let options: any;
    let input: AsyncIterator<any>;
    let push: (message: any) => void = () => { };
    let closed = false;
    let released = false;
    const receipts: Record<string, string> = {};
    const sdk = { query(args: any) {
            options = args.options;
            input = args.prompt[Symbol.asyncIterator]();
            const pending: any[] = [];
            let wake: (() => void) | undefined;
            push = m => { pending.push(m); wake?.(); };
            return { async *[Symbol.asyncIterator]() { while (!closed) {
                    if (!pending.length)
                        await new Promise<void>(r => wake = r);
                    while (pending.length)
                        yield pending.shift();
                } }, initializationResult: async () => ({}), supportedModels: async () => [{ value: "sonnet", displayName: "Sonnet" }], setModel: async () => { }, interrupt: async () => { }, close() { closed = true; wake?.(); } } as any;
        }, getSessionInfo: async () => undefined, getSessionMessages: async () => [] };
    const authority = { authorityId: "owned", generation: 1, receipts, releasedAuthorities: [], spawn() { throw new Error("SDK fake does not spawn"); }, receipt: async (op: string, id: string) => { receipts[op] = id; }, close: async () => { released = true; } } as Awaited<ReturnType<typeof createProcessAuthority>>;
    const rt = await createClaudeRuntime(context, sdk, authority);
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, e) => events.push(e));
    const native = await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, randomUUID());
    assert.equal(native.kind, "confirmed");
    const endpointBefore = await rt.endpoint!();
    const bindingBefore = { ...endpointBefore, canonicalSessionId: "canonical", backendSessionId: Object.values(receipts)[0]!, reconciliationOrdinal: 7 };
    await rt.reconcile!(bindingBefore);
    rt.onObservation!((_sid, observation) => { assert.equal(observation.reconciliationOrdinal, 7); events.push(...observation.events); });
    for (let turn = 0; turn < 2; turn++) {
        const op = randomUUID();
        const admission = rt.startTurnOperation!({ sessionId: "canonical", text: `task${turn}` }, op);
        assert.equal((await input!.next()).value.uuid, op);
        push({ type: "assistant", uuid: randomUUID(), parent_tool_use_id: null, message: { content: [{ type: "thinking", thinking: "private scratch" }, { type: "text", text: `answer${turn}` }] } });
        assert.equal((await admission).kind, "confirmed");
        const permission = options.canUseTool("Bash", { command: "git status" }, { signal: new AbortController().signal, toolUseID: "tool" });
        await rt.replyPermission("canonical", "tool", "once");
        assert.equal((await permission).behavior, "allow");
        push({ type: "result", is_error: false });
        await new Promise(r => setImmediate(r));
    }
    assert.equal(events.filter(e => e.type === "turn/stopped").length, 2);
    assert.doesNotMatch(JSON.stringify(events), /private scratch/);
    assert.ok(options.spawnClaudeCodeProcess);
    assert.equal(options.permissionMode, "default");
    assert.equal((await rt.capabilities()).subagents, false);
    const endpoint = await rt.endpoint!();
    const binding = { ...endpoint, canonicalSessionId: "canonical", backendSessionId: Object.values(receipts)[0]! };
    assert.equal((await rt.releaseExecution!({ ...binding, generation: 2 }, "wrong")).kind, "unknown");
    assert.equal(released, false);
    assert.equal((await rt.releaseExecution!(binding, "switch")).kind, "confirmed");
    assert.equal(released, true);
});
