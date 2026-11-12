import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SourceRecord } from "@polyth/contracts";
import { dialogueRecords, latestPromptUsage, listNativeSessions, parseLog, parseWorkspaceYaml, readLatestPrompt, readNativeDialogue, readNativeSession, resolveCopilotHome } from "../src/nativeLog.ts";

// Row shapes copied from a Copilot CLI 1.0.109 `events.jsonl`.
const row = (type: string, data: Record<string, unknown>, id = `${type}-${Math.random()}`, timestamp = "2026-11-11T06:57:54.631Z") =>
  JSON.stringify({ type, data, id, timestamp, parentId: null });
const start = (version = 1) => row("session.start", { sessionId: "s", version, producer: "copilot-agent", copilotVersion: "1.0.109" });
const usage = (id: string, input: number, output: number, cacheRead = 0, extra: Record<string, unknown> = {}) =>
  row("session.usage_record", { usage: { model: "claude-sonnet-4.5", inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0, ...extra } }, id);
const toolTurn = [
  start(),
  row("user.message", { content: "run it", transformedContent: "<current_datetime>…</current_datetime>\n\nrun it" }),
  row("system.message", { role: "system", content: "You are GitHub Copilot" }),
  row("assistant.turn_start", { turnId: "0" }),
  usage("u1", 100, 20),
  row("assistant.message", { content: "", toolRequests: [{ toolCallId: "call_1", name: "bash" }] }),
  row("tool.execution_complete", { toolCallId: "call_1", success: true }),
  row("assistant.turn_end", { turnId: "0" }),
  row("assistant.turn_start", { turnId: "1" }),
  usage("u2", 150, 5, 40),
  row("assistant.message", { content: "Hello from mock.", toolRequests: [] }),
  row("assistant.turn_end", { turnId: "1" }),
];

const home = async () => mkdtemp(join(tmpdir(), "polyth-copilot-log-"));
const writeSession = async (root: string, id: string, cwd: string, lines: string[] | undefined, name?: string) => {
  const dir = join(root, "session-state", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "workspace.yaml"), `id: ${id}\ncwd: ${cwd}\n${name ? `name: ${name}\n` : ""}user_named: false\n`);
  if (lines) await writeFile(join(dir, "events.jsonl"), `${lines.join("\n")}\n`);
};

test("COPILOT_HOME relocates the CLI's state; blank is unset", () => {
  assert.equal(resolveCopilotHome({ COPILOT_HOME: "/srv/copilot" }), "/srv/copilot");
  assert.match(resolveCopilotHome({ COPILOT_HOME: "  " }), /\.copilot$/);
});

test("each model response of the newest prompt is one usage row, with cache reads taken out of the input", () => {
  const read = latestPromptUsage(parseLog(toolTurn.join("\n")));
  assert.equal(read.complete, true);
  assert.deepEqual(read.rows, [
    { id: "u1", model: "claude-sonnet-4.5", tokens: { input: 100, output: 20 } },
    { id: "u2", model: "claude-sonnet-4.5", tokens: { input: 110, output: 5, cacheRead: 40 } },
  ]);
});

test("usage of an earlier prompt is not reported again, and a turn still running is incomplete", () => {
  const next = [
    ...toolTurn,
    row("user.message", { content: "again" }),
    row("assistant.turn_start", { turnId: "2" }),
    usage("u3", 300, 7, 300),
  ];
  const read = latestPromptUsage(parseLog(next.join("\n")));
  assert.equal(read.complete, false);
  assert.deepEqual(read.rows.map((entry) => [entry.id, entry.tokens.input]), [["u3", 0]]);
  assert.equal(latestPromptUsage(parseLog([...next, row("abort", { reason: "user_abort" })].join("\n"))).complete, true);
  assert.deepEqual(latestPromptUsage(parseLog(start())), { rows: [], complete: false });
});

test("a torn last line is ignored and malformed usage is skipped", () => {
  const events = parseLog([...toolTurn.slice(0, 5), row("session.usage_record", { usage: { model: "", inputTokens: 1, outputTokens: 1 } }, "bad"), '{"type":"assistant.mess'].join("\n"));
  assert.deepEqual(latestPromptUsage(events).rows.map((entry) => entry.id), ["u1"]);
});

test("dialogue keeps prompts and visible answers, not tool calls, system text or subagent messages", () => {
  const events = parseLog([
    ...toolTurn,
    row("user.message", { content: "inner", parentToolCallId: "call_9" }),
    row("assistant.message", { content: "inner answer", parentToolCallId: "call_9" }),
  ].join("\n"));
  assert.deepEqual([...dialogueRecords(events)].map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "run it" },
    { role: "assistant", text: "Hello from mock." },
  ]);
});

test("workspace.yaml scalars are read with their quoting", () => {
  assert.deepEqual(parseWorkspaceYaml('id: a\ncwd: "/tmp/with: colon"\nname: \'it\'\'s\'\nuser_named: false\n  nested: x\n'), {
    id: "a", cwd: "/tmp/with: colon", name: "it's", user_named: "false",
  });
});

test("sessions are listed for their own working directory only, and only once they hold a conversation", async () => {
  const root = await home();
  try {
    await writeSession(root, "11111111-aaaa", "/work/project", toolTurn, "Fix the build");
    await writeSession(root, "22222222-bbbb", "/work/other", toolTurn, "Elsewhere");
    await writeSession(root, "33333333-cccc", "/work/project", undefined);
    assert.deepEqual((await listNativeSessions(root, "/work/project")).map(({ ref, title }) => ({ ref, title })), [
      { ref: "11111111-aaaa", title: "Fix the build" },
    ]);
    assert.deepEqual(await listNativeSessions(join(root, "missing"), "/work/project"), []);
    const records: SourceRecord[] = [];
    for await (const record of readNativeDialogue(root, "/work/project", "11111111-aaaa")) records.push(record);
    assert.deepEqual(records.map((record) => record.role), ["user", "assistant"]);
    // Another project's session, and a path that is not an id, are not found.
    await assert.rejects(async () => { for await (const _ of readNativeDialogue(root, "/work/project", "22222222-bbbb")) { /* drain */ } }, { code: "not-found" });
    await assert.rejects(async () => { for await (const _ of readNativeDialogue(root, "/work/project", "../22222222-bbbb")) { /* drain */ } }, { code: "not-found" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unverified log generation yields nothing", async () => {
  const root = await home();
  try {
    await writeSession(root, "44444444-dddd", "/work/project", [start(2), ...toolTurn.slice(1)]);
    assert.equal(await readNativeSession(root, "44444444-dddd"), undefined);
    assert.equal(await readLatestPrompt(root, "44444444-dddd"), undefined);
    assert.equal(await readNativeSession(root, "../escape"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a long log is read from its end, back to the newest prompt", async () => {
  const root = await home();
  try {
    const filler = row("tool.execution_complete", { result: { content: "x".repeat(64 * 1024) } });
    const lines = [...toolTurn.slice(0, 4), ...Array.from({ length: 80 }, () => filler), ...toolTurn.slice(1)];
    await writeSession(root, "55555555-eeee", "/work/project", lines);
    const events = await readLatestPrompt(root, "55555555-eeee");
    assert.equal(events?.[0]?.type, "user.message");
    assert.deepEqual(latestPromptUsage(events!).rows.map((entry) => entry.id), ["u1", "u2"]);
    // The same tail from another generation is refused.
    await writeSession(root, "66666666-ffff", "/work/project", [start(9), ...lines.slice(1)]);
    assert.equal(await readLatestPrompt(root, "66666666-ffff"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
