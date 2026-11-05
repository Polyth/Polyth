import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultPlan,
  HOUR_GRACE_MS,
  LEAD_GRACE_MS,
  nextStart,
  parsePlan,
  projectWindows,
  RESET_MARGIN_MS,
  START_MARGIN_MS,
  type WindowPlan,
} from "../src/plan.ts";

const UTC = "UTC";
const HOUR = 60 * 60_000;
const FIVE = 5 * HOUR;
const utc = (time: string, day = 5): number => Date.parse(`2026-11-${String(day).padStart(2, "0")}T${time}:00Z`);
const hourPlan = (patch: Partial<WindowPlan> = {}): WindowPlan => ({ ...defaultPlan(UTC), mode: "hour", ...patch });
const resetPlan = (patch: Partial<WindowPlan> = {}): WindowPlan => ({ ...defaultPlan(UTC), mode: "reset", ...patch });

test("a window already free has no reset margin to wait out", () => {
  const now = utc("04:00") + START_MARGIN_MS;
  assert.equal(nextStart(hourPlan({ lead: 1 }), FIVE, 0, now)?.at, now);
  assert.equal(nextStart(resetPlan(), FIVE, 0, now)?.at, now);
});

test("nothing is ever planned while off", () => {
  assert.equal(nextStart(defaultPlan(UTC), FIVE, 0, utc("02:00")), null);
});

test("an hour with nothing ahead starts just after the hour", () => {
  const start = nextStart(hourPlan({ lead: 0 }), FIVE, utc("02:00"), utc("02:00"));
  assert.deepEqual(start, { at: utc("09:00") + START_MARGIN_MS, reason: "hour", targetAt: utc("09:00") });
});

test("the night window lands its boundary on the chosen hour", () => {
  const start = nextStart(hourPlan({ lead: 1 }), FIVE, utc("02:00"), utc("02:00"));
  assert.deepEqual(start, { at: utc("04:00") + START_MARGIN_MS, reason: "lead", targetAt: utc("09:00") });
});

test("more windows ahead start at the earliest boundary still free", () => {
  assert.equal(nextStart(hourPlan({ lead: 3 }), FIVE, utc("20:00", 4), utc("20:00", 4))?.at, utc("23:00", 4) + START_MARGIN_MS);
  // Busy until 01:00: the 23:00 boundary is gone, 04:00 is the next one.
  assert.equal(nextStart(hourPlan({ lead: 3 }), FIVE, utc("01:00"), utc("20:00", 4))?.at, utc("04:00") + START_MARGIN_MS);
});

test("a boundary missed by more than a moment is skipped: it would run past the hour", () => {
  const missed = utc("04:00") + START_MARGIN_MS + LEAD_GRACE_MS + 1;
  const start = nextStart(hourPlan({ lead: 1 }), FIVE, missed, missed);
  assert.equal(start?.reason, "hour");
  assert.equal(start?.at, utc("09:00") + START_MARGIN_MS);
});

test("a boundary just missed still goes out at once", () => {
  const late = utc("04:00") + START_MARGIN_MS + LEAD_GRACE_MS - 1;
  const start = nextStart(hourPlan({ lead: 1 }), FIVE, 0, late);
  assert.deepEqual(start, { at: late, reason: "lead", targetAt: utc("09:00") });
});

test("the window after the night one starts right on the hour", () => {
  // The night window was started at 04:00:45 and ends five hours later.
  const over = utc("04:00") + START_MARGIN_MS + FIVE;
  const start = nextStart(hourPlan({ lead: 1 }), FIVE, over, utc("05:00"));
  assert.equal(start?.reason, "hour");
  assert.equal(start?.targetAt, utc("09:00"));
  assert.equal(start?.at, over + RESET_MARGIN_MS);
});

test("a window running over the hour starts the next one late, inside the grace", () => {
  const over = utc("09:10");
  const start = nextStart(hourPlan({ lead: 1 }), FIVE, over, utc("08:00"));
  assert.deepEqual(start, { at: over + RESET_MARGIN_MS, reason: "hour", targetAt: utc("09:00") });
});

test("a window running far over the hour waits for the next day", () => {
  const over = utc("09:00") + HOUR_GRACE_MS + 60_000;
  const start = nextStart(hourPlan({ lead: 0 }), FIVE, over, utc("08:00"));
  assert.equal(start?.targetAt, utc("09:00", 6));
});

test("a restart inside the grace still serves the hour", () => {
  const start = nextStart(hourPlan({ lead: 0 }), FIVE, utc("02:00"), utc("09:10"));
  assert.deepEqual(start, { at: utc("09:10"), reason: "hour", targetAt: utc("09:00") });
});

