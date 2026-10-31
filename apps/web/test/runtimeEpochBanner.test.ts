import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./tsxHooks.mjs", import.meta.url);
const { shouldShowUnownedEpochNotice } = await import("../src/components/RuntimeEpochBanner.tsx");

const session = (status: "idle" | "epoch-pending", runtimeControl: "owned" | "borrowed" | undefined = undefined) => ({
  status,
  runtimeControl,
});

test("a planned runtime handoff suppresses the generic epoch notice", () => {
  assert.equal(shouldShowUnownedEpochNotice(session("epoch-pending"), true), false);
  assert.equal(shouldShowUnownedEpochNotice(session("epoch-pending"), false), true);
  assert.equal(shouldShowUnownedEpochNotice(session("epoch-pending", "owned"), false), false);
  assert.equal(shouldShowUnownedEpochNotice(session("epoch-pending", "borrowed"), false), false);
  assert.equal(shouldShowUnownedEpochNotice(session("idle"), false), false);
});

test("a recorded planned transition also suppresses the generic epoch notice", () => {
  assert.equal(shouldShowUnownedEpochNotice({
    status: "epoch-pending",
    runtimeControl: undefined,
    harnessTransition: {
      id: "switch-1",
      selection: { mode: "pinned", harnessId: "cursor" },
      targetHarnessId: "cursor",
      timing: "after-turn",
      phase: "requested",
    },
  }, false), false, "the row updates in the same commit the transition lands in");
});
