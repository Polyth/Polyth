import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  classifyAgyPermission,
  createAntigravityPermissionBridge,
  parseAgyHookRequest,
} from "../src/permissions.ts";

const request = (tool: string, args: Record<string, unknown>) => parseAgyHookRequest({
  conversationId: "native-a",
  stepIdx: 2,
  toolCall: { name: tool, args },
})!;

test("workspace reads and edits are allowed by default, but traversal and symlink escape still ask", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "polyth-agy-permissions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await Promise.all([mkdir(join(workspace, "src"), { recursive: true }), mkdir(outside)]);
  await symlink(outside, join(workspace, "linked-outside"));

  assert.deepEqual(
    await classifyAgyPermission(request("write_to_file", { TargetFile: join(workspace, "src", "new.ts") }), workspace),
    { kind: "allow", permission: "edit" },
  );
  assert.deepEqual(
    await classifyAgyPermission(request("view_file", { AbsolutePath: join(workspace, "src", "new.ts") }), workspace),
    { kind: "allow", permission: "read" },
  );
  assert.deepEqual(
    await classifyAgyPermission(request("sed_file", { path: join(workspace, "src", "new.ts") }), workspace),
    { kind: "allow", permission: "edit" },
  );
  assert.equal(
    (await classifyAgyPermission(request("write_to_file", { TargetFile: join(outside, "escape.ts") }), workspace)).kind,
    "request",
  );
  assert.equal(
    (await classifyAgyPermission(request("write_to_file", { TargetFile: join(workspace, "linked-outside", "escape.ts") }), workspace)).kind,
    "request",
  );
});

test("commands become Polyth bash requests and malformed hook payloads fail validation", async () => {
  assert.deepEqual(await classifyAgyPermission(request("run_command", { CommandLine: "npm test" }), "/missing"), {
    kind: "request",
    permission: "bash",
    patterns: ["npm test"],
    tool: "run_command",
    stepIdx: 2,
  });
  assert.equal(parseAgyHookRequest({ toolCall: { name: "run_command", args: {} }, stepIdx: -1 }), undefined);
});

test("call_mcp_tool asks about the MCP tool it wraps, not the wrapper", async () => {
  assert.deepEqual(await classifyAgyPermission(request("call_mcp_tool", {
    ServerName: "polyth-agent-tools",
    ToolName: "polyth_todo",
    Arguments: { todos: [{ id: "1", status: "in_progress", title: "Investigate" }] },
  }), "/missing"), {
    kind: "request",
    permission: "mcp__polyth-agent-tools__polyth_todo",
    patterns: ["mcp__polyth-agent-tools__polyth_todo"],
    tool: "mcp__polyth-agent-tools__polyth_todo",
    stepIdx: 2,
  });
  // Arguments may arrive JSON-encoded; a wrapped browser call is still a browser request.
  assert.deepEqual(await classifyAgyPermission(request("call_mcp_tool", {
    ServerName: "polyth-agent-tools",
    ToolName: "polyth_browser",
    Arguments: JSON.stringify({ action: "open", parameters: { url: "https://example.com" } }),
  }), "/missing"), {
    kind: "request",
    permission: "browser",
    patterns: ["open: https://example.com"],
    tool: "mcp__polyth-agent-tools__polyth_browser",
    stepIdx: 2,
  });
  // Without a server and tool name the wrapper itself is all there is to ask about.
  assert.equal((await classifyAgyPermission(request("call_mcp_tool", { ToolName: "x" }), "/missing") as { permission?: string }).permission, "call_mcp_tool");
});

test("reading the CLI's MCP tool schemas needs no approval; escaping that cache still asks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "polyth-agy-schemas-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const schemas = join(root, "home", ".gemini", "antigravity-cli", "mcp");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(join(schemas, "polyth-agent-tools"), { recursive: true })]);
  await symlink(root, join(schemas, "escape"));
  const options = { mcpSchemaRoot: schemas };
  assert.deepEqual(
    await classifyAgyPermission(request("view_file", { AbsolutePath: join(schemas, "polyth-agent-tools", "polyth_todo.json") }), workspace, options),
    { kind: "allow", permission: "read" },
  );
  assert.deepEqual(
    await classifyAgyPermission(request("list_dir", { DirectoryPath: join(schemas, "polyth-agent-tools") }), workspace, options),
    { kind: "allow", permission: "read" },
  );
  assert.equal((await classifyAgyPermission(request("view_file", { AbsolutePath: join(schemas, "escape", "secret") }), workspace, options)).kind, "request");
  assert.equal((await classifyAgyPermission(request("view_file", { AbsolutePath: join(schemas, "..", "config", "mcp_config.json") }), workspace, options)).kind, "request");
  assert.equal((await classifyAgyPermission(request("view_file", { AbsolutePath: join(schemas, "polyth-agent-tools", "polyth_todo.json") }), workspace)).kind, "request");
});

