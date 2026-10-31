import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODEX_AGENT_TOOLS_MCP_NAME,
  hasPolythAgentToolsMcp,
  waitForCodexNativeMcp,
} from "../src/mcpReadiness.ts";

test("hasPolythAgentToolsMcp detects the private Polyth bridge", () => {
  assert.equal(hasPolythAgentToolsMcp(undefined), false);
  assert.equal(hasPolythAgentToolsMcp({ ping: {} }), false);
  assert.equal(hasPolythAgentToolsMcp({ [CODEX_AGENT_TOOLS_MCP_NAME]: {} }), true);
});

test("waitForCodexNativeMcp resolves when connected tools are present", async () => {
  let checks = 0;
  const rpc = {
    request: async () => {
      checks++;
      return {
        data: [{
          name: CODEX_AGENT_TOOLS_MCP_NAME,
          runtimeStatus: checks >= 2 ? "connected" : "starting",
          tools: checks >= 2 ? { browser: { name: "polyth_browser" } } : {},
        }],
        nextCursor: null,
      };
    },
  };
  await waitForCodexNativeMcp(
    rpc as never,
    "native",
    [{ capabilityId: "polyth.agent-tools", name: CODEX_AGENT_TOOLS_MCP_NAME, tools: [{ capabilityId: "browser.polyth-browser", name: "polyth_browser" }] }],
    { pollIntervalMs: 0, timeoutMs: 100 },
  );
  assert.ok(checks >= 2);
});

test("waitForCodexNativeMcp fails closed on terminal MCP status", async () => {
  await assert.rejects(
    () => waitForCodexNativeMcp(
      {
        request: async () => ({
          data: [{ name: CODEX_AGENT_TOOLS_MCP_NAME, runtimeStatus: "failed", tools: {} }],
          nextCursor: null,
        }),
      } as never,
      "native",
      [{ capabilityId: "polyth.agent-tools", name: CODEX_AGENT_TOOLS_MCP_NAME, tools: [] }],
      { pollIntervalMs: 0, timeoutMs: 100 },
    ),
    (error: Error & { code?: string }) => error.code === "native-failure",
  );
});

test("agent-tools bridge authenticationRequired rejects with native-failure", async () => {
  await assert.rejects(
    () => waitForCodexNativeMcp(
      {
        request: async () => ({
          data: [
            { name: CODEX_AGENT_TOOLS_MCP_NAME, runtimeStatus: "authenticationRequired", tools: {} },
            { name: "linear", runtimeStatus: "connected", tools: {} },
          ],
          nextCursor: null,
        }),
      } as never,
      "native",
      [
        { capabilityId: "polyth.agent-tools", name: CODEX_AGENT_TOOLS_MCP_NAME, tools: [] },
        { capabilityId: "polyth.mcp.626a4874", name: "linear", tools: [] },
      ],
      { pollIntervalMs: 0, timeoutMs: 100 },
    ),
    (error: Error & { code?: string }) =>
      error.code === "native-failure"
      && /Polyth agent-tools bridge failed to connect \(Codex status: authenticationRequired\)/.test(error.message),
  );
});

test("a user MCP server that needs auth does not deny admission or blame the bridge", async () => {
  // Codex reports `authenticationRequired` for any OAuth resource server that
  // answers 401 with a WWW-Authenticate challenge — an expired Linear token,
  // say. That is the user's credential, not Polyth's private stdio bridge.
  await waitForCodexNativeMcp(
    {
      request: async () => ({
        data: [
          { name: CODEX_AGENT_TOOLS_MCP_NAME, runtimeStatus: "connected", tools: { browser: { name: "polyth_browser" } } },
          { name: "linear", runtimeStatus: "authenticationRequired", tools: {} },
        ],
        nextCursor: null,
      }),
    } as never,
    "native",
    [
      { capabilityId: "polyth.agent-tools", name: CODEX_AGENT_TOOLS_MCP_NAME, tools: [{ capabilityId: "browser.polyth-browser", name: "polyth_browser" }] },
      { capabilityId: "polyth.mcp.626a4874", name: "linear", tools: [] },
    ],
    { pollIntervalMs: 0, timeoutMs: 100 },
  );
});

test("a user MCP server stuck starting stops blocking once the bridge is ready", async () => {
  await waitForCodexNativeMcp(
    {
      request: async () => ({
        data: [
          { name: CODEX_AGENT_TOOLS_MCP_NAME, runtimeStatus: "connected", tools: {} },
          { name: "linear", runtimeStatus: "starting", tools: {} },
        ],
        nextCursor: null,
      }),
    } as never,
    "native",
    [
      { capabilityId: "polyth.agent-tools", name: CODEX_AGENT_TOOLS_MCP_NAME, tools: [] },
      { capabilityId: "polyth.mcp.626a4874", name: "linear", tools: [] },
    ],
    { pollIntervalMs: 0, timeoutMs: 30 },
  );
});

test("waitForCodexNativeMcp fails closed when expected tools never appear", async () => {
  await assert.rejects(
    () => waitForCodexNativeMcp(
      {
        request: async () => ({
          data: [{ name: CODEX_AGENT_TOOLS_MCP_NAME, runtimeStatus: "connected", tools: { ping: { name: "ping" } } }],
          nextCursor: null,
        }),
      } as never,
      "native",
      [{ capabilityId: "polyth.agent-tools", name: CODEX_AGENT_TOOLS_MCP_NAME, tools: [{ capabilityId: "browser.polyth-browser", name: "polyth_browser" }] }],
      { pollIntervalMs: 0, timeoutMs: 50 },
    ),
    (error: Error & { code?: string }) => error.code === "native-failure",
  );
});
