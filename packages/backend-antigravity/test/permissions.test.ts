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

const invokeClient = (file: string, input: unknown): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [file], { env, stdio: ["pipe", "pipe", "pipe"] });
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
