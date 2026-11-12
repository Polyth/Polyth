// "Harness here, tools on the host": Claude Code runs on this machine while the
// project is on an SSH host. These tests cover the three pieces around the
// remote tools: the in-process tool server, the delivery bridge for the
// project's own Claude Code files, and Polyth's policy in front of each call.
// The fake host runs the remote argv locally in the requested directory, the
// way the SSH transport's raw-pipe process command does on the far side.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { RuntimeEvent } from "@polyth/contracts";
import type { createProcessAuthority } from "@polyth/harness-runtime";
import type { RemoteProcessHost } from "@polyth/harness-runtime/remote-host";
import { createRemoteWorkspace } from "@polyth/harness-runtime/remote-workspace";
import { createClaudeRuntime } from "../src/index.ts";
import {
  bridgedHooksFromSettings,
  claudeInstructionImports,
  interpretHookResult,
  loadRemoteProjectBridge,
  parseBridgeSections,
  parseSkillFrontmatter,
} from "../src/remoteBridge.ts";
import { createRemoteHandsSession, REMOTE_HANDS_DISALLOWED_TOOLS } from "../src/remoteHands.ts";
import { createSdkMcpServerInstance } from "../src/sdkMcpServer.ts";
import { claudeLocalRestrictingRules, claudeRemoteWorkspace } from "../src/serverEntry.ts";

const host: RemoteProcessHost = {
  label: "dev@remote",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  start: async () => { throw new Error("unused"); },
  forward: async () => { throw new Error("unused"); },
  processCommand: (argv, opts) => ({ command: "sh", args: ["-c", 'cd "$0" || exit 78; exec "$@"', opts?.cwd ?? "/", ...argv] }),
};

const LOG = ".claude/hook.log";
/** Appends the hook's JSON input to a log in the project, then runs `then`. */
const logging = (then = "") => `input=$(cat); printf '%s\\n' "$input" >> "$CLAUDE_PROJECT_DIR/${LOG}"; ${then}`;

const SETTINGS = {
  permissions: {
    allow: ["Bash(rm:*)", "Edit"],
    deny: ["Bash(git push --force:*)", "Read(./secrets/**)"],
    ask: ["Bash(git log:*)"],
  },
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: 'echo "Release train: WHITE-MOTH"' }] }],
    UserPromptSubmit: [
      { hooks: [{ type: "command", command: 'echo "Sprint 12"' }] },
      { hooks: [{ type: "command", command: 'echo "No tickets were named" >&2; exit 2' }] },
    ],
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: logging('case "$input" in *"git push"*) echo "Pushing is not allowed here" >&2; exit 2;; esac') }] },
      { matcher: "Edit|Write", hooks: [{ type: "command", command: `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'` }] },
      { matcher: "Read", hooks: [{ type: "command", if: "Read(/docs/**)", command: `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Docs are under review"}}'` }] },
    ],
    PostToolUse: [
      { matcher: "Edit", hooks: [{ type: "command", command: logging(`echo '{"decision":"block","reason":"Run the formatter"}'`) }] },
      { matcher: "Bash", hooks: [{ type: "prompt", prompt: "Was that safe?" }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: "echo never" }] }],
  },
};

const project = (t: { after(fn: () => void): void }) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-remote-hands-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  put("CLAUDE.md", [
    "# Shop",
    "Codeword BLUE-HERON. See @docs/conventions.md and @./docs/missing.md.",
    "Not an import: `@docs/secret.md`, a@b.example, @anthropic-ai/sdk.",
    "```",
    "@docs/fenced.md",
    "```",
    "Outside the project: @../outside.md",
  ].join("\n"));
  put("CLAUDE.local.md", "Local note: GREY-WOLF.\n");
  put("docs/conventions.md", "Conventions: AMBER-LYNX. More in @deeper.md\n");
  put("docs/deeper.md", "Deeper: RED-KITE.\n");
  put("docs/secret.md", "must not load\n");
  put("docs/fenced.md", "must not load\n");
  put("docs/guide.md", "Guide\n");
  put("shop/CLAUDE.md", "Shop rules: GREEN-OTTER.\n");
  put("shop/cart/CLAUDE.md", "Cart rules: PINK-SWAN.\n");
  put("shop/cart/items.py", "ITEMS = []\n");
  put("shop/pricing.py", "def total(items):\n    return sum(items)\n");
  put("node_modules/pkg/CLAUDE.md", "must not load\n");
  put("secrets/token.txt", "hunter2\n");
  put("README.md", "# Shop\n");
  put(".claude/settings.json", JSON.stringify(SETTINGS));
  put(".claude/settings.local.json", JSON.stringify({ permissions: { deny: ["Write(/dist/**)"] } }));
  put(".claude/skills/release-notes/SKILL.md", "---\nname: release-notes\ndescription: \"Write the release notes\"\n---\nSILVER-CRANE\n");
  put(".claude/skills/hidden/SKILL.md", "---\nname: hidden\ndescription: Internal\ndisable-model-invocation: true\n---\n");
  put(".claude/skills/unnamed/SKILL.md", "No frontmatter here.\n");
  put(".claude/commands/ship.md", "ship it\n");
  put(".mcp.json", "{}");
  return dir;
};

