import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cadenceToView,
  cadencesEqual,
  combineDateAndTime,
  compactZoneChoices,
  defaultOnceView,
  defaultWeeklyView,
  describeCronExpression,
  formatOnceDate,
  formatOnceSummary,
  formatOnceTime,
  fromDatetimeLocalValue,
  fromTimeValue,
  monthlyDayNeedsApplicableMonthsCopy,
  toDateValue,
  toDatetimeLocalValue,
  toTimeValue,
  validateCadenceView,
  viewToCadence,
  weekdayNames,
  weeklyViewFromOnce,
} from "../src/cadenceView.ts";

test("weekly round-trip preserves sorted days and clock", () => {
  const view = {
    mode: "weekly" as const,
    days: [5, 1, 3],
    hour: 9,
    minute: 0,
    timeZone: "Europe/Kyiv",
  };
  const cadence = viewToCadence(view);
  assert.deepEqual(cadence, { kind: "cron", expression: "0 9 * * 1,3,5", timeZone: "Europe/Kyiv" });
  assert.deepEqual(cadenceToView(cadence), {
    mode: "weekly",
    days: [1, 3, 5],
    hour: 9,
    minute: 0,
    timeZone: "Europe/Kyiv",
  });
});

test("multi-day weekly including Sunday stays weekly", () => {
  const cadence = { kind: "cron" as const, expression: "30 8 * * 0,6", timeZone: "UTC" };
  const view = cadenceToView(cadence);
  assert.equal(view.mode, "weekly");
  if (view.mode !== "weekly") return;
  assert.deepEqual(view.days, [0, 6]);
  assert.deepEqual(viewToCadence(view), cadence);
});

test("monthly round-trip", () => {
  const view = {
    mode: "monthly" as const,
    dayOfMonth: 1,
    hour: 8,
    minute: 30,
    timeZone: "America/Los_Angeles",
  };
  const cadence = viewToCadence(view);
  assert.deepEqual(cadence, { kind: "cron", expression: "30 8 1 * *", timeZone: "America/Los_Angeles" });
  assert.deepEqual(cadenceToView(cadence), view);
});

test("unknown cron is pass-through and is not coerced into weekly", () => {
  const mixed = { kind: "cron" as const, expression: "0 9 1-5 * 1", timeZone: "UTC" };
  const view = cadenceToView(mixed, "en");
  assert.equal(view.mode, "legacy-cron");
  if (view.mode !== "legacy-cron") return;
  assert.equal(view.expression, "0 9 1-5 * 1");
  assert.equal(view.timeZone, "UTC");
  assert.deepEqual(viewToCadence(view), mixed);
});

test("weekday ranges and steps are not coerced into weekly or monthly", () => {
  const range = cadenceToView({ kind: "cron", expression: "0 9 * * 1-5", timeZone: "UTC" });
  assert.equal(range.mode, "legacy-cron");
  const stepped = cadenceToView({ kind: "cron", expression: "*/15 9 * * 1", timeZone: "UTC" });
  assert.equal(stepped.mode, "legacy-cron");
  const named = cadenceToView({ kind: "cron", expression: "0 9 * * MON", timeZone: "UTC" });
  assert.equal(named.mode, "legacy-cron");
  const monthPinned = cadenceToView({ kind: "cron", expression: "0 9 * 1 1", timeZone: "UTC" });
  assert.equal(monthPinned.mode, "legacy-cron");
  const monthlyList = cadenceToView({ kind: "cron", expression: "0 9 1,15 * *", timeZone: "UTC" });
  assert.equal(monthlyList.mode, "legacy-cron");
});

test("interval pass-through", () => {
  const cadence = { kind: "every" as const, everyMinutes: 15 };
  assert.deepEqual(cadenceToView(cadence), { mode: "interval", everyMinutes: 15 });
  assert.deepEqual(viewToCadence({ mode: "interval", everyMinutes: 15 }), cadence);
  assert.equal(cadencesEqual(cadence, viewToCadence(cadenceToView(cadence))), true);
});

test("once pass-through", () => {
  const at = Date.UTC(2026, 8, 15, 12, 0);
  const cadence = { kind: "at" as const, at };
  assert.deepEqual(cadenceToView(cadence), { mode: "once", at });
  assert.deepEqual(viewToCadence({ mode: "once", at }), cadence);
});

test("validation failures", () => {
  assert.equal(validateCadenceView({ mode: "weekly", days: [], hour: 9, minute: 0, timeZone: "UTC" }).ok, false);
  assert.equal(validateCadenceView({ mode: "weekly", days: [8], hour: 9, minute: 0, timeZone: "UTC" }).ok, false);
  assert.equal(validateCadenceView({ mode: "monthly", dayOfMonth: 0, hour: 9, minute: 0, timeZone: "UTC" }).ok, false);
  assert.equal(validateCadenceView({ mode: "monthly", dayOfMonth: 32, hour: 9, minute: 0, timeZone: "UTC" }).ok, false);
  assert.equal(validateCadenceView({ mode: "weekly", days: [1], hour: 24, minute: 0, timeZone: "UTC" }).ok, false);
  assert.equal(validateCadenceView({ mode: "weekly", days: [1], hour: 9, minute: 60, timeZone: "UTC" }).ok, false);
  assert.equal(validateCadenceView({ mode: "once", at: Number.NaN }).ok, false);
  assert.equal(validateCadenceView({ mode: "interval", everyMinutes: 0 }).ok, false);
  assert.equal(validateCadenceView({ mode: "once", at: Date.now() - 60_000 }).ok, true);
});

