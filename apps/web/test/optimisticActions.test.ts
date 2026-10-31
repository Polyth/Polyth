// Optimistic session/project verbs: the store reflects the action before the
// server answers, a rejection restores the previous state, and nothing is
// retried.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage as unknown as Storage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  location: dom.location,
  history: dom.history,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
globalThis.fetch = async () => new Response("{}", { status: 404 });

const { api } = await import("@polyth/session/web-api");
const { forkSession, removeProject, renameProject, saveProjectAppearanceOptimistic, saveProjectDefaultsOptimistic } = await import("../src/init.ts");
const { renameSessionTitle, toggleSessionPin } = await import("../src/sessionActions.ts");
const store = await import("../src/store.ts");
// Reconciliation reads after each verb: an empty page cannot delete rows.
api.listSessionSummaries = (async () => ({ sessions: [], complete: true, revision: 1 })) as unknown as typeof api.listSessionSummaries;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

const rejected = () => Object.assign(new Error("rejected"), { code: "conflict" });
const session = (id: string) => store.getState().sessions.find((item) => item.id === id);
const project = (id: string) => store.getState().projectRegistry.projects.find((item) => item.id === id);

test("session rename shows the new title at once and restores it on rejection", async () => {
  const original = api.renameSession;
  const release = deferred();
  let calls = 0;
  api.renameSession = (async () => { calls += 1; await release.promise; throw rejected(); }) as typeof api.renameSession;
  try {
    store.seedSessionCache({ id: "opt-rename", projectId: "opt-p", title: "Old", titleSource: "manual", status: "idle", createdAt: 1, updatedAt: 1 });
    const renaming = renameSessionTitle("opt-rename", "Old", "New");
    assert.equal(session("opt-rename")?.title, "New");
    // A projection broadcast during the request cannot revert the visible title.
    store.upsertSession({ id: "opt-rename", projectId: "opt-p", title: "Old", titleSource: "manual", status: "idle", createdAt: 1, updatedAt: 2 });
    assert.equal(session("opt-rename")?.title, "New");
    release.resolve();
    await assert.rejects(renaming, /rejected/);
    assert.equal(calls, 1);
    assert.equal(session("opt-rename")?.title, "Old");
  } finally {
    api.renameSession = original;
  }
});

test("session pin moves the row at once and an unpin rejection keeps it pinned", async () => {
  const original = api.organizeSession;
  const release = deferred();
  api.organizeSession = (async () => { await release.promise; throw rejected(); }) as typeof api.organizeSession;
  try {
    store.seedSessionCache({ id: "opt-pin", projectId: "opt-p", title: "Pinned", status: "idle", createdAt: 1, updatedAt: 1, pinned: { position: 3 } });
    const target = session("opt-pin")!;
    const toggling = toggleSessionPin(target, [target]);
    assert.equal(session("opt-pin")?.pinned, undefined);
    release.resolve();
    await assert.rejects(toggling, /rejected/);
    assert.deepEqual(session("opt-pin")?.pinned, { position: 3 });
  } finally {
    api.organizeSession = original;
  }
});

test("project rename and removal are optimistic and roll back on rejection", async () => {
  const originalPatch = api.patchProject;
  const originalDelete = api.deleteProject;
  const releaseRename = deferred();
  const releaseRemove = deferred();
  api.patchProject = (async () => { await releaseRename.promise; throw rejected(); }) as typeof api.patchProject;
  api.deleteProject = (async () => { await releaseRemove.promise; throw rejected(); }) as typeof api.deleteProject;
  // The reconcile read stays mocked for the rest of this file: it reports the
  // server's truth (both projects) without arming the 404 retry timer.
  const serverProjects = [
    { id: "opt-a", name: "Alpha", path: "/repos/a", createdAt: 1 },
    { id: "opt-b", name: "Beta", path: "/repos/b", createdAt: 2 },
  ];
  api.listProjects = (async () => serverProjects) as typeof api.listProjects;
  try {
    const ticket = store.beginProjectListRequest();
    store.publishProjectList(ticket, serverProjects);

    const renaming = renameProject("opt-a", "Renamed");
    assert.equal(project("opt-a")?.name, "Renamed");
    releaseRename.resolve();
    await assert.rejects(renaming, /rejected/);
    assert.equal(project("opt-a")?.name, "Alpha");

    const removing = removeProject("opt-b");
    assert.equal(project("opt-b"), undefined);
    releaseRemove.resolve();
    await assert.rejects(removing, /rejected/);
    assert.equal(project("opt-b")?.name, "Beta");
  } finally {
    api.patchProject = originalPatch;
    api.deleteProject = originalDelete;
  }
});

