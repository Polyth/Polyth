// Session switches return to Chat unless the workspace window is pinned. A
// pinned window remains the shared companion across sessions and reloads;
// dynamic/fullscreen windows are transient.
import test, { afterEach } from "node:test";
import { setImmediate as settleLocalHydration } from "node:timers/promises";
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
// Holds the legacy interactive history path (prefetch=0). A cold open must
// paint without ever depending on that unbounded suffix.
let interactiveGate: Promise<void> | null = null;
let releaseInteractive: (() => void) | null = null;
const requestSignals = new Map<string, AbortSignal | null | undefined>();
const requestBodies = new Map<string, unknown>();
// A path whose read hits its deadline (the bounded read's abort).
let timedOutPath: string | null = null;
const eventFixtures = new Map<string, unknown[]>();
(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
  const u = new URL(String(url), "http://localhost:3000");
  requestedPaths.push(`${u.pathname}${u.search}`);
  requestSignals.set(`${u.pathname}${u.search}`, init?.signal);
  if (typeof init?.body === "string") requestBodies.set(`${u.pathname}${u.search}`, JSON.parse(init.body));
  if (u.pathname === timedOutPath) throw new DOMException("signal timed out", "TimeoutError");
  if (requestGate) await requestGate;
  if (interactiveGate && u.searchParams.get("prefetch") === "0") await interactiveGate;
  if (blockedSession && u.pathname.startsWith(`/api/sessions/${blockedSession}`)) {
    await blockedSessionGate;
  }
  const m = /^\/api\/sessions\/([^/]+)$/.exec(u.pathname);
  const forward = /^\/api\/sessions\/([^/]+)\/events\/forward$/.exec(u.pathname);
  const cursor = Number(u.searchParams.get("afterSeq") ?? 0);
  const forwardEvents = forward ? (eventFixtures.get(forward[1]!) ?? []).filter((event) => (event as { seq: number }).seq > cursor) : [];
  const body: unknown = forward
    ? { events: forwardEvents, cursor: (forwardEvents.at(-1) as { seq: number } | undefined)?.seq ?? cursor, highWater: (forwardEvents.at(-1) as { seq: number } | undefined)?.seq ?? cursor, complete: true }
    : u.pathname === "/api/sessions/summaries" ? { sessions: [], revision: 0, complete: true }
    : m
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
const { createSession, openSession, pollSessionTail, prefetchSessionTail } = await import("../src/init.ts");
const { registerSurface } = await import("../src/surfaces.ts");
const { getWorkspacePanePrefs, workspacePaneKey } = await import("../src/workspace/panePrefs.ts");
const { getWorkspaceMode, setWorkspaceMode } = await import("../src/widgets/workspaceMode.ts");
const { PROJECT_PRESENTATION_HYDRATED_EVENT } = await import("../src/projectPresentationSync.ts");

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

afterEach(async () => {
  unblockFetches();
  unblockSession();
  releaseInteractive?.();
  interactiveGate = null;
  releaseInteractive = null;
  timedOutPath = null;
  await settleLocalHydration();
});

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

test("closing an unloaded package window clears its stale pinned preference", () => {
  store.activateProject("p1");
  const unregister = registerSurface({
    id: "late-package",
    title: "Late package",
    order: 2,
    component: () => null,
    presentation: {
      kind: "workspace", defaultRatio: 0.42, minWidth: 360, preferredMaxWidth: 920,
      keepAlive: true, escape: "close",
    },
  });
  assert.equal(store.openWorkspacePane("late-package"), true);
  store.togglePanePin();
  unregister();

  // The registry no longer knows the surface, but closing it must still clear
  // the project-scoped record instead of restoring it on the next activation.
  store.setRailPlugin(null);
  assert.equal(store.getState().railPlugin, null);
  assert.equal(getWorkspacePanePrefs("p1").openSurface, null);

  store.activateProject("p2");
  store.activateProject("p1");
  assert.equal(store.getState().railPlugin, null);
});

test("a same-project presentation rehydrate never closes an open package window", () => {
  store.activateProject("p1");
  assert.equal(store.openWorkspacePane("files"), true);
  assert.equal(store.getState().railPlugin, "files", "dynamic window is open");
  assert.equal(store.getState().paneMode, "dynamic");

  // Boot, WebSocket reconnect and cross-device sync all republish the project
  // presentation record. None of them is a user close, so the visible window
  // must survive every one of them.
  for (let rehydrate = 0; rehydrate < 3; rehydrate++) {
    dom.dispatchEvent(new dom.CustomEvent(PROJECT_PRESENTATION_HYDRATED_EVENT, {
      detail: { projectId: "p1" },
    }));
    assert.equal(store.getState().railPlugin, "files", `rehydrate #${rehydrate + 1} kept the window`);
    assert.equal(store.getState().paneMode, "dynamic");
  }

  // The user close remains the only thing that dismisses it here.
  store.setRailPlugin(null);
  assert.equal(store.getState().railPlugin, null);
});

test("a cold open paints from a passive tail before bounded replay and runtime activation", { timeout: 5_000 }, async () => {
  requestedPaths = [];
  interactiveGate = new Promise<void>((resolve) => {
    releaseInteractive = resolve;
  });
  blockFetches();
  const opening = openSession("parallel");
  await Promise.resolve();

  // Metadata and the NEWEST event window start in parallel (paginated
  // hydration); the window is passive, so the server answers from SQLite
  // without first materializing the native runtime.
  assert.deepEqual(requestedPaths, [
    "/api/sessions/parallel",
    "/api/sessions/parallel/events?afterSeq=0&limit=40&prefetch=1",
  ]);
  // Both open-critical reads are bounded: a stalled connection fails the open
  // (and clears its loading claim) instead of leaving it pending forever.
  for (const path of requestedPaths) assert.ok(requestSignals.get(path) instanceof AbortSignal, path);

  unblockFetches();
  await opening;
  await settleLocalHydration();
  assert.equal(store.getState().activeSessionId, "parallel", "the open resolves while the legacy suffix is held");
  assert.equal(store.getState().openingSessionId, null);
  assert.ok(
    requestedPaths.includes("/api/sessions/parallel/activate"),
    "runtime reconciliation starts through the explicit lifecycle endpoint",
  );
  assert.deepEqual(
    requestBodies.get("/api/sessions/parallel/activate"),
    { intent: "open" },
    "opening a chat to read it does not ask the server to warm its runtime",
  );
  assert.ok(requestedPaths.includes("/api/sessions/parallel/events/forward?afterSeq=0"));
  assert.equal(
    requestedPaths.some((path) => path === "/api/sessions/parallel/events?afterSeq=0&prefetch=0"),
    false,
    "revalidation never restores the unbounded history suffix",
  );
});

test("a timed-out history read fails the open and clears its loading claim", async () => {
  const before = store.getState().activeSessionId;
  timedOutPath = "/api/sessions/stalled/events";
  await assert.rejects(openSession("stalled"), { name: "TimeoutError" });
  assert.equal(store.getState().openingSessionId, null, "the loading layer does not stay forever");
  assert.equal(store.getState().activeSessionId, before);
});

test("a hydrated session renders from cache while its suffix revalidates", async () => {
  store.activateSession(null);
  store.setActiveView("goals");
  requestedPaths = [];
  blockFetches();

  const revalidating = openSession("parallel");
  await settleLocalHydration();
  assert.equal(store.getState().activeSessionId, "parallel", "cached session activates after local draft hydration, without waiting for the server");
  assert.equal(store.getState().activeView, "session", "cached chat is immediately usable");
  assert.deepEqual(requestedPaths, [
    "/api/sessions/parallel/activate",
    "/api/harnesses/sessions/parallel/features",
    "/api/sessions/parallel",
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
  await settleLocalHydration();
  assert.deepEqual(requestedPaths.slice(0, 6), [
    "/api/sessions",
    "/api/sessions/summaries?projectId=p1&limit=50",
    // Pinned chats ride along: the recency page cannot guarantee them.
    "/api/sessions/summaries?projectId=p1&limit=100&pinned=true",
    "/api/sessions/precache/activate",
    "/api/harnesses/sessions/precache/features",
    "/api/sessions/precache",
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
    `/api/sessions/${sessionId}/activate`,
    `/api/harnesses/sessions/${sessionId}/features`,
    `/api/sessions/${sessionId}/read`,
    `/api/sessions/${sessionId}`,
  ], "opening a session advances its read cursor");

  unblockFetches();
  await opening;
  eventFixtures.delete(sessionId);
});

test("a passive tail poll refreshes a hydrated background session title without opening it", async () => {
  const sessionId = "background-title";
  store.upsertSession({
    id: sessionId,
    projectId: "p1",
    title: "New session",
    status: "working",
    createdAt: 1,
    updatedAt: 2,
    lastTurnAt: 2,
  });
  eventFixtures.set(sessionId, []);
  prefetchSessionTail(sessionId);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  const activeBefore = store.getState().activeSessionId;
  eventFixtures.set(sessionId, [{
    id: "background-title-1",
    sessionId,
    seq: 1,
    time: 2,
    type: "user/message",
    data: { text: "Refresh background session titles" },
    v: 1,
  }]);
  requestedPaths = [];

  await pollSessionTail(sessionId);

  assert.equal(
    store.getState().sessions.find((session) => session.id === sessionId)?.title,
    "Refresh background session titles",
  );
  assert.equal(store.getState().activeSessionId, activeBefore, "title polling must not navigate");
  assert.deepEqual(requestedPaths, [
    `/api/sessions/${sessionId}/events?afterSeq=0&limit=40&prefetch=1`,
  ]);
  eventFixtures.delete(sessionId);
});

test("list tail warms never refetch rows the event LRU evicted", async () => {
  // The phone island warms its Active/Recent rows and re-runs after every
  // event-map change. With more rows than the 12-session LRU holds, each warm
  // evicted an earlier row, which the next run fetched again — forever.
  const ids = Array.from({ length: 20 }, (_, index) => `warm-row-${index}`);
  for (const id of ids) {
    store.upsertSession({ id, projectId: "p1", title: "Row", status: "idle", createdAt: 1, updatedAt: 1 });
    eventFixtures.set(id, [{ id: `${id}-1`, sessionId: id, seq: 1, time: 1, type: "user/message", data: { text: "x" }, v: 1 }]);
  }
  requestedPaths = [];
  // React runs the effect after the store change commits, not inside it. The
  // cap only stops a regression from looping until the heap runs out.
  const warmAll = (): void => {
    if (requestedPaths.length > ids.length * 3) return;
    for (const id of ids) prefetchSessionTail(id);
  };
  const unsubscribe = store.subscribeStore(() => { setTimeout(warmAll, 0); });
  warmAll();
  for (let turn = 0; turn < 50; turn += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  unsubscribe();
  assert.equal(requestedPaths.length, ids.length, "each row is warmed at most once");
  for (const id of ids) eventFixtures.delete(id);
});

test("a completed prefetch activates after local hydration before SWR resolves", async () => {
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
  await settleLocalHydration();
  assert.equal(store.getState().activeSessionId, sessionId, "completed prefetch paints before server revalidation");
  assert.deepEqual(requestedPaths, [
    `/api/sessions/${sessionId}/activate`,
    `/api/harnesses/sessions/${sessionId}/features`,
    `/api/sessions/${sessionId}`,
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
  await settleLocalHydration();

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
  await settleLocalHydration();
  assert.equal(store.getState().activeSessionId, "cached-take", "cached open activates without waiting for the first open");
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

test("opening a session belonging to another project activates both that project and the session", async () => {
  store.activateProject("p1");
  store.upsertSession({
    id: "p2-session-1",
    projectId: "p2",
    title: "Project 2 Session",
    status: "idle",
    createdAt: 100,
    updatedAt: 100,
  });
  store.ensureEventCache("p2-session-1");
  await openSession("p2-session-1");
  const state = store.getState();
  assert.equal(state.activeProjectId, "p2");
  assert.equal(state.activeSessionId, "p2-session-1");
});

test("full browser storage does not block opening or creating sessions", async () => {
  const originalStorage = globalThis.localStorage;
  const quotaStorage = new Proxy(originalStorage, {
    get(target, property) {
      if (property === "setItem") return () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  Object.defineProperty(globalThis, "localStorage", { value: quotaStorage, configurable: true });
  try {
    store.activateProject("p2");
    assert.equal(store.getState().activeProjectId, "p2");

    await openSession("quota-cold");
    assert.equal(store.getState().activeProjectId, "p1");
    assert.equal(store.getState().activeSessionId, "quota-cold");

    store.activateProject("p2");
    await openSession("quota-cold");
    assert.equal(store.getState().activeProjectId, "p1", "cached session reopens across projects");
    assert.equal(store.getState().activeSessionId, "quota-cold");

    store.startNewSession("p2");
    assert.equal(store.getState().activeProjectId, "p2");
    assert.equal(store.getState().newSessionIntent?.projectId, "p2");

    store.startNewSession("p1");
    assert.equal(store.getState().activeSessionId, null);
    assert.equal(store.getState().newSessionIntent?.projectId, "p1");

    const created = await createSession("p1");
    assert.equal(created, "precache");
    assert.equal(store.getState().activeSessionId, created);
  } finally {
    Object.defineProperty(globalThis, "localStorage", { value: originalStorage, configurable: true });
  }
});
