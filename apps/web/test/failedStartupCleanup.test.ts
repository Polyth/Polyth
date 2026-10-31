import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { AttachmentRef, SessionDeleteOptions, SessionEvent } from "@polyth/contracts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });

const { isEmptyFailedStartupSession, shouldDeleteFailedStartupSession } = await import("../src/failedStartupCleanup.ts");
const { cleanupFailedStartupSession, cleanupFailedStartupSessionFromError, sendMessage } = await import("../src/init.ts");
const { api } = await import("@polyth/session/web-api");
const { activateProject, activateSession, applyEvents, beginPendingSend, bindPendingSend, endPendingSend, seedSessionCache, startNewSession, updateSettings, getState } = await import("../src/store.ts");
const { loadScopedDraftRecord, updateScopedDraftRecord } = await import("../src/draftRecord.ts");
const { setClientReliabilityContext } = await import("../src/reliabilityContext.ts");
const { flushClientPersistence, setClientPersistenceBackend } = await import("../src/clientPersistence.ts");

function event(seq: number, type: string, data: Record<string, unknown> = {}): SessionEvent {
  return {
    id: `event-${seq}`,
    sessionId: "startup-test",
    seq,
    time: seq,
    type,
    data,
  } as SessionEvent;
}

const failedEvents = (withAssistant = false): SessionEvent[] => [
  event(1, "session/created"),
  event(2, "user/message", { text: "hello" }),
  event(3, "turn/started", { turnId: "turn-1" }),
  ...(withAssistant ? [event(4, "assistant/chunk", { partId: "part-1", text: "partial" })] : []),
  event(withAssistant ? 5 : 4, "turn/stopped", { turnId: "turn-1", reason: "error" }),
];

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

/** Drain the cleanup monitor's documented setTimeout(0) turn without hiding
 * async regressions behind an arbitrary sleep. */
const drainCleanupTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const attachment = (id: string, path: string): AttachmentRef => ({
  id, name: path, mime: "text/plain", size: path.length, kind: "file", path,
});

test("only an assistant-less terminal startup failure qualifies for deletion", () => {
  assert.equal(shouldDeleteFailedStartupSession(failedEvents()), true);
  assert.equal(shouldDeleteFailedStartupSession(failedEvents(true)), false);
  assert.equal(isEmptyFailedStartupSession([event(1, "session/created")]), true);
  assert.equal(isEmptyFailedStartupSession(failedEvents()), false);
  assert.equal(
    shouldDeleteFailedStartupSession([
      event(1, "session/created"),
      event(2, "user/message", { text: "hello" }),
      event(3, "turn/stopped", { reason: "completed" }),
    ]),
    false,
  );
  assert.equal(
    shouldDeleteFailedStartupSession([
      event(1, "session/created"),
      event(2, "user/message", { text: "hello" }),
      event(3, "turn/stopped", { reason: "aborted" }),
    ]),
    false,
  );
  assert.equal(
    shouldDeleteFailedStartupSession([
      event(1, "session/created"),
      event(2, "user/message", { text: "hello" }),
      event(3, "turn/stopped", { reason: "error", retry: { resumeAt: 10 } }),
    ]),
    false,
  );
  assert.equal(
    shouldDeleteFailedStartupSession([
      ...failedEvents(),
      event(5, "user/message", { text: "retry" }),
    ]),
    false,
  );
});

test("a first-send runtime failure deletes the new session after canonical verification", async () => {
  const originalSend = api.sendMessage;
  const originalSession = api.getSession;
  const originalEvents = api.getEvents;
  const originalDelete = api.deleteSession;
  const canonical = failedEvents();
  let deleted = 0;
  let deleteOptions: unknown;
  const deleteStarted = deferred<void>();
  api.sendMessage = (async () => ({ turnId: "turn-1" })) as typeof api.sendMessage;
  api.getSession = (async () => ({
    id: "startup-test", projectId: "project-1", title: "New session", status: "failed",
    createdAt: 1, updatedAt: 2,
  })) as typeof api.getSession;
  api.getEvents = (async () => canonical) as typeof api.getEvents;
  api.deleteSession = (async (_id: string, options?: SessionDeleteOptions) => {
    deleted += 1;
    deleteOptions = options;
    deleteStarted.resolve();
  }) as unknown as typeof api.deleteSession;
  updateSettings({ autoDeleteFailedStartupSessions: true });
  try {
    assert.equal(await sendMessage("hello", undefined, undefined, {
      targetSessionId: "startup-test",
      delivery: "steer",
      deleteIfFailedToStart: true,
    }), true);
    applyEvents(canonical);
    await deleteStarted.promise;
    assert.equal(deleted, 1);
    assert.deepEqual(deleteOptions, { expectedLastEventSeq: 4 });
  } finally {
    api.sendMessage = originalSend;
    api.getSession = originalSession;
    api.getEvents = originalEvents;
    api.deleteSession = originalDelete;
    updateSettings({ autoDeleteFailedStartupSessions: true });
  }
});

