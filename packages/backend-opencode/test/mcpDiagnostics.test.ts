import { test } from "node:test";
import assert from "node:assert/strict";
import {
  displayToolName,
  mapToolsForServer,
  mcpToolId,
  sanitizeMcpSegment,
  toolIdBelongsToServer,
  toolIdsFromMcpStatusEntry,
  listMcpServerTools,
} from "../src/mcpDiagnostics.ts";

test("sanitizeMcpSegment mirrors OpenCode catalog rules", () => {
  assert.equal(sanitizeMcpSegment("github"), "github");
  assert.equal(sanitizeMcpSegment("my server!"), "my_server_");
  assert.equal(sanitizeMcpSegment("a.b/c"), "a_b_c");
});

test("mcpToolId builds server_tool ids", () => {
  assert.equal(mcpToolId("github", "list_issues"), "github_list_issues");
  assert.equal(mcpToolId("my mcp", "do:thing"), "my_mcp_do_thing");
});

test("toolIdBelongsToServer matches OpenCode prefix and segments", () => {
  assert.equal(toolIdBelongsToServer("github", "github_list_issues"), true);
  assert.equal(toolIdBelongsToServer("github", "bash"), false);
  assert.equal(toolIdBelongsToServer("github", "read"), false);
  assert.equal(toolIdBelongsToServer("docs", "other_docs_search"), true);
  assert.equal(toolIdBelongsToServer("docs", "documentation_search"), false);
  assert.equal(toolIdBelongsToServer("my mcp", "my_mcp_fetch"), true);
});

test("displayToolName strips the server prefix", () => {
  assert.equal(displayToolName("github", "github_list_issues"), "list_issues");
  assert.equal(displayToolName("github", "bash"), "bash");
});

test("mapToolsForServer filters ids and marks availability from /mcp status", () => {
  const tools = mapToolsForServer({
    serverName: "github",
    toolIds: ["bash", "github_list_issues", "github_create_issue", "read", "slack_post"],
    mcpStatus: {
      github: { status: "connected" },
      slack: { status: "failed", error: "down" },
    },
    details: new Map([
      ["github_list_issues", { id: "github_list_issues", description: "List issues" }],
    ]),
  });
  assert.deepEqual(tools.map((t) => t.name), ["create_issue", "list_issues"]);
  assert.equal(tools.every((t) => t.available), true);
  assert.equal(tools.find((t) => t.name === "list_issues")?.description, "List issues");
});

test("mapToolsForServer marks tools unavailable when MCP server is not connected", () => {
  const tools = mapToolsForServer({
    serverName: "docs",
    toolIds: ["docs_search"],
    mcpStatus: { docs: { status: "failed", error: "timeout" } },
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.available, false);
});

test("mapToolsForServer merges tools listed under /mcp status entries", () => {
  assert.deepEqual(toolIdsFromMcpStatusEntry({ status: "connected", tools: ["ping", { name: "pong" }] }), [
    "ping",
    "pong",
  ]);
  const tools = mapToolsForServer({
    serverName: "custom",
    toolIds: [],
    mcpStatus: {
      custom: { status: "connected", tools: ["alpha", { id: "custom_beta" }] },
    },
  });
  assert.deepEqual(tools.map((t) => t.name).sort(), ["alpha", "beta"]);
  assert.equal(tools.every((t) => t.available), true);
});

test("listMcpServerTools fails soft when transport queries reject", async () => {
  const result = await listMcpServerTools({
    transport: {
      query: async () => {
        throw new Error("runtime offline");
      },
    },
    serverName: "github",
  });
  assert.deepEqual(result, {
    tools: [],
    source: "unavailable",
    message: "runtime offline",
  });
});

test("listMcpServerTools maps runtime payloads", async () => {
  const result = await listMcpServerTools({
    transport: {
      async query<T>({ path }: { method: "GET" | "HEAD"; path: string; deadlineMs: number }) {
        if (path === "/mcp") {
          return { status: 200, headers: {}, body: { github: { status: "connected" } } } as T;
        }
        if (path === "/experimental/tool/ids") {
          return {
            status: 200,
            headers: {},
            body: ["bash", "github_list_issues", "read"],
          } as T;
        }
        if (path.startsWith("/experimental/tool?")) {
          return {
            status: 200,
            headers: {},
            body: [{ id: "github_list_issues", description: "List GitHub issues", parameters: {} }],
          } as T;
        }
        throw new Error(`unexpected path ${path}`);
      },
    },
    serverName: "github",
    provider: "opencode",
    model: "test",
  });
  assert.equal(result.source, "runtime");
  assert.equal(result.tools.length, 1);
  assert.deepEqual(result.tools[0], {
    name: "list_issues",
    server: "github",
    description: "List GitHub issues",
    available: true,
  });
});
