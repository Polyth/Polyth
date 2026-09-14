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

test("scoped Polyth tool credentials stay in the worker-owned MCP child, not Command Code env", () => {
  assert.match(COMMANDCODE_WORKER_SOURCE, /const startToolBridge = async/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /env: \{ \.\.\.process\.env, \.\.\.spec\.env \}/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /stdio: \["pipe", "pipe", "pipe", "pipe", "pipe"\]/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /turn\.child\.stdio\?\.\[3\]/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /turn\.child\.stdio\?\.\[4\]/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /type: "polyth-tool-invoked"/);

  const commandEnv = /const env = \{([\s\S]*?)\n  \};\n  let child;/.exec(COMMANDCODE_WORKER_SOURCE)?.[1] ?? "";
  assert.ok(commandEnv, "Command Code child environment block must be present");
  assert.doesNotMatch(commandEnv, /POLYTH_AGENT_TOOLS_URL|POLYTH_AGENT_TOOLS_TOKEN/);
});
