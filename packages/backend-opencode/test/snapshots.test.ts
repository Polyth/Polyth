// WP8: adapter normalization of todo/task tool activity into revisioned
// task/subagent snapshot runtime events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTranslateState, translateOcEvent } from "../src/events.ts";

const toolEvent = (tool: string, status: string, input: Record<string, unknown>, metadata?: Record<string, unknown>) => ({
  type: "message.part.updated",
  properties: {
    part: {
      id: `part-${tool}`,
      messageID: "msg-1",
      sessionID: "ses-1",
      type: "tool",
      callID: `call-${tool}`,
      tool,
      state: { status, input, ...(metadata ? { metadata } : {}) },
    },
  },
});

test("tool lifecycle emits pending call then a distinct running transition", () => {
  const state = createTranslateState();
  const pending = translateOcEvent(toolEvent("bash", "pending", { command: "npm test" }), state);
  assert.deepEqual(pending, [{
    type: "tool/call",
    callId: "call-bash",
    tool: "bash",
    input: { command: "npm test" },
    status: "pending",
  }]);

  const running = translateOcEvent(toolEvent("bash", "running", { command: "npm test" }), state);
  assert.deepEqual(running, [{
    type: "tool/started",
    callId: "call-bash",
    tool: "bash",
    input: { command: "npm test" },
  }]);
  assert.deepEqual(
    translateOcEvent(toolEvent("bash", "running", { command: "npm test" }), state),
    [],
    "repeated running updates do not duplicate lifecycle events",
  );
});

test("todowrite emits a full task snapshot with normalized statuses", () => {
  const state = createTranslateState();
  const evs = translateOcEvent(toolEvent("todowrite", "running", {
    todos: [
      { id: "1", content: "explore", status: "completed" },
      { id: "2", content: "build", status: "in_progress" },
      { id: "3", content: "test", status: "pending" },
      { id: "4", content: "drop", status: "cancelled" },
    ],
  }), state);
  const snap = evs.find((e) => e.type === "task/snapshot");
  assert.ok(snap && snap.type === "task/snapshot");
  assert.equal(snap.revision, 1);
  assert.deepEqual(snap.items.map((i) => i.status), ["done", "active", "pending", "failed"]);
  assert.deepEqual(snap.items.map((i) => i.text), ["explore", "build", "test", "drop"]);
});

test("the authoritative todo.updated event emits and clears task snapshots", () => {
  const state = createTranslateState();
  const updated = translateOcEvent({
    type: "todo.updated",
    properties: {
      sessionID: "ses-1",
      todos: [
        { id: "1", content: "inspect", status: "completed", priority: "high" },
        { id: "2", content: "fix", status: "in_progress", priority: "medium" },
      ],
    },
  }, state);
  assert.deepEqual(updated, [{
    type: "task/snapshot",
    listId: "todo",
    revision: 1,
    items: [
      { id: "1", text: "inspect", status: "done" },
      { id: "2", text: "fix", status: "active" },
    ],
  }]);

  assert.deepEqual(translateOcEvent({
    type: "todo.updated",
    properties: { sessionID: "ses-1", todos: [] },
  }, state), [{
    type: "task/snapshot",
    listId: "todo",
    revision: 2,
    items: [],
  }]);
});

test("identical todo state does not re-emit; changed state bumps revision", () => {
  const state = createTranslateState();
  const input = { todos: [{ id: "1", content: "a", status: "pending" }] };
  const first = translateOcEvent(toolEvent("todowrite", "running", input), state);
  assert.equal(first.filter((e) => e.type === "task/snapshot").length, 1);
  const again = translateOcEvent(toolEvent("todowrite", "completed", input), state);
  assert.equal(again.filter((e) => e.type === "task/snapshot").length, 0);
  const changed = translateOcEvent(toolEvent("todowrite", "completed", {
    todos: [{ id: "1", content: "a", status: "completed" }],
  }), state);
  const snap = changed.find((e) => e.type === "task/snapshot");
  assert.ok(snap && snap.type === "task/snapshot");
  assert.equal(snap.revision, 2);
});

test("task tool lifecycle emits subagent snapshots: running then done", () => {
  const state = createTranslateState();
  const start = translateOcEvent(toolEvent("task", "running", {
    description: "Explore codebase", prompt: "look around\nmore detail", subagent_type: "general",
  }, { sessionID: "child-1" }), state);
  const s1 = start.find((e) => e.type === "subagent/snapshot");
  assert.ok(s1 && s1.type === "subagent/snapshot");
  assert.equal(s1.revision, 1);
  assert.deepEqual(s1.agents, [{
    sessionId: "child-1", label: "Explore codebase", status: "running", currentTask: "look around",
  }]);

  const finish = translateOcEvent(toolEvent("task", "completed", {
    description: "Explore codebase", prompt: "look around", subagent_type: "general",
  }, { sessionID: "child-1" }), state);
  const s2 = finish.find((e) => e.type === "subagent/snapshot");
  assert.ok(s2 && s2.type === "subagent/snapshot");
  assert.equal(s2.revision, 2);
  assert.equal(s2.agents[0]!.status, "done");
  // unchanged state re-delivery does not spam snapshots
  const dup = translateOcEvent(toolEvent("task", "completed", {
    description: "Explore codebase", prompt: "look around", subagent_type: "general",
  }, { sessionID: "child-1" }), state);
  assert.equal(dup.filter((e) => e.type === "subagent/snapshot").length, 0);
});
