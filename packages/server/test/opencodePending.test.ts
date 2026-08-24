import test from "node:test";
import assert from "node:assert/strict";
import { createOpenCodePendingService } from "../src/opencodePending.ts";

test("pending OpenCode changes coalesce by id and clear only after restart", async () => {
  const applied: string[] = [];
  let restarts = 0;
  const pending = createOpenCodePendingService({
    restart: async () => { restarts += 1; return 3; },
  });
  pending.stage({
    id: "mcp",
    kind: "mcp",
    label: "Old MCP state",
    apply: async () => { applied.push("old"); },
  });
  pending.stage({
    id: "mcp",
    kind: "mcp",
    label: "MCP servers",
    apply: async () => { applied.push("latest"); },
  });
  pending.stage({
    id: "agent:review",
    kind: "agent",
    label: "Agent role: review",
    apply: async () => { applied.push("agent"); },
  });

  assert.deepEqual(pending.list(), {
    changes: [
      { id: "mcp", kind: "mcp", label: "MCP servers" },
      { id: "agent:review", kind: "agent", label: "Agent role: review" },
    ],
    count: 2,
  });
  assert.deepEqual(await pending.applyAndRestart(), { applied: 2, restarted: 3 });
  assert.deepEqual(applied, ["latest", "agent"]);
  assert.equal(restarts, 1);
  assert.deepEqual(pending.list(), { changes: [], count: 0 });
});

test("pending OpenCode changes remain queued when restart fails", async () => {
  let applies = 0;
  const pending = createOpenCodePendingService({
    restart: async () => { throw new Error("restart failed"); },
  });
  pending.stage({
    id: "provider-visibility",
    kind: "provider-visibility",
    label: "Provider and model visibility",
    apply: async () => { applies += 1; },
  });

  await assert.rejects(() => pending.applyAndRestart(), /restart failed/);
  assert.equal(applies, 1);
  assert.equal(pending.list().count, 1);
});
