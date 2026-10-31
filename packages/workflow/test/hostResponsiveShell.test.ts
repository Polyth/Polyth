// Moved from apps/web/test/responsiveShell.test.ts: the workflow package's own
// status-bar segment assertions.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the workflow package renders its status-bar segment", async () => {
  const workflowSegment = await readFile(new URL("../widgets/WorkflowStatusbarSegment.tsx", import.meta.url), "utf8");
  assert.ok(workflowSegment.includes("sb-workflow"), "the workflow package renders .sb-workflow");
  assert.ok(workflowSegment.includes("data-fit-keep"), "the workflow segment opts out of early dropping");
});
