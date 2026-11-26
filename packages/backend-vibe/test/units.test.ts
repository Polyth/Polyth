import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ResolvedHarnessAccount } from "@polyth/harness-runtime/accounts";
import { classifyVibePromptFailure } from "../src/failures.ts";
import { vibeChildEnv, VIBE_POLYTH_DISABLED_TOOLS, VIBE_POLYTH_SETTINGS } from "../src/launchEnv.ts";
import { foldReplay, listVibeSessions, parseVibeSessionMeta, resolveVibeHome } from "../src/nativeSessions.ts";
import { createVibeClientTranslator, createVibeProfile, parseVibeAcpVersion, vibeCliBeside, vibeInstallCommand, vibeUpdateCommand, VIBE_WINDOWS_INSTALL } from "../src/serverEntry.ts";
import { signInFromSessionNew } from "../src/signIn.ts";
import { vibeNativeToolName, vibeToolName } from "../src/toolNames.ts";
import { createVibeTurnUsageTracker } from "../src/usage.ts";

const account = { id: "work", harnessId: "vibe-work", name: "Work", dir: "/data/accounts/work" } as unknown as ResolvedHarnessAccount;

test("Vibe installs with Mistral's script on Linux and macOS and with uv on Windows; updates the same way", () => {
    assert.equal(vibeInstallCommand("linux"), "curl -fsSL https://mistral.ai/vibe/install.sh | bash");
    assert.equal(vibeInstallCommand("darwin"), "curl -fsSL https://mistral.ai/vibe/install.sh | bash");
    assert.equal(vibeInstallCommand("posix"), "curl -fsSL https://mistral.ai/vibe/install.sh | bash");
    assert.equal(vibeInstallCommand("win32"), VIBE_WINDOWS_INSTALL);
    assert.match(VIBE_WINDOWS_INSTALL, /^powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "[^"]*irm https:\/\/astral\.sh\/uv\/install\.ps1 \| iex[^"]*uv tool install --python 3\.13 mistral-vibe; exit \$LASTEXITCODE"$/);
    // cmd.exe expands `%`; the PowerShell body must not contain one.
    assert.equal(VIBE_WINDOWS_INSTALL.includes("%"), false);
    assert.deepEqual(vibeUpdateCommand("linux"), ["bash", "-c", "curl -fsSL https://mistral.ai/vibe/install.sh | bash"]);
    assert.deepEqual(vibeUpdateCommand("win32"), ["uv", "tool", "upgrade", "mistral-vibe"]);
});

test("the descriptor is a local ACP harness that reads its release from PyPI", () => {
    const { descriptor, command, args } = createVibeProfile();
    assert.equal(descriptor.id, "vibe");
    assert.equal(descriptor.name, "Mistral Vibe");
    assert.equal(descriptor.autoSelect, false);
    assert.equal(descriptor.remoteHost, undefined, "vibe-acp takes its Polyth settings from the environment, which an SSH launch does not carry");
    assert.equal(command, process.env.POLYTH_VIBE_BIN?.trim() || "vibe-acp");
    assert.deepEqual(args, []);
    assert.equal(descriptor.releaseSource?.kind, "page");
    if (descriptor.releaseSource?.kind === "page") {
        assert.equal(descriptor.releaseSource.url, "https://pypi.org/pypi/mistral-vibe/json");
        const version = new RegExp(descriptor.releaseSource.pattern).exec('{"info":{"author":"Mistral","version":"3.1.5","yanked":false},"releases":{"3.0.0":[]}}')?.[1];
        assert.equal(version, "3.1.5");
    }
    assert.equal(createVibeProfile(account).descriptor.id, "vibe-work");
    // Vibe advertises no `mcpCapabilities.http`, so its tools go over stdio.
    assert.equal(createVibeProfile().agentToolsOverHttp, undefined);
});

test("vibe-acp --version is recognized, other programs are not", () => {
    assert.equal(parseVibeAcpVersion("vibe-acp 3.1.5\n"), "3.1.5");
    assert.equal(parseVibeAcpVersion("vibe-acp 3.2.0rc1"), "3.2.0rc1");
    assert.equal(parseVibeAcpVersion("vibe 3.1.5"), undefined);
    assert.equal(parseVibeAcpVersion("usage: something --version"), undefined);
});