test("assistant output and the disabled setting preserve a failed startup session", async () => {
  const originalSend = api.sendMessage;
  const originalSession = api.getSession;
  const originalEvents = api.getEvents;
  const originalDelete = api.deleteSession;
  let deleted = 0;
  api.sendMessage = (async () => ({ turnId: "turn-1" })) as typeof api.sendMessage;
  api.getSession = (async () => ({
    id: "startup-with-output", projectId: "project-1", title: "New session", status: "failed",
    createdAt: 1, updatedAt: 2,
  })) as typeof api.getSession;
  api.getEvents = (async () => failedEvents(true)) as typeof api.getEvents;
  api.deleteSession = (async () => { deleted += 1; }) as unknown as typeof api.deleteSession;
  try {
    updateSettings({ autoDeleteFailedStartupSessions: true });
    assert.equal(await sendMessage("hello", undefined, undefined, {
      targetSessionId: "startup-with-output",
      delivery: "steer",
      deleteIfFailedToStart: true,
    }), true);
    applyEvents(failedEvents(true).map((item) => ({ ...item, sessionId: "startup-with-output" })));
    await drainCleanupTurn();
    assert.equal(deleted, 0);

    updateSettings({ autoDeleteFailedStartupSessions: true });
    assert.equal(await sendMessage("hello", undefined, undefined, {
      targetSessionId: "startup-disabled",
      delivery: "steer",
      deleteIfFailedToStart: true,
    }), true);
    updateSettings({ autoDeleteFailedStartupSessions: false });
    applyEvents(failedEvents().map((item) => ({ ...item, sessionId: "startup-disabled" })));
    await drainCleanupTurn();
    assert.equal(deleted, 0);
  } finally {
    api.sendMessage = originalSend;
    api.getSession = originalSession;
    api.getEvents = originalEvents;
    api.deleteSession = originalDelete;
    updateSettings({ autoDeleteFailedStartupSessions: true });
  }
});

test("creation failures delete only a verified empty row, never an unknown outcome", async () => {
  const originalSession = api.getSession;
  const originalEvents = api.getEvents;
  const originalDelete = api.deleteSession;
  let deleted = 0;
  api.getSession = (async () => ({
    id: "startup-create", projectId: "project-1", title: "New session", status: "failed",
    createdAt: 1, updatedAt: 2,
  })) as typeof api.getSession;
  api.getEvents = (async () => [event(1, "session/created")]) as typeof api.getEvents;
  api.deleteSession = (async () => { deleted += 1; }) as unknown as typeof api.deleteSession;
  updateSettings({ autoDeleteFailedStartupSessions: true });
  try {
    await cleanupFailedStartupSessionFromError(Object.assign(new Error("runtime unavailable"), {
      sessionId: "startup-create",
    }));
    assert.equal(deleted, 1);

    await cleanupFailedStartupSessionFromError(Object.assign(new Error("outcome unknown"), {
      code: "outcome-unknown",
      sessionId: "startup-create",
    }));
    assert.equal(deleted, 1);
  } finally {
    api.getSession = originalSession;
    api.getEvents = originalEvents;
    api.deleteSession = originalDelete;
    updateSettings({ autoDeleteFailedStartupSessions: true });
  }
});