test("a plan saved just after the hour does not fire for it", () => {
  const start = nextStart(hourPlan({ lead: 0 }), FIVE, utc("09:10"), utc("09:10"), utc("09:10"));
  assert.equal(start?.targetAt, utc("09:00", 6));
});

test("rolling restarts while the new window still ends by the next hour", () => {
  const plan = hourPlan({ lead: 0, rolling: true });
  assert.deepEqual(nextStart(plan, FIVE, utc("14:00"), utc("10:00")), { at: utc("14:00") + RESET_MARGIN_MS, reason: "rolling" });
  // 05:00 + 5 h is 10:00, past tomorrow's 09:00: the gap goes here, not at noon.
  assert.equal(nextStart(plan, FIVE, utc("05:00", 6), utc("04:00", 6))?.reason, "hour");
});

test("rolling draws the day's windows up to the next hour, then lands on it", () => {
  const plan = hourPlan({ lead: 0, rolling: true });
  const windows = projectWindows(plan, FIVE, utc("09:00"), utc("09:00"), utc("10:00", 6));
  // 24 h does not divide by 5 h, so exactly one 4 h gap remains.
  assert.equal(windows.length, 5);
  assert.equal(windows.at(-1)?.reason, "hour");
  assert.equal(windows.at(-1)?.targetAt, utc("09:00", 6));
  assert.ok(windows[3]!.to <= utc("09:00", 6));
});

test("the lead windows of tomorrow's hour are projected too", () => {
  const windows = projectWindows(hourPlan({ lead: 1 }), FIVE, utc("02:00"), utc("02:00"), utc("10:00", 6));
  assert.deepEqual(windows.map((row) => row.reason), ["lead", "hour", "lead", "hour"]);
  assert.equal(windows[1]!.from - windows[0]!.to, RESET_MARGIN_MS);
});

test("a weekday list plans nothing on the other days", () => {
  // Thursday; only Monday.
  const start = nextStart(hourPlan({ lead: 1, days: [1] }), FIVE, utc("02:00"), utc("02:00"));
  assert.equal(start?.targetAt, utc("09:00", 9));
  assert.equal(start?.at, utc("04:00", 9) + START_MARGIN_MS);
});

test("after every reset means right after it", () => {
  assert.deepEqual(nextStart(resetPlan(), FIVE, utc("07:50"), utc("05:00")), { at: utc("07:50") + RESET_MARGIN_MS, reason: "reset" });
  // Idle already: at once.
  assert.deepEqual(nextStart(resetPlan(), FIVE, utc("05:00"), utc("05:00") + 60_000), { at: utc("05:00") + 60_000, reason: "reset" });
});

test("an active range holds a reset until it opens", () => {
  const plan = resetPlan({ activeFrom: "08:00", activeUntil: "23:00" });
  assert.equal(nextStart(plan, FIVE, utc("23:30"), utc("23:00"))?.at, utc("08:00", 6));
  assert.equal(nextStart(plan, FIVE, utc("10:00"), utc("09:00"))?.at, utc("10:00") + RESET_MARGIN_MS);
});

test("parsePlan keeps a valid plan and canonicalizes its lists", () => {
  const plan = parsePlan({ mode: "hour", times: ["14:00", "09:00", "14:00"], days: [5, 1, 1], lead: 2, rolling: true, timeZone: "Europe/Kyiv", model: { providerID: "anthropic", modelID: "haiku", extra: 1 }, skipMeters: ["third-party"] });
  assert.deepEqual(plan, { mode: "hour", times: ["09:00", "14:00"], days: [1, 5], lead: 2, rolling: true, timeZone: "Europe/Kyiv", model: { providerID: "anthropic", modelID: "haiku" }, skipMeters: ["third-party"] });
});

test("parsePlan refuses what cannot run", () => {
  const base = { mode: "hour", times: ["09:00"], timeZone: UTC };
  for (const bad of [
    null,
    [],
    { ...base, mode: "sometimes" },
    { ...base, timeZone: "Not/AZone" },
    { ...base, times: [] },
    { ...base, times: ["25:00"] },
    { ...base, times: Array(7).fill("09:00") },
    { ...base, days: [7] },
    { ...base, lead: 4 },
    { ...base, lead: 1.5 },
    { ...base, rolling: "yes" },
    { ...base, activeFrom: "08:00" },
    { ...base, activeFrom: "8", activeUntil: "9" },
    { ...base, model: { providerID: "a" } },
    { ...base, skipMeters: ["../x"] },
  ]) {
    assert.throws(() => parsePlan(bad), { code: "invalid-input" }, JSON.stringify(bad));
  }
});
