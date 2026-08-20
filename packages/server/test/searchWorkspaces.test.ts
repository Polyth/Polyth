import { test } from "node:test";
import assert from "node:assert/strict";
import type { Project, SessionProjection, WorkspaceLabel } from "@polyth/contracts";
import { matchWorkspaces, parseArchivedFilter, foldText } from "../src/search.ts";

const project = (id: string, name: string, path = `/repos/${name}`): Project => ({
  id, name, path, createdAt: 1000,
});

const session = (over: Partial<SessionProjection> & { id: string; projectId: string }): SessionProjection => ({
  title: "untitled",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

test("same title across projects: both returned, disambiguated by subtitle", () => {
  const projects = [project("p1", "alpha"), project("p2", "beta")];
  const sessions = [
    session({ id: "s1", projectId: "p1", title: "Fix login", updatedAt: 10 }),
    session({ id: "s2", projectId: "p2", title: "Fix login", updatedAt: 20 }),
  ];
  const items = matchWorkspaces({ projects, sessions, q: "fix login" });
  assert.equal(items.length, 2);
  assert.equal(items[0]!.id, "s2"); // recency order within sessions
  assert.ok(items[0]!.subtitle!.includes("beta"));
  assert.ok(items[1]!.subtitle!.includes("alpha"));
});

test("archived sessions hidden by default, exclusive behind archived flag", () => {
  const projects = [project("p1", "alpha")];
  const sessions = [
    session({ id: "live", projectId: "p1", title: "report", status: "idle" }),
    session({ id: "old", projectId: "p1", title: "report", status: "archived" }),
  ];
  const def = matchWorkspaces({ projects, sessions, q: "report" });
  assert.deepEqual(def.map((i) => i.id), ["live"]);
  const arch = matchWorkspaces({ projects, sessions, q: "report", archived: true });
  assert.deepEqual(arch.map((i) => i.id), ["old"]);
  assert.equal(arch[0]!.archived, true);
});

test("branch and label names match; keywords carried on the row", () => {
  const projects = [project("p1", "alpha")];
  const labels: WorkspaceLabel[] = [{ id: "l1", name: "urgent", color: "#f00", position: 0, revision: 1 }];
  const sessions = [
    session({ id: "s1", projectId: "p1", title: "one", branch: "feat/payments" }),
    session({ id: "s2", projectId: "p1", title: "two", labelIds: ["l1"] }),
    session({ id: "s3", projectId: "p1", title: "three" }),
  ];
  assert.deepEqual(matchWorkspaces({ projects, sessions, labels, q: "payments" }).map((i) => i.id), ["s1"]);
  const byLabel = matchWorkspaces({ projects, sessions, labels, q: "urgent" });
  assert.deepEqual(byLabel.map((i) => i.id), ["s2"]);
  assert.deepEqual(byLabel[0]!.keywords, ["urgent"]);
});

test("sessions of deleted projects never surface", () => {
  const sessions = [session({ id: "s1", projectId: "gone", title: "orphan work" })];
  assert.deepEqual(matchWorkspaces({ projects: [], sessions, q: "orphan" }), []);
});

test("projects match on name or path and lead the list", () => {
  const projects = [project("p1", "polyth", "/home/dev/polyth")];
  const sessions = [session({ id: "s1", projectId: "p1", title: "polyth refactor", updatedAt: 99 })];
  const items = matchWorkspaces({ projects, sessions, q: "polyth" });
  assert.deepEqual(items.map((i) => i.kind), ["project", "session"]);
  const byPath = matchWorkspaces({ projects, sessions: [], q: "home/dev" });
  assert.equal(byPath.length, 1);
  assert.equal(byPath[0]!.kind, "project");
});

test("1000 sessions stay bounded by limit and cap", () => {
  const projects = [project("p1", "alpha")];
  const sessions = Array.from({ length: 1000 }, (_, i) =>
    session({ id: `s${i}`, projectId: "p1", title: `bulk item ${i}`, updatedAt: i }),
  );
  const items = matchWorkspaces({ projects, sessions, q: "bulk", limit: 10 });
  assert.equal(items.length, 10);
  assert.equal(items[0]!.id, "s999"); // most recent first
  const capped = matchWorkspaces({ projects, sessions, q: "bulk", limit: 5000 });
  assert.equal(capped.length, 100); // hard cap
});

test("Unicode: diacritic and case folding both directions", () => {
  const projects = [project("p1", "Álbum Fotos")];
  const sessions = [session({ id: "s1", projectId: "p1", title: "Déployer côté serveur" })];
  assert.equal(matchWorkspaces({ projects, sessions, q: "album" })[0]!.kind, "project");
  assert.equal(matchWorkspaces({ projects, sessions, q: "DEPLOYER" })[0]!.id, "s1");
  assert.equal(foldText("Œ").length > 0, true); // fold never throws on odd input
});

test("empty and whitespace queries return nothing", () => {
  const projects = [project("p1", "alpha")];
  assert.deepEqual(matchWorkspaces({ projects, sessions: [], q: "" }), []);
  assert.deepEqual(matchWorkspaces({ projects, sessions: [], q: "   " }), []);
});

test("is:archived alone lists recent archived sessions, bounded", () => {
  const projects = [project("p1", "alpha")];
  const sessions = [
    session({ id: "a1", projectId: "p1", title: "one", status: "archived", updatedAt: 5 }),
    session({ id: "a2", projectId: "p1", title: "two", status: "archived", updatedAt: 9 }),
    session({ id: "live", projectId: "p1", title: "three", status: "idle" }),
  ];
  const items = matchWorkspaces({ projects, sessions, q: "", archived: true, limit: 1 });
  assert.deepEqual(items.map((i) => i.id), ["a2"]);
});

test("parseArchivedFilter strips the token anywhere in the query", () => {
  assert.deepEqual(parseArchivedFilter("is:archived report"), { q: "report", archived: true });
  assert.deepEqual(parseArchivedFilter("report is:archived"), { q: "report", archived: true });
  assert.deepEqual(parseArchivedFilter("plain query"), { q: "plain query", archived: false });
  // no partial-token false positives
  assert.deepEqual(parseArchivedFilter("thisis:archivedish"), { q: "thisis:archivedish", archived: false });
});