const open = async (t: { after(fn: () => void): void }, localRules = {}) => {
  const dir = project(t);
  const workspace = createRemoteWorkspace(host, dir);
  const bridge = await loadRemoteProjectBridge(workspace, "native-1");
  const session = createRemoteHandsSession({ workspace, bridge, localRules });
  t.after(() => session.close());
  return { dir, workspace, bridge, session };
};

const hookLog = (dir: string): Array<Record<string, any>> => existsSync(join(dir, LOG))
  ? readFileSync(join(dir, LOG), "utf8").trim().split("\n").map((line) => JSON.parse(line))
  : [];

// ---- the in-process tool server --------------------------------------------------

test("the tool server answers the MCP calls the SDK makes and nothing else", async () => {
  const sent: any[] = [];
  const transport: any = { send: async (message: unknown) => { sent.push(message); } };
  let slowSignal: AbortSignal | undefined;
  const server = createSdkMcpServerInstance({
    name: "workspace",
    tools: [
      { name: "echo", description: "Echo", inputSchema: { type: "object" }, handler: async (args) => ({ text: JSON.stringify(args) }) },
      { name: "boom", description: "Throws", inputSchema: { type: "object" }, handler: async () => { throw new Error("no"); } },
      {
        name: "slow", description: "Waits", inputSchema: { type: "object" },
        handler: (_args, { signal }) => new Promise((resolve) => {
          slowSignal = signal;
          signal.addEventListener("abort", () => resolve({ text: "stopped", isError: true }));
        }),
      },
    ],
  });
  await server.connect(transport);
  const call = async (message: Record<string, unknown>) => {
    transport.onmessage({ jsonrpc: "2.0", ...message });
    await new Promise((resolve) => setImmediate(resolve));
    return sent.at(-1);
  };

  const init = await call({ id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  assert.deepEqual(init.result, { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "workspace", version: "1.0.0" } });
  const before = sent.length;
  await call({ method: "notifications/initialized" });
  assert.equal(sent.length, before, "a notification gets no answer");
  assert.deepEqual((await call({ id: 2, method: "ping" })).result, {});
  const listed = (await call({ id: 3, method: "tools/list" })).result.tools;
  assert.deepEqual(listed.map((tool: any) => tool.name), ["echo", "boom", "slow"]);
  // Deferred tools would cost the model a search before every first use.
  assert.ok(listed.every((tool: any) => tool._meta["anthropic/alwaysLoad"] === true));
  assert.deepEqual((await call({ id: 4, method: "tools/call", params: { name: "echo", arguments: { a: 1 } } })).result, {
    content: [{ type: "text", text: '{"a":1}' }],
  });
  assert.deepEqual((await call({ id: 5, method: "tools/call", params: { name: "echo", arguments: "junk" } })).result.content[0].text, "{}");
  assert.deepEqual((await call({ id: 6, method: "tools/call", params: { name: "boom" } })).result, {
    content: [{ type: "text", text: "Tool failed: no" }], isError: true,
  });
  assert.equal((await call({ id: 7, method: "tools/call", params: { name: "nope" } })).error.code, -32602);
  assert.equal((await call({ id: 8, method: "resources/list" })).error.code, -32601);

  // A cancelled request reaches the running tool.
  transport.onmessage({ jsonrpc: "2.0", id: "s1", method: "tools/call", params: { name: "slow" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(slowSignal?.aborted, false);
  assert.deepEqual((await call({ method: "notifications/cancelled", params: { requestId: "s1" } })).result, {
    content: [{ type: "text", text: "stopped" }], isError: true,
  });
  // Closing stops what still runs.
  transport.onmessage({ jsonrpc: "2.0", id: "s2", method: "tools/call", params: { name: "slow" } });
  await new Promise((resolve) => setImmediate(resolve));
  server.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.at(-1).id, "s2");
});

// ---- the delivery bridge ---------------------------------------------------------

test("imports are read from prose only and never leave the project", () => {
  assert.deepEqual(claudeInstructionImports("See @docs/a.md, @./b.md and @../up.md. Mail a@b.example", "CLAUDE.md"), ["docs/a.md", "b.md"]);
  assert.deepEqual(claudeInstructionImports("@a.md `@code.md`\n```\n@fenced.md\n```\n@/etc/passwd @~/x.md", "CLAUDE.md"), ["a.md"]);
  // Relative to the importing file, not to the project root.
  assert.deepEqual(claudeInstructionImports("@peer.md @../top.md @../../root.md @../../../out.md", "docs/guide/a.md"), ["docs/guide/peer.md", "docs/top.md", "root.md"]);
  assert.equal(claudeInstructionImports(Array.from({ length: 80 }, (_, i) => `@f${i}.md`).join(" "), "CLAUDE.md").length, 24);
});

test("skill frontmatter and settings hooks are read defensively", () => {
  assert.deepEqual(parseSkillFrontmatter("---\nname: a\ndescription: 'Does b'\n---\nbody"), { name: "a", description: "Does b", modelInvocable: true });
  assert.deepEqual(parseSkillFrontmatter("---\nname: a\ndisable-model-invocation: true\n---"), { name: "a", modelInvocable: false });
  assert.deepEqual(parseSkillFrontmatter("name: not-frontmatter"), { modelInvocable: true });

  const { hooks, skipped } = bridgedHooksFromSettings(SETTINGS);
  assert.deepEqual(hooks.map((hook) => [hook.event, hook.matcher, hook.condition]), [
    ["SessionStart", undefined, undefined],
    ["UserPromptSubmit", undefined, undefined],
    ["UserPromptSubmit", undefined, undefined],
    ["PreToolUse", "Bash", undefined],
    ["PreToolUse", "Edit|Write", undefined],
    ["PreToolUse", "Read", "Read(/docs/**)"],
    ["PostToolUse", "Edit", undefined],
  ]);
  assert.equal(skipped, 2, "a prompt hook and a Stop hook are not bridged");
  assert.equal(hooks[0]!.timeoutMs, 60_000);
  assert.equal(bridgedHooksFromSettings({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "x", timeout: 9_999 }] }] } }).hooks[0]!.timeoutMs, 600_000);
  for (const junk of [undefined, null, 3, "x", [], { hooks: 3 }, { hooks: { PreToolUse: "x" } }, { hooks: { PreToolUse: [null, { hooks: "x" }, { hooks: [null, { type: "command" }] }] } }]) {
    assert.deepEqual(bridgedHooksFromSettings(junk).hooks, []);
  }
});

