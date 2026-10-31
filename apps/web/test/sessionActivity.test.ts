import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveSessionActivity,
  type SessionActivitySession,
  type SessionActivityTurn,
} from "../src/sessionActivity.ts";

const oldModel = { providerID: "openai", modelID: "old" };
const newModel = { providerID: "anthropic", modelID: "new" };

function session(overrides: Partial<SessionActivitySession> = {}): SessionActivitySession {
  return { status: "idle", ...overrides };
}

function turn(overrides: Partial<SessionActivityTurn> = {}): SessionActivityTurn {
  return { status: "stopped", ...overrides };
}

const leg = (id: string, harnessId: string) => ({
  id,
  harnessId,
  nativeSessionId: `${id}-native`,
  startedAt: 1,
  canonicalThroughSeq: 0,
  bootstrap: "empty" as const,
});

test("harness epoch handoff fences the old turn and keeps the target startup dock", () => {
  const activity = resolveSessionActivity(
    session({
      status: "epoch-pending",
      resolvedHarnessId: "anthropic",
      runtimeLeg: leg("leg-new", "anthropic"),
      harnessTransition: {
        id: "switch-1",
        selection: { mode: "pinned", harnessId: "anthropic" },
        targetHarnessId: "anthropic",
        timing: "stop-now",
        phase: "requested",
      },
      model: oldModel,
    }),
    turn({
      status: "working",
      model: oldModel,
      harnessId: "openai",
      runtimeLegId: "leg-old",
    }),
    [{ model: newModel, harness: { mode: "pinned", harnessId: "anthropic" }, delivery: "interrupt" }],
  );

  assert.equal(activity.working, false);
  assert.equal(activity.awaitingTurn, true);
  assert.deepEqual(activity.model, newModel);
  assert.equal(activity.harnessId, "anthropic");
});

test("a target projection replaces a stale old-runtime turn in the live dock", () => {
  const activity = resolveSessionActivity(
    session({
      status: "working",
      resolvedHarnessId: "anthropic",
      runtimeLeg: leg("leg-new", "anthropic"),
      model: newModel,
    }),
    turn({ status: "working", model: oldModel, harnessId: "openai", runtimeLegId: "leg-old" }),
    [],
  );

  assert.equal(activity.working, true);
  assert.deepEqual(activity.model, newModel);
  assert.equal(activity.harnessId, "anthropic");
});

test("Auto turn activity never falls back to the previous projection model", () => {
  const activity = resolveSessionActivity(
    session({
      status: "working",
      resolvedHarnessId: "openai",
      runtimeLeg: leg("leg-openai", "openai"),
      model: oldModel,
    }),
    turn({ status: "working", harnessId: "openai", runtimeLegId: "leg-openai" }),
    [],
  );

  assert.equal(activity.working, true);
  assert.equal(activity.model, undefined);
  assert.equal(activity.harnessId, "openai");
});

test("after-turn switches keep the currently running harness until it finishes", () => {
  const activity = resolveSessionActivity(
    session({
      status: "working",
      resolvedHarnessId: "openai",
      runtimeLeg: leg("leg-openai", "openai"),
      harnessTransition: {
        id: "switch-2",
        selection: { mode: "pinned", harnessId: "anthropic" },
        targetHarnessId: "anthropic",
        timing: "after-turn",
        phase: "requested",
      },
      model: oldModel,
    }),
    turn({ status: "working", model: oldModel, harnessId: "openai", runtimeLegId: "leg-openai" }),
    [],
  );

  assert.equal(activity.working, true);
  assert.deepEqual(activity.model, oldModel);
  assert.equal(activity.harnessId, "openai");
});
