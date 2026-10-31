// Sidebar Group-by — mode validation/persistence fallback, pure
// bucketing, and plugin-contributed grouping descriptors.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import { readFile } from "node:fs/promises";
import {
  applyManualProjectOrder, arrangeSessions, BUILTIN_GROUPINGS, getGroupingMode, getShowDateGroups,
  getSidebarPrefsSnapshot, listGroupings, orderProjects, parseGroupingMode, parseProjectSortMode,
  parseSessionSortMode, registerGrouping, replaceSidebarPrefs, sessionGroupsOf, sessionTypeOf,
  setGroupingMode, setSessionSortMode, permuteManualProjects, type GroupingDescriptor,
} from "../src/sidebarPrefs.ts";

const session = (over: Partial<SessionProjection> & { id: string }): SessionProjection => ({
  projectId: "p1",
  title: over.id,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const ids = (list: readonly { id: string }[]) => list.map((item) => item.id);
const grouping = (id: string): GroupingDescriptor => listGroupings().find((g) => g.id === id)!;
const context = { relativeTime: false, locale: "en", now: new Date("2026-10-24T15:00:00").getTime() };

test("built-ins: none, date, type", () => {
  assert.deepEqual(BUILTIN_GROUPINGS.map((g) => g.id), ["none", "date", "type"]);
});

test("parseGroupingMode falls back to none for unknown/absent modes", () => {
  const known = [...BUILTIN_GROUPINGS];
  assert.equal(parseGroupingMode("type", known), "type");
  assert.equal(parseGroupingMode("bogus", known), "none");
  assert.equal(parseGroupingMode(null, known), "none");
});

test("every chat has one type, what needs the person first", () => {
  assert.equal(sessionTypeOf(session({ id: "q", status: "waiting" })), "attention");
  assert.equal(sessionTypeOf(session({ id: "p", attention: { questions: 0, permissions: 1, unread: 0 } })), "attention");
  assert.equal(sessionTypeOf(session({ id: "w", status: "working", isolationSummary: "git-worktree" })), "progress");
  assert.equal(sessionTypeOf(session({ id: "d", draftPreview: "Write the notes" })), "draft");
  // A draft in a chat with history must not move the chat while it is typed.
  assert.equal(sessionTypeOf(session({ id: "h", draftPreview: "more", lastTurnAt: 5 })), "workspace");
  assert.equal(sessionTypeOf(session({ id: "s", sharing: { visibility: "space", access: "manage", shared: true } })), "shared");
  assert.equal(sessionTypeOf(session({ id: "i", isolationSummary: "git-worktree" })), "isolated");
  assert.equal(sessionTypeOf(session({ id: "b", branch: "polyth/isolate/abc" })), "isolated");
  assert.equal(sessionTypeOf(session({ id: "f", status: "failed" })), "workspace");
});

test("grouping by type keeps groups contiguous in a fixed order, newest first inside", () => {
  const sessions = [
    session({ id: "old-isolated", isolationSummary: "git-worktree", lastTurnAt: 10 }),
    session({ id: "plain", lastTurnAt: 50 }),
    session({ id: "new-isolated", isolationSummary: "git-worktree", lastTurnAt: 40 }),
    session({ id: "running", status: "working", lastTurnAt: 5 }),
    session({ id: "asks", status: "waiting", lastTurnAt: 1 }),
  ];
  const arranged = arrangeSessions(sessions, grouping("type"), "recent");
  assert.deepEqual(ids(arranged), ["asks", "running", "new-isolated", "old-isolated", "plain"]);
  const groups = sessionGroupsOf(arranged, grouping("type"), context);
  assert.deepEqual(groups.map((g) => g.label), ["Needs attention", "In progress", "Isolated", "Shared workspace"]);
  assert.deepEqual(ids(groups[2]!.sessions), ["new-isolated", "old-isolated"]);
});

test("sort orders inside a group: recent, created, title, type", () => {
  const sessions = [
    session({ id: "b", title: "beta 10", createdAt: 300, lastTurnAt: 400 }),
    session({ id: "a", title: "Alpha", createdAt: 100, lastTurnAt: 900 }),
    session({ id: "c", title: "beta 9", createdAt: 200, lastTurnAt: 500, isolationSummary: "git-worktree" }),
    session({ id: "d", title: "", draftPreview: "Delta draft", createdAt: 50 }),
  ];
  const none = grouping("none");
  assert.deepEqual(ids(arrangeSessions(sessions, none, "recent")), ["a", "c", "b", "d"]);
  assert.deepEqual(ids(arrangeSessions(sessions, none, "created")), ["b", "c", "a", "d"]);
  // Natural, case-insensitive titles; a draft is named by its draft.
  assert.deepEqual(ids(arrangeSessions(sessions, none, "title")), ["a", "c", "b", "d"]);
  assert.deepEqual(ids(arrangeSessions(sessions, none, "type")), ["d", "c", "a", "b"]);
  // Ungrouped: one group, no heading.
  assert.deepEqual(sessionGroupsOf(sessions, none, context).map((g) => g.label), [null]);
  // The input is never mutated: React state holds it.
  assert.deepEqual(ids(sessions), ["b", "a", "c", "d"]);
});

test("date groups put the newest day first and draw no heading for today", () => {
  const day = (iso: string) => new Date(iso).getTime();
  const sessions = [
    session({ id: "yesterday", lastTurnAt: day("2026-10-23T09:00:00"), title: "A" }),
    session({ id: "today", lastTurnAt: day("2026-10-24T08:00:00"), title: "Z" }),
    session({ id: "older", lastTurnAt: day("2026-10-01T09:00:00"), title: "B" }),
  ];
  // Even sorted by title the days stay in order.
  const arranged = arrangeSessions(sessions, grouping("date"), "title");
  assert.deepEqual(ids(arranged), ["today", "yesterday", "older"]);
  const labels = sessionGroupsOf(arranged, grouping("date"), context).map((g) => g.label);
  assert.equal(labels[0], null);
  assert.equal(labels.length, 3);
});

test("the old date switch becomes the date grouping, and stays its compatibility record", () => {
  replaceSidebarPrefs({ grouping: "folder", viewMode: "rail", showDateGroups: true });
  assert.equal(getGroupingMode(), "date");
  replaceSidebarPrefs({ grouping: "folder", viewMode: "rail", showDateGroups: false });
  assert.equal(getGroupingMode(), "none");
  setGroupingMode("date");
  assert.equal(getShowDateGroups(), true);
  assert.equal(getSidebarPrefsSnapshot().showDateGroups, true);
  setGroupingMode("type");
  assert.equal(getShowDateGroups(), false);
  assert.deepEqual(getSidebarPrefsSnapshot(), { grouping: "type", viewMode: "rail", showDateGroups: false, sessionSort: "recent" });
  setSessionSortMode("title");
  assert.equal(getSidebarPrefsSnapshot().sessionSort, "title");
  setSessionSortMode("recent");
  setGroupingMode("none");
});

test("a synced package grouping survives until its package registers", () => {
  replaceSidebarPrefs({ grouping: "pkg.marker", viewMode: "rail", showDateGroups: false });
  assert.equal(getGroupingMode(), "none", "not offered yet");
  assert.equal(getSidebarPrefsSnapshot().grouping, "pkg.marker", "the choice is not overwritten");
  const dispose = registerGrouping({ id: "pkg.marker", label: "Marker", keyOf: () => "x" });
  try {
    assert.equal(getGroupingMode(), "pkg.marker");
  } finally {
    dispose();
  }
  setGroupingMode("none");
});

test("session sort accepts its modes with a recent fallback", () => {
  for (const mode of ["recent", "created", "title", "type"]) assert.equal(parseSessionSortMode(mode), mode);
  assert.equal(parseSessionSortMode("bogus"), "recent");
  assert.equal(parseSessionSortMode(null), "recent");
});

test("a move saves every project, and projects a filter hides keep their slots", () => {
  const ordered = ["a", "hidden-1", "b", "c", "hidden-2", "d"];
  // On screen: a b c d; the user moved d to the top.
  const order = permuteManualProjects(ordered, ["d", "a", "b", "c"]);
  assert.deepEqual(order, ["d", "hidden-1", "a", "b", "hidden-2", "c"]);
  const projects = ordered.map((id) => session({ id }));
  assert.deepEqual(applyManualProjectOrder(projects, order).map((item) => item.id), order);
  // Nothing hidden: the new order is saved as it is.
  assert.deepEqual(permuteManualProjects(["a", "b", "c"], ["c", "a", "b"]), ["c", "a", "b"]);
});

test("manual order defaults to newest-created first when nothing was dragged", () => {
  const sessions = [
    session({ id: "old", createdAt: 100 }),
    session({ id: "new", createdAt: 300 }),
    session({ id: "mid", createdAt: 200 }),
  ];
  assert.deepEqual(applyManualProjectOrder(sessions, []).map((item) => item.id), ["new", "mid", "old"]);
});

test("manual order keeps unknown items above stored ones and sorts them by createdAt", () => {
  const sessions = [
    session({ id: "a", createdAt: 300 }),
    session({ id: "b", createdAt: 100 }),
    session({ id: "c", createdAt: 200 }),
  ];
  assert.deepEqual(applyManualProjectOrder(sessions, ["b"]).map((item) => item.id), ["a", "c", "b"]);
});

// One ordering authority: the same stored sort must put a project in the same
// place on the sidebar, the phone navigator and the settings pickers.
test("one project ordering rule, whatever surface asks for it", () => {
  const projects = [
    { id: "alpha", name: "Alpha", path: "/a", createdAt: 1 },
    { id: "beta", name: "Beta", path: "/b", createdAt: 2 },
    { id: "gamma", name: "Gamma", path: "/g", createdAt: 3 },
  ];
  const activity = (id: string) => ({ alpha: 50, beta: 900, gamma: 10 })[id] ?? 0;
  const ids = (list: readonly { id: string }[]) => list.map((item) => item.id);

  assert.deepEqual(ids(orderProjects(projects, "recent", [], activity)), ["beta", "alpha", "gamma"]);
  assert.deepEqual(ids(orderProjects(projects, "name", [], activity)), ["alpha", "beta", "gamma"]);
  assert.deepEqual(
    ids(orderProjects(projects, "manual", ["gamma", "alpha", "beta"], activity)),
    ["gamma", "alpha", "beta"],
  );
  // Equal activity falls back to the name, never to the input order.
  assert.deepEqual(ids(orderProjects(projects, "recent", [])), ["alpha", "beta", "gamma"]);
  // A caller that supplies no activity cannot invent one surface's own rule.
  assert.deepEqual(ids(orderProjects(projects, "recent", [], () => 0)), ["alpha", "beta", "gamma"]);
  // The input array is never mutated: React state holds it.
  const original = ids(projects);
  orderProjects(projects, "recent", [], activity);
  assert.deepEqual(ids(projects), original);
});

// A new project list that sorts by itself would silently reintroduce the
// defect: the same preference, a different order on another screen. The phone
// navigator is deliberately excluded — its "recent" puts projects that need
// attention first, and that divergence is guarded by its own tests.
test("no surface re-implements the shared project ordering", async () => {
  const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");
  const surfaces = {
    sidebar: "../src/components/Sidebar.tsx",
    settings: "../src/components/settings/pages.tsx",
  };
  for (const [name, path] of Object.entries(surfaces)) {
    const source = await read(path);
    assert.ok(source.includes("useOrderedProjects"), `${name} consumes the shared project ordering`);
    assert.ok(!source.includes("applyManualProjectOrder"), `${name} no longer hand-rolls the manual order`);
  }
});

test("project sort mode accepts activity, name, and manual with a recent fallback", () => {
  assert.equal(parseProjectSortMode("recent"), "recent");
  assert.equal(parseProjectSortMode("name"), "name");
  assert.equal(parseProjectSortMode("manual"), "manual");
  assert.equal(parseProjectSortMode("unknown"), "recent");
  assert.equal(parseProjectSortMode(null), "recent");
});

test("package groupings need a pure keyOf, no duplicates; rank and labels are theirs", () => {
  assert.throws(() => registerGrouping({ id: "byagent", label: "Agent" }), /keyOf/);
  assert.throws(() => registerGrouping({ id: "type", label: "clash", keyOf: () => "x" }), /already/);

  const dispose = registerGrouping({
    id: "byagent",
    label: "Agent",
    keyOf: (s) => s.agent ?? "",
    labelOf: (key) => key || "No agent",
    rankOf: (key) => key ? 0 : 1,
  });
  try {
    assert.ok(listGroupings().some((g) => g.id === "byagent"));
    setGroupingMode("byagent");
    assert.equal(getGroupingMode(), "byagent");
    const arranged = arrangeSessions(
      [session({ id: "b", lastTurnAt: 9 }), session({ id: "a", agent: "build", lastTurnAt: 1 })],
      grouping("byagent"),
      "recent",
    );
    const groups = sessionGroupsOf(arranged, grouping("byagent"), context);
    assert.deepEqual(groups.map((g) => g.label), ["build", "No agent"]);
  } finally {
    dispose();
  }
  // A disposed contribution reads as ungrouped.
  assert.ok(!listGroupings().some((g) => g.id === "byagent"));
  assert.equal(getGroupingMode(), "none");
  setGroupingMode("none");
});

test("setGroupingMode rejects unknown ids by falling back to none", () => {
  setGroupingMode("type");
  assert.equal(getGroupingMode(), "type");
  setGroupingMode("not-a-mode");
  assert.equal(getGroupingMode(), "none");
});