test("a hook can refuse or ask, and can never approve", () => {
  const ran = (code: number, stdout = "", stderr = "") => ({ code, stdout, stderr, timedOut: false, aborted: false });
  const json = (value: unknown) => ran(0, JSON.stringify(value));
  assert.deepEqual(interpretHookResult("PreToolUse", ran(2, "", "No pushing\n")), { block: "No pushing" });
  assert.deepEqual(interpretHookResult("PreToolUse", ran(2)), { block: "Blocked by a project hook." });
  assert.deepEqual(interpretHookResult("PreToolUse", ran(1, "x", "broken")), {}, "a failing hook does not block");
  assert.deepEqual(interpretHookResult("PreToolUse", ran(0, "plain text")), {});
  assert.deepEqual(interpretHookResult("PreToolUse", json({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "Nope" } })), { block: "Nope" });
  assert.deepEqual(interpretHookResult("PreToolUse", json({ hookSpecificOutput: { permissionDecision: "ask" } })), { ask: "A project hook asks for confirmation." });
  assert.deepEqual(interpretHookResult("PreToolUse", json({ hookSpecificOutput: { permissionDecision: "allow", additionalContext: "fyi" } })), { context: "fyi" });
  assert.deepEqual(interpretHookResult("PreToolUse", json({ decision: "approve" })), {});
  assert.deepEqual(interpretHookResult("PreToolUse", json({ decision: "block", reason: "Old style" })), { block: "Old style" });
  assert.deepEqual(interpretHookResult("PostToolUse", json({ continue: false, stopReason: "Stop here" })), { block: "Stop here" });
  assert.deepEqual(interpretHookResult("PostToolUse", json({ hookSpecificOutput: { permissionDecision: "deny" } })), {}, "only PreToolUse decides permission");
  assert.deepEqual(interpretHookResult("SessionStart", ran(0, "Context line\n")), { context: "Context line" });
  assert.deepEqual(interpretHookResult("SessionStart", ran(2, "", "noise")), {}, "a session start cannot be blocked");
  assert.deepEqual(interpretHookResult("UserPromptSubmit", ran(0, "{not json")), { context: "{not json" });
  assert.deepEqual(interpretHookResult("PreToolUse", { ...ran(2, "", "late"), timedOut: true }), {});
  assert.deepEqual(interpretHookResult("PreToolUse", ran(255, "", "ssh: connection refused")), {});
  assert.equal(interpretHookResult("SessionStart", ran(0, "x".repeat(50_000))).context!.length < 10_100, true);
});

