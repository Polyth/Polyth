// "By marker" in the session lists' Group by menu: one group per chat, in the
// marker list's order, unmarked chats last, and a re-sort when markers change.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import type { SessionProjection } from "@polyth/contracts";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { BUILT_IN_MARKERS } = await import("../src/markers.ts");
const { acceptSnapshot, resetMarkerState } = await import("../widgets/client.ts");
const { markerGrouping, MARKER_GROUPING_ID } = await import("../widgets/grouping.ts");
const { arrangeSessions, sessionGroupsOf } = await import("../../../apps/web/src/sidebarPrefs.ts");

const session = (id: string, lastTurnAt: number): SessionProjection => ({
  id, projectId: "p", title: id, status: "idle", createdAt: 1, updatedAt: 1, lastTurnAt,
});
const marked = (sessionId: string, ...ids: string[]) => ({
  sessionId, projectId: "p", title: sessionId, archived: false, updatedAt: 1,
  markers: ids.map((id) => ({ id, at: 1, by: { kind: "person", userId: "u" } as const })),
});
const context = { relativeTime: false, locale: "en", now: 0 };

test("chats group under their first marker in the marker list's order", () => {
  resetMarkerState();
  const custom = { id: "blocked", label: "Blocked", color: "red", icon: "flag", builtIn: false } as const;
  acceptSnapshot({
    revision: 1,
    definitions: [...BUILT_IN_MARKERS, custom],
    sessions: [
      marked("both", "important", "needs-review"),
      marked("custom", "blocked"),
      marked("later", "reply-later"),
      marked("gone", "deleted-marker"),
    ],
  });
  const grouping = markerGrouping();
  assert.equal(grouping.id, MARKER_GROUPING_ID);
  const sessions = [
    session("plain", 90),
    session("custom", 80),
    session("later", 70),
    session("both", 60),
    session("gone", 50),
  ];
  const arranged = arrangeSessions(sessions, grouping, "recent");
  const groups = sessionGroupsOf(arranged, grouping, context);
  assert.deepEqual(groups.map((group) => group.label), ["Needs review", "Reply later", "Blocked", "No marker"]);
  assert.deepEqual(groups.map((group) => group.sessions.map((s) => s.id)), [
    ["both"], ["later"], ["custom"], ["plain", "gone"],
  ]);
  resetMarkerState();
});

test("a marker change notifies the active grouping", () => {
  resetMarkerState();
  let calls = 0;
  const off = markerGrouping().subscribe!(() => { calls += 1; });
  acceptSnapshot({ revision: 2, definitions: [...BUILT_IN_MARKERS], sessions: [marked("a", "important")] });
  off();
  acceptSnapshot({ revision: 3, definitions: [...BUILT_IN_MARKERS], sessions: [] });
  assert.equal(calls, 1);
  resetMarkerState();
});
