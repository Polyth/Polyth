import test from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import { sessionTreePostOrder } from "../src/spaceScope.ts";

const projection = (
  id: string,
  parentId?: string,
  status: SessionProjection["status"] = "idle",
): SessionProjection => ({ id, parentId, status } as SessionProjection);

test("session lifecycle traversal is deepest-first and crosses archived intermediates", () => {
  const rows = [
    projection("root"),
    projection("archived-child", "root", "archived"),
    projection("grandchild", "archived-child"),
    projection("sibling", "root"),
    projection("sibling-leaf", "sibling"),
  ];

  assert.deepEqual(sessionTreePostOrder("root", rows), [
    "grandchild",
    "archived-child",
    "sibling-leaf",
    "sibling",
    "root",
  ]);
});

test("session lifecycle traversal does not duplicate or loop on corrupt ancestry", () => {
  const rows = [
    projection("root", "child"),
    projection("child", "root"),
  ];

  assert.deepEqual(sessionTreePostOrder("root", rows), ["child", "root"]);
});

test("session lifecycle traversal ignores unrelated trees", () => {
  const rows = [
    projection("root"),
    projection("child", "root"),
    projection("other"),
    projection("other-child", "other"),
  ];

  assert.deepEqual(sessionTreePostOrder("root", rows), ["child", "root"]);
});
