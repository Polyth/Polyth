// WP13: sidebar Group-by — mode validation/persistence fallback, pure
// bucketing, and plugin-contributed grouping descriptors.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import {
  applyManualProjectOrder, BUILTIN_GROUPINGS, getGroupingMode, groupSessions, listGroupings,
  parseGroupingMode, registerGrouping, setGroupingMode, reorderManualProjects,
} from "../src/sidebarPrefs.ts";

const session = (over: Partial<SessionProjection> & { id: string }): SessionProjection => ({
  projectId: "p1",
  title: over.id,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

test("built-ins: flat, folder, status, worktree", () => {
  assert.deepEqual(BUILTIN_GROUPINGS.map((g) => g.id), ["flat", "folder", "status", "worktree"]);
});

test("parseGroupingMode falls back to folder for unknown/absent modes", () => {
  const known = [...BUILTIN_GROUPINGS];
  assert.equal(parseGroupingMode("status", known), "status");
  assert.equal(parseGroupingMode("bogus", known), "folder");
  assert.equal(parseGroupingMode(null, known), "folder");
});

test("groupSessions buckets by status with busiest-first-appearance order", () => {
  const sessions = [
    session({ id: "a", status: "working" }),
    session({ id: "b", status: "idle" }),
    session({ id: "c", status: "working" }),
  ];
  const groups = groupSessions(sessions, "status");
  assert.deepEqual(groups.map((g) => g.label), ["Working", "Idle"]);
  assert.deepEqual(groups[0]!.sessions.map((s) => s.id), ["a", "c"]);
});

test("groupSessions worktree uses branch, worktree basename, then main workspace", () => {
  const sessions = [
    session({ id: "a", branch: "feat/x" }),
    session({ id: "b", worktreePath: "/tmp/wt/feat-y" }),
    session({ id: "c" }),
  ];
  const groups = groupSessions(sessions, "worktree");
  assert.deepEqual(groups.map((g) => g.label), ["feat/x", "feat-y", "Main workspace"]);
});

test("flat and folder modes return one structural bucket", () => {
  const sessions = [session({ id: "a" }), session({ id: "b" })];
  for (const mode of ["flat", "folder"]) {
    const groups = groupSessions(sessions, mode);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.sessions.length, 2);
  }
});

test("manual ordering moves a project into its drop target's slot", () => {
  const projects = [session({ id: "new" }), session({ id: "middle" }), session({ id: "old" })];
  const order = reorderManualProjects(projects.map((item) => item.id), "old", "new");
  assert.deepEqual(order, ["old", "new", "middle"]);
  assert.deepEqual(applyManualProjectOrder(projects, order).map((item) => item.id), order);
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

test("plugin groupings need a pure keyOf, no duplicates; dispose falls back", () => {
  assert.throws(() => registerGrouping({ id: "byagent", label: "Agent" }), /keyOf/);
  assert.throws(() => registerGrouping({ id: "status", label: "clash", keyOf: () => "x" }), /already/);

  const dispose = registerGrouping({ id: "byagent", label: "Agent", keyOf: (s) => s.agent ?? "No agent" });
  try {
    assert.ok(listGroupings().some((g) => g.id === "byagent"));
    setGroupingMode("byagent");
    assert.equal(getGroupingMode(), "byagent");
    const groups = groupSessions([session({ id: "a", agent: "build" }), session({ id: "b" })], "byagent");
    assert.deepEqual(groups.map((g) => g.label), ["build", "No agent"]);
  } finally {
    dispose();
  }
  // disposed contribution: stored mode no longer resolves → folder
  assert.ok(!listGroupings().some((g) => g.id === "byagent"));
  assert.equal(getGroupingMode(), "folder");
  setGroupingMode("folder");
});

test("setGroupingMode rejects unknown ids by falling back to folder", () => {
  setGroupingMode("status");
  assert.equal(getGroupingMode(), "status");
  setGroupingMode("not-a-mode");
  assert.equal(getGroupingMode(), "folder");
});