test("call_mcp_tool without names falls back to the wrapper", async () => {
  assert.equal((await classifyAgyPermission(request("call_mcp_tool", { ToolName: "x" }), "/missing") as { permission?: string }).permission, "call_mcp_tool");
});

const invokeClient = (file: string, input: unknown, event?: string): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [file, ...(event ? [event] : [])], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code) => {
    if (code !== 0) reject(new Error(`hook client exited ${code}: ${stderr}`));
    else {
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    }
  });
  child.stdin.end(JSON.stringify(input));
});

test("generated hook bridge returns decisions and fails closed after the owner closes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "polyth-agy-bridge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bridge = await createAntigravityPermissionBridge({
    root,
    handle: async () => ({ decision: "allow" }),
  });
  const client = join(root, "polyth-hook-client.mjs");
  const hooks = JSON.parse(await readFile(join(root, ".agents", "hooks.json"), "utf8"));
  assert.equal(hooks["polyth-permission-gate"].PreToolUse[0].matcher, "*");
  assert.deepEqual(await invokeClient(client, {
    conversationId: "native-a",
    stepIdx: 2,
    toolCall: { name: "run_command", args: { CommandLine: "npm test" } },
  }), { decision: "allow" });
  await bridge.close();
  assert.deepEqual(await invokeClient(client, {}), {
    decision: "deny",
    reason: "Polyth approval bridge is unavailable",
  });
});

test("loop hooks are flat handlers that name their event and fail open, unlike the tool gate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "polyth-agy-loop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen: Array<{ event: string; payload: unknown }> = [];
  const bridge = await createAntigravityPermissionBridge({
    root,
    handle: async (payload, event) => {
      seen.push({ event, payload });
      if (event === "PreInvocation") return { injectSteps: [{ userMessage: "Use tabs" }], extra: "dropped" } as never;
      if (event === "Stop") return { decision: "continue", reason: "One more message", smuggled: true } as never;
      return { decision: "allow", injectSteps: [] } as never;
    },
  });
  const client = join(root, "polyth-hook-client.mjs");
  const hooks = JSON.parse(await readFile(join(root, ".agents", "hooks.json"), "utf8"))["polyth-permission-gate"];
  // PreInvocation and Stop take no matcher group; each command names its event.
  assert.match(hooks.PreInvocation[0].command, / PreInvocation$/);
  assert.match(hooks.Stop[0].command, / Stop$/);
  assert.match(hooks.PreToolUse[0].hooks[0].command, / PreToolUse$/);
  assert.equal(hooks.PreToolUse[0].hooks[0].timeout, 86_400);

  // Every reply is rebuilt per event, so no unexpected field reaches the CLI.
  assert.deepEqual(await invokeClient(client, { conversationId: "native-a", invocationNum: 1 }, "PreInvocation"),
    { injectSteps: [{ userMessage: "Use tabs" }] });
  assert.deepEqual(await invokeClient(client, { conversationId: "native-a", finalModelOutput: "long private text" }, "Stop"),
    { decision: "continue", reason: "One more message" });
  assert.deepEqual(await invokeClient(client, { conversationId: "native-a", stepIdx: 1, toolCall: { name: "view_file", args: {} } }, "PreToolUse"),
    { decision: "allow" });
  assert.deepEqual(seen.map((entry) => entry.event), ["PreInvocation", "Stop", "PreToolUse"]);
  // The model's final text never crosses the bridge.
  assert.equal(JSON.stringify(seen[1]?.payload).includes("long private text"), false);

  await bridge.close();
  // Without the bridge, steps are simply not injected and the loop may stop;
  // a tool still fails closed.
  assert.deepEqual(await invokeClient(client, { conversationId: "native-a" }, "PreInvocation"), {});
  assert.deepEqual(await invokeClient(client, { conversationId: "native-a" }, "Stop"), {});
  assert.deepEqual(await invokeClient(client, {}, "PreToolUse"), { decision: "deny", reason: "Polyth approval bridge is unavailable" });
});
