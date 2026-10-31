// Moved from apps/web/test/responsiveShell.test.ts: these are the goals
// package's own widget and dialog assertions.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("goal parameters open in a focused modal", async () => {
  const goal = await read("../widgets/GoalStrip.tsx");
  assert.match(goal, /<Dialog\s+title=\{tr\("goalstrip\.sessionGoal"\)\}/, "goal parameters open in a focused modal");
});

test("goals are a placeable composer action", async () => {
  const goals = await read("../widgets/index.tsx");
  assert.ok(goals.includes('"session.goal-composer-action"'), "goals are a placeable composer action");
  assert.ok(goals.includes("icon={TargetIcon}"), "Focus exposes the goals target");
});
