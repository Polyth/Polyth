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
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as typeof globalThis & { matchMedia: typeof globalThis.matchMedia }).matchMedia = () => ({
  matches: false,
  media: "",
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return false; },
});
globalThis.fetch = async () => new Response("{}", { status: 404 });

const { act, createElement, useEffect } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Composer } = await import("../src/components/Composer.tsx");
const { deleteSession } = await import("../src/init.ts");
const { api } = await import("@polyth/session/web-api");
const {
  activateProject,
  activateSession,
  endPendingSend,
  finishSessionSpawn,
  flushComposerDraftBeforeSessionRemoval,
  getState,
  registerComposerDraftFlusher,
  seedSessionCache,
  setModels,
  startNewSession,
  useStore,
} = await import("../src/store.ts");
const { loadScopedDraftRecord, updateScopedDraftRecord } = await import("../src/draftRecord.ts");

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

const attachment = {
  id: "removal-attachment",
  name: "notes.txt",
  mime: "text/plain",
  size: 9,
  kind: "file" as const,
  path: "notes.txt",
};

test("mounted Composer flushes newer live text before async deletion clears its session", async () => {
  const originalSend = api.sendMessage;
  const originalDelete = api.deleteSession;
  const originalList = api.listSessions;
  const sendStarted = deferred<void>();
  const deleteStarted = deferred<void>();
  const releaseDelete = deferred<void>();
  const sessionId = "mounted-removal-ordering";
  const projectId = "mounted-removal-project";
  let sendCalls = 0;

  api.sendMessage = (async () => {
    sendCalls += 1;
    sendStarted.resolve();
    return { turnId: "turn-1" };
  }) as typeof api.sendMessage;
  api.deleteSession = (async () => {
    deleteStarted.resolve();
    await releaseDelete.promise;
  }) as unknown as typeof api.deleteSession;
  api.listSessions = (async () => []) as typeof api.listSessions;

  activateProject(projectId);
  setModels([{ providerID: "test", modelID: "model", name: "Test model", connected: true }]);
  seedSessionCache({
    id: sessionId,
    projectId,
    title: "New session",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });
  activateSession(sessionId);
  updateScopedDraftRecord(sessionId, {
    text: "initial prompt",
    attachments: [attachment],
    dirty: true,
  });

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let unregisterObserver = () => {};
  try {
    await act(async () => { root.render(createElement(Composer)); });
    let observedBeforeActivation: { activeSessionId: string | null; text: string } | undefined;
    unregisterObserver = registerComposerDraftFlusher((targetSessionId) => {
      if (targetSessionId !== sessionId) return;
      observedBeforeActivation = {
        activeSessionId: getState().activeSessionId,
        text: loadScopedDraftRecord(sessionId).text,
      };
    });
    const input = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
    const send = host.querySelector<HTMLButtonElement>("button.send");
    assert.ok(input);
    assert.ok(send);

    await act(async () => {
      input.value = "submitted prompt";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      send.click();
      await sendStarted.promise;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(sendCalls, 1);
    assert.equal(getState().pendingSends.length, 1);

    await act(async () => {
      input.value = "typed after submit";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Delete is optimistic: the live text is flushed and the chat closes
    // synchronously, before the server request settles.
    const deleting = deleteSession(sessionId);
    assert.equal(getState().activeSessionId, null);
    assert.equal(getState().sessions.some((session) => session.id === sessionId), false);
    await deleteStarted.promise;
    await act(async () => {
      releaseDelete.resolve();
      await deleting;
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    assert.deepEqual(observedBeforeActivation, {
      activeSessionId: sessionId,
      text: "typed after submit",
    });
    assert.equal(getState().activeSessionId, null);
    assert.equal(loadScopedDraftRecord(sessionId).text, "typed after submit");
    // The admitted prompt consumed its submitted attachment before the newer
    // text was typed; the live-text fence must still preserve that newer text.
    assert.deepEqual(loadScopedDraftRecord(sessionId).attachments, []);
  } finally {
    unregisterObserver();
    const pending = getState().pendingSends.at(-1);
    if (pending?.sessionId === sessionId) endPendingSend(pending.id);
    await act(async () => { root.unmount(); });
    host.remove();
    api.sendMessage = originalSend;
    api.deleteSession = originalDelete;
    api.listSessions = originalList;
  }
});

test("first-send hero-to-timeline remount flushes newer text before deletion", async () => {
  const originalCreate = api.createSession;
  const originalEvents = api.getEvents;
  const originalSend = api.sendMessage;
  const originalDelete = api.deleteSession;
  const originalList = api.listSessions;
  const createStarted = deferred<void>();
  const sendStarted = deferred<void>();
  const sendFinished = deferred<void>();
  const releaseSend = deferred<void>();
  const deleteStarted = deferred<void>();
  const releaseDelete = deferred<void>();
  const remounted = deferred<void>();
  const sessionId = "first-send-remounted";
  const projectId = "first-send-remount-project";
  let mountCount = 0;
  let sendWasStarted = false;
  let deleting: Promise<void> | undefined;

  api.createSession = (async () => {
    createStarted.resolve();
    return { id: sessionId };
  }) as typeof api.createSession;
  api.getEvents = (async () => []) as typeof api.getEvents;
  api.sendMessage = (async () => {
    sendWasStarted = true;
    sendStarted.resolve();
    await releaseSend.promise;
    sendFinished.resolve();
    return { turnId: "turn-1" };
  }) as typeof api.sendMessage;
  api.deleteSession = (async () => {
    deleteStarted.resolve();
    await releaseDelete.promise;
  }) as unknown as typeof api.deleteSession;
  api.listSessions = (async () => [{
    id: sessionId,
    projectId,
    title: "New session",
    status: "working",
    createdAt: 1,
    updatedAt: 1,
  }]) as typeof api.listSessions;

  activateProject(projectId);
  setModels([{ providerID: "test", modelID: "model", name: "Test model", connected: true }]);
  startNewSession(projectId, { draft: "" });

  function ComposerMountProbe() {
    useEffect(() => {
      mountCount += 1;
      if (mountCount === 2) remounted.resolve();
    }, []);
    return createElement(Composer);
  }
  function FirstSendSurface() {
    const activeSessionId = useStore((state) => state.activeSessionId);
    return createElement(ComposerMountProbe, { key: activeSessionId ?? "hero" });
  }

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let unregisterObserver = () => {};
  try {
    await act(async () => { root.render(createElement(FirstSendSurface)); });
    const heroInput = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
    const send = host.querySelector<HTMLButtonElement>("button.send");
    assert.ok(heroInput);
    assert.ok(send);
    await act(async () => {
      heroInput.value = "submitted first prompt";
      heroInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { send.click(); });
    await createStarted.promise;
    await act(async () => {
      await remounted.promise;
      await sendStarted.promise;
    });
    assert.equal(mountCount, 2, "first-send switched from the hero Composer to a fresh timeline Composer");
    assert.equal(getState().activeSessionId, sessionId);
    const spawn = getState().sessionSpawn;
    assert.ok(spawn);
    // The creation handoff has completed; keep admission pending so this test
    // exercises the remounted Composer's live-edit fence.
    finishSessionSpawn(spawn.requestId);
    await act(async () => { await Promise.resolve(); });

    const observedBeforeActivation: Array<{ activeSessionId: string | null; text: string }> = [];
    unregisterObserver = registerComposerDraftFlusher((targetSessionId) => {
      if (targetSessionId !== sessionId) return;
      observedBeforeActivation.push({
        activeSessionId: getState().activeSessionId,
        text: loadScopedDraftRecord(sessionId).text,
      });
    });
    const timelineInput = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
    assert.ok(timelineInput);
    await act(async () => {
      timelineInput.value = "typed after hero remount";
      timelineInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Exercise the same local-only flusher once before the final delete, then
    // explicitly clear the newer draft. The final delete must preserve that
    // coherent clear instead of restoring the submitted prompt.
    flushComposerDraftBeforeSessionRemoval(sessionId);
    assert.equal(loadScopedDraftRecord(sessionId).text, "typed after hero remount");
    await act(async () => {
      timelineInput.value = "";
      timelineInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    deleting = deleteSession(sessionId);
    await deleteStarted.promise;
    await act(async () => {
      releaseDelete.resolve();
      await deleting;
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    assert.deepEqual(observedBeforeActivation, [
      { activeSessionId: sessionId, text: "typed after hero remount" },
      { activeSessionId: sessionId, text: "" },
    ]);
    assert.equal(getState().activeSessionId, null);
    assert.equal(loadScopedDraftRecord(sessionId).text, "");
  } finally {
    unregisterObserver();
    releaseDelete.resolve();
    releaseSend.resolve();
    if (deleting) await deleting.catch(() => undefined);
    if (sendWasStarted) await sendFinished.promise;
    await act(async () => { root.unmount(); });
    host.remove();
    api.createSession = originalCreate;
    api.getEvents = originalEvents;
    api.sendMessage = originalSend;
    api.deleteSession = originalDelete;
    api.listSessions = originalList;
  }
});

test("mounted Composer pre-delete flush beats the 250ms draft debounce", async () => {
  const originalDelete = api.deleteSession;
  const originalList = api.listSessions;
  const originalSetTimeout = globalThis.setTimeout;
  const deleteStarted = deferred<void>();
  const releaseDelete = deferred<void>();
  const heldDebounceCallbacks: Array<() => void> = [];
  const sessionId = "mounted-debounce-removal";
  const projectId = "mounted-debounce-project";
  let observedBeforeActivation: { activeSessionId: string | null; text: string } | undefined;

  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 250) {
      heldDebounceCallbacks.push(() => callback(...args));
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(callback, delay, ...args);
  }) as unknown as typeof setTimeout;
  api.deleteSession = (async () => {
    deleteStarted.resolve();
    await releaseDelete.promise;
  }) as unknown as typeof api.deleteSession;
  api.listSessions = (async () => []) as typeof api.listSessions;

  activateProject(projectId);
  setModels([{ providerID: "test", modelID: "model", name: "Test model", connected: true }]);
  seedSessionCache({
    id: sessionId,
    projectId,
    title: "New session",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });
  activateSession(sessionId);
  updateScopedDraftRecord(sessionId, {
    text: "initial draft",
    attachments: [attachment],
    dirty: true,
  });

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let unregisterObserver = () => {};
  try {
    await act(async () => { root.render(createElement(Composer)); });
    unregisterObserver = registerComposerDraftFlusher((targetSessionId) => {
      if (targetSessionId !== sessionId) return;
      observedBeforeActivation = {
        activeSessionId: getState().activeSessionId,
        text: loadScopedDraftRecord(sessionId).text,
      };
    });
    const input = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
    assert.ok(input);
    await act(async () => {
      input.value = "typed before debounce";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.ok(heldDebounceCallbacks.length > 0, "the 250ms local timer is still gated");
    assert.equal(loadScopedDraftRecord(sessionId).text, "initial draft");

    const deleting = deleteSession(sessionId);
    await deleteStarted.promise;
    await act(async () => {
      releaseDelete.resolve();
      await deleting;
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    assert.deepEqual(observedBeforeActivation, {
      activeSessionId: sessionId,
      text: "typed before debounce",
    });
    assert.equal(getState().activeSessionId, null);
    assert.equal(loadScopedDraftRecord(sessionId).text, "typed before debounce");
    assert.deepEqual(loadScopedDraftRecord(sessionId).attachments, [attachment]);
  } finally {
    unregisterObserver();
    globalThis.setTimeout = originalSetTimeout;
    await act(async () => { root.unmount(); });
    host.remove();
    api.deleteSession = originalDelete;
    api.listSessions = originalList;
  }
});

test("optimistic delete restores the row and chat when the server rejects it", async () => {
  const originalDelete = api.deleteSession;
  const originalSummaries = api.listSessionSummaries;
  const releaseDelete = deferred<void>();
  const sessionId = "optimistic-delete-rejected";
  const projectId = "optimistic-delete-project";
  const projection = {
    id: sessionId,
    projectId,
    title: "Keep me",
    status: "idle" as const,
    createdAt: 1,
    updatedAt: 1,
  };
  let deleteCalls = 0;
  api.deleteSession = (async () => {
    deleteCalls += 1;
    await releaseDelete.promise;
    throw Object.assign(new Error("denied"), { code: "conflict" });
  }) as unknown as typeof api.deleteSession;
  // A list page that still contains the row must not resurrect it mid-flight.
  api.listSessionSummaries = (async () => ({ sessions: [projection] })) as unknown as typeof api.listSessionSummaries;
  try {
    activateProject(projectId);
    seedSessionCache(projection);
    activateSession(sessionId);

    const deleting = deleteSession(sessionId);
    assert.equal(getState().activeSessionId, null);
    assert.equal(getState().sessions.some((session) => session.id === sessionId), false);
    const { upsertSessions } = await import("../src/store.ts");
    upsertSessions([projection]);
    assert.equal(getState().sessions.some((session) => session.id === sessionId), false);

    releaseDelete.resolve();
    await assert.rejects(deleting, /denied/);
    assert.equal(deleteCalls, 1, "a rejected mutation is never replayed");
    assert.equal(getState().sessions.find((session) => session.id === sessionId)?.title, "Keep me");
    assert.equal(getState().activeSessionId, sessionId, "the untouched chat surface reopens the restored session");
  } finally {
    releaseDelete.resolve();
    api.deleteSession = originalDelete;
    api.listSessionSummaries = originalSummaries;
  }
});