test("the sign-in command is the `vibe` CLI installed beside vibe-acp", () => {
    assert.equal(vibeCliBeside("/home/a/.local/bin/vibe-acp"), "/home/a/.local/bin/vibe");
    assert.equal(vibeCliBeside("C:\\Users\\a\\.local\\bin\\vibe-acp.exe"), "C:\\Users\\a\\.local\\bin\\vibe.exe");
    assert.equal(vibeCliBeside("vibe-acp"), "vibe");
    assert.equal(vibeCliBeside("/opt/custom/agent"), "vibe");
});

test("every launch switches off Vibe's subagents, background work, scheduling, commit credit and self-update, and asks before tools", () => {
    const env = vibeChildEnv({ PATH: "/bin", MISTRAL_API_KEY: "k" });
    assert.equal(env.PATH, "/bin");
    assert.equal(env.MISTRAL_API_KEY, "k", "the default login keeps the server's key");
    for (const [name, value] of Object.entries(VIBE_POLYTH_SETTINGS)) assert.equal(env[name], value);
    assert.equal(env.VIBE_ENABLE_SUBAGENTS, "false");
    assert.equal(env.VIBE_ENABLE_BACKGROUND_PROCESSES, "false");
    assert.equal(env.VIBE_DEFAULT_APPROVAL_POLICY, "ask");
    assert.equal(env.VIBE_INCLUDE_COMMIT_SIGNATURE, "false");
    assert.deepEqual(JSON.parse(env.VIBE_DISABLED_TOOLS!), [...VIBE_POLYTH_DISABLED_TOOLS]);
    // A person's own list is kept; an unparseable one is ignored, as Vibe does.
    assert.deepEqual(JSON.parse(vibeChildEnv({ VIBE_DISABLED_TOOLS: '["web_fetch","cron"]' }).VIBE_DISABLED_TOOLS!), ["web_fetch", ...VIBE_POLYTH_DISABLED_TOOLS]);
    assert.deepEqual(JSON.parse(vibeChildEnv({ VIBE_DISABLED_TOOLS: "web_fetch" }).VIBE_DISABLED_TOOLS!), [...VIBE_POLYTH_DISABLED_TOOLS]);
});

test("an added account runs in its own VIBE_HOME and never on the server's key", () => {
    const env = vibeChildEnv({ PATH: "/bin", MISTRAL_API_KEY: "k", VIBE_HOME: "/root/.vibe" }, account);
    assert.equal(env.MISTRAL_API_KEY, undefined);
    assert.equal(env.VIBE_HOME, "/data/accounts/work");
    assert.equal(createVibeProfile(account).env?.VIBE_HOME, "/data/accounts/work");
});

test("VIBE_HOME resolves like Vibe's own lookup", () => {
    assert.equal(resolveVibeHome({ VIBE_HOME: "/x/vibe" }), "/x/vibe");
    assert.match(resolveVibeHome({}), /[\\/]\.vibe$/);
});