test("empty startup cleanup returns a mixed rejected prompt after deferred deletion", async () => {
  const originalSession = api.getSession;
  const originalEvents = api.getEvents;
  const originalDelete = api.deleteSession;
  const originalList = api.listSessions;
  let deleted = 0;
  const deleteStarted = deferred<void>();
  const releaseDelete = deferred<void>();
  const sessionId = "startup-empty-recovery";
  const projectId = "project-recovery";
  const recoveredAttachment = attachment("recovered-attachment", "notes.txt");
  const updatedAttachment = attachment("updated-attachment", "new-notes.txt");
  api.getSession = (async () => ({
    id: sessionId, projectId, title: "New session", status: "failed",
    createdAt: 1, updatedAt: 2,
  })) as typeof api.getSession;
  api.getEvents = (async () => [event(1, "session/created")]) as typeof api.getEvents;
  api.deleteSession = (async () => {
    deleted += 1;
    deleteStarted.resolve();
    await releaseDelete.promise;
  }) as unknown as typeof api.deleteSession;
  api.listSessions = (async () => []) as typeof api.listSessions;
  updateSettings({ autoDeleteFailedStartupSessions: true });
  activateProject(projectId);
  seedSessionCache({
    id: sessionId, projectId, title: "New session", status: "working",
    createdAt: 1, updatedAt: 2,
  });
  activateSession(sessionId);
  const echo = beginPendingSend({ sessionId: null, text: "recover this prompt", attachments: [recoveredAttachment] });
  bindPendingSend(echo, sessionId);
  updateScopedDraftRecord(sessionId, {
    text: "recover this prompt",
    attachments: [recoveredAttachment],
    dirty: true,
  });
  try {
    const cleanup = cleanupFailedStartupSession(sessionId);
    await deleteStarted.promise;
    // The composer normally retires the optimistic echo before cleanup wins
    // the race; recovery must still use the staged session draft.
    endPendingSend(echo);
    updateScopedDraftRecord(sessionId, {
      text: "updated while deletion was pending",
      attachments: [updatedAttachment],
      dirty: true,
    });
    releaseDelete.resolve();
    await cleanup;
    assert.equal(deleted, 1);
    assert.equal(getState().activeSessionId, null);
    assert.equal(getState().newSessionIntent?.draft, "updated while deletion was pending");
    assert.equal(loadScopedDraftRecord(null).text, "updated while deletion was pending");
    assert.deepEqual(loadScopedDraftRecord(null).attachments, [updatedAttachment]);
  } finally {
    api.getSession = originalSession;
    api.getEvents = originalEvents;
    api.deleteSession = originalDelete;
    api.listSessions = originalList;
    updateSettings({ autoDeleteFailedStartupSessions: true });
  }
});

test("empty startup cleanup recovers an attachment-only prompt", async () => {
  const originalSession = api.getSession;
  const originalEvents = api.getEvents;
  const originalDelete = api.deleteSession;
  const originalList = api.listSessions;
  const sessionId = "startup-attachment-only";
  const projectId = "project-attachment-only";
  const recoveredAttachment = attachment("attachment-only", "image.txt");
  let deleted = 0;
  api.getSession = (async () => ({
    id: sessionId, projectId, title: "New session", status: "failed",
    createdAt: 1, updatedAt: 2,
  })) as typeof api.getSession;
  api.getEvents = (async () => [event(1, "session/created")]) as typeof api.getEvents;
  api.deleteSession = (async () => { deleted += 1; }) as unknown as typeof api.deleteSession;
  api.listSessions = (async () => []) as typeof api.listSessions;
  updateSettings({ autoDeleteFailedStartupSessions: true });
  activateProject(projectId);
  seedSessionCache({
    id: sessionId, projectId, title: "New session", status: "working",
    createdAt: 1, updatedAt: 2,
  });
  activateSession(sessionId);
  updateScopedDraftRecord(sessionId, { text: "", attachments: [recoveredAttachment], dirty: true });
  try {
    await cleanupFailedStartupSession(sessionId);
    assert.equal(deleted, 1);
    assert.equal(getState().newSessionIntent?.draft, "");
    assert.deepEqual(loadScopedDraftRecord(null).attachments, [recoveredAttachment]);
  } finally {
    api.getSession = originalSession;
    api.getEvents = originalEvents;
    api.deleteSession = originalDelete;
    api.listSessions = originalList;
    updateSettings({ autoDeleteFailedStartupSessions: true });
  }
});

