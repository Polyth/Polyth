import { test } from "node:test";
import assert from "node:assert/strict";
import { completeCoachSetup, parseCoachSetup } from "../src/setup.ts";
import type { CoachStore } from "../src/index.ts";

const preferences = () => ({
  confirm: true, timeZone: "Europe/Kyiv", tone: "balanced", initiative: "balanced",
  challengeAssumptions: false, dailyCheckIn: false, dailyMinuteOfDay: 480,
  weeklyReview: false, weeklyDay: 0, weeklyMinuteOfDay: 1080,
});

test("setup requires explicit confirmation and explicit reminder consent", () => {
  for (const patch of [{ confirm: false }, { confirm: undefined }, { dailyCheckIn: undefined }, { weeklyReview: "false" }, { challengeAssumptions: 0 }]) {
    assert.throws(() => parseCoachSetup({ ...preferences(), ...patch }), (error: { code?: string }) => error.code === "invalid-input");
  }
});

test("all settings validate before schedule/profile mutation", () => {
  for (const patch of [{ timeZone: "bad/zone" }, { tone: "mean" }, { initiative: "always" }, { dailyMinuteOfDay: 1440 }, { weeklyDay: 7 }, { weeklyMinuteOfDay: -1 }, { weeklyDay: "1" }]) {
    assert.throws(() => parseCoachSetup({ ...preferences(), ...patch }));
  }
});

test("manual setup completes without a model or Schedule", () => {
  let saved: unknown;
  const store = { updateProfile: (patch: unknown) => { saved = patch; return patch; } } as Pick<CoachStore, "updateProfile">;
  completeCoachSetup(store, parseCoachSetup(preferences()));
  assert.deepEqual(saved, { timeZone: "Europe/Kyiv", tone: "balanced", initiative: "balanced", challengeAssumptions: false, onboardingState: "complete" });
});

test("unavailable reminders cannot silently opt users in or mark setup complete", () => {
  let writes = 0;
  const store = { updateProfile: () => { writes++; return {} as never; } };
  assert.throws(() => completeCoachSetup(store, parseCoachSetup({ ...preferences(), dailyCheckIn: true })), /unavailable/);
  assert.equal(writes, 0);
});

test("failed schedule save leaves setup incomplete; retry is explicit", () => {
  let writes = 0;
  const store = { updateProfile: () => { writes++; return {} as never; } };
  assert.throws(() => completeCoachSetup(store, parseCoachSetup(preferences()), () => { throw new Error("save failed"); }), /save failed/);
  assert.equal(writes, 0);
});