test("a file cannot forge a section of the bridge's answer", () => {
  const sections = parseBridgeSections("junk\nSEP home\n/home/dev\nSEP instructions CLAUDE.md\nline\nOTHER settings x\n{}\nSEP end\n", "SEP");
  assert.deepEqual(sections, [["home", "/home/dev"], ["instructions CLAUDE.md", "line\nOTHER settings x\n{}"], ["end", ""]]);
});

test("the bridge delivers the project's instructions, imports, skills and rules from the host", async (t) => {
  const { dir, bridge } = await open(t);

  for (const codeword of ["BLUE-HERON", "GREY-WOLF", "AMBER-LYNX", "RED-KITE"]) assert.match(bridge.instructions, new RegExp(codeword));
  assert.doesNotMatch(bridge.instructions, /must not load|GREEN-OTTER|PINK-SWAN|SILVER-CRANE|hunter2/);
  assert.match(bridge.instructions, new RegExp(`## ${dir}/CLAUDE.md\n# Shop`));
  assert.match(bridge.instructions, new RegExp(`## ${dir}/docs/conventions.md \\(imported by CLAUDE.md\\)`));
  assert.match(bridge.instructions, new RegExp(`## ${dir}/docs/deeper.md \\(imported by docs/conventions.md\\)`));

  assert.deepEqual(bridge.skills, [
    { name: "release-notes", description: "Write the release notes", file: `${dir}/.claude/skills/release-notes/SKILL.md` },
    { name: "unnamed", description: "", file: `${dir}/.claude/skills/unnamed/SKILL.md` },
  ]);
  assert.match(bridge.instructions, new RegExp(`- release-notes: Write the release notes — ${dir}/.claude/skills/release-notes/SKILL.md`));

  // Only restricting rules cross: the project's `allow` list is never read.
  assert.deepEqual(bridge.rules, { deny: ["Bash(git push --force:*)", "Read(./secrets/**)", "Write(/dist/**)"], ask: ["Bash(git log:*)"] });
  assert.equal(bridge.hooks.length, 7);
  assert.deepEqual(bridge.skipped, [".claude/commands", ".mcp.json", "2 hooks of an unsupported type or event"]);
  assert.equal(bridge.home, process.env.HOME);
});

test("a nested CLAUDE.md is delivered once, when its folder is first touched", async (t) => {
  const { dir, bridge } = await open(t);
  assert.equal(await bridge.nestedInstructions(`${dir}/README.md`, "file"), "");
  assert.equal(await bridge.nestedInstructions("/etc/passwd", "file"), "");
  const first = await bridge.nestedInstructions(`${dir}/shop/cart/items.py`, "file");
  assert.match(first, /Project instructions for files under shop\/ .*\nShop rules: GREEN-OTTER\./);
  assert.match(first, /Project instructions for files under shop\/cart\/ .*\nCart rules: PINK-SWAN\./);
  assert.equal(await bridge.nestedInstructions(`${dir}/shop/pricing.py`, "file"), "", "already delivered");
  assert.equal(await bridge.nestedInstructions(`${dir}/shop`, "directory"), "");

  const second = await loadRemoteProjectBridge(createRemoteWorkspace(host, dir), "native-2");
  assert.match(await second.nestedInstructions(`${dir}/shop`, "directory"), /GREEN-OTTER/);
  assert.match(await second.nestedInstructions(`${dir}/shop/cart`, "directory"), /PINK-SWAN/);
});

test("a project without any Claude Code files delivers nothing and still works", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-remote-empty-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bridge = await loadRemoteProjectBridge(createRemoteWorkspace(host, dir), "native-1");
  assert.equal(bridge.instructions, "");
  assert.deepEqual([bridge.rules, bridge.skills, bridge.hooks, bridge.skipped], [{ deny: [], ask: [] }, [], [], []]);
  assert.deepEqual(await bridge.runHooks("SessionStart", { payload: {} }), { context: [] });

  writeFileSync(join(dir, "CLAUDE.md"), "ok\n");
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude/settings.json"), "{ not json");
  const broken = await loadRemoteProjectBridge(createRemoteWorkspace(host, dir), "native-1");
  assert.match(broken.instructions, /ok/);
  assert.deepEqual(broken.skipped, [".claude/settings.json (not valid JSON)"]);
});

