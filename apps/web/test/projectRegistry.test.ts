import test from "node:test";
import assert from "node:assert/strict";
import type { Project } from "@polyth/contracts";
import {
  adoptProvisionalList,
  beginListRequest,
  initialProjectRegistry,
  normalizeProjects,
  publishListFailure,
  publishListSuccess,
  removeProject,
  replacementActiveId,
  resolveActiveProjectId,
  shouldRefreshProjectsOnSyncOpen,
  upsertProject,
} from "../src/projectRegistry.ts";

const project = (id: string): Project => ({
  id,
  path: `/work/${id}`,
  name: id.toUpperCase(),
  createdAt: 1,
});

test("newer list generations reject older responses", () => {
  const initial = initialProjectRegistry();
  const first = beginListRequest(initial, 1);
  const second = beginListRequest(first, 2);

  const stale = publishListSuccess(second, 1, 0, [project("old")]);
  assert.equal(stale.outcome, "stale-request");
  assert.equal(stale.state, second);

  const current = publishListSuccess(second, 2, 0, [project("current")]);
  assert.equal(current.outcome, "published");
  assert.equal(current.state.status, "ready");
  assert.deepEqual(current.state.projects.map((entry) => entry.id), ["current"]);
});

test("a confirmed mutation supersedes an in-flight list snapshot", () => {
  const seeded = publishListSuccess(
    beginListRequest(initialProjectRegistry(), 1),
    1,
    0,
    [project("one")],
  ).state;
  const refreshing = beginListRequest(seeded, 2);
  const capturedMutationVersion = seeded.status === "ready" ? seeded.mutationVersion : -1;
  const mutated = upsertProject(refreshing, project("two"));

  const stale = publishListSuccess(mutated, 2, capturedMutationVersion, [project("one")]);
  assert.equal(stale.outcome, "superseded-by-mutation");
  assert.equal(stale.state, mutated);
  assert.deepEqual(stale.state.projects.map((entry) => entry.id), ["one", "two"]);
});

test("initial and refresh failures preserve honest registry states", () => {
  const loading = beginListRequest(initialProjectRegistry(), 1);
  const failed = publishListFailure(loading, 1, "offline");
  assert.deepEqual(failed, {
    status: "failed",
    requestId: 1,
    projects: [],
    error: "offline",
  });
  assert.equal(publishListFailure(failed, 0, "stale"), failed);

  const ready = publishListSuccess(beginListRequest(failed, 2), 2, 0, [project("one")]).state;
  const refreshing = beginListRequest(ready, 3);
  const refreshFailed = publishListFailure(refreshing, 3, "try again");
  assert.equal(refreshFailed.status, "ready");
  assert.deepEqual(refreshFailed.projects.map((entry) => entry.id), ["one"]);
  if (refreshFailed.status === "ready") {
    assert.equal(refreshFailed.refreshing, false);
    assert.equal(refreshFailed.refreshError, "try again");
  }
});

test("normalization and mutations are deterministic", () => {
  const invalid = { ...project(""), id: "" };
  assert.deepEqual(
    normalizeProjects([project("one"), project("two"), project("one"), invalid]).map((entry) => entry.id),
    ["one", "two"],
  );

  const one = upsertProject(initialProjectRegistry(), project("one"));
  const renamed = upsertProject(one, { ...project("one"), name: "Renamed" });
  assert.equal(renamed.status, "ready");
  assert.equal(renamed.projects.length, 1);
  assert.equal(renamed.projects[0]?.name, "Renamed");

  const removed = removeProject(renamed, "one");
  assert.equal(removed.status, "ready");
  assert.deepEqual(removed.projects, []);
  assert.equal(removeProject(removed, "missing"), removed);
});

test("first active project selection follows the documented priority and empty fallback", () => {
  const projects = [project("first"), project("session"), project("url"), project("saved")];
  assert.equal(resolveActiveProjectId(projects, {
    sessionProjectId: "session",
    urlProjectId: "url",
    savedProjectId: "saved",
  }), "session");
  assert.equal(resolveActiveProjectId(projects, {
    sessionProjectId: "missing",
    urlProjectId: "url",
    savedProjectId: "saved",
  }), "url");
  assert.equal(resolveActiveProjectId(projects, {
    urlProjectId: "missing",
    savedProjectId: "saved",
  }), "saved");
  assert.equal(resolveActiveProjectId(projects, { savedProjectId: "missing" }), "first");
  assert.equal(resolveActiveProjectId(projects, {
    savedProjectId: "missing",
    localSavedProjectId: "url",
  }), "url");
  assert.equal(resolveActiveProjectId([], { savedProjectId: "missing" }), null);

  assert.equal(replacementActiveId(projects, "url"), "url");
  assert.equal(replacementActiveId(projects, "missing"), "first");
  assert.equal(replacementActiveId([], "missing"), null);
});

