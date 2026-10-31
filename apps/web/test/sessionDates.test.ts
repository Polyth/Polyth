import test from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import {
  compareSessionNavigation,
  groupSessionsByActivityDate,
  sessionDateGroupLabel,
  sessionDateInputValue,
  sessionMatchesDateFilter,
  sortPinnedSessions,
} from "../src/sessionDates.ts";

const at = (day: number, hour = 12) => new Date(2026, 8, day, hour).getTime();
const session = (over: Partial<SessionProjection> & { id: string }): SessionProjection => ({
  projectId: "p1",
  title: over.id,
  status: "idle",
  createdAt: at(12),
  updatedAt: at(12),
  ...over,
});

test("session navigation is pinned-first then chronological and ignores metadata-only updates", () => {
  const sessions = [
    session({ id: "older", createdAt: at(9), updatedAt: at(12) }),
    session({ id: "newer", createdAt: at(11), updatedAt: at(11) }),
    session({ id: "second-pin", createdAt: at(12), pinned: { position: 4 } }),
    session({ id: "top-pin", createdAt: at(8), pinned: { position: -1 } }),
  ];

  assert.deepEqual([...sessions].sort(compareSessionNavigation).map((item) => item.id), [
    "top-pin", "second-pin", "newer", "older",
  ]);
  assert.deepEqual(sortPinnedSessions(sessions).map((item) => item.id), ["top-pin", "second-pin"]);
});

test("single-date and inclusive date-range filters use local calendar days", () => {
  const item = session({ id: "target", createdAt: at(10, 23) });
  assert.equal(sessionDateInputValue(item.createdAt), "2026-09-10");
  assert.equal(sessionMatchesDateFilter(item, { mode: "date", date: "2026-09-10", from: "", to: "" }), true);
  assert.equal(sessionMatchesDateFilter(item, { mode: "date", date: "2026-09-11", from: "", to: "" }), false);
  assert.equal(sessionMatchesDateFilter(item, { mode: "range", date: "", from: "2026-09-09", to: "2026-09-10" }), true);
  assert.equal(sessionMatchesDateFilter(item, { mode: "range", date: "", from: "2026-09-11", to: "2026-09-12" }), false);
});

test("chronological chats form subtle day groups with localized relative labels", () => {
  const groups = groupSessionsByActivityDate([
    session({ id: "today-a", createdAt: at(12, 17) }),
    session({ id: "today-b", createdAt: at(12, 9) }),
    session({ id: "yesterday", createdAt: at(11, 20) }),
    session({ id: "older", createdAt: at(10, 8) }),
  ]);

  assert.deepEqual(groups.map((group) => group.sessions.map((item) => item.id)), [
    ["today-a", "today-b"], ["yesterday"], ["older"],
  ]);
  assert.equal(sessionDateGroupLabel(at(12), true, "en", at(12, 18)), "today");
  assert.equal(sessionDateGroupLabel(at(11), true, "en", at(12, 18)), "yesterday");
  assert.equal(sessionDateGroupLabel(at(10), true, "en", at(12, 18)), "2 days ago");
});
