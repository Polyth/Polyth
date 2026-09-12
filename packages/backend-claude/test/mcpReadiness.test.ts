import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
