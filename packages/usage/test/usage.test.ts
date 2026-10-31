import test from "node:test";
import assert from "node:assert/strict";
import { USAGE_WIDGETS } from "@polyth/usage";

test("usage package exposes session, project, global, and limits widgets", () => {
  assert.deepEqual(USAGE_WIDGETS.map((widget) => widget.id), [
    "usage.session",
    "usage.project",
    "usage.global",
    "usage.limits",
  ]);
  assert.ok(USAGE_WIDGETS.every((widget) => widget.category === "Usage"));
  assert.ok(USAGE_WIDGETS.every((widget) => widget.supportedSlots.includes(widget.defaultSlot)));
});

