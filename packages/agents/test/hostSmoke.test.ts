// Moved from apps/web/test/smoke.test.ts: schedule list normalization is the
// schedule package's own data contract.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeScheduleList } from "../widgets/scheduleData.ts";

test("schedule list normalization accepts arrays and wrapped payloads", () => {
  const task = {
    id: "task-1",
    projectId: "project-1",
    prompt: "Check CI",
    kind: "every" as const,
    cadence: { kind: "every" as const, everyMinutes: 15 },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: 2,
    runs: 0,
  };
  assert.deepEqual(normalizeScheduleList([task]), { tasks: [task], loopErrors: [] });
  assert.deepEqual(
    normalizeScheduleList({ tasks: [task], loopErrors: [{ path: ".agents/loops/ci.md", error: "bad cron" }] }),
    { tasks: [task], loopErrors: [{ path: ".agents/loops/ci.md", error: "bad cron" }] },
  );
  assert.deepEqual(normalizeScheduleList({ tasks: null }), { tasks: [], loopErrors: [] });
});
