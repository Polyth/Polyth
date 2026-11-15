import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent, SessionProjection } from "@polyth/contracts";
import { createGoalService } from "../src/index.ts";
import { goalStartStep } from "../src/serverEntry.ts";

function fixture() {
  const events: Array<{ type: string; data: JsonObject }> = [];
  const goals = createGoalService({
    append: async (_sessionId, type, data) => {
      events.push({ type, data });
    },
    send: async () => {},
    complete: async () => '{"verdict":"done","reason":"ok"}',
    now: () => 1000,
  });
  const step = goalStartStep({
    goals,
    events: async (sessionId) => events.map((event, index) => ({
      id: `e${index}`,
      sessionId,
      seq: index + 1,
      time: index + 1,
      ...event,
    })) as SessionEvent[],
  });
  const session = { id: "s1" } as SessionProjection;
  return { events, goals, step, session };
}

test("the goals.attach start step attaches the goal", async () => {
  const { events, goals, step, session } = fixture();
  await step.run({ objective: "  ship it  " }, { projectId: "p1", session });
  assert.deepEqual(events.map((event) => event.type), ["goal/attached"]);
  assert.equal(goals.get("s1")?.objective, "ship it");
});

test("a second run with the same objective creates no second goal", async () => {
  const { events, step, session } = fixture();
  await step.run({ objective: "ship it" }, { projectId: "p1", session });
  await step.run({ objective: "ship it" }, { projectId: "p1", session });
  assert.deepEqual(events.map((event) => event.type), ["goal/attached"]);
});

test("an empty objective is rejected before anything is created", () => {
  const { step } = fixture();
  for (const objective of ["", "   ", undefined]) {
    assert.throws(
      () => step.validate!({ objective } as unknown as JsonObject, { projectId: "p1" }),
      (error: Error & { code?: string }) => error.code === "invalid-input",
    );
  }
});