test("an explicit staged-draft clear does not fall back to an older pending echo", async () => {
  const originalSession = api.getSession;
  const originalEvents = api.getEvents;
  const originalDelete = api.deleteSession;
  const originalList = api.listSessions;
  const sessionId = "startup-explicit-clear";
  const projectId = "project-explicit-clear";
  const oldAttachment = attachment("cleared-attachment", "cleared.txt");
  const deleteStarted = deferred<void>();
  const releaseDelete = deferred<void>();
  let deleted = 0;
  api.getSession = (async () => ({
    id: sessionId, projectId, title: "New session", status: "failed",
    createdAt: 1, updatedAt: 2,
  })) as typeof api.getSession;
  api.getEvents = (async () => [event(1, "session/created")]) as typeof api.getEvents;
  api.deleteSession = (async () => {
    deleted += 1;
    deleteStarted.resolve();
    await releaseDelete.promise;
  }) as unknown as typeof api.deleteSession;
  api.listSessions = (async () => []) as typeof api.listSessions;
  updateSettings({ autoDeleteFailedStartupSessions: true });
  activateProject(projectId);
  seedSessionCache({
    id: sessionId, projectId, title: "New session", status: "working",
    createdAt: 1, updatedAt: 2,
  });
  activateSession(sessionId);
  const echo = beginPendingSend({ sessionId: null, text: "older pending prompt", attachments: [oldAttachment] });
  bindPendingSend(echo, sessionId);
  updateScopedDraftRecord(sessionId, {
    text: "older pending prompt",
    attachments: [oldAttachment],
    dirty: true,
  });
  try {
    const cleanup = cleanupFailedStartupSession(sessionId);
    await deleteStarted.promise;
    // The user explicitly removed the staged record while the delete was in
    // flight. Its empty coherent record owns both fields; the pending echo is
    // older and must not repopulate either one field-by-field.
    updateScopedDraftRecord(sessionId, {
      text: "",
      attachments: [],
      nativeStaged: [],
      dirty: false,
      seed: undefined,
      conflict: undefined,
    });
    releaseDelete.resolve();
    await cleanup;
    assert.equal(deleted, 1);
    assert.equal(getState().newSessionIntent, null);
    assert.equal(loadScopedDraftRecord(null).text, "");
    assert.deepEqual(loadScopedDraftRecord(null).attachments, []);
  } finally {
    endPendingSend(echo);
    api.getSession = originalSession;
    api.getEvents = originalEvents;
    api.deleteSession = originalDelete;
    api.listSessions = originalList;
    updateSettings({ autoDeleteFailedStartupSessions: true });
  }
});

test("deferred cleanup does not replace a fresh draft typed while deletion is pending", async () => {
  const originalSession = api.getSession;
  const originalEvents = api.getEvents;
  const originalDelete = api.deleteSession;
  const originalList = api.listSessions;
  const sessionId = "startup-navigation-recovery";
  const projectId = "project-navigation-recovery";
  const oldAttachment = attachment("old-attachment", "old.txt");
  const freshAttachment = attachment("fresh-attachment", "fresh.txt");
  const deleteStarted = deferred<void>();
  const releaseDelete = deferred<void>();
  let deleted = 0;
  api.getSession = (async () => ({
    id: sessionId, projectId, title: "New session", status: "failed",
    createdAt: 1, updatedAt: 2,
  })) as typeof api.getSession;
  api.getEvents = (async () => [event(1, "session/created")]) as typeof api.getEvents;
  api.deleteSession = (async () => {
    deleted += 1;
    deleteStarted.resolve();
    await releaseDelete.promise;
  }) as unknown as typeof api.deleteSession;
  api.listSessions = (async () => []) as typeof api.listSessions;
  updateSettings({ autoDeleteFailedStartupSessions: true });
  activateProject(projectId);
  seedSessionCache({
    id: sessionId, projectId, title: "New session", status: "working",
    createdAt: 1, updatedAt: 2,
  });
  activateSession(sessionId);
  updateScopedDraftRecord(sessionId, { text: "old prompt", attachments: [oldAttachment], dirty: true });
  try {
    const cleanup = cleanupFailedStartupSession(sessionId);
    await deleteStarted.promise;
    startNewSession(projectId, { draft: "typed while deletion was pending" });
    updateScopedDraftRecord(null, { attachments: [freshAttachment], dirty: true });
    releaseDelete.resolve();
    await cleanup;
    assert.equal(deleted, 1);
    assert.equal(getState().activeSessionId, null);
    assert.equal(getState().newSessionIntent?.draft, "typed while deletion was pending");
    assert.equal(loadScopedDraftRecord(null).text, "typed while deletion was pending");
    assert.deepEqual(loadScopedDraftRecord(null).attachments, [freshAttachment]);
  } finally {
    api.getSession = originalSession;
    api.getEvents = originalEvents;
    api.deleteSession = originalDelete;
    api.listSessions = originalList;
    updateSettings({ autoDeleteFailedStartupSessions: true });
  }
});

