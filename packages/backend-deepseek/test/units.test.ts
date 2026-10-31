import assert from "node:assert/strict";
import { test } from "node:test";
import * as zlib from "node:zlib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyDshPromptFailure, dshFailedMcpServer } from "../src/failures.ts";
import { canonicalDshModelId, dshModelIdCodec } from "../src/models.ts";
import {
    decodeLogBytes,
    dialogueRecords,
    latestPromptUsage,
    listNativeSessions,
    parseLog,
    readNativeDialogue,
    readNativeSession,
    zstdFrames,
} from "../src/nativeLog.ts";
import { ACP_PATCH, createDeepSeekProfile, SIGN_IN_SCRIPT } from "../src/serverEntry.ts";

const compress = (zlib as unknown as { zstdCompressSync?: (input: Buffer) => Buffer }).zstdCompressSync;
const zstd = { skip: compress ? false : "node:zlib has no Zstandard on this Node" };

test("model ids: the official route is the bare model id, others keep their route", () => {
    assert.equal(dshModelIdCodec.canonical('["deepseek-official","deepseek-v4-flash"]'), "deepseek-v4-flash");
    assert.equal(dshModelIdCodec.canonical('["pi-ai","openrouter/x"]'), "pi-ai/openrouter/x");
    assert.equal(dshModelIdCodec.canonical("deepseek-v4-pro"), "deepseek-v4-pro");
    assert.equal(dshModelIdCodec.canonical('["only-one"]'), '["only-one"]');
    assert.equal(canonicalDshModelId("deepseek-official", "deepseek-flash"), "deepseek-flash");
});

test("prompt failures: the wire messages dsh 0.2 sends are classified", () => {
    const missing = classifyDshPromptFailure({ rpcCode: -32603, message: 'Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service' });
    assert.equal(missing?.admitted, true);
    assert.equal(missing?.code, "auth-expired");
    assert.match(missing!.message, /Sign in to DeepSeek/);
    const auth = classifyDshPromptFailure({ rpcCode: -32603, message: "Internal error: turn failed: Authentication Fails (invalid api key)" });
    assert.deepEqual([auth?.admitted, auth?.code], [true, "auth-expired"]);
    const quota = classifyDshPromptFailure({ rpcCode: -32603, message: "Internal error: turn failed: Insufficient Balance" });
    assert.deepEqual([quota?.code, quota?.retry], ["quota-exhausted", { scope: "quota", provider: "deepseek", retryable: false }]);
    const rate = classifyDshPromptFailure({ rpcCode: -32603, message: "Internal error: turn failed: Rate limit reached" });
    assert.deepEqual([rate?.code, rate?.retry], ["rate-limited", { scope: "rate", provider: "deepseek", retryable: true }]);
    const busy = classifyDshPromptFailure({ message: "Internal error: turn failed: Server Overloaded" });
    assert.equal(busy?.code, "overloaded");
    const model = classifyDshPromptFailure({ message: "Internal error: turn failed: Model Not Exist" });
    assert.equal(model?.code, "model-unavailable");
    const other = classifyDshPromptFailure({ message: "Internal error: turn failed: something odd" });
    assert.deepEqual(other, { admitted: true, message: "DeepSeek turn failed: something odd" });
    const refused = classifyDshPromptFailure({ message: "Internal error: image route unavailable" });
    assert.deepEqual(refused, { admitted: false, message: "DeepSeek Harness refused the prompt: image route unavailable" });
    assert.equal(classifyDshPromptFailure({ message: "  " }), undefined);
});

