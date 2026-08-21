import test from "node:test";
import assert from "node:assert/strict";
import type { Project } from "@polyth/contracts";
import {
  beginListRequest,
  initialProjectRegistry,
  normalizeProjects,
  publishListFailure,
  publishListSuccess,
  removeProject,
  replacementActiveId,
  resolveActiveProjectId,
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
  assert.equal(resolveActiveProjectId([], { savedProjectId: "missing" }), null);

  assert.equal(replacementActiveId(projects, "url"), "url");
  assert.equal(replacementActiveId(projects, "missing"), "first");
  assert.equal(replacementActiveId([], "missing"), null);
});
