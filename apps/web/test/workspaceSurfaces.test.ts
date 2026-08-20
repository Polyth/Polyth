// EXTENSION-SEAMS slice 2: workspace surface registry + host selection logic.
// Covers deterministic ordering, replacement by id, disposal, late
// registration notifications, lookup, plugin availability gates, deterministic
// fallback resolution, project/session requirement gates, and the boundary
// reset identity used for same-id replacement recovery.
import test from "node:test";
import assert from "node:assert/strict";
import {
  availableWorkspaceSurfaces,
  getWorkspaceSurface,
  listWorkspaceSurfaces,
  registerWorkspaceSurface,
  resolveWorkspaceSurface,
  subscribeWorkspaceSurfaces,
  workspaceSurfaceGate,
  workspaceSurfaceVersion,
  type WorkspaceSurface,
} from "../src/workspace/surfaceRegistry.ts";
import { surfaceResetKey } from "../src/components/workspace/WorkspaceHost.ts";

const surface = (over: Partial<WorkspaceSurface> & { id: string }): WorkspaceSurface => ({
  title: over.id,
  order: 0,
  component: () => null,
  ...over,
});

test("listWorkspaceSurfaces orders by order then id, deterministically", () => {
  const offs = [
    registerWorkspaceSurface(surface({ id: "z-late", order: 1 })),
    registerWorkspaceSurface(surface({ id: "b-tie", order: 5 })),
    registerWorkspaceSurface(surface({ id: "a-tie", order: 5 })),
    registerWorkspaceSurface(surface({ id: "first", order: 0 })),
  ];
  try {
    assert.deepEqual(
      listWorkspaceSurfaces().map((s) => s.id),
      ["first", "z-late", "a-tie", "b-tie"],
    );
    assert.equal(getWorkspaceSurface("a-tie")?.order, 5);
    assert.equal(getWorkspaceSurface("missing"), undefined);
  } finally {
    for (const off of offs) off();
  }
  assert.deepEqual(listWorkspaceSurfaces(), []);
});

test("re-registering an id replaces the surface; a superseded off() is a no-op", () => {
  const offOld = registerWorkspaceSurface(surface({ id: "dup", order: 10, title: "old" }));
  const offNew = registerWorkspaceSurface(surface({ id: "dup", order: 2, title: "new" }));
  try {
    const listed = listWorkspaceSurfaces().filter((s) => s.id === "dup");
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.title, "new");
    assert.equal(listed[0]!.order, 2);

    offOld(); // superseded registration must not remove the replacement
    assert.equal(getWorkspaceSurface("dup")?.title, "new");
  } finally {
    offNew();
  }
  assert.equal(getWorkspaceSurface("dup"), undefined);
});

test("late registration and disposal notify subscribers and bump the version", () => {
  let notified = 0;
  const unsubscribe = subscribeWorkspaceSurfaces(() => { notified++; });
  const before = workspaceSurfaceVersion();

  const off = registerWorkspaceSurface(surface({ id: "late" }));
  assert.equal(notified, 1);
  assert.equal(workspaceSurfaceVersion(), before + 1);

  off();
  assert.equal(notified, 2);
  assert.equal(workspaceSurfaceVersion(), before + 2);

  off(); // second dispose is a no-op — no phantom version bumps
  assert.equal(notified, 2);

  unsubscribe();
  const off2 = registerWorkspaceSurface(surface({ id: "after-unsub" }));
  off2();
  assert.equal(notified, 2);
});

test("plugin gate: a surface tied to a disabled plugin is unavailable", () => {
  const all = [
    surface({ id: "always" }),
    surface({ id: "gated", plugin: "github" }),
  ];
  assert.deepEqual(availableWorkspaceSurfaces(all, []).map((s) => s.id), ["always"]);
  assert.deepEqual(
    availableWorkspaceSurfaces(all, ["github"]).map((s) => s.id),
    ["always", "gated"],
  );
});

test("resolution: requested surface wins; fallback is session, then first available", () => {
  const session = surface({ id: "session", order: 0 });
  const files = surface({ id: "files", order: 10 });
  const gated = surface({ id: "github", order: 25, plugin: "github" });

  // Requested and available → itself.
  assert.equal(resolveWorkspaceSurface("files", [session, files, gated], []), files);
  // Unknown id (e.g. the active surface was disposed) → session.
  assert.equal(resolveWorkspaceSurface("gone", [session, files], []), session);
  // Requested but plugin-gated off → deterministic fallback, not a blank page.
  assert.equal(resolveWorkspaceSurface("github", [session, files, gated], []), session);
  assert.equal(resolveWorkspaceSurface("github", [session, files, gated], ["github"]), gated);
  // No session surface → first available in (order, id) order.
  assert.equal(resolveWorkspaceSurface("gone", [files, gated], []), files);
  // Nothing available at all → null.
  assert.equal(resolveWorkspaceSurface("gone", [gated], []), null);
  assert.equal(resolveWorkspaceSurface("gone", [], []), null);
});

test("requirement gate: none, project, and session (project reported first)", () => {
  const none = surface({ id: "n" });
  const needsProject = surface({ id: "p", requires: "project" });
  const needsSession = surface({ id: "s", requires: "session" });

  assert.equal(workspaceSurfaceGate(none, { projectId: null, sessionId: null }), "ok");
  assert.equal(workspaceSurfaceGate(needsProject, { projectId: null, sessionId: null }), "needs-project");
  assert.equal(workspaceSurfaceGate(needsProject, { projectId: "p1", sessionId: null }), "ok");
  // Needing a session implies needing its project.
  assert.equal(workspaceSurfaceGate(needsSession, { projectId: null, sessionId: null }), "needs-project");
  assert.equal(workspaceSurfaceGate(needsSession, { projectId: "p1", sessionId: null }), "needs-session");
  assert.equal(workspaceSurfaceGate(needsSession, { projectId: "p1", sessionId: "s1" }), "ok");
});

test("surfaceResetKey changes on same-id replacement and on project/session change", () => {
  const first = surface({ id: "flaky" });
  const replacement = surface({ id: "flaky" });

  const stable = surfaceResetKey(first, "p1", "s1");
  assert.equal(surfaceResetKey(first, "p1", "s1"), stable); // stable per registration
  assert.notEqual(surfaceResetKey(replacement, "p1", "s1"), stable); // replacement resets
  assert.notEqual(surfaceResetKey(first, "p2", "s1"), stable); // project change resets
  assert.notEqual(surfaceResetKey(first, "p1", null), stable); // session change resets
});
