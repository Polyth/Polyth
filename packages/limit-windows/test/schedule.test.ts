import test from "node:test";
import assert from "node:assert/strict";
import { insideDailyRange, isClockTime, isValidTimeZone, localParts, localTimeToUtc, nextOccurrence } from "../src/schedule.ts";

const KYIV = "Europe/Kyiv";
const at = (iso: string): number => Date.parse(iso);

test("the next occurrence is today's when it is still ahead, tomorrow's otherwise", () => {
  // 2026-11-05 is EET (UTC+2).
  assert.equal(nextOccurrence(["09:00"], [], KYIV, at("2026-11-05T05:00:00Z")), at("2026-11-05T07:00:00Z"));
  assert.equal(nextOccurrence(["09:00"], [], KYIV, at("2026-11-05T07:00:00Z")), at("2026-11-05T07:00:00Z"));
  assert.equal(nextOccurrence(["09:00"], [], KYIV, at("2026-11-05T07:00:01Z")), at("2026-11-06T07:00:00Z"));
});

test("the nearest of several times wins, whatever their order", () => {
  assert.equal(nextOccurrence(["14:00", "09:00"], [], KYIV, at("2026-11-05T05:00:00Z")), at("2026-11-05T07:00:00Z"));
  assert.equal(nextOccurrence(["14:00", "09:00"], [], KYIV, at("2026-11-05T08:00:00Z")), at("2026-11-05T12:00:00Z"));
});

test("a weekday list skips to the next listed day", () => {
  // Thursday 2026-11-05; only Mondays.
  assert.equal(nextOccurrence(["09:00"], [1], KYIV, at("2026-11-05T05:00:00Z")), at("2026-11-09T07:00:00Z"));
  // Monday itself, already past: the Monday a week later.
  assert.equal(nextOccurrence(["09:00"], [1], KYIV, at("2026-11-09T08:00:00Z")), at("2026-11-16T07:00:00Z"));
});

test("nothing to schedule answers null", () => {
  assert.equal(nextOccurrence([], [], KYIV, 0), null);
  assert.equal(nextOccurrence(["09:00"], [], "Not/AZone", 0), null);
});

test("a clock change keeps the wall-clock hour and does not skip a date", () => {
  // Autumn: 25 Oct 2026, EEST to EET at 04:00 local. 09:00 moves from 06:00Z to 07:00Z.
  assert.equal(nextOccurrence(["09:00"], [], KYIV, at("2026-10-24T07:00:00Z")), at("2026-10-25T07:00:00Z"));
  // Spring: 28 Mar 2027 is 23 hours long. From 23:30 the day before, that date is not skipped.
  assert.equal(nextOccurrence(["09:00"], [], KYIV, at("2027-03-27T21:30:00Z")), at("2027-03-28T06:00:00Z"));
});

test("a time the clock skips lands just past the gap; a repeated one on its first pass", () => {
  // 28 Mar 2027 03:30 does not exist in Kyiv (03:00 jumps to 04:00).
  const skipped = localParts(localTimeToUtc(2027, 3, 28, 3 * 60 + 30, KYIV), KYIV);
  assert.deepEqual([skipped.hour, skipped.minute], [4, 30]);
  // 25 Oct 2026 03:30 happens twice; the first is still at UTC+3.
  assert.equal(localTimeToUtc(2026, 10, 25, 3 * 60 + 30, KYIV), at("2026-10-25T00:30:00Z"));
});

test("a daily range can wrap past midnight", () => {
  const noon = at("2026-11-05T10:00:00Z");
  const night = at("2026-11-05T22:00:00Z");
  assert.equal(insideDailyRange(noon, "08:00", "23:00", KYIV), true);
  assert.equal(insideDailyRange(night, "08:00", "23:00", KYIV), false);
  assert.equal(insideDailyRange(night, "22:00", "06:00", KYIV), true);
  assert.equal(insideDailyRange(noon, "22:00", "06:00", KYIV), false);
  assert.equal(insideDailyRange(noon, "08:00", "08:00", KYIV), true);
});

test("validators", () => {
  assert.equal(isClockTime("09:00"), true);
  for (const bad of ["9:00", "24:00", "09:60", "", null, 900]) assert.equal(isClockTime(bad), false);
  assert.equal(isValidTimeZone(KYIV), true);
  for (const bad of ["Not/AZone", "", null, 3]) assert.equal(isValidTimeZone(bad), false);
});
