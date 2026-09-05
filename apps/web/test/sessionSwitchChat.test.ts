// Session switches return to Chat unless the workspace window is pinned. A
// pinned window remains the shared companion across sessions and reloads;
// dynamic/fullscreen windows are transient.
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
let requestGate: Promise<void> | null = null;
let releaseRequests: (() => void) | null = null;
let blockedSession: string | null = null;
let blockedSessionGate: Promise<void> | null = null;
let releaseBlockedSession: (() => void) | null = null;
let requestedPaths: string[] = [];
const eventFixtures = new Map<string, unknown[]>();
(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
  const u = new URL(String(url), "http://localhost:3000");
  requestedPaths.push(`${u.pathname}${u.search}`);
  if (requestGate) await requestGate;
  if (blockedSession && u.pathname.startsWith(`/api/sessions/${blockedSession}`)) {
    await blockedSessionGate;
  }
  const m = /^\/api\/sessions\/([^/]+)$/.exec(u.pathname);
  const body: unknown = m
    ? { id: m[1], projectId: "p1", title: "T", status: "idle", createdAt: 1, updatedAt: 1 }
    : u.pathname === "/api/sessions" && init?.method === "POST"
      ? { id: "precache" }
    : /^\/api\/sessions\/([^/]+)\/events$/.test(u.pathname)
      ? eventFixtures.get(/^\/api\/sessions\/([^/]+)\/events$/.exec(u.pathname)![1]!) ?? []
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
const { createSession, openSession, prefetchSessionTail } = await import("../src/init.ts");
const { registerSurface } = await import("../src/surfaces.ts");
const { getWorkspacePanePrefs, workspacePaneKey } = await import("../src/workspace/panePrefs.ts");
const { getWorkspaceMode, setWorkspaceMode } = await import("../src/widgets/workspaceMode.ts");

function blockFetches(): void {
  requestGate = new Promise<void>((resolve) => {
    releaseRequests = resolve;
  });
}

function unblockFetches(): void {
  releaseRequests?.();
  requestGate = null;
  releaseRequests = null;
}

function blockSession(sessionId: string): void {
  blockedSession = sessionId;
  blockedSessionGate = new Promise<void>((resolve) => {
    releaseBlockedSession = resolve;
  });
}

function unblockSession(): void {
  releaseBlockedSession?.();
  blockedSession = null;
  blockedSessionGate = null;
  releaseBlockedSession = null;
}

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

test("user session switch closes a dynamic pane and returns to chat, keeping pane metadata", async () => {
  store.activateProject("p1");
  assert.equal(store.openWorkspacePane("files", "file:src/app.ts"), true);
  store.setOverlay("settings");
  setWorkspaceMode("widgets");
  assert.equal(store.getState().railPlugin, "files");
  assert.equal(store.getState().activeView, "session");
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

test("pinned workspace pane survives session switches and boot restoration", async () => {
  store.activateProject("p1");
  store.openEditorFile(null);
  assert.equal(store.openWorkspacePane("files"), true);
  assert.equal(store.getState().editorFile, "src/app.ts", "reopen reapplies the remembered resource");
  store.togglePanePin();
  assert.equal(store.getState().paneMode, "pinned");
  setWorkspaceMode("widgets");

  await openSession("s2", { showChat: false });

  const s = store.getState();
  assert.equal(s.activeSessionId, "s2");
  assert.equal(s.railPlugin, "files", "boot path must not close the restored pane");
  assert.equal(s.activeView, "session");
  assert.equal(s.paneMode, "pinned");
  assert.equal(getWorkspaceMode(), "widgets", "boot restoration preserves the saved workspace mode");
});

test("a non-pinned pane closes when reopening the current session", async () => {
  store.togglePanePin();
  store.openWorkspacePane("files");
  assert.equal(store.getState().paneMode, "dynamic");

  await openSession("s2");

  assert.equal(store.getState().activeSessionId, "s2");
  assert.equal(store.getState().railPlugin, null);
  assert.equal(store.getState().paneMode, "dynamic");
});

test("non-pinned persisted windows are not restored on project activation", () => {
  localStorage.setItem(workspacePaneKey("p2"), JSON.stringify({
    version: 2,
    openSurface: "files",
    mode: "dynamic",
    previousMode: "dynamic",
    widths: {},
    heights: {},
    lastResource: {},
  }));

  store.activateProject("p2");

  assert.equal(store.getState().railPlugin, null);
  assert.equal(getWorkspacePanePrefs("p2").openSurface, null);
  store.activateProject("p1");
});

test("session metadata and history start in parallel on a cold open", async () => {
  requestedPaths = [];
  blockFetches();
  const opening = openSession("parallel");
  await Promise.resolve();

  // Cold opens fetch only the NEWEST event window (paginated hydration);
  // older history backfills in the background after first paint.
  assert.deepEqual(requestedPaths, [
    "/api/sessions/parallel",
    "/api/sessions/parallel/events?afterSeq=0&limit=40&prefetch=0",
  ]);

  unblockFetches();
  await opening;
  assert.equal(store.getState().activeSessionId, "parallel");
});

test("a hydrated session renders from cache while its suffix revalidates", async () => {
  store.activateSession(null);
  store.setActiveView("goals");
  requestedPaths = [];
  blockFetches();

  const revalidating = openSession("parallel");
  assert.equal(store.getState().activeSessionId, "parallel", "cached session activates synchronously");
  assert.equal(store.getState().activeView, "session", "cached chat is immediately usable");
  assert.deepEqual(requestedPaths, [
    "/api/sessions/parallel",
    "/api/sessions/parallel/events?afterSeq=0&prefetch=0",
  ]);

  unblockFetches();
  await revalidating;
});

test("first-message session creation opens the chat instantly while revalidating", async () => {
  requestedPaths = [];
  blockSession("precache");

  const sessionId = await createSession("p1", { precache: true });

  assert.equal(sessionId, "precache");
  // Instant spawn: the optimistic projection + empty canonical log open the
  // chat with no awaited request and no blocking loading claim; metadata and
  // the (empty) suffix revalidate in the background.
  assert.equal(store.getState().activeSessionId, "precache");
  assert.equal(store.getState().openingSessionId, null);
  assert.equal(store.getState().activeView, "session");
  assert.deepEqual(requestedPaths.slice(0, 3), [
    "/api/sessions",
    "/api/sessions/precache",
    "/api/sessions/precache/events?afterSeq=0&prefetch=0",
  ]);

  unblockSession();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});

test("tail prefetch dedupes and click paints its cache before reconcile resolves", async () => {
  const sessionId = "prefetched";
  const projection = { id: sessionId, projectId: "p1", title: "Prefetched", status: "idle", createdAt: 1, updatedAt: 1 } as const;
  const tailEvent = {
    id: "prefetched-1", sessionId, seq: 1, time: 1, type: "user/message", data: { text: "ready" }, v: 1,
  } as const;
  store.upsertSession(projection);
  eventFixtures.set(sessionId, [tailEvent]);
  requestedPaths = [];
  blockSession(sessionId);

  prefetchSessionTail(sessionId);
  prefetchSessionTail(sessionId);
  await Promise.resolve();
  assert.deepEqual(requestedPaths, [
    `/api/sessions/${sessionId}/events?afterSeq=0&limit=40&prefetch=1`,
  ], "repeated pointer intent shares one bounded request");

  const opening = openSession(sessionId);
  await Promise.resolve();
  assert.equal(requestedPaths.length, 1, "click shares the in-flight tail instead of overlapping it");

  blockFetches();
  unblockSession();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(store.getState().activeSessionId, sessionId, "cached tail activates before reconcile");
  assert.deepEqual(store.getState().events[sessionId]?.map((event) => event.seq), [1]);
  assert.deepEqual(requestedPaths.slice(1), [
    `/api/sessions/${sessionId}/read`,
    `/api/sessions/${sessionId}`,
    `/api/sessions/${sessionId}/events?afterSeq=1&prefetch=0`,
  ], "opening a session advances its read cursor");

  unblockFetches();
  await opening;
  eventFixtures.delete(sessionId);
});

test("a completed prefetch activates synchronously before SWR resolves", async () => {
  const sessionId = "prefetched-ready";
  store.upsertSession({ id: sessionId, projectId: "p1", title: "Ready", status: "idle", createdAt: 1, updatedAt: 1 });
  eventFixtures.set(sessionId, [{
    id: "prefetched-ready-1", sessionId, seq: 1, time: 1,
    type: "user/message", data: { text: "cached" }, v: 1,
  }]);
  prefetchSessionTail(sessionId);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  store.activateSession(null);
  requestedPaths = [];
  blockFetches();

  const opening = openSession(sessionId);
  assert.equal(store.getState().activeSessionId, sessionId, "completed prefetch paints cache synchronously");
  assert.deepEqual(requestedPaths, [
    `/api/sessions/${sessionId}`,
    `/api/sessions/${sessionId}/events?afterSeq=1&prefetch=0`,
  ]);

  unblockFetches();
  await opening;
  eventFixtures.delete(sessionId);
});

test("a streamed event applies as a delta without a REST history request", () => {
  requestedPaths = [];
  store.applyEvent({
    id: "prefetched-2", sessionId: "prefetched", seq: 2, time: 2,
    type: "assistant/message", data: { text: "delta" }, v: 1,
  });
  assert.deepEqual(store.getState().events.prefetched?.map((event) => event.seq), [1, 2]);
  assert.deepEqual(requestedPaths, []);
});

test("a slower earlier open cannot replace a newer selected session", async () => {
  blockSession("slow");
  const slow = openSession("slow");
  await Promise.resolve();

  await openSession("newer");
  assert.equal(store.getState().activeSessionId, "newer");

  unblockSession();
  await slow;
  assert.equal(store.getState().activeSessionId, "newer");
});

test("a cached reconcile cannot overwrite a newer streamed projection", async () => {
  await openSession("stale-reconcile");
  blockSession("stale-reconcile");
  const stale = openSession("stale-reconcile");
  await Promise.resolve();

  store.upsertSession({
    id: "stale-reconcile", projectId: "p1", title: "newer projection",
    status: "working", createdAt: 1, updatedAt: 2,
  });
  unblockSession();
  await stale;

  assert.equal(
    store.getState().sessions.find((session) => session.id === "stale-reconcile")?.title,
    "newer projection",
  );
});

// Regression (QA P0): a first open claims the loading row; when a CACHED open
// superseded it, neither open cleared the claim — every hero-eligible surface
// (a fresh spawn's empty chat included) rendered as an endless loading row.
test("a superseded first open never leaves a stale loading claim", async () => {
  await openSession("cached-take"); // hydrate so the next open is cached
  store.activateSession(null);

  blockSession("slow-claim");
  const slow = openSession("slow-claim");
  await Promise.resolve();
  assert.equal(store.getState().openingSessionId, "slow-claim", "first open claims the loading row");

  const cached = openSession("cached-take");
  assert.equal(store.getState().activeSessionId, "cached-take", "cached open activates synchronously");
  assert.equal(store.getState().openingSessionId, null, "cached open takes over the stale claim");

  unblockSession();
  await slow;
  await cached;
  const s = store.getState();
  assert.equal(s.openingSessionId, null, "no claim survives once every open settled");
  assert.equal(s.activeSessionId, "cached-take", "the superseded open does not steal the surface");
});

// Regression (QA P0): an open resolving AFTER the user moved to the new-chat
// surface re-activated its session, discarding the intent — "+" appeared to
// do nothing and the fresh chat never showed.
test("an open resolving after the user starts a new chat keeps the new-chat surface", async () => {
  blockSession("slow-steal");
  const slow = openSession("slow-steal");
  await Promise.resolve();
  assert.equal(store.getState().openingSessionId, "slow-steal");

  store.startNewSession("p1", { draft: "typed while loading" });
  assert.equal(store.getState().activeSessionId, null);
  assert.notEqual(store.getState().newSessionIntent, null);

  unblockSession();
  await slow;
  const s = store.getState();
  assert.equal(s.activeSessionId, null, "resolved open must not steal the new-chat surface");
  assert.equal(s.newSessionIntent?.draft, "typed while loading", "new-chat intent survives");
  assert.equal(s.openingSessionId, null, "loading claim is cleared");
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

test("new session restores its hidden project draft after navigation", () => {
  store.startNewSession("p1");
  store.saveNewSessionDraftText("p1", "Keep this work");
  store.activateProject("p2");
  store.startNewSession("p1");

  const state = store.getState();
  assert.equal(state.activeSessionId, null);
  assert.equal(state.newSessionIntent?.draft, "Keep this work");
  assert.equal(state.sessions.some((session) => session.title === "Keep this work"), false);
});