test("an unreachable host or a missing project folder fails the start plainly", async () => {
  const down: RemoteProcessHost = { ...host, processCommand: () => ({ command: "sh", args: ["-c", "echo 'ssh: connect refused' >&2; exit 255"] }) };
  await assert.rejects(loadRemoteProjectBridge(createRemoteWorkspace(down, "/srv/app"), "n"), (error: Error & { code?: string }) =>
    error.code === "runtime-unavailable" && /Could not reach dev@remote: ssh: connect refused/.test(error.message));
  await assert.rejects(loadRemoteProjectBridge(createRemoteWorkspace(host, "/nonexistent/polyth-project"), "n"), { code: "runtime-unavailable" });
});

// ---- policy and hooks in front of each call --------------------------------------

/** Runs the session's own PreToolUse callback, as the SDK does before a call. */
const pre = async (session: Awaited<ReturnType<typeof open>>["session"], tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}, id = "tu") => {
  const out = await session.hooks.PreToolUse![0]!.hooks[0]!(
    { hook_event_name: "PreToolUse", tool_name: `mcp__workspace__${tool}`, tool_input: input, ...extra } as any, id, { signal: new AbortController().signal },
  ) as any;
  return out.hookSpecificOutput as { permissionDecision: string; permissionDecisionReason?: string; additionalContext?: string };
};

test("reads inside the project pass without a question; changes are asked under the native name", async (t) => {
  const { dir, session } = await open(t);

  assert.equal((await pre(session, "bash", { command: "git status" })).permissionDecision, "allow");
  assert.equal((await pre(session, "read", { file_path: "README.md" })).permissionDecision, "allow");
  assert.equal((await pre(session, "grep", { pattern: "total" })).permissionDecision, "allow");
  assert.deepEqual(session.permissionFor("mcp__workspace__read", { file_path: "README.md" }), { kind: "allow" });

  assert.equal((await pre(session, "bash", { command: "npm test" })).permissionDecision, "ask");
  assert.deepEqual(session.permissionFor("mcp__workspace__bash", { command: "npm test" }), {
    kind: "ask", permission: "Bash", patterns: ["npm test"], metadata: { host: "dev@remote" },
  });
  assert.deepEqual(session.permissionFor("mcp__workspace__edit", { file_path: "shop/pricing.py", old_string: "a", new_string: "b" }), {
    kind: "ask", permission: "Edit", patterns: [`${dir}/shop/pricing.py`], metadata: { host: "dev@remote" },
  });
  assert.deepEqual(session.permissionFor("mcp__workspace__read", { file_path: "/etc/passwd" }), {
    kind: "ask", permission: "Read", patterns: ["/etc/passwd"], metadata: { host: "dev@remote" },
  });
  // Tools that are not the remote workspace's are not this policy's to answer.
  assert.equal(session.permissionFor("Bash", { command: "ls" }), undefined);
  assert.equal(session.permissionFor("mcp__workspace__other", {}), undefined);
  assert.equal(session.permissionFor("mcp__polyth-agent-tools__web_search", {}), undefined);
  assert.deepEqual(await session.hooks.PreToolUse![0]!.hooks[0]!({ hook_event_name: "PreToolUse", tool_name: "WebFetch" } as any, "x", { signal: new AbortController().signal }), { continue: true });
});

test("the project's and the person's deny rules stop the remote shell", async (t) => {
  const { dir, session } = await open(t, { deny: ["Bash(rm:*)"], ask: ["Read(/README.md)"] });

  const forced = await pre(session, "bash", { command: "git push --force origin main" });
  assert.equal(forced.permissionDecision, "deny");
  assert.match(forced.permissionDecisionReason!, /Blocked by the permission rule Bash\(git push --force:\*\)/);
  assert.equal(session.permissionFor("mcp__workspace__bash", { command: "ls && rm -rf build" })?.kind, "deny", "the person's own rule on this machine");
  assert.equal(session.permissionFor("mcp__workspace__read", { file_path: "secrets/token.txt" })?.kind, "deny");
  assert.equal(session.permissionFor("mcp__workspace__write", { file_path: "dist/a.js", content: "" })?.kind, "deny", "from settings.local.json");
  // The project's own `allow` list grants nothing: `rm` was on it.
  assert.equal((await pre(session, "bash", { command: "rm -f x" })).permissionDecision, "deny");
  assert.equal(session.permissionFor("mcp__workspace__edit", { file_path: "a.py" })?.kind, "ask");
  // `ask` rules send an otherwise free read to a person.
  assert.equal(session.permissionFor("mcp__workspace__bash", { command: "git log --oneline" })?.kind, "ask");
  assert.equal(session.permissionFor("mcp__workspace__read", { file_path: "README.md" })?.kind, "ask");
  // A refused call runs no project hook.
  assert.deepEqual(hookLog(dir), []);
});

