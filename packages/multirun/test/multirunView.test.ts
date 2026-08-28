import test from "node:test";
import assert from "node:assert/strict";
import type { MultirunRunDto } from "@polyth/contracts";
import {
  multirunDuration,
  preferredRunId,
  summarizeMultirun,
} from "../widgets/multirunView.ts";

const runs: MultirunRunDto[] = [
  { id: "waiting", status: "pending", output: "" },
  { id: "active", status: "running", output: "partial", startedAt: 1_000, cost: 0.01 },
  { id: "done", status: "completed", output: "answer", startedAt: 1_000, finishedAt: 4_000, cost: 0.02 },
  { id: "failed", status: "failed", output: "", error: "nope", startedAt: 2_000, finishedAt: 2_500 },
];

test("summarizeMultirun reports user-facing progress and known cost", () => {
  assert.deepEqual(summarizeMultirun(runs), {
    total: 4,
    finished: 2,
    running: 1,
    waiting: 1,
    completed: 1,
    failed: 1,
    cost: 0.03,
  });
});

test("multirunDuration uses current time only for an active run", () => {
  assert.equal(multirunDuration(runs[1]!, 5_000), 4_000);
  assert.equal(multirunDuration(runs[2]!, 9_000), 3_000);
  assert.equal(multirunDuration(runs[0]!, 9_000), null);
});

test("preferredRunId preserves selection then prefers active and completed runs", () => {
  assert.equal(preferredRunId(runs, "failed"), "failed");
  assert.equal(preferredRunId(runs), "active");
  assert.equal(preferredRunId(runs.filter((run) => run.status !== "running")), "done");
  assert.equal(preferredRunId([]), "");
});
