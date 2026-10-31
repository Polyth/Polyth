import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSessionTree, includeSessionTreeContext, isNavigatorRoot } from "../src/sessionTree.ts";

const item = (id: string, parentId?: string) => ({ id, ...(parentId ? { parentId } : {}) });

test("session tree context keeps parents and descendants around a paged seed", () => {
  const sessions = [item("root"), item("child", "root"), item("grandchild", "child"), item("other")];
  const visible = includeSessionTreeContext(sessions, [sessions[1]!]);

  assert.deepEqual(visible.map((session) => session.id), ["root", "child", "grandchild"]);
});

test("session tree nests known parents and keeps an orphan visible", () => {
  const roots = buildSessionTree([
    item("root"),
    item("child", "root"),
    item("orphan", "missing-parent"),
  ]);

  assert.deepEqual(roots.map((node) => node.item.id), ["root", "orphan"]);
  assert.deepEqual(roots[0]!.children.map((node) => node.item.id), ["child"]);
});

test("session tree keeps a malformed parent cycle visible", () => {
  const roots = buildSessionTree([
    item("first", "second"),
    item("second", "first"),
  ]);

  assert.deepEqual(roots.map((node) => node.item.id), ["first"]);
  assert.deepEqual(roots[0]!.children.map((node) => node.item.id), ["second"]);
});

test("a delegated child rides with its listed parent and waits for an unread one", () => {
  const listed = new Set(["parent", "child"]);
  const pending = (id: string) => id === "loading-parent";
  assert.equal(isNavigatorRoot(item("parent"), listed, pending), true);
  assert.equal(isNavigatorRoot(item("child", "parent"), listed, pending), false);
  assert.equal(isNavigatorRoot(item("early", "loading-parent"), listed, pending), false);
  assert.equal(isNavigatorRoot(item("orphan", "archived-parent"), listed, pending), true);
});

test("pinned context can include descendants without pulling in ancestors", () => {
  const sessions = [item("root"), item("pinned", "root"), item("grandchild", "pinned")];
  const visible = includeSessionTreeContext(sessions, [sessions[1]!], { ancestors: false });
  assert.deepEqual(visible.map((session) => session.id), ["pinned", "grandchild"]);
});
