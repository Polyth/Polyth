import assert from "node:assert/strict";
import test from "node:test";
import type { ToolExecutionContext } from "@polyth/contracts";
import { createWebSearchAgentTool } from "../src/agentTool.ts";

const context: ToolExecutionContext = {
  sessionId: "session-a",
  projectId: "project-a",
  cwd: "/workspace",
  spaceId: "space-a",
};

test("agent tool forwards only bounded search fields and returns structured metadata", async () => {
  let received: unknown;
  const tool = createWebSearchAgentTool({
    async search(_context, request) {
      received = request;
      return {
        query: "Polyth",
        provider: "duckduckgo",
        results: [{
          rank: 1,
          title: "Polyth",
          url: "https://example.com/",
          snippet: "Docs",
          publishedAt: null,
        }],
        truncated: false,
      };
    },
  });
  const result = await tool.execute?.({ query: "Polyth", count: 3, freshness: "week" }, context);
  assert.deepEqual(received, { query: "Polyth", count: 3, freshness: "week" });
  assert.deepEqual(result?.metadata, { provider: "duckduckgo", count: 1, truncated: false });
  assert.deepEqual(JSON.parse(result!.output), {
    query: "Polyth",
    provider: "duckduckgo",
    results: [{
      rank: 1,
      title: "Polyth",
      url: "https://example.com/",
      snippet: "Docs",
      publishedAt: null,
    }],
    truncated: false,
  });
  assert.equal(tool.descriptor.kind === "tool" ? tool.descriptor.name : null, "web_search");
});
