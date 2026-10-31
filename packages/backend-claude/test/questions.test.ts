import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { RuntimeEvent } from "@polyth/contracts";
import type { createProcessAuthority } from "@polyth/harness-runtime";
import { createClaudeRuntime } from "../src/index.ts";
import { CLAUDE_QUESTION_DISMISSED, claudeQuestionAnswers, claudeQuestionItems, parseClaudeQuestions } from "../src/questions.ts";

const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };
const input = {
    questions: [
        { question: "Which approach?", header: "Approach", multiSelect: false, options: [
            { label: "Commit (Recommended)", description: "I commit, you merge" },
            { label: "Restart", description: "Restart the live server" },
        ] },
        { question: "Which checks?", header: "Checks", multiSelect: true, options: [
            { label: "Unit", description: "Focused tests" },
            { label: "Build", description: "Web build" },
        ] },
    ],
};

test("AskUserQuestion input becomes Polyth question items with write-in answers", () => {
    const parsed = parseClaudeQuestions(input)!;
    assert.deepEqual(claudeQuestionItems(parsed), [
        { id: "q1", title: "Approach", prompt: "Which approach?", type: "single", options: [
            { value: "Commit (Recommended)", label: "Commit (Recommended)", description: "I commit, you merge" },
            { value: "Restart", label: "Restart", description: "Restart the live server" },
        ], allowOther: true, required: true },
        { id: "q2", title: "Checks", prompt: "Which checks?", type: "multi", options: [
            { value: "Unit", label: "Unit", description: "Focused tests" },
            { value: "Build", label: "Build", description: "Web build" },
        ], allowOther: true, required: true },
    ]);
    assert.equal(parseClaudeQuestions({}), undefined);
    assert.equal(parseClaudeQuestions({ questions: [{ header: "no prompt" }] }), undefined);
});

test("Polyth answers map to the tool's question-text answers", () => {
    const parsed = parseClaudeQuestions(input)!;
    assert.deepEqual(claudeQuestionAnswers(parsed, { answers: [["Restart"], ["Unit", "Build"]] }), {
        "Which approach?": "Restart",
        "Which checks?": "Unit, Build",
    });
    // A write-in answer passes through; an empty row stays unanswered.
    assert.deepEqual(claudeQuestionAnswers(parsed, { answers: [["Something else "], []] }), {
        "Which approach?": "Something else",
    });
});

const fakeSdk = () => {
    let options: any;
    let prompt: AsyncIterator<any>;
    let push: (message: any) => void = () => {};
    let closed = false;
    const sdk = { query(args: any) {
        options = args.options;
        prompt = args.prompt[Symbol.asyncIterator]();
        const pending: any[] = [];
        let wake: (() => void) | undefined;
        push = (message) => { pending.push(message); wake?.(); };
        return { async *[Symbol.asyncIterator]() { while (!closed) {
            if (!pending.length) await new Promise<void>((resolve) => wake = resolve);
            while (pending.length) yield pending.shift();
        } }, initializationResult: async () => ({}), supportedModels: async () => [], setModel: async () => {}, interrupt: async () => {}, close() { closed = true; wake?.(); } } as any;
    }, getSessionInfo: async () => undefined, getSessionMessages: async () => [] };
    return { sdk, options: () => options, prompt: () => prompt, push: (message: any) => push(message) };
};

test("Claude asks AskUserQuestion through Polyth and waits for the answer instead of approving it empty", async () => {
    const fake = fakeSdk();
    const receipts: Record<string, string> = {};
    const authority = { authorityId: "owned", generation: 1, receipts, releasedAuthorities: [], spawn() { throw new Error("SDK fake does not spawn"); }, receipt: async (op: string, id: string) => { receipts[op] = id; }, close: async () => {} } as Awaited<ReturnType<typeof createProcessAuthority>>;
    const rt = await createClaudeRuntime(context, fake.sdk, authority);
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    assert.equal((await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, randomUUID())).kind, "confirmed");
    assert.equal((await rt.capabilities()).questions, true);

    const op = randomUUID();
    const admission = rt.startTurnOperation!({ sessionId: "canonical", text: "ask me" }, op);
    await fake.prompt().next();
    fake.push({ type: "assistant", uuid: randomUUID(), parent_tool_use_id: null, message: { content: [{ type: "text", text: "one question" }] } });
    assert.equal((await admission).kind, "confirmed");

    // Answered: the tool receives the answers, never a bare approval.
    let settled = false;
    const answered = fake.options().canUseTool("AskUserQuestion", input, { signal: new AbortController().signal, toolUseID: "toolu_q1" })
        .then((result: any) => { settled = true; return result; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "the tool waits for the user");
    const asked = events.find((event) => event.type === "question/asked");
    assert.ok(asked && asked.type === "question/asked");
    assert.equal(asked.requestId, "toolu_q1");
    assert.equal(asked.questions.length, 2);
    assert.equal(events.some((event) => event.type === "permission/requested"), false, "a question is not a permission");
    const endpoint = await rt.endpoint!();
    const binding = { ...endpoint, canonicalSessionId: "canonical", backendSessionId: Object.values(receipts)[0]! };
    assert.deepEqual((await rt.reconcile!(binding)).questions.map((question) => question.requestId), ["toolu_q1"]);
    assert.equal((await rt.replyQuestionOperation!("canonical", "toolu_q1", { answers: [["Restart"], ["Unit", "Build"]] }, "reply-1")).kind, "confirmed");
    const result = await answered;
    assert.equal(result.behavior, "allow");
    assert.deepEqual(result.updatedInput.answers, { "Which approach?": "Restart", "Which checks?": "Unit, Build" });
    assert.deepEqual(result.updatedInput.questions, input.questions);
    assert.deepEqual((await rt.reconcile!(binding)).questions, []);
    const again = await rt.replyQuestionOperation!("canonical", "toolu_q1", { answers: [["Restart"]] }, "reply-2");
    assert.equal(again.kind, "rejected");

    // Dismissed: the model is told no answer was given.
    const dismissed = fake.options().canUseTool("AskUserQuestion", input, { signal: new AbortController().signal, toolUseID: "toolu_q2" });
    await rt.replyQuestion("canonical", "toolu_q2", { action: "reject" });
    assert.deepEqual(await dismissed, { behavior: "deny", message: CLAUDE_QUESTION_DISMISSED });

    // Interrupted: the pending question is released with the turn.
    const abort = new AbortController();
    const interrupted = fake.options().canUseTool("AskUserQuestion", input, { signal: abort.signal, toolUseID: "toolu_q3" });
    abort.abort();
    assert.equal((await interrupted).behavior, "deny");
    assert.deepEqual((await rt.reconcile!(binding)).questions, []);

    // An unreadable call is refused rather than approved empty.
    assert.equal((await fake.options().canUseTool("AskUserQuestion", { questions: [] }, { signal: new AbortController().signal, toolUseID: "toolu_q4" })).behavior, "deny");

    fake.push({ type: "result", is_error: false });
    await new Promise((resolve) => setImmediate(resolve));
    await rt.dispose();
});
