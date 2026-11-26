import test from "node:test";
import assert from "node:assert/strict";
import type { Project, SessionProjection } from "@polyth/contracts";
import { pinnedAboveSessions, projectMonogram, sessionProjectMark } from "../src/pinnedSessions.ts";
import { parsePinnedPlacement } from "../src/sidebarPrefs.ts";
import { setLocale, tr } from "../src/i18n/index.ts";

const project = (over: Partial<Project> & { id: string }): Project => ({
  name: over.id,
  path: `/work/${over.id}`,
  ...over,
} as Project);
const session = (over: Partial<SessionProjection> & { id: string }): SessionProjection => ({
  projectId: "alpha",
  title: over.id,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const projects = new Map([
  project({ id: "alpha", name: "Alpha", icon: "🅰" }),
  project({ id: "beta", name: "", path: "/work/beta-checkout" }),
  project({ id: "alpha-room", name: "room", parentProjectId: "alpha" }),
].map((candidate) => [candidate.id, candidate]));

test("pinned placement keeps each project's list unless the reader chose top", () => {
  assert.equal(parsePinnedPlacement("top"), "top");
  for (const raw of ["project", undefined, null, "", "TOP", 1]) assert.equal(parsePinnedPlacement(raw), "project");
});

test("the Pinned group gathers every live pinned chat of the Space, in pin order", () => {
  const sessions = [
    session({ id: "alpha-second", pinned: { position: 1 } }),
    session({ id: "beta-first", projectId: "beta", pinned: { position: 0 } }),
    session({ id: "alpha-unpinned" }),
    session({ id: "alpha-archived", status: "archived", pinned: { position: 0 } }),
    session({ id: "foreign", projectId: "other-space-project", pinned: { position: 0 } }),
    session({ id: "room-pin", projectId: "alpha-room", pinned: { position: 2 } }),
  ];
  assert.deepEqual(pinnedAboveSessions(sessions, projects).map((item) => item.id), ["beta-first", "alpha-second", "room-pin"]);
});

test("the Pinned group keeps the navigator's attention filter", () => {
  const sessions = [
    session({ id: "quiet", pinned: { position: 0 } }),
    session({ id: "asking", pinned: { position: 1 }, attention: { questions: 1, permissions: 0 } } as Partial<SessionProjection> & { id: string }),
    session({ id: "running", projectId: "beta", status: "working", pinned: { position: 2 } }),
  ];
  assert.deepEqual(
    pinnedAboveSessions(sessions, projects, { attentionOnly: true }).map((item) => item.id),
    ["asking", "running"],
  );
});

test("a pinned row names its project, and a private room as its project's own", async () => {
  await setLocale("en");
  assert.deepEqual(sessionProjectMark(projects, { projectId: "alpha" }), {
    project: projects.get("alpha"), name: "Alpha", monogram: "", path: "/work/alpha",
  });
  assert.equal(sessionProjectMark(projects, { projectId: "beta" })?.name, "/work/beta-checkout");
  const room = sessionProjectMark(projects, { projectId: "alpha-room" });
  assert.equal(room?.project, projects.get("alpha"));
  assert.equal(room?.name, `Alpha · ${tr("privateRoom.onlyMe")}`);
  assert.equal(sessionProjectMark(projects, { projectId: "missing" }), undefined);
});

test("a project without an icon is marked by its initial", () => {
  // A nameless project goes by its folder, not the whole path.
  assert.equal(sessionProjectMark(projects, { projectId: "beta" })?.monogram, "B");
  // A project with an icon draws the icon; a room draws its project's mark.
  assert.equal(sessionProjectMark(projects, { projectId: "alpha-room" })?.monogram, "");
  const cases: Array<[string, string]> = [
    ["Home Assistant", "H"],
    ["polyth-site", "P"],
    ["myProject", "M"],
    ["c2f4a6976e5b", "C"],
    ["2026 budget", "2"],
    ["🚀 launch plan", "L"],
    ["україна дім", "У"],
    ["项目管理", "项"],
    ["  ", ""],
    ["🚀", ""],
  ];
  for (const [name, monogram] of cases) assert.equal(projectMonogram(name), monogram, name);
  assert.equal(projectMonogram("Écoles"), "É", "a decomposed accent keeps its letter whole");
});