test("defaults: once rounds to the next local hour", () => {
  const now = new Date(2026, 8, 15, 14, 11, 33).getTime();
  const once = defaultOnceView(now);
  const at = new Date(once.at);
  assert.equal(once.mode, "once");
  assert.equal(at.getHours(), 15);
  assert.equal(at.getMinutes(), 0);
  assert.equal(at.getSeconds(), 0);
  assert.equal(at.getDate(), 15);
  const late = defaultOnceView(new Date(2026, 8, 15, 23, 40).getTime());
  const nextDay = new Date(late.at);
  assert.equal(nextDay.getHours(), 0);
  assert.equal(nextDay.getMinutes(), 0);
  assert.equal(nextDay.getDate(), 16);
  const weekly = defaultWeeklyView(Date.UTC(2026, 8, 15, 14, 7), "UTC");
  assert.equal(weekly.mode, "weekly");
  assert.deepEqual(weekly.days, [2]);
  assert.equal(weekly.hour, 14);
  assert.equal(weekly.minute, 7);
});

test("Once → Every inherits the rounded future weekday and time", () => {
  const now = new Date(2026, 8, 15, 14, 11, 33).getTime();
  const once = defaultOnceView(now);
  const weekly = weeklyViewFromOnce(once.at);
  const at = new Date(once.at);
  assert.equal(weekly.mode, "weekly");
  assert.deepEqual(weekly.days, [at.getDay()]);
  assert.equal(weekly.hour, 15);
  assert.equal(weekly.minute, 0);
  assert.notEqual(weekly.minute, 11);
});

test("monthly days 29–31 need applicable-months copy", () => {
  assert.equal(monthlyDayNeedsApplicableMonthsCopy(1), false);
  assert.equal(monthlyDayNeedsApplicableMonthsCopy(15), false);
  assert.equal(monthlyDayNeedsApplicableMonthsCopy(28), false);
  assert.equal(monthlyDayNeedsApplicableMonthsCopy(29), true);
  assert.equal(monthlyDayNeedsApplicableMonthsCopy(31), true);
});

test("once summary is date · time without a raw datetime-local string", () => {
  const at = new Date(2026, 8, 19, 9, 58).getTime();
  const text = formatOnceSummary(at, "en-US");
  assert.match(text, /Sep/);
  assert.match(text, /19/);
  assert.match(text, /2026/);
  assert.match(text, /9:58/);
  assert.doesNotMatch(text, /T09:58/);
});

test("weekday names come from Intl, not a hardcoded catalog", () => {
  const en = weekdayNames("en-US");
  const uk = weekdayNames("uk-UA");
  assert.equal(en.length, 7);
  assert.notEqual(en[1], uk[1]);
  assert.match(en[1] ?? "", /Mon/i);
});

test("describeCronExpression stays isomorphic and does not invent weekly mode", () => {
  const text = describeCronExpression("0 9 1-5 * 1", "en-US");
  assert.ok(text.length > 0);
  assert.equal(cadenceToView({ kind: "cron", expression: "0 9 1-5 * 1", timeZone: "UTC" }).mode, "legacy-cron");
});

test("datetime-local and time helpers round-trip local wall time", () => {
  const at = new Date(2026, 0, 2, 9, 5).getTime();
  const value = toDatetimeLocalValue(at);
  assert.match(value, /^2026-01-02T09:05$/);
  assert.equal(fromDatetimeLocalValue(value), at);
  assert.equal(toTimeValue(9, 5), "09:05");
  assert.deepEqual(fromTimeValue("09:05"), { hour: 9, minute: 5 });
  assert.equal(fromTimeValue("25:00"), null);
  assert.equal(toDateValue(at), "2026-01-02");
  assert.equal(combineDateAndTime("2026-01-02", "09:05"), at);
  assert.match(formatOnceDate(at, "en-US"), /Jan/);
  assert.match(formatOnceTime(at, "en-US"), /9:05/);
  assert.equal(formatOnceSummary(at, "en-US"), `${formatOnceDate(at, "en-US")} · ${formatOnceTime(at, "en-US")}`);
});

test("narrow weekday names are a compact seven-day row", () => {
  const names = weekdayNames("en-US", "narrow");
  assert.equal(names.length, 7);
  assert.equal((names[1] ?? "").length, 1);
});

test("weekly cron with unsorted days is semantically equal after parse", () => {
  const original = { kind: "cron" as const, expression: "0 9 * * 5,1,3", timeZone: "UTC" };
  const rewritten = viewToCadence(cadenceToView(original));
  assert.equal(rewritten.kind, "cron");
  if (rewritten.kind !== "cron") return;
  assert.equal(rewritten.expression, "0 9 * * 1,3,5");
  assert.equal(cadencesEqual(original, rewritten), true);
});

test("compact zone choices stay small", () => {
  const zones = compactZoneChoices("Asia/Tokyo");
  assert.ok(zones.includes("UTC"));
  assert.ok(zones.includes("Asia/Tokyo"));
  assert.ok(zones.length <= 3);
});