test("plan mode refuses changes on the host until it ends", async (t) => {
  const { session } = await open(t);
  const planned = await pre(session, "write", { file_path: "notes.md", content: "x" }, { permission_mode: "plan" });
  assert.equal(planned.permissionDecision, "deny");
  assert.match(planned.permissionDecisionReason!, /Plan mode is on/);
  assert.equal(session.permissionFor("mcp__workspace__bash", { command: "npm test" })?.kind, "deny");
  assert.equal((await pre(session, "bash", { command: "ls" }, { permission_mode: "plan" })).permissionDecision, "allow");
  assert.equal((await pre(session, "bash", { command: "npm test" }, { permission_mode: "default" })).permissionDecision, "ask");
  assert.equal(session.permissionFor("mcp__workspace__bash", { command: "npm test" })?.kind, "ask");
  assert.ok(REMOTE_HANDS_DISALLOWED_TOOLS.includes("EnterPlanMode"), "plan mode needs the native file tools for its plan file");
});

test("the project's hooks run on the host with the native tool name and can only restrict", async (t) => {
  const { dir, session } = await open(t);

  // PreToolUse: sees `Bash` and the command; exit 2 refuses with its message.
  assert.equal((await pre(session, "bash", { command: "ls -la" })).permissionDecision, "allow");
  const pushed = await pre(session, "bash", { command: "git push origin main" });
  assert.deepEqual([pushed.permissionDecision, pushed.permissionDecisionReason], ["deny", "Pushing is not allowed here"]);
  const logged = hookLog(dir);
  assert.deepEqual(logged.map((entry) => [entry.hook_event_name, entry.tool_name, entry.tool_input.command, entry.cwd, entry.session_id]), [
    ["PreToolUse", "Bash", "ls -la", dir, "native-1"],
    ["PreToolUse", "Bash", "git push origin main", dir, "native-1"],
  ]);

  // A hook's "allow" approves nothing: the edit is still asked.
  assert.equal((await pre(session, "edit", { file_path: "shop/pricing.py", old_string: "a", new_string: "b" })).permissionDecision, "ask");

  // A hook's "ask" hands an otherwise free read to a person, once.
  const docs = await pre(session, "read", { file_path: "docs/guide.md" }, {}, "tu-docs");
  assert.deepEqual([docs.permissionDecision, docs.permissionDecisionReason], ["ask", "Docs are under review"]);
  assert.equal(session.permissionFor("mcp__workspace__read", { file_path: "docs/guide.md" }, "tu-docs")?.kind, "ask");
  assert.equal(session.permissionFor("mcp__workspace__read", { file_path: "docs/guide.md" }, "tu-docs")?.kind, "allow");
  // Its `if` filter keeps it away from other reads.
  assert.equal((await pre(session, "read", { file_path: "README.md" })).permissionDecision, "allow");

  // PostToolUse: paths are absolute, the result is text, a block is feedback.
  const post = await session.hooks.PostToolUse![0]!.hooks[0]!({
    hook_event_name: "PostToolUse", tool_name: "mcp__workspace__edit", tool_input: { file_path: "shop/pricing.py" },
    tool_response: [{ type: "text", text: "Edited" }],
  } as any, "tu", { signal: new AbortController().signal });
  assert.deepEqual(post, { decision: "block", reason: "Run the formatter" });
  const last = hookLog(dir).at(-1)!;
  assert.deepEqual([last.hook_event_name, last.tool_name, last.tool_input.file_path, last.tool_response], ["PostToolUse", "Edit", `${dir}/shop/pricing.py`, "Edited"]);

  // UserPromptSubmit adds context; a prompt cannot be taken back.
  const signal = new AbortController().signal;
  assert.equal(session.hooks.SessionStart, undefined, "Claude Code starts before an SDK hook can be registered");
  assert.deepEqual(await session.hooks.UserPromptSubmit![0]!.hooks[0]!({ hook_event_name: "UserPromptSubmit", prompt: "do it" } as any, undefined, { signal }), {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "A hook of this project objected to the request: No tickets were named\n\nSprint 12" },
  });
  // Nothing ran on this machine: the only log is in the project on the host.
  assert.equal(existsSync(join(process.cwd(), LOG)), false);
});

