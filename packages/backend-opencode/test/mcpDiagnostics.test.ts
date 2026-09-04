import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listMcpServerTools,
} from "../src/mcpDiagnostics.ts";

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

test("listMcpServerTools prefers tools listed under /mcp status", async () => {
  const result = await listMcpServerTools({
    transport: {
      async query<T>({ path }: { method: "GET" | "HEAD"; path: string; deadlineMs: number }) {
        if (path === "/mcp") {
          return {
            status: 200,
            headers: {},
            body: {
              github: {
                status: "connected",
                tools: ["list_issues", { name: "create_issue" }],
              },
            },
          } as T;
        }
        throw new Error(`unexpected path ${path}`);
      },
    },
    serverName: "github",
  });
  assert.equal(result.source, "runtime");
  assert.deepEqual(
    result.tools.map((t) => t.name).sort(),
    ["create_issue", "list_issues"],
  );
  assert.equal(result.tools.every((t) => t.available), true);
});

test("listMcpServerTools falls back to exact server_tool ids", async () => {
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
            body: ["bash", "github_list_issues", "read", "slack_post"],
          } as T;
        }
        throw new Error(`unexpected path ${path}`);
      },
    },
    serverName: "github",
  });
  assert.equal(result.source, "runtime");
  assert.deepEqual(result.tools, [{
    name: "list_issues",
    server: "github",
    available: true,
  }]);
});
