import test from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import { transitionBackgroundWork } from "../src/backgroundWork.ts";

const session = (): SessionProjection => ({
  id: "session",
  projectId: "project",
  title: "Background work",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
});

test("background workflow counts compose without changing turn status", () => {
  const multirun = transitionBackgroundWork(
    session(),
    "multirun",
    { phase: "started", id: "multi-1" },
    100,
  );
  const both = transitionBackgroundWork(
    multirun,
    "fusion",
    { phase: "started", id: "fusion-1" },
    200,
  );

  assert.equal(both.status, "idle");
  assert.deepEqual(both.backgroundWork, {
    multirun: 1,
    fusion: 1,
    startedAt: 100,
  });
});

test("completion preserves sibling work and records a notification result", () => {
  const initial = {
    ...session(),
    backgroundWork: { multirun: 1, fusion: 1, startedAt: 100 },
  } satisfies SessionProjection;
  const next = transitionBackgroundWork(
    initial,
    "fusion",
    { phase: "completed", id: "fusion-1", status: "failed" },
    300,
  );

  assert.deepEqual(next.backgroundWork, {
    multirun: 1,
    startedAt: 100,
    lastResult: {
      id: "fusion-1",
      kind: "fusion",
      status: "failed",
      at: 300,
    },
  });
});

test("last completion clears active timing but remains replay-dedupable", () => {
  const active = {
    ...session(),
    backgroundWork: { multirun: 1, startedAt: 100 },
  } satisfies SessionProjection;
  const next = transitionBackgroundWork(
    active,
    "multirun",
    { phase: "completed", id: "multi-1", status: "completed" },
    500,
  );

  assert.deepEqual(next.backgroundWork, {
    lastResult: {
      id: "multi-1",
      kind: "multirun",
      status: "completed",
      at: 500,
    },
  });
});
