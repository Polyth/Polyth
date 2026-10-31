import test from "node:test";
import assert from "node:assert/strict";
import { api } from "@polyth/session/web-api";

test("missing worktree reads are an empty list, not a UI error", async () => {
  const previous = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ error: "not-found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    assert.deepEqual(await api.listWorktrees("project/1", { status: true }), []);
    assert.deepEqual(await api.gitBranches("project/1"), { current: "", branches: [] });
    assert.deepEqual(requests, [
      "/api/worktrees?projectId=project%2F1&status=1",
      "/api/git/branches?projectId=project%2F1",
    ]);
  } finally {
    globalThis.fetch = previous;
  }
});

test("worktree read failures other than not-found still surface", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "internal" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
  try {
    await assert.rejects(api.listWorktrees("project-1"), /HTTP 500/);
  } finally {
    globalThis.fetch = previous;
  }
});
