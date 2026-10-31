// Moved from apps/web/test/projectPicker.test.ts: the schedule planner's own
// project-selection UI belongs with the package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("the planner project selection delegates to the shared ProjectPicker", async () => {
  const planner = await read("../widgets/PlannerProjectPicker.tsx");
  assert.match(planner, /<ProjectPicker/);
  assert.doesNotMatch(planner, /ResponsiveOverlay/);
});