test("deferred cleanup is fenced when the connection/Space namespace changes", async () => {
  const originalSession = api.getSession;
  const originalEvents = api.getEvents;
  const originalDelete = api.deleteSession;
  const originalList = api.listSessions;
  const sessionId = "startup-namespace-fence";
  const projectId = "project-namespace-fence";
  const recoveredAttachment = attachment("namespace-attachment", "namespace.txt");
  const deleteStarted = deferred<void>();
  const releaseDelete = deferred<void>();
  let deleted = 0;
  api.getSession = (async () => ({
    id: sessionId, projectId, title: "New session", status: "failed",
    createdAt: 1, updatedAt: 2,
  })) as typeof api.getSession;
  api.getEvents = (async () => [event(1, "session/created")]) as typeof api.getEvents;
  api.deleteSession = (async () => {
    deleted += 1;
    deleteStarted.resolve();
    await releaseDelete.promise;
  }) as unknown as typeof api.deleteSession;
  api.listSessions = (async () => []) as typeof api.listSessions;
  updateSettings({ autoDeleteFailedStartupSessions: true });
  activateProject(projectId);
  seedSessionCache({
    id: sessionId, projectId, title: "New session", status: "working",
    createdAt: 1, updatedAt: 2,
  });
  activateSession(sessionId);
  updateScopedDraftRecord(sessionId, {
    text: "do not cross the namespace",
    attachments: [recoveredAttachment],
    dirty: true,
  });
  try {
    const cleanup = cleanupFailedStartupSession(sessionId);
    await deleteStarted.promise;
    setClientReliabilityContext({ connectionScope: "other-connection", spaceId: "other-space" });
    releaseDelete.resolve();
    await cleanup;
    assert.equal(deleted, 1);
    assert.equal(getState().newSessionIntent, null);
  } finally {
    setClientReliabilityContext({ connectionScope: "browser-origin", spaceId: "default" });
    api.getSession = originalSession;
    api.getEvents = originalEvents;
    api.deleteSession = originalDelete;
    api.listSessions = originalList;
    updateSettings({ autoDeleteFailedStartupSessions: true });
  }
});

test("stale verification is rejected before an empty-session delete", async () => {
  const originalSession = api.getSession;
  const originalEvents = api.getEvents;
  const originalDelete = api.deleteSession;
  const originalList = api.listSessions;
  const sessionId = "startup-stale-verification";
  const projectId = "project-stale-verification";
  const verificationStarted = deferred<void>();
  const releaseVerification = deferred<void>();
  let deleted = 0;
  api.getSession = (async () => ({
    id: sessionId, projectId, title: "New session", status: "failed",
    createdAt: 1, updatedAt: 2,
  })) as typeof api.getSession;
  api.getEvents = (async () => {
    verificationStarted.resolve();
    await releaseVerification.promise;
    return [event(1, "session/created")];
  }) as typeof api.getEvents;
  api.deleteSession = (async () => { deleted += 1; }) as unknown as typeof api.deleteSession;
  api.listSessions = (async () => []) as typeof api.listSessions;
  updateSettings({ autoDeleteFailedStartupSessions: true });
  activateProject(projectId);
  seedSessionCache({
    id: sessionId, projectId, title: "New session", status: "working",
    createdAt: 1, updatedAt: 2,
  });
  activateSession(sessionId);
  updateScopedDraftRecord(sessionId, { text: "do not use stale verification", dirty: true });
  try {
    const cleanup = cleanupFailedStartupSession(sessionId);
    await verificationStarted.promise;
    setClientReliabilityContext({ connectionScope: "other-connection", spaceId: "other-space" });
    releaseVerification.resolve();
    await cleanup;
    assert.equal(deleted, 0);
    assert.equal(getState().activeSessionId, sessionId);
    assert.equal(getState().newSessionIntent, null);
  } finally {
    setClientReliabilityContext({ connectionScope: "browser-origin", spaceId: "default" });
    api.getSession = originalSession;
    api.getEvents = originalEvents;
    api.deleteSession = originalDelete;
    api.listSessions = originalList;
    updateSettings({ autoDeleteFailedStartupSessions: true });
  }
});

