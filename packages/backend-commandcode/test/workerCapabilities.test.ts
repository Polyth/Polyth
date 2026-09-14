import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDCODE_WORKER_SOURCE } from "../src/workerSource.ts";

test("Command Code worker projects only documented transient capability CLI surfaces", () => {
  assert.match(COMMANDCODE_WORKER_SOURCE, /message\.capabilityModPath/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /args\.push\("--mod", message\.capabilityModPath\)/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /args\.push\("--mod", message\.toolModPath\)/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /args\.push\("--skill", root\)/);
  assert.doesNotMatch(COMMANDCODE_WORKER_SOURCE, /\.mcp\.json|command-code\s+mcp\s+add|--yolo|--trust/);
});

test("scoped Polyth tool bearer stays only in worker memory", () => {
  assert.match(COMMANDCODE_WORKER_SOURCE, /const invokeScopedTool =/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /authorization: "Bearer " \+ turn\.toolBridge\.token/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /target\.pathname !== AGENT_TOOLS_PATH/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /const loopback = host === "127\.0\.0\.1"/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /stdio: \["pipe", "pipe", "pipe", "pipe", "pipe"\]/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /turn\.child\.stdio\?\.\[3\]/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /turn\.child\.stdio\?\.\[4\]/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /type: "polyth-tool-invoked"/);
  assert.doesNotMatch(COMMANDCODE_WORKER_SOURCE, /spawn\(spec\.command/);
  assert.doesNotMatch(COMMANDCODE_WORKER_SOURCE, /startToolBridge/);
  assert.doesNotMatch(COMMANDCODE_WORKER_SOURCE, /agentToolsMcp\.mjs/);

  const commandEnv = /const env = \{([\s\S]*?)\n  \};\n  const child = spawn/.exec(COMMANDCODE_WORKER_SOURCE)?.[1] ?? "";
  assert.ok(commandEnv, "Command Code child environment block must be present");
  assert.doesNotMatch(commandEnv, /POLYTH_AGENT_TOOLS_URL|POLYTH_AGENT_TOOLS_TOKEN/);
});

test("direct tool relay uses the scoped capability id and canonical loopback route", () => {
  assert.match(COMMANDCODE_WORKER_SOURCE, /JSON\.stringify\(\{ id: call\.capabilityId, arguments: call\.input \?\? \{\} \}\)/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /method: "POST"/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /AGENT_TOOLS_PATH = "\/internal\/agent-tools"/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /if \(outcome\.observed\) send\(\{ type: "polyth-tool-invoked"/);
});

test("direct tool relay is bounded, cancellable and fail-closed", () => {
  assert.match(COMMANDCODE_WORKER_SOURCE, /pending\.get\(requestId\)\?\.abort\(\)/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /if \(bytes\.length > MAX_LINE\)/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /requests\.on\("error", failRelay\)/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /requests\.on\("close", failRelay\)/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /responses\.on\("error", failRelay\)/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /for \(const controller of pending\.values\(\)\) controller\.abort\(\)/);
});