test("sync reconnect retries a failed or unselected registry, not an in-flight boot", () => {
  const loading = beginListRequest(initialProjectRegistry(), 1);
  assert.equal(shouldRefreshProjectsOnSyncOpen(loading, null), false);

  const failed = publishListFailure(loading, 1, "offline");
  assert.equal(shouldRefreshProjectsOnSyncOpen(failed, null), true);

  const ready = publishListSuccess(beginListRequest(failed, 2), 2, 0, [project("one")]).state;
  assert.equal(shouldRefreshProjectsOnSyncOpen(ready, null), true);
  assert.equal(shouldRefreshProjectsOnSyncOpen(ready, "one"), false);
  const readyEmpty = publishListSuccess(
    beginListRequest(initialProjectRegistry(), 1),
    1,
    0,
    [],
  ).state;
  assert.equal(shouldRefreshProjectsOnSyncOpen(readyEmpty, null), false);
  assert.equal(
    shouldRefreshProjectsOnSyncOpen(readyEmpty, null, "project-from-route"),
    true,
    "ready-empty contradicts an explicit project selection and must retry",
  );
});

test("a remembered list shows while the boot request is out, and that request's answer still publishes over it", () => {
  const idle = initialProjectRegistry();
  assert.equal(adoptProvisionalList(idle, [project("one")]), idle, "no request out: nothing to stand in for");
  const loading = beginListRequest(idle, 1);
  assert.equal(adoptProvisionalList(loading, []), loading, "an empty memory is not project data");
  const remembered = adoptProvisionalList(loading, [project("one"), project("one"), project("two")]);
  assert.equal(remembered.status, "ready");
  assert.deepEqual(remembered.projects.map((entry) => entry.id), ["one", "two"]);
  assert.equal(remembered.status === "ready" && remembered.provisional, true);
  assert.equal(adoptProvisionalList(remembered, [project("three")]), remembered, "only a loading registry adopts");

  const answered = publishListSuccess(remembered, 1, 0, [project("two"), project("new")]);
  assert.equal(answered.outcome, "published");
  assert.deepEqual(answered.state.projects.map((entry) => entry.id), ["two", "new"]);
  assert.equal(answered.state.status === "ready" && answered.state.provisional, undefined, "the answer is the server's");

  const failed = publishListFailure(remembered, 1, "offline");
  assert.equal(failed.status, "ready", "a failed answer keeps the remembered list on screen");
  assert.equal(failed.status === "ready" && failed.refreshError, "offline");

  const mutated = upsertProject(remembered, project("added"));
  assert.equal(publishListSuccess(mutated, 1, 0, [project("one")]).outcome, "superseded-by-mutation",
    "a mutation meanwhile still supersedes the boot answer");
});

test("socket open neither races the boot answer under a remembered list nor gives up after it failed", () => {
  const remembered = adoptProvisionalList(beginListRequest(initialProjectRegistry(), 1), [project("one")]);
  assert.equal(shouldRefreshProjectsOnSyncOpen(remembered, null), false, "the boot request owns publication");
  const failed = publishListFailure(remembered, 1, "offline");
  assert.equal(shouldRefreshProjectsOnSyncOpen(failed, "one"), true, "a failed boot answer is asked again");
});

test("a project keeps its audience through a mutation's answer, which doesn't carry it", () => {
  const shared = { id: "p", name: "Wellness", path: "/p", createdAt: 0, sharedWith: 2, othersHere: true } as Project;
  const ready = upsertProject(initialProjectRegistry(), shared);
  const renamed = upsertProject(ready, { id: "p", name: "Здоров'я", path: "/p", createdAt: 0 } as Project);
  assert.equal(renamed.status === "ready" && renamed.projects[0]?.sharedWith, 2);
  assert.equal(renamed.status === "ready" && renamed.projects[0]?.othersHere, true);
  assert.equal(renamed.status === "ready" && renamed.projects[0]?.name, "Здоров'я");
});

test("the replacement for a removed project is never someone's private room", () => {
  const room = { id: "room", name: "Wellness", path: "/r", createdAt: 0, parentProjectId: "gone" } as Project;
  const other = { id: "other", name: "Other", path: "/o", createdAt: 0 } as Project;
  assert.equal(replacementActiveId([room, other], "gone"), "other");
  assert.equal(replacementActiveId([room], "gone"), "room", "with nothing else, the chats still have a home");
});