const header = (id: string, cwd: string, version = 4) => JSON.stringify({ type: "session", version, id, createdAt: 1, cwd, isSeeded: false, delegationDepth: 0 });
const row = (value: unknown) => JSON.stringify(value);
const user = (seq: number, text: string) => row({ type: "user/message", seq, time: 10 + seq, data: { role: "user", id: `u${seq}`, source: { kind: "user" }, content: [{ type: "text", text }] } });
const injected = (seq: number) => row({ type: "user/message", seq, data: { role: "user", id: `i${seq}`, source: { kind: "runtime-context" }, content: [{ type: "text", text: "policy" }] } });
const assistant = (seq: number, id: string, text: string, usage: Record<string, number>) => row({
    type: "assistant/message",
    seq,
    time: 10 + seq,
    data: {
        message: { role: "assistant", id, content: [{ type: "reasoning", text: "private" }, { type: "text", text }], source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-pro" } },
        usage,
    },
});
const turnEnd = (seq: number) => row({ type: "turn/end", seq, data: { turn: 1, reason: { kind: "completed" } } });

test("log: complete zstd frames are walked; a torn tail ends the readable prefix", zstd, () => {
    const lines = [header("s1", "/w"), user(0, "one"), assistant(1, "a1", "first", { inputTokens: 5, outputTokens: 2 })];
    const frames = lines.map((line) => compress!(Buffer.from(`${line}\n`)));
    const torn = compress!(Buffer.from(`${turnEnd(2)}\n`)).subarray(0, 9);
    const bytes = Buffer.concat([...frames, torn]);
    assert.equal(zstdFrames(bytes).length, 3);
    const parsed = parseLog(decodeLogBytes(bytes, true));
    assert.equal(parsed.header?.id, "s1");
    assert.deepEqual(parsed.events.map((event) => event.type), ["user/message", "assistant/message"]);
    // A skippable frame between data frames is stepped over.
    const skippable = Buffer.alloc(12);
    skippable.writeUInt32LE(0x184d2a50, 0);
    skippable.writeUInt32LE(4, 4);
    assert.equal(zstdFrames(Buffer.concat([frames[0]!, skippable, frames[1]!])).length, 2);
});

test("usage: one row per response after the newest user prompt, cache counters separate", () => {
    const { events } = parseLog([
        header("s", "/w"),
        user(0, "old"),
        assistant(1, "old-a", "old answer", { inputTokens: 1, outputTokens: 1 }),
        turnEnd(2),
        user(3, "new"),
        injected(4),
        assistant(5, "a1", "step", { inputTokens: 1200, outputTokens: 20, cacheReadTokens: 800, cacheWriteTokens: 0 }),
        assistant(6, "a2", "done", { inputTokens: 300, outputTokens: 7, cacheReadTokens: 2000 }),
    ].join("\n"));
    const pending = latestPromptUsage(events);
    assert.equal(pending.complete, false);
    assert.deepEqual(pending.rows.map((usage) => [usage.messageId, usage.model, usage.tokens]), [
        ["a1", "deepseek-v4-pro", { input: 1200, output: 20, cacheRead: 800, cacheWrite: 0 }],
        ["a2", "deepseek-v4-pro", { input: 300, output: 7, cacheRead: 2000 }],
    ]);
    assert.equal(latestPromptUsage(parseLog([header("s", "/w"), user(0, "x"), turnEnd(1)].join("\n")).events).complete, true);
    assert.deepEqual(latestPromptUsage(parseLog(header("s", "/w")).events), { rows: [], complete: false });
});

test("dialogue: user prompts and visible text only", () => {
    const { events } = parseLog([header("s", "/w"), user(0, "hello"), injected(1), assistant(2, "a", "hi there", { inputTokens: 1, outputTokens: 1 })].join("\n"));
    assert.deepEqual([...dialogueRecords(events)].map(({ role, text }) => [role, text]), [["user", "hello"], ["assistant", "hi there"]]);
});

test("sessions: listed and read only for their own workspace and supported generation", zstd, async () => {
    const home = await mkdtemp(join(tmpdir(), "dsh-home-"));
    try {
        const write = async (project: string, id: string, lines: string[], name = "session.v4.jsonl.zstd") => {
            await mkdir(join(home, "sessions", project, id), { recursive: true });
            const bytes = name.endsWith(".zstd")
                ? Buffer.concat(lines.map((line) => compress!(Buffer.from(`${line}\n`))))
                : Buffer.from(`${lines.join("\n")}\n`);
            await writeFile(join(home, "sessions", project, id, name), bytes);
        };
        await write("--w--", "mine", [header("mine", "/w"), user(0, "Fix the build"), row({ type: "session/title", seq: 1, data: { title: "Build fix" } })]);
        await write("--w--", "raw", [header("raw", "/w"), user(0, "Raw prompt")], "session.v4.jsonl");
        await write("--w--", "empty", [header("empty", "/w")]);
        await write("--other--", "theirs", [header("theirs", "/other"), user(0, "x")]);
        await write("--w--", "future", [header("future", "/w", 5), user(0, "x")], "session.v5.jsonl.zstd");
        await write("--w--", "../escape", [header("x", "/w"), user(0, "x")]).catch(() => {});
        const listed = await listNativeSessions(home, "/w");
        assert.deepEqual(listed.map((session) => [session.ref, session.title]).sort(), [["mine", "Build fix"], ["raw", "Raw prompt"]]);
        const records = [];
        for await (const record of readNativeDialogue(home, "/w", "mine")) records.push(record.text);
        assert.deepEqual(records, ["Fix the build"]);
        await assert.rejects(async () => { for await (const _ of readNativeDialogue(home, "/w", "theirs")) { /* drain */ } }, { code: "not-found" });
        assert.equal(await readNativeSession(home, "../theirs"), undefined);
        assert.equal(await readNativeSession(home, "future"), undefined);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("profile: ACP launch, overlay, account isolation and sign-in helper", () => {
    assert.ok(existsSync(ACP_PATCH), "the overlay file ships with the package");
    assert.ok(existsSync(SIGN_IN_SCRIPT), "the sign-in helper ships with the package");
    const main = createDeepSeekProfile();
    assert.equal(main.descriptor.id, "deepseek");
    assert.deepEqual(main.args, ["--profile", "acp", "--patch", ACP_PATCH]);
    assert.deepEqual(main.remoteArgs, ["--profile", "acp"]);
    assert.equal(main.toolNameFromTitle, true);
    assert.equal(main.descriptor.releaseSource?.kind, "npm");
    assert.deepEqual(main.descriptor.updateCommand, ["npm", "install", "-g", "@deepseek-ai/dsh@latest"]);
    assert.equal(main.env, undefined, "the default login runs on the server's own environment");
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "server-key";
    try {
        const second = createDeepSeekProfile({ id: "work", harnessId: "deepseek-work", name: "Work", dir: "/accounts/work" });
        assert.equal(second.descriptor.id, "deepseek-work");
        assert.equal(second.env?.DSH_HOME, "/accounts/work");
        assert.equal(second.env?.DEEPSEEK_API_KEY, undefined, "an account never runs on the server's key");
    } finally {
        if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous;
    }
});

test("overlay: removes every native subagent entry point", async () => {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(ACP_PATCH, "utf8");
    const disabled = [...text.matchAll(/^- id: ([\w-]+)\n {2}disabled: true$/gm)].map((match) => match[1]);
    assert.deepEqual(disabled.sort(), [
        "subagent-fork-in-process",
        "subagent-spawn-in-process",
        "tool-ralph",
        "tool-subagent",
        "tool-subagent-control",
        "tool-subagent-fork",
        "tool-subagent-list-agents",
        "tool-workflow",
        "workflow-ptc",
    ]);
});

test("MCP refusals: dsh names the server by position or by name", () => {
    const servers = [
        { name: "mempalace", command: "python3", args: [], env: [] },
        { type: "http" as const, name: "linear", url: "https://example.invalid/mcp", headers: [] },
    ];
    assert.equal(dshFailedMcpServer({ rpcCode: -32602, message: "Invalid params: mcpServers[0].command must be an absolute path" }, servers), 0);
    assert.equal(dshFailedMcpServer({ rpcCode: -32603, message: "Internal error", data: { details: "mcp-client(linear): initial connection or tool synchronization failed" } }, servers), 1);
    assert.equal(dshFailedMcpServer({ message: "Invalid params: mcpServers[7].command must be an absolute path" }, servers), undefined);
    assert.equal(dshFailedMcpServer({ message: "Internal error", data: { details: "mcp-client(other): failed" } }, servers), undefined);
    assert.equal(dshFailedMcpServer({ message: "cwd must be absolute" }, servers), undefined);
});