test("a turn's usage is its share of Vibe's session totals, counted from the prompt echo", () => {
    const tracker = createVibeTurnUsageTracker(() => 1000);
    const usage = (promptTokens: number, completionTokens: number, cachedTokens: number) => ({ sessionUpdate: "usage_update", used: 1, size: 10, _meta: { promptTokens, completionTokens, cachedTokens } });
    // A loaded session reports its earlier totals before the first prompt.
    tracker.observe("s", usage(3600, 21, 300));
    tracker.observe("s", { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } });
    assert.equal(tracker.echoedAt("s"), 1000);
    tracker.observe("s", usage(4800, 28, 400));
    assert.deepEqual(tracker.settle("s", { stopReason: "end_turn", usage: { inputTokens: 6000, outputTokens: 35, cachedReadTokens: 500, totalTokens: 6035 } }), { input: 2200, output: 14, cacheRead: 200 });
    // The next turn starts from the last answer even if the final update is late.
    tracker.observe("s", { sessionUpdate: "user_message_chunk", content: { type: "text", text: "again" } });
    assert.deepEqual(tracker.settle("s", { usage: { inputTokens: 7200, outputTokens: 42 } }), { input: 1200, output: 7 });
    // No echo, no starting point, nothing reported.
    assert.equal(tracker.settle("s", { usage: { inputTokens: 9000, outputTokens: 50 } }), undefined);
    // A session never seen before the echo is not counted from zero.
    tracker.observe("fresh", { sessionUpdate: "user_message_chunk", content: { type: "text", text: "x" } });
    assert.equal(tracker.settle("fresh", { usage: { inputTokens: 10, outputTokens: 1 } }), undefined);
    // A shrinking total is not this session's counter.
    tracker.observe("s", { sessionUpdate: "user_message_chunk", content: { type: "text", text: "x" } });
    assert.equal(tracker.settle("s", { usage: { inputTokens: 5, outputTokens: 1 } }), undefined);
    // An answer without usage reports nothing.
    tracker.observe("s", { sessionUpdate: "user_message_chunk", content: { type: "text", text: "x" } });
    assert.equal(tracker.settle("s", { stopReason: "cancelled" }), undefined);
});

test("prompt failures are classified from Vibe's error codes", () => {
    const missing = classifyVibePromptFailure({ rpcCode: -32000, message: "Missing API key for mistral provider." });
    assert.deepEqual([missing?.admitted, missing?.code], [false, "auth-expired"]);
    assert.match(missing!.message, /MISTRAL_API_KEY/);
    const invalid = classifyVibePromptFailure({ rpcCode: -31002, message: "Invalid API key (from env var MISTRAL_API_KEY). Please check your API key and try again." });
    assert.deepEqual([invalid?.admitted, invalid?.code], [false, "auth-expired"]);
    assert.deepEqual(classifyVibePromptFailure({ rpcCode: -31002, message: "Unknown model alias: foo" })?.code, "unsupported");
    const rate = classifyVibePromptFailure({ rpcCode: -31001, message: "Rate limit exceeded for mistral (model: mistral-large-4-0)." });
    assert.deepEqual([rate?.admitted, rate?.code, rate?.retry], [true, "rate-limited", { scope: "rate", provider: "mistral", retryable: true }]);
    assert.equal(classifyVibePromptFailure({ rpcCode: -31004, message: "Context too long" })?.code, "context-full");
    const model = classifyVibePromptFailure({ rpcCode: -32603, message: "Client error '404 Not Found' for url 'https://api.mistral.ai/v1/chat/completions'\nFor more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/404: Invalid model: x" });
    assert.equal(model?.code, "model-unavailable");
    assert.equal(model?.message.includes("developer.mozilla.org"), false, "the generic status-page link is dropped");
    assert.equal(classifyVibePromptFailure({ rpcCode: -32603, message: "Server error '503 Service Unavailable' for url '…'" })?.code, "overloaded");
    assert.equal(classifyVibePromptFailure({ rpcCode: -32603, message: "402 Payment Required: insufficient credit" })?.code, "quota-exhausted");
    assert.equal(classifyVibePromptFailure({ rpcCode: -32603, message: "something odd" })?.code, "unknown");
    assert.equal(classifyVibePromptFailure({ rpcCode: -32602, message: "bad params" }), undefined);
    assert.equal(classifyVibePromptFailure({ rpcCode: -32603, message: "" }), undefined);
});

test("Vibe's MCP tool names become Polyth's, its own server's name restored", () => {
    assert.equal(vibeToolName("mcp_polyth_agent_tools.polyth_todo"), "mcp__polyth-agent-tools__polyth_todo");
    assert.equal(vibeToolName("mcp_github.list_issues"), "mcp__github__list_issues");
    assert.equal(vibeToolName("bash"), "bash");
    assert.equal(vibeNativeToolName({ _meta: { tool_name: "mcp_polyth_agent_tools.polyth" } }), "mcp__polyth-agent-tools__polyth");
    assert.equal(vibeNativeToolName({ _meta: { tool_name: "search_tool_functions" } }), "search_tool_functions");
    assert.equal(vibeNativeToolName({ _meta: { tool_name: "has spaces" } }), undefined);
    assert.equal(vibeNativeToolName({ title: "bash" }), undefined);
});

