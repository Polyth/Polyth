import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionProjection } from "@polyth/contracts";

import {
  sessionActivityState,
  subagentActivity,
  subagentActivityTone,
  type SubagentActivityState,
  type SubagentTree,
} from "../src/subagentActivity.ts";

interface Node { id: string; state?: SubagentActivityState; children?: Node[] }
const tree: SubagentTree<Node> = {
  idOf: (node) => node.id,
  childrenOf: (node) => node.children ?? [],
  stateOf: (node) => node.state,
};

const session = (over: Partial<SessionProjection>): SessionProjection => ({
  id: "s", projectId: "p", title: "s", status: "idle", createdAt: 1, updatedAt: 1, ...over,
});

test("a session contributes waiting for a person, working, or nothing", () => {
  assert.equal(sessionActivityState(session({ status: "working" })), "working");
  assert.equal(sessionActivityState(session({ status: "waiting" })), "waiting");
  assert.equal(sessionActivityState(session({ status: "working", attention: { questions: 0, permissions: 1, unread: 0 } })), "waiting",
    "an approval outranks the run it interrupts");
  assert.equal(sessionActivityState(session({ status: "idle", attention: { questions: 1, permissions: 0, unread: 0 } })), "waiting");
  assert.equal(sessionActivityState(session({ status: "idle" })), undefined);
  assert.equal(sessionActivityState(session({ status: "reconciling" })), undefined, "reconnecting is not work");
  assert.equal(sessionActivityState(session({ status: "failed" })), undefined);
});

test("direct children are counted by what their whole subtree is doing", () => {
  const activity = subagentActivity<Node>([
    { id: "a", state: "working" },
    { id: "b", children: [{ id: "b1", state: "working" }] },
    { id: "c", state: "working", children: [{ id: "c1", children: [{ id: "c11", state: "waiting" }] }] },
    { id: "d" },
  ], tree);
  assert.deepEqual(activity, { total: 4, working: 2, waiting: 1 },
    "a grandchild's run and a great-grandchild's question count for the child they hang under");
  assert.equal(subagentActivityTone(activity), "waiting", "a person's turn outranks running work");
});

test("idle children give no tone, and a cycle does not loop", () => {
  const first: Node = { id: "first" };
  const second: Node = { id: "second", children: [first] };
  first.children = [second];
  const activity = subagentActivity([first, { id: "idle" }], tree);
  assert.deepEqual(activity, { total: 2, working: 0, waiting: 0 });
  assert.equal(subagentActivityTone(activity), undefined);
  assert.equal(subagentActivityTone({ total: 3, working: 1, waiting: 0 }), "working");
});