test("a tool result carries the instructions of the folder it touched", async (t) => {
  const { dir, session } = await open(t);
  const sent: any[] = [];
  const transport: any = { send: async (message: unknown) => { sent.push(message); } };
  await (session.mcpServers.workspace as any).instance.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const id = sent.length + 1;
    transport.onmessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    while (sent.at(-1)?.id !== id) await new Promise((resolve) => setTimeout(resolve, 10));
    return sent.at(-1).result as { content: Array<{ text: string }>; isError?: boolean };
  };

  const read = await call("read", { file_path: "shop/pricing.py" });
  assert.match(read.content[0]!.text, /^ {5}1\tdef total\(items\):/);
  assert.match(read.content[0]!.text, /<system-reminder>\nProject instructions for files under shop\/ .*\nShop rules: GREEN-OTTER\.\n<\/system-reminder>$/s);
  assert.doesNotMatch((await call("read", { file_path: "shop/pricing.py" })).content[0]!.text, /GREEN-OTTER/);
  assert.match((await call("glob", { pattern: "*.py", path: "shop/cart" })).content[0]!.text, /PINK-SWAN/);
  // A failed call and the shell carry nothing extra.
  assert.equal((await call("read", { file_path: "shop/missing.py" })).isError, true);
  assert.equal((await call("bash", { command: "echo hi" })).content[0]!.text, "hi\n");
  assert.equal((await call("edit", { file_path: "shop/pricing.py", old_string: "sum(items)", new_string: "sum(items) * 1" })).isError, undefined);
  assert.match(readFileSync(join(dir, "shop/pricing.py"), "utf8"), /sum\(items\) \* 1/);
});

test("the person's own restricting rules come from their Claude Code settings", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-claude-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await claudeLocalRestrictingRules(dir), {}, "no settings file");
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash"], deny: ["Bash(rm:*)"], ask: ["Edit"] } }));
  assert.deepEqual(await claudeLocalRestrictingRules(dir), { deny: ["Bash(rm:*)"], ask: ["Edit"] });
  writeFileSync(join(dir, "settings.json"), "{ broken");
  assert.deepEqual(await claudeLocalRestrictingRules(dir), {});
});

// ---- the runtime -----------------------------------------------------------------

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

async function openRuntime(t: { after(fn: () => void): void }) {
  const dir = project(t);
  const localCwd = mkdtempSync(join(tmpdir(), "polyth-remote-placeholder-"));
  t.after(() => rmSync(localCwd, { recursive: true, force: true }));
  const context = { spaceId: "s", projectId: "p", cwd: dir, sessionId: "canonical", remote: true };
  let options: Record<string, any> = {};
  let closed = false;
  const infoDirs: unknown[] = [];
  const receipts: Record<string, string> = {};
  const sdk = {
    query(args: any) {
      options = args.options;
      let wake: (() => void) | undefined;
      return {
        async *[Symbol.asyncIterator]() {
          while (!closed) await new Promise<void>((resolve) => { wake = resolve; });
        },
        initializationResult: async () => ({}),
        supportedModels: async () => [],
        getContextUsage: async () => ({ totalTokens: 1, maxTokens: 10 }),
        interrupt: async () => {},
        close() { closed = true; wake?.(); },
      } as any;
    },
    getSessionInfo: async (_id: string, opts: { dir?: string }) => { infoDirs.push(opts?.dir); return undefined as any; },
  };
  const authority = {
    authorityId: "owned", generation: 1, receipts, releasedAuthorities: [],
    spawn() { throw new Error("SDK fake does not spawn"); },
    receipt: async (operationId: string, id: string) => { receipts[operationId] = id; },
    close: async () => { closed = true; },
  } as Awaited<ReturnType<typeof createProcessAuthority>>;
  const runtime = await createClaudeRuntime(context, sdk, authority, {
    remoteWorkspace: claudeRemoteWorkspace({ remote: host, root: dir, localCwd, localRules: async () => ({ deny: ["Bash(rm:*)"] }) }),
  });
  const events: RuntimeEvent[] = [];
  runtime.onEvent((_sid, event) => events.push(event));
  await runtime.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: dir }, "create");
  t.after(() => runtime.dispose());
  return { runtime, events, dir, localCwd, options: () => options, infoDirs };
}