test("nonempty failed startup cleanup restores its sent prompt and attachments to a fresh composer", async () => {
  const originalSession = api.getSession;
  const originalEvents = api.getEvents;
  const originalDelete = api.deleteSession;
  const originalList = api.listSessions;
  const sessionId = "startup-nonempty-recovery";
  const projectId = "project-nonempty-recovery";
  const testAttachment = attachment("att-1", "doc.txt");
  let deleted = 0;
  api.getSession = (async () => ({
    id: sessionId, projectId, title: "New session", status: "failed",
    createdAt: 1, updatedAt: 2,
  })) as typeof api.getSession;
  const eventsWithAttachment = [
    event(1, "session/created"),
    event(2, "user/message", { text: "hello with attachment", attachments: [testAttachment] }),
    event(3, "turn/started", { turnId: "turn-1" }),
    event(4, "turn/stopped", { turnId: "turn-1", reason: "error" }),
  ];
  api.getEvents = (async () => eventsWithAttachment) as typeof api.getEvents;
  api.deleteSession = (async () => { deleted += 1; }) as unknown as typeof api.deleteSession;
  api.listSessions = (async () => []) as typeof api.listSessions;
  updateSettings({ autoDeleteFailedStartupSessions: true });
  activateProject(projectId);
  seedSessionCache({
    id: sessionId, projectId, title: "New session", status: "working",
    createdAt: 1, updatedAt: 2,
  });
  activateSession(sessionId);
  // Staged draft was cleared on send
  updateScopedDraftRecord(sessionId, { text: "", attachments: [], dirty: false });
  try {
    await cleanupFailedStartupSession(sessionId);
    assert.equal(deleted, 1);
    assert.equal(getState().activeSessionId, null);
    assert.equal(getState().newSessionIntent?.draft, "hello with attachment");
    assert.equal(loadScopedDraftRecord(null).text, "hello with attachment");
    assert.deepEqual(loadScopedDraftRecord(null).attachments, [testAttachment]);
  } finally {
    api.getSession = originalSession;
    api.getEvents = originalEvents;
    api.deleteSession = originalDelete;
    api.listSessions = originalList;
    updateSettings({ autoDeleteFailedStartupSessions: true });
  }
});

test("failed empty-session deletion leaves the draft recoverable when the delete fails", async () => {
  const originalSession = api.getSession;
  const originalEvents = api.getEvents;
  const originalDelete = api.deleteSession;
  const originalList = api.listSessions;
  const originalConsoleError = console.error;
  const sessionId = "startup-delete-failed";
  const projectId = "project-delete-failed";
  const recoveredAttachment = attachment("delete-failed-attachment", "retry.txt");
  let deleted = 0;
  let logged = 0;
  api.getSession = (async () => ({
    id: sessionId, projectId, title: "New session", status: "failed",
    createdAt: 1, updatedAt: 2,
  })) as typeof api.getSession;
  api.getEvents = (async () => [event(1, "session/created")]) as typeof api.getEvents;
  api.deleteSession = (async () => {
    deleted += 1;
    throw new Error("delete rejected");
  }) as unknown as typeof api.deleteSession;
  api.listSessions = (async () => []) as typeof api.listSessions;
  console.error = () => { logged += 1; };
  updateSettings({ autoDeleteFailedStartupSessions: true });
  activateProject(projectId);
  seedSessionCache({
    id: sessionId, projectId, title: "New session", status: "working",
    createdAt: 1, updatedAt: 2,
  });
  activateSession(sessionId);
  updateScopedDraftRecord(sessionId, {
    text: "still recoverable",
    attachments: [recoveredAttachment],
    dirty: true,
  });
  try {
    await cleanupFailedStartupSession(sessionId);
    assert.equal(deleted, 1);
    assert.equal(logged, 1);
    assert.equal(getState().activeSessionId, sessionId);
    assert.equal(getState().newSessionIntent, null);
    assert.equal(loadScopedDraftRecord(sessionId).text, "still recoverable");
    assert.deepEqual(loadScopedDraftRecord(sessionId).attachments, [recoveredAttachment]);
  } finally {
    console.error = originalConsoleError;
    api.getSession = originalSession;
    api.getEvents = originalEvents;
    api.deleteSession = originalDelete;
    api.listSessions = originalList;
    updateSettings({ autoDeleteFailedStartupSessions: true });
  }
});

