// UX-FILES-TIMELINE-03 finding 8: switching sessions always restores that
// session's chat view. openSession closes the visible workspace pane through
// the command path (metadata-only — widths and last resources survive per
// UX-PANE-MODEL) and returns the primary view to "session". Boot restoration
// opts out so a reload keeps the restored pane.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
// recordPaneInvoker checks document.activeElement instanceof HTMLElement.
Object.defineProperty(globalThis, "HTMLElement", {
  value: (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement,
  configurable: true,
});

// Deterministic sessions API: any session id resolves to project p1 with an
// empty event log — openSession's store transition is the unit under test.
(globalThis as { fetch?: unknown }).fetch = async (url: string) => {
  const u = new URL(String(url), "http://localhost:3000");
  const m = /^\/api\/sessions\/([^/]+)$/.exec(u.pathname);
  const body: unknown = m
    ? { id: m[1], projectId: "p1", title: "T", status: "idle", createdAt: 1, updatedAt: 1 }
    : /^\/api\/sessions\/[^/]+\/events$/.test(u.pathname)
      ? []
      : [];
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
};

const store = await import("../src/store.ts");
const { openSession } = await import("../src/init.ts");
const { registerSurface } = await import("../src/surfaces.ts");
const { getWorkspacePanePrefs } = await import("../src/workspace/panePrefs.ts");
const { getWorkspaceMode, setWorkspaceMode } = await import("../src/widgets/workspaceMode.ts");

// A minimal canonical workspace surface so openWorkspacePane admits "files"
// without mounting the real component tree.
registerSurface({
  id: "files",
  title: "Files",
  order: 1,
  component: () => null,
  presentation: {
    kind: "workspace", defaultRatio: 0.42, minWidth: 360, preferredMaxWidth: 920,
    keepAlive: true, escape: "close",
  },
});

test("user session switch closes the open pane and returns to chat, keeping pane metadata", async () => {
  store.activateProject("p1");
  assert.equal(store.openWorkspacePane("files", "file:src/app.ts"), true);
  store.setActiveView("goals"); // pane stays open while a workflow page shows
  store.setOverlay("settings");
  setWorkspaceMode("widgets");
  assert.equal(store.getState().railPlugin, "files");
  assert.equal(store.getState().activeView, "goals");
  assert.equal(getWorkspaceMode(), "widgets");

  await openSession("s1");

  const s = store.getState();
  assert.equal(s.activeSessionId, "s1", "session activated");
  assert.equal(s.railPlugin, null, "visible workspace pane closed");
  assert.equal(s.activeView, "session", "primary view returned to chat");
  assert.equal(s.overlay, null, "session activation closes overlays above chat");
  assert.equal(getWorkspaceMode(), "chat", "Canvas no longer covers the selected session");
  // Scope caches survive: only openSurface flips to null — the surface's
  // last resource (and any widths) remain for the next open.
  const prefs = getWorkspacePanePrefs("p1");
  assert.equal(prefs.openSurface, null);
  assert.equal(prefs.lastResource.files, "file:src/app.ts", "pane resource memory preserved");
});

test("boot restoration keeps the restored workspace pane open", async () => {
  store.activateProject("p1");
  assert.equal(store.openWorkspacePane("files"), true);
  setWorkspaceMode("widgets");

  await openSession("s2", { showChat: false });

  const s = store.getState();
  assert.equal(s.activeSessionId, "s2");
  assert.equal(s.railPlugin, "files", "boot path must not close the restored pane");
  assert.equal(s.activeView, "session");
  assert.equal(getWorkspaceMode(), "widgets", "boot restoration preserves the saved workspace mode");
});

test("starting a new chat records only UI intent until the first send", () => {
  const before = store.getState().sessions.map((session) => session.id);
  store.startNewSession("p1", {
    title: "Prepared chat",
    draft: "Review this branch",
    worktreePath: "/tmp/polyth-worktree",
  });

  const state = store.getState();
  assert.equal(state.activeProjectId, "p1");
  assert.equal(state.activeSessionId, null);
  assert.deepEqual(state.sessions.map((session) => session.id), before, "no session projection is created");
  assert.deepEqual(state.newSessionIntent, {
    projectId: "p1",
    title: "Prepared chat",
    draft: "Review this branch",
    worktreePath: "/tmp/polyth-worktree",
  });
  assert.equal(state.activeView, "session");
  assert.equal(getWorkspaceMode(), "chat");
});