test("Vibe's retry notice proves the turn without producing events", () => {
    const translator = createVibeClientTranslator();
    assert.deepEqual(translator.translateClientMethod("_session/retrying", { sessionId: "s", category: "rate_limited", detail: "HTTP 429" }), { handled: true, events: [] });
    assert.deepEqual(translator.translateClientMethod("_other", {}), { handled: false });
});

test("session/new proves whether a login has a key", () => {
    assert.deepEqual(signInFromSessionNew({ ok: true }), { loggedIn: true, plan: "API key" });
    assert.deepEqual(signInFromSessionNew({ ok: false, rpcCode: -32000, message: "Missing API key for mistral provider." }), { loggedIn: false });
    assert.deepEqual(signInFromSessionNew({ ok: false, rpcCode: -32603, message: "boom" }), { loggedIn: "unknown" });
});

test("native sessions are listed from meta.json for this folder, newest first, without subagent sessions", async () => {
    const home = await mkdtemp(join(tmpdir(), "polyth-vibe-home-"));
    try {
        const write = async (id: string, meta: Record<string, unknown>) => {
            await mkdir(join(home, "logs", "session", "unified", id), { recursive: true });
            await writeFile(join(home, "logs", "session", "unified", id, "meta.json"), JSON.stringify({ session_id: id, ...meta }));
        };
        await write("aaa", { environment: { working_directory: "/w" }, title: "Older", bumped_at: "2026-11-01T00:00:00Z" });
        await write("bbb", { environment: { working_directory: "/w" }, title: "Newer", bumped_at: "2026-11-02T00:00:00Z" });
        await write("ccc", { environment: { working_directory: "/w" }, parent_session_id: "bbb", title: "Child" });
        await write("ddd", { environment: { working_directory: "/other" }, title: "Elsewhere" });
        await write("eee", { environment: { working_directory: "/w" }, start_time: "2026-10-01T00:00:00Z" });
        await mkdir(join(home, "logs", "session", "unified", "fff"), { recursive: true });
        await writeFile(join(home, "logs", "session", "unified", "fff", "meta.json"), JSON.stringify({ session_id: "not-fff", environment: { working_directory: "/w" } }));
        assert.deepEqual((await listVibeSessions(home, "/w")).map((session) => [session.ref, session.title]), [["bbb", "Newer"], ["aaa", "Older"], ["eee", "Mistral Vibe session"]]);
        assert.deepEqual(await listVibeSessions(join(home, "missing"), "/w"), []);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
    assert.equal(parseVibeSessionMeta("x", "not json"), undefined);
});

test("replayed chunks fold into one record per message", () => {
    assert.deepEqual(foldReplay([
        { sessionUpdate: "user_message_chunk", messageId: "u1", content: { type: "text", text: "hello" } },
        { sessionUpdate: "agent_thought_chunk", messageId: "a1", content: { type: "text", text: "thinking" } },
        { sessionUpdate: "agent_message_chunk", messageId: "a1", content: { type: "text", text: "Hi " } },
        { sessionUpdate: "tool_call", toolCallId: "t" },
        { sessionUpdate: "agent_message_chunk", messageId: "a1", content: { type: "text", text: "there" } },
        { sessionUpdate: "agent_message_chunk", messageId: "a2", content: { type: "text", text: "Done." } },
        { sessionUpdate: "user_message_chunk", messageId: "u2", content: { type: "image", data: "x" } },
        { sessionUpdate: "user_message_chunk", messageId: "u3", content: { type: "text", text: "again" } },
    ]), [
        { role: "user", text: "hello" },
        { role: "assistant", text: "Hi there" },
        { role: "assistant", text: "Done." },
        { role: "user", text: "again" },
    ]);
});