test("project appearance shows at once, prepares slow parts once, and rolls back on rejection", async () => {
  const originalPatch = api.patchProject;
  const prepared = deferred();
  let patches = 0;
  api.patchProject = (async () => { patches += 1; throw rejected(); }) as typeof api.patchProject;
  try {
    const ticket = store.beginProjectListRequest();
    store.publishProjectList(ticket, [{ id: "opt-look", name: "Look", path: "/repos/look", createdAt: 3, color: "#111111" }]);
    const saving = saveProjectAppearanceOptimistic(
      "opt-look",
      { name: "New look", color: "#222222" },
      async () => { await prepared.promise; return { name: "New look", color: "#222222", icon: "x" }; },
    );
    assert.equal(project("opt-look")?.name, "New look", "visible before the icon is prepared");
    assert.equal(project("opt-look")?.color, "#222222");
    prepared.resolve();
    await assert.rejects(saving, /rejected/);
    assert.equal(patches, 1);
    assert.equal(project("opt-look")?.name, "Look");
    assert.equal(project("opt-look")?.color, "#111111");
  } finally {
    api.patchProject = originalPatch;
  }
});

test("fork enters the loading state at once and releases it when the fork is rejected", async () => {
  const originalFork = api.fork;
  const release = deferred();
  let calls = 0;
  api.fork = (async () => { calls += 1; await release.promise; throw rejected(); }) as typeof api.fork;
  try {
    store.seedSessionCache({ id: "opt-fork", projectId: "opt-p", title: "Fork me", status: "idle", createdAt: 1, updatedAt: 1 });
    const forking = forkSession("opt-fork", 4);
    assert.notEqual(store.getState().openingSessionId, null, "the chat shows its loading layer before the server answers");
    release.resolve();
    await assert.rejects(forking, /rejected/);
    assert.equal(calls, 1);
    assert.equal(store.getState().openingSessionId, null);
  } finally {
    api.fork = originalFork;
  }
});

test("project defaults move at once, null clears a default, and a rejection restores them", async () => {
  const originalPatch = api.patchProject;
  const release = deferred();
  let calls = 0;
  api.patchProject = (async () => { calls += 1; await release.promise; throw rejected(); }) as typeof api.patchProject;
  try {
    const ticket = store.beginProjectListRequest();
    store.publishProjectList(ticket, [{
      id: "opt-defaults", name: "Defaults", path: "/repos/defaults", createdAt: 4,
      defaults: { harness: { mode: "pinned", harnessId: "h1" }, isolation: "off" },
    }]);
    const saving = saveProjectDefaultsOptimistic("opt-defaults", { harness: null, isolation: "workspace" });
    assert.equal(project("opt-defaults")?.defaults?.harness, undefined);
    assert.equal(project("opt-defaults")?.defaults?.isolation, "workspace");
    release.resolve();
    await assert.rejects(saving, /rejected/);
    assert.equal(calls, 1);
    assert.deepEqual(project("opt-defaults")?.defaults, { harness: { mode: "pinned", harnessId: "h1" }, isolation: "off" });
  } finally {
    api.patchProject = originalPatch;
  }
});