test("a remote project launches Claude Code here, on a placeholder, with host tools in place of its own", async (t) => {
  const f = await openRuntime(t);
  const options = f.options();

  assert.equal(options.cwd, f.localCwd, "the CLI never runs in a path that exists only on the host");
  for (const tool of ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "NotebookEdit", "EnterPlanMode", "Agent", "Task"]) {
    assert.ok(options.disallowedTools.includes(tool), `${tool} is switched off`);
  }
  assert.equal(options.mcpServers.workspace.type, "sdk");
  assert.equal(typeof options.mcpServers.workspace.instance.connect, "function");
  assert.equal(typeof options.hooks.PreToolUse[0].hooks[0], "function");
  assert.equal(options.hooks.PreToolUse[0].matcher, "mcp__workspace__.*");
  assert.equal(options.systemPrompt.preset, "claude_code");
  assert.match(options.systemPrompt.append, new RegExp(`It is on dev@remote, in ${f.dir}, reached over SSH`));
  assert.match(options.systemPrompt.append, /BLUE-HERON[\s\S]*release-notes: Write the release notes/);
  // The project's SessionStart hook ran on the host; its output is in the prompt.
  assert.match(options.systemPrompt.append, /# Output of the project's SessionStart hook on dev@remote\nRelease train: WHITE-MOTH$/);
});

test("the runtime answers remote calls by policy and asks the session about the rest", async (t) => {
  const f = await openRuntime(t);
  const canUseTool = f.options().canUseTool as (tool: string, input: Record<string, unknown>, options: any) => Promise<any>;
  const signal = new AbortController().signal;

  // Read-only: answered here, no card.
  assert.deepEqual(await canUseTool("mcp__workspace__bash", { command: "git status" }, { signal, toolUseID: "t1" }), {
    behavior: "allow", updatedInput: { command: "git status" },
  });
  // A deny rule: refused here, no card.
  const denied = await canUseTool("mcp__workspace__bash", { command: "rm -rf build" }, { signal, toolUseID: "t2" });
  assert.equal(denied.behavior, "deny");
  assert.match(denied.message, /Blocked by the permission rule Bash\(rm:\*\)/);
  assert.deepEqual(f.events.filter((event) => event.type === "permission/requested"), []);

  // A change: asked as `Bash` with the command, so rules and risk apply to it.
  const pending = canUseTool("mcp__workspace__bash", { command: "npm test" }, { signal, toolUseID: "t3" });
  await flush();
  assert.deepEqual(f.events.filter((event) => event.type === "permission/requested"), [{
    type: "permission/requested", requestId: "t3", permission: "Bash", patterns: ["npm test"], metadata: { host: "dev@remote" },
  }]);
  await f.runtime.replyPermission("canonical", "t3", "once");
  assert.deepEqual(await pending, { behavior: "allow", updatedInput: { command: "npm test" } });

  const edit = canUseTool("mcp__workspace__edit", { file_path: "shop/pricing.py", old_string: "a", new_string: "b" }, { signal, toolUseID: "t4" });
  await flush();
  const asked = f.events.at(-1) as Extract<RuntimeEvent, { type: "permission/requested" }>;
  assert.deepEqual([asked.permission, asked.patterns], ["Edit", [`${f.dir}/shop/pricing.py`]]);
  await f.runtime.replyPermission("canonical", "t4", "reject");
  assert.equal((await edit).behavior, "deny");

  // Any other tool is asked about as before.
  const other = canUseTool("WebFetch", { url: "https://example.com" }, { signal, toolUseID: "t5" });
  await flush();
  const web = f.events.at(-1) as Extract<RuntimeEvent, { type: "permission/requested" }>;
  assert.deepEqual([web.permission, web.patterns, web.metadata], ["WebFetch", ["WebFetch"], undefined]);
  await f.runtime.replyPermission("canonical", "t5", "once");
  await other;
});

test("closing the session stops its host tools", async (t) => {
  const f = await openRuntime(t);
  const instance = f.options().mcpServers.workspace.instance;
  const sent: any[] = [];
  const transport: any = { send: async (message: unknown) => { sent.push(message); } };
  await instance.connect(transport);
  transport.onmessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bash", arguments: { command: "sleep 30" } } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const started = Date.now();
  await f.runtime.dispose();
  while (!sent.length && Date.now() - started < 5_000) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent[0]?.result?.isError, true, "the running command was cancelled");
  assert.ok(Date.now() - started < 5_000);
});