test("recovery keeps the source draft when destination persistence fails", async () => {
  const originalSession = api.getSession;
  const originalEvents = api.getEvents;
  const originalDelete = api.deleteSession;
  const originalList = api.listSessions;
  const originalSummaries = api.listSessionSummaries;
  const originalConsoleError = console.error;
  const sessionId = "startup-destination-persist-failed";
  const projectId = "project-destination-persist-failed";
  const recoveredAttachment = attachment("destination-persist-attachment", "keep.txt");
  const removedKeys: string[] = [];
  const destinationWriteStarted = deferred<void>();
  const releaseDestinationWrite = deferred<void>();
  let rejectWrites = false;
  let deleted = 0;
  let logged = 0;
  setClientPersistenceBackend({
    async get() { return null; },
    async set() {
      if (rejectWrites) {
        destinationWriteStarted.resolve();
        await releaseDestinationWrite.promise;
        throw new Error("destination persistence rejected");
      }
    },
    async remove(key) {
      removedKeys.push(key);
    },
  });
  api.getSession = (async () => ({
    id: sessionId, projectId, title: "New session", status: "failed",
    createdAt: 1, updatedAt: 2,
  })) as typeof api.getSession;
  api.getEvents = (async () => [event(1, "session/created")]) as typeof api.getEvents;
  api.deleteSession = (async () => { deleted += 1; }) as unknown as typeof api.deleteSession;
  api.listSessions = (async () => []) as typeof api.listSessions;
  // The navigator refresh after the delete reads the paged summaries.
  api.listSessionSummaries = (async () => ({ sessions: [], revision: 0, complete: true })) as typeof api.listSessionSummaries;
  console.error = () => { logged += 1; };
  updateSettings({ autoDeleteFailedStartupSessions: true });
  activateProject(projectId);
  seedSessionCache({
    id: sessionId, projectId, title: "New session", status: "working",
    createdAt: 1, updatedAt: 2,
  });
  activateSession(sessionId);
  updateScopedDraftRecord(sessionId, {
    text: "keep this source copy",
    attachments: [recoveredAttachment],
    dirty: true,
  });
  await flushClientPersistence();
  rejectWrites = true;
  try {
    const cleanup = cleanupFailedStartupSession(sessionId);
    await destinationWriteStarted.promise;
    // The destination key is still in flight; the source must not be removed
    // independently just because its backend operation can settle first.
    assert.deepEqual(removedKeys, []);
    releaseDestinationWrite.resolve();
    await cleanup;
    assert.equal(deleted, 1);
    assert.equal(logged, 1);
    assert.deepEqual(removedKeys, []);
    assert.equal(loadScopedDraftRecord(sessionId).text, "keep this source copy");
    assert.deepEqual(loadScopedDraftRecord(sessionId).attachments, [recoveredAttachment]);
  } finally {
    setClientPersistenceBackend(null);
    console.error = originalConsoleError;
    api.getSession = originalSession;
    api.getEvents = originalEvents;
    api.deleteSession = originalDelete;
    api.listSessions = originalList;
    api.listSessionSummaries = originalSummaries;
    updateSettings({ autoDeleteFailedStartupSessions: true });
  }
});
