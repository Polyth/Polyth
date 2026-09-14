import { test } from "node:test";
import assert from "node:assert/strict";
import { coachLocalDateKey, coachMoveTarget } from "../widgets/coachTime.ts";

test("Coach move targets follow the profile timezone across a UTC day boundary", () => {
  const now = Date.parse("2026-09-10T21:30:00Z"); // 00:30 Sep 11 in Kyiv

  assert.equal(coachLocalDateKey(now, "Europe/Kyiv"), "2026-09-11");
  assert.equal(coachMoveTarget("Europe/Kyiv", "today", now), now);
  assert.equal(
    new Date(coachMoveTarget("Europe/Kyiv", "tomorrow", now)).toISOString(),
    "2026-09-12T06:00:00.000Z",
  );
  assert.equal(
    new Date(coachMoveTarget("Europe/Kyiv", "week", now)).toISOString(),
    "2026-09-18T06:00:00.000Z",
  );
});

test("Coach move targets keep local wall time through a DST offset change", () => {
  const now = Date.parse("2026-10-24T09:00:00Z");
  const tomorrow = coachMoveTarget("Europe/Kyiv", "tomorrow", now);

  assert.equal(coachLocalDateKey(tomorrow, "Europe/Kyiv"), "2026-10-25");
  assert.equal(new Date(tomorrow).toISOString(), "2026-10-25T07:00:00.000Z");
});

test("Later today never spills into the next Coach-local day", () => {
  const now = Date.parse("2026-09-10T20:00:00Z"); // 23:00 in Kyiv
  const later = coachMoveTarget("Europe/Kyiv", "later", now);

  assert.ok(later > now);
  assert.equal(coachLocalDateKey(later, "Europe/Kyiv"), "2026-09-10");
  assert.equal(new Date(later).toISOString(), "2026-09-10T20:30:00.000Z");
});
