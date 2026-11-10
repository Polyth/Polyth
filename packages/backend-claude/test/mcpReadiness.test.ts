import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claudeAgentToolsTimeoutMs,
  gateClaudeAgentTools,
  hasPolythAgentToolsMcp,
  waitForClaudeAgentTools,
} from "../src/mcpReadiness.ts";

test("detects only the private Polyth agent-tools MCP", () => {
  assert.equal(hasPolythAgentToolsMcp(undefined), false);
  assert.equal(hasPolythAgentToolsMcp({ other: {} }), false);
  assert.equal(hasPolythAgentToolsMcp({ "polyth-agent-tools": {} }), true);
});

test("leaves Claude initialization untouched when Polyth tools are not projected", async () => {
  const query = {
    initializationResult: async () => ({ initialized: true }),
  };
  const gated = gateClaudeAgentTools(query, false);
  assert.equal(gated, query);
  assert.deepEqual(await gated.initializationResult(), { initialized: true });
});

test("holds Claude initialization until the Polyth tool bridge is connected", async () => {
  let checks = 0;
  const query = {
    initializationResult: async () => ({ initialized: true }),
    mcpServerStatus: async () => {
      checks += 1;
      return [{ name: "polyth-agent-tools", status: checks === 1 ? "pending" : "connected" }];
    },
  };
  const gated = gateClaudeAgentTools(query, true, { pollIntervalMs: 0, timeoutMs: 100 });
  assert.deepEqual(await gated.initializationResult(), { initialized: true });
  assert.equal(checks, 2);
});

test("fails closed when the private Polyth bridge reports a terminal failure", async () => {
  await assert.rejects(
    () => waitForClaudeAgentTools({
      mcpServerStatus: async () => [{ name: "polyth-agent-tools", status: "failed" }],
    }, { pollIntervalMs: 0, timeoutMs: 100 }),
    /failed to connect/,
  );
});

test("fails closed when the private Polyth bridge never becomes ready", async () => {
  await assert.rejects(
    () => waitForClaudeAgentTools({
      mcpServerStatus: async () => [{ name: "polyth-agent-tools", status: "pending" }],
    }, { pollIntervalMs: 0, timeoutMs: 0 }),
    /did not become ready before Claude session admission/,
  );
});

test("waits at least as long as Claude's own MCP connect timeout", () => {
  // The CLI keeps a healthy bridge `pending` while it connects other servers
  // in batches; a gate shorter than MCP_TIMEOUT failed slow but healthy starts.
  assert.equal(claudeAgentToolsTimeoutMs({}), 35_000);
  assert.equal(claudeAgentToolsTimeoutMs({ MCP_TIMEOUT: "60000" }), 65_000);
  assert.equal(claudeAgentToolsTimeoutMs({ MCP_TIMEOUT: "nonsense" }), 35_000);
  assert.equal(claudeAgentToolsTimeoutMs({ MCP_TIMEOUT: "0" }), 35_000);
});

test("a bridge that turns connected after several seconds is admitted", async () => {
  let polls = 0;
  await waitForClaudeAgentTools({
    mcpServerStatus: async () => [{ name: "polyth-agent-tools", status: ++polls < 4 ? "pending" : "connected" }],
  }, { pollIntervalMs: 0 });
  assert.equal(polls, 4);
});
