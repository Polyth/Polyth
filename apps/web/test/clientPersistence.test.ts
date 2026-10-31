import assert from "node:assert/strict";
import { test } from "node:test";
import { addAttachment, pendingAttachmentEntryCountForTest, pendingAttachments } from "../src/attachments.ts";
import { activeBrowserAccountId, setActiveBrowserAccount } from "../src/accountStorage.ts";
import { acceptAuthenticatedBrowserAccount } from "../src/authPrefetch.ts";
import { deadlineSignal } from "../src/deadline.ts";
import {
  hydrateClientRecord,
  clientContextStore,
  clientPersistenceCacheSizeForTest,
  flushClientPersistence,
  migrateLegacyClientRecord,
  setClientPersistenceBackend,
  type AsyncKeyValueStore,
} from "../src/clientPersistence.ts";
import { hydrateComposerDraft, loadSeedRecord, saveSeedRecord } from "../src/drafts.ts";
import { loadLocalMutationIntent, markLocalMutationUnknown, reconcileLocalMutationIntent, retainLocalMutationIntentAfterError, stageLocalMutationIntent, submitDirectPrompt } from "../src/mutationIntent.ts";
import {
  acknowledgeDraftRevision, adoptServerDraft, hydrateScopedDraftRecord, loadScopedDraftRecord, nativeStagedAttachments,
  recordLocalDraftEdit, registerNativeStagedAttachment, removeNativeStagedAttachment, updateScopedDraftRecord,
} from "../src/draftRecord.ts";
import {
  clientPersistenceScope,
  initializeClientReliabilityContext,
  setClientReliabilityContext,
  setClientReliabilityProject,
  setClientReliabilitySpace,
} from "../src/reliabilityContext.ts";
import { activateProject, activateSession, getState, hasPreviousNewSessionDraft, hydrateClientNavigation, hydrateNewSessionDraft, saveNewSessionDraftText, setNewSessionIsolation, startFreshSession, startNewSession } from "../src/store.ts";
import { cancelDraftSync, flushDraftToServer, loadDraft, saveDraft, syncDraftToServer } from "../src/utils.ts";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const installStorage = (): (() => void) => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
  return () => {
    if (prior) Object.defineProperty(globalThis, "localStorage", prior);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  };
};

const scope = (connectionScope: string, accountId: string, spaceId = "default") => {
  setClientPersistenceBackend(null);
  setClientReliabilityContext({ connectionScope, spaceId });
  setClientReliabilityProject("p");
  setActiveBrowserAccount(accountId);
  assert.equal(activeBrowserAccountId(), accountId);
};

const waitFor = async (predicate: () => boolean, message: string): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(message);
};

test("a seeded isolated chat stays an unsent scoped draft and preserves a later opt-out", async () => {
  const restore = installStorage();
  try {
    scope("isolated-seed", "usr_user1");
    const sessionsBefore = getState().sessions.length;
    startNewSession("p", { draft: "Implement the task", isolate: true });
    assert.equal(getState().activeSessionId, null);
    assert.equal(getState().sessions.length, sessionsBefore);
    saveNewSessionDraftText("p", "Edited task");
    activateSession("existing");
    startNewSession("p");
    assert.equal(getState().newSessionIntent?.isolate, true);
    assert.equal(getState().newSessionIntent?.draft, "Edited task");

    setNewSessionIsolation("p", false);
    activateSession("existing");
    startNewSession("p");
    assert.equal(getState().newSessionIntent?.isolate, false);
    assert.equal((await hydrateNewSessionDraft("p"))?.isolate, false);

    scope("isolated-seed", "usr_user1", "foreign-space");
    assert.equal((await hydrateNewSessionDraft("p"))?.isolate, undefined);
  } finally {
    setClientPersistenceBackend(null);
    restore();
  }
});

test("draft, seed, attachment, fresh-session, unsent intent and navigation records isolate identical IDs", async () => {
  const restore = installStorage();
  try {
    scope("connection-a", "usr_user1");
    saveDraft("s", "draft-a1");
    saveSeedRecord("s", { key: "seed-a1", seedText: "draft-a1" });
    assert.equal(addAttachment("s", { id: "a1", name: "a.txt", mime: "text/plain", size: 1, kind: "file", path: "a.txt" }), true);
    startNewSession("p", { draft: "new-a1" });
    assert.equal(addAttachment(null, { id: "fresh-a1", name: "fresh.txt", mime: "text/plain", size: 1, kind: "file", path: "fresh.txt" }), true);
    stageLocalMutationIntent("s", "turn-submit", "op-a1");
    activateProject("p");
    activateSession("s");

    scope("connection-a", "usr_user2");
    assert.equal(loadDraft("s"), "");
    assert.equal(loadSeedRecord("s"), null);
    assert.deepEqual(pendingAttachments("s"), []);
    assert.deepEqual(pendingAttachments(null), []);
    assert.equal(loadLocalMutationIntent("s"), null);
    assert.equal(await hydrateClientNavigation(), null);
    startNewSession("p");
    // New-session text is held in the store intent; a cross-account visit must
    // never restore the other account's persistent record.
    saveNewSessionDraftText("p", "new-a2");

    scope("connection-b", "usr_user1");
    assert.equal(loadDraft("s"), "");
    assert.equal(loadSeedRecord("s"), null);
    assert.deepEqual(pendingAttachments("s"), []);
    assert.equal(loadLocalMutationIntent("s"), null);
    assert.equal(await hydrateClientNavigation(), null);

    scope("connection-a", "usr_user1", "space-b");
    assert.equal(loadDraft("s"), "");
    assert.deepEqual(pendingAttachments("s"), []);

    scope("connection-a", "usr_user1");
    assert.equal(loadDraft("s"), "draft-a1");
    assert.deepEqual(loadSeedRecord("s"), { key: "seed-a1", seedText: "draft-a1" });
    assert.equal(pendingAttachments("s")[0]?.id, "a1");
    assert.equal(pendingAttachments(null)[0]?.id, "fresh-a1");
    assert.equal(loadLocalMutationIntent("s")?.operationId, "op-a1");
    assert.deepEqual(await hydrateClientNavigation(), { v: 1, spaceId: "default", projectId: "p", sessionId: "s" });
  } finally {
    setClientPersistenceBackend(null);
    restore();
  }
});

test("explicit New Chat automatically restores its previous text and attachments", () => {
  const restore = installStorage();
  try {
    scope("fresh-chat", "usr_user1");
    startNewSession("p", { draft: "unsent before New Chat", worktreePath: "/worktree/one" });
    assert.equal(addAttachment(null, { id: "previous-pill", name: "note.txt", mime: "text/plain", size: 1, kind: "file", path: "note.txt" }), true);

    startFreshSession("p");
    assert.equal(getState().newSessionIntent?.draft, "unsent before New Chat");
    assert.equal(getState().newSessionIntent?.worktreePath, "/worktree/one");
    assert.equal(loadScopedDraftRecord(null).text, "unsent before New Chat");
    assert.equal(pendingAttachments(null)[0]?.id, "previous-pill");
    assert.equal(hasPreviousNewSessionDraft("p"), false);
  } finally {
    setClientPersistenceBackend(null);
    restore();
  }
});

test("automatic New Chat restore consumes a draft shelved by an older client", () => {
  const restore = installStorage();
  try {
    scope("fresh-chat-legacy", "usr_user1");
    updateScopedDraftRecord(null, {
      previousNewSessionDrafts: [{
        text: "draft from the previous client",
        attachments: [{ id: "legacy-pill", name: "note.txt", mime: "text/plain", size: 1, kind: "file", path: "note.txt" }],
        worktreePath: "/worktree/legacy",
      }],
    });
    startNewSession("p", { draft: "" });

    startFreshSession("p");

    assert.equal(getState().newSessionIntent?.draft, "draft from the previous client");
    assert.equal(getState().newSessionIntent?.worktreePath, "/worktree/legacy");
    assert.equal(pendingAttachments(null)[0]?.id, "legacy-pill");
    assert.equal(hasPreviousNewSessionDraft("p"), false);
  } finally {
    setClientPersistenceBackend(null);
    restore();
  }
});

test("explicit New Chat restores the active draft without trimming older recovery entries", () => {
  const restore = installStorage();
  try {
    scope("fresh-chat-shelf", "usr_user1");
    startNewSession("p", { draft: "current draft" });
    updateScopedDraftRecord(null, {
      previousNewSessionDrafts: [
        { text: "oldest recovery", attachments: [] },
        { text: "middle recovery", attachments: [] },
        { text: "newest recovery", attachments: [] },
      ],
    });

    startFreshSession("p");

    assert.equal(getState().newSessionIntent?.draft, "current draft");
    assert.deepEqual(
      loadScopedDraftRecord(null).previousNewSessionDrafts?.map((draft) => draft.text),
      ["oldest recovery", "middle recovery", "newest recovery"],
    );
  } finally {
    setClientPersistenceBackend(null);
    restore();
  }
});

test("ordinary New Chat navigation restores a legacy shelf without clobbering newer edits", () => {
  const restore = installStorage();
  try {
    scope("ordinary-navigation", "usr_user1", "space-a");
    activateProject("p");
    setClientReliabilitySpace("space-a");
    setClientReliabilityProject("p");
    updateScopedDraftRecord(null, {
      previousNewSessionDrafts: [{
        text: "older shelved draft",
        attachments: [],
        worktreePath: "/worktree/old",
      }],
    });

    startNewSession("p");
    assert.equal(getState().newSessionIntent?.draft, "older shelved draft");
    assert.equal(getState().newSessionIntent?.worktreePath, "/worktree/old");

    updateScopedDraftRecord(null, {
      previousNewSessionDrafts: [{ text: "still older", attachments: [] }],
    });
    startNewSession("p", { draft: "newer current edit", worktreePath: "/worktree/new" });
    startNewSession("p");
    assert.equal(getState().newSessionIntent?.draft, "newer current edit");
    assert.equal(getState().newSessionIntent?.worktreePath, "/worktree/new");
    assert.equal(loadScopedDraftRecord(null).previousNewSessionDrafts?.length, 1);
  } finally {
    setClientPersistenceBackend(null);
    restore();
  }
});

test("ordinary legacy restore keeps newer current intent metadata", () => {
  const restore = installStorage();
  try {
    scope("ordinary-metadata", "usr_user1", "space-a");
    activateProject("p");
    setClientReliabilitySpace("space-a");
    setClientReliabilityProject("p");
    updateScopedDraftRecord(null, {
      previousNewSessionDrafts: [{
        text: "legacy text",
        attachments: [],
        title: "legacy title",
        worktreePath: "/worktree/legacy",
        repositoryIds: ["legacy-repository"],
      }],
    });

    startNewSession("p", {
      draft: "",
      title: "newer title",
      worktreePath: "/worktree/newer",
      repositoryIds: ["newer-repository"],
    });
    startNewSession("p");

    assert.equal(getState().newSessionIntent?.draft, "legacy text");
    assert.equal(getState().newSessionIntent?.title, "newer title");
    assert.equal(getState().newSessionIntent?.worktreePath, "/worktree/newer");
    assert.deepEqual(getState().newSessionIntent?.repositoryIds, ["newer-repository"]);
  } finally {
    setClientPersistenceBackend(null);
    restore();
  }
});

test("ordinary legacy restore remains isolated by project and Space", () => {
  const restore = installStorage();
  try {
    scope("ordinary-isolation", "usr_user1", "space-a");
    activateProject("p");
    setClientReliabilitySpace("space-a");
    setClientReliabilityProject("p");
    updateScopedDraftRecord(null, {
      previousNewSessionDrafts: [{ text: "scoped legacy draft", attachments: [] }],
    });

    startNewSession("other-project");
    assert.equal(getState().newSessionIntent?.draft, "");

    startNewSession("p");
    setClientReliabilitySpace("space-b");
    startNewSession("p");
    assert.equal(getState().newSessionIntent?.draft, "");

    setClientReliabilitySpace("space-a");
    startNewSession("p");
    assert.equal(getState().newSessionIntent?.draft, "scoped legacy draft");
  } finally {
    setClientPersistenceBackend(null);
    restore();
  }
});

test("ordinary New Chat reload promotes a legacy shelf after native hydration", async () => {
  const restore = installStorage();
  const values = new Map<string, string>();
  const remote: AsyncKeyValueStore = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); },
    remove: async (key) => { values.delete(key); },
  };
  try {
    scope("ordinary-reload", "usr_user1");
    activateProject("p");
    setClientReliabilitySpace("default");
    setClientReliabilityProject("p");
    setClientPersistenceBackend(remote);
    updateScopedDraftRecord(null, {
      previousNewSessionDrafts: [{
        text: "native legacy draft",
        attachments: [{ id: "native-legacy-pill", name: "native.txt", mime: "text/plain", size: 1, kind: "file", path: "native.txt" }],
        title: "Recovered title",
        worktreePath: "/worktree/native-legacy",
      }],
    });
    await flushClientPersistence();

    setClientPersistenceBackend(remote);
    const restored = await hydrateNewSessionDraft("p");
    assert.ok(restored?.recovery, "hydration returns a deferred recovery candidate");
    assert.deepEqual(pendingAttachments(null), [], "read-only hydration does not seed ambient attachments");
    startNewSession("p", restored!);
    await waitFor(() => getState().newSessionIntent?.draft === "native legacy draft", "the hydrated legacy shelf is restored");
    assert.equal(getState().newSessionIntent?.title, "Recovered title");
    assert.equal(getState().newSessionIntent?.worktreePath, "/worktree/native-legacy");
    assert.equal(pendingAttachments(null)[0]?.id, "native-legacy-pill");
    assert.equal(loadScopedDraftRecord(null).previousNewSessionDrafts?.length ?? 0, 0);
    await flushClientPersistence();
  } finally {
    setClientPersistenceBackend(null);
    restore();
  }
});

test("cold native New Chat hydrates before writing over a persisted active draft", async () => {
  const restore = installStorage();
  const values = new Map<string, string>();
  const remote: AsyncKeyValueStore = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); },
    remove: async (key) => { values.delete(key); },
  };
  try {
    scope("fresh-cold-native", "usr_user1");
    activateProject("p");
    setClientReliabilitySpace("default");
    setClientReliabilityProject("p");
    setClientPersistenceBackend(remote);
    startNewSession("p", { draft: "persisted active draft", worktreePath: "/worktree/persisted" });
    await flushClientPersistence();
    const persistedEntryCount = values.size;

    setClientPersistenceBackend(remote);
    startFreshSession("p", { worktreePath: "/worktree/selected" });
    assert.equal(values.size, persistedEntryCount, "cold New Chat does not write an empty placeholder");
    await waitFor(() => getState().newSessionIntent?.draft === "persisted active draft", "the active draft is hydrated before New Chat writes");

    assert.equal(getState().newSessionIntent?.worktreePath, "/worktree/selected");
    await flushClientPersistence();
    setClientPersistenceBackend(remote);
    await hydrateScopedDraftRecord(null);
    assert.equal(loadScopedDraftRecord(null).text, "persisted active draft");
  } finally {
    setClientPersistenceBackend(null);
    restore();
  }
});

test("deferred native hydration cannot seed attachments after a project and Space switch", async () => {
  const restore = installStorage();
  const values = new Map<string, string>();
  let releaseRead: (() => void) | undefined;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  let holdReads = true;
  let reads = 0;
  const remote: AsyncKeyValueStore = {
    get: async (key) => {
      reads += 1;
      if (holdReads) await readGate;
      return values.get(key) ?? null;
    },
    set: async (key, value) => { values.set(key, value); },
    remove: async (key) => { values.delete(key); },
  };
  try {
    scope("deferred-switch", "usr_user1", "space-a");
    activateProject("p");
    setClientReliabilitySpace("space-a");
    setClientReliabilityProject("p");
    setClientPersistenceBackend(remote);
    updateScopedDraftRecord(null, {
      previousNewSessionDrafts: [{
        text: "source draft",
        attachments: [{ id: "source-pill", name: "source.txt", mime: "text/plain", size: 1, kind: "file", path: "source.txt" }],
      }],
    });
    await flushClientPersistence();

    setClientPersistenceBackend(remote);
    startNewSession("p");
    await waitFor(() => reads >= 2, "source hydration starts");

    setClientReliabilitySpace("space-b");
    startNewSession("other-project");
    setClientReliabilitySpace("space-b");
    setClientReliabilityProject("other-project");
    await waitFor(() => reads >= 4, "destination hydration starts");
    holdReads = false;
    releaseRead?.();
    await flushClientPersistence();

    assert.deepEqual(pendingAttachments(null), [], "stale source hydration must not seed the destination composer");

    setClientPersistenceBackend(remote);
    setClientReliabilityContext({ connectionScope: "deferred-switch", spaceId: "space-a" });
    setClientReliabilityProject("p");
    await hydrateScopedDraftRecord(null);
    assert.equal(loadScopedDraftRecord(null).previousNewSessionDrafts?.[0]?.text, "source draft", "stale hydration must not consume the source shelf");
  } finally {
    holdReads = false;
    releaseRead?.();
    setClientPersistenceBackend(null);
    restore();
  }
});

test("an automatically restored New Chat draft survives native renderer restart", async () => {
  const restore = installStorage();
  const values = new Map<string, string>();
  const remote: AsyncKeyValueStore = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); },
    remove: async (key) => { values.delete(key); },
  };
  try {
    scope("fresh-native", "usr_user1");
    setClientPersistenceBackend(remote);
    startNewSession("p", { draft: "native unsent draft" });
    startFreshSession("p");
    await flushClientPersistence();

    setClientPersistenceBackend(remote);
    await hydrateScopedDraftRecord(null);
    assert.equal(loadScopedDraftRecord(null).text, "native unsent draft");
    assert.equal(hasPreviousNewSessionDraft("p"), false);
  } finally {
    setClientPersistenceBackend(null);
    restore();
  }
});

test("a scheduled draft flush sends the current unsent session text to the server", async () => {
  const restore = installStorage();
  const { api } = await import("@polyth/session/web-api");
  const originalSaveDraft = api.saveDraft;
  const writes: Array<{ sessionId: string; text: string; expectedUpdatedAt?: number | null }> = [];
  try {
    scope("connection-a", "usr_user1");
    api.saveDraft = async (sessionId, text, expectedUpdatedAt) => {
      writes.push({ sessionId, text, expectedUpdatedAt });
      return { draftUpdatedAt: 12 };
    };
    saveDraft("session-draft", "unsent prompt");
    syncDraftToServer("session-draft", "unsent prompt");
    flushDraftToServer("session-draft");
    syncDraftToServer("session-draft", "unsent prompt");
    flushDraftToServer("session-draft");
    await waitFor(() => !loadScopedDraftRecord("session-draft").dirty, "the scheduled draft receives its ACK");
    assert.deepEqual(writes, [{ sessionId: "session-draft", text: "unsent prompt", expectedUpdatedAt: null }]);
  } finally {
    api.saveDraft = originalSaveDraft;
    setClientPersistenceBackend(null);
    restore();
  }
});

test("server draft sync serializes revisions and sends the newest with the acknowledged CAS stamp", async () => {
  const restore = installStorage();
  const { api } = await import("@polyth/session/web-api");
  const originalSaveDraft = api.saveDraft;
  const writes: Array<{ text: string; expectedUpdatedAt?: number | null }> = [];
  let releaseFirst: (() => void) | undefined;
  try {
    scope("connection-draft-serial", "usr_draft-serial");
    api.saveDraft = async (_sessionId, text, expectedUpdatedAt) => {
      writes.push({ text, expectedUpdatedAt });
      if (writes.length === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return { draftUpdatedAt: 12 };
      }
      return { draftUpdatedAt: 13 };
    };

    saveDraft("session-draft", "first");
    syncDraftToServer("session-draft", "first");
    flushDraftToServer("session-draft");
    await waitFor(() => writes.length === 1, "the first draft revision starts");

    saveDraft("session-draft", "second");
    syncDraftToServer("session-draft", "second");
    flushDraftToServer("session-draft");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(writes.length, 1, "a newer revision must not overlap the in-flight CAS write");

    releaseFirst?.();
    await waitFor(() => writes.length === 2, "the newest draft revision follows the first ACK");
    assert.deepEqual(writes, [
      { text: "first", expectedUpdatedAt: null },
      { text: "second", expectedUpdatedAt: 12 },
    ]);
    await waitFor(() => !loadScopedDraftRecord("session-draft").dirty, "the newest revision becomes durable");
    assert.equal(loadScopedDraftRecord("session-draft").serverUpdatedAt, 13);
  } finally {
    releaseFirst?.();
    api.saveDraft = originalSaveDraft;
    setClientPersistenceBackend(null);
    restore();
  }
});

test("a real draft conflict blocks replay of the same revision and a later edit resumes syncing", async () => {
  const restore = installStorage();
  const { api } = await import("@polyth/session/web-api");
  const originalSaveDraft = api.saveDraft;
  const writes: Array<{ text: string; expectedUpdatedAt?: number | null }> = [];
  let rejectFirst: (() => void) | undefined;
  try {
    scope("connection-draft-conflict", "usr_draft-conflict");
    api.saveDraft = async (_sessionId, text, expectedUpdatedAt) => {
      writes.push({ text, expectedUpdatedAt });
      if (writes.length === 1) {
        await new Promise<void>((_resolve, reject) => {
          rejectFirst = () => reject(Object.assign(new Error("draft changed on another client"), {
            status: 409,
            code: "draft-conflict",
          }));
        });
      }
      return { draftUpdatedAt: 20 };
    };

    saveDraft("session-draft", "first");
    syncDraftToServer("session-draft", "first");
    flushDraftToServer("session-draft");
    await waitFor(() => writes.length === 1, "the stale draft write starts");
    saveDraft("session-draft", "second");
    syncDraftToServer("session-draft", "second");
    flushDraftToServer("session-draft");
    rejectFirst?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(writes, [{ text: "first", expectedUpdatedAt: null }], "queued work cannot stampede a known CAS conflict");
    flushDraftToServer("session-draft");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(writes.length, 1, "lifecycle retries preserve the conflicted local revision");

    saveDraft("session-draft", "explicit continuation");
    syncDraftToServer("session-draft", "explicit continuation");
    flushDraftToServer("session-draft");
    await waitFor(() => writes.length === 2, "a new local edit explicitly resumes draft sync");
    assert.deepEqual(writes[1], { text: "explicit continuation", expectedUpdatedAt: null });
    await waitFor(() => !loadScopedDraftRecord("session-draft").dirty, "the resumed revision becomes durable");
  } finally {
    rejectFirst?.();
    api.saveDraft = originalSaveDraft;
    setClientPersistenceBackend(null);
    restore();
  }
});

test("a send cancels the pending blur autosave before it can echo the submitted prompt", async () => {
  const restore = installStorage();
  const { api } = await import("@polyth/session/web-api");
  const originalSaveDraft = api.saveDraft;
  const writes: string[] = [];
  try {
    scope("connection-a", "usr_user1");
    api.saveDraft = async (_sessionId, text) => {
      writes.push(text);
      return { draftUpdatedAt: 12 };
    };
    saveDraft("session-draft", "submitted prompt");
    syncDraftToServer("session-draft", "submitted prompt");
    cancelDraftSync("session-draft");
    flushDraftToServer("session-draft");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(writes, [], "the canceled blur timer cannot write the submitted prompt");
  } finally {
    api.saveDraft = originalSaveDraft;
    setClientPersistenceBackend(null);
    restore();
  }
});

test("remote and attachment caches remain bounded across many scoped contexts", async () => {
  const restore = installStorage();
  const remote: AsyncKeyValueStore = { get: async () => null, set: async () => {}, remove: async () => {} };
  try {
    setClientPersistenceBackend(remote);
    for (let i = 0; i < 260; i++) {
      setClientReliabilityContext({ connectionScope: `connection-${i}`, spaceId: "default" });
      setClientReliabilityProject("p");
      setActiveBrowserAccount(`usr_user${i}`);
      await hydrateClientRecord("draft-record", clientPersistenceScope({ sessionId: `session-${i}` }));
      addAttachment(`session-${i}`, { id: `a-${i}`, name: "a", mime: "text/plain", size: 1, kind: "file", path: `a-${i}` });
    }
    assert.ok(clientPersistenceCacheSizeForTest() <= 128);
    assert.ok(pendingAttachmentEntryCountForTest() <= 64);
  } finally {
    setClientPersistenceBackend(null);
    restore();
  }
});

test("dirty draft reconciliation preserves ordering and exact acknowledgements", () => {
  const restore = installStorage();
  try {
    scope("connection-a", "usr_user1");
    const first = recordLocalDraftEdit("s", "local-new");
    const older = adoptServerDraft("s", "server-old", 4);
    assert.equal(older.text, "local-new");
    assert.equal(older.serverUpdatedAt, 4);
    assert.equal(older.conflict?.text, "server-old");
    const newer = adoptServerDraft("s", "server-new", 9);
    assert.equal(newer.text, "local-new");
    assert.equal(newer.serverUpdatedAt, 9);
    assert.equal(newer.conflict?.text, "server-new");
    // A newer keystroke makes the previous network acknowledgement stale.
    const second = recordLocalDraftEdit("s", "local-newer");
    const staleAcknowledgement = acknowledgeDraftRevision("s", first.revision, 10);
    assert.equal(staleAcknowledgement.dirty, true);
    assert.equal(staleAcknowledgement.serverUpdatedAt, 10);
    const acknowledged = acknowledgeDraftRevision("s", second.revision, 11);
    assert.equal(acknowledged.dirty, false);
    assert.equal(loadScopedDraftRecord("s").serverUpdatedAt, 11);
  } finally { restore(); }
});

test("an unchanged server draft revision does not manufacture a cross-client conflict", () => {
  const restore = installStorage();
  try {
    scope("connection-draft-base", "usr_draftbase");
    adoptServerDraft("same-base", "", 4);
    const local = recordLocalDraftEdit("same-base", "local-new");

    const unchanged = adoptServerDraft("same-base", "", 4);
    assert.equal(unchanged.text, "local-new");
    assert.equal(unchanged.dirty, true);
    assert.equal(unchanged.conflict, undefined);
    assert.equal(unchanged.revision, local.revision, "an unrelated projection broadcast must be a no-op");

    const advanced = adoptServerDraft("same-base", "remote-new", 5);
    assert.equal(advanced.text, "local-new");
    assert.equal(advanced.serverUpdatedAt, 5);
    assert.deepEqual(advanced.conflict, { text: "remote-new", serverUpdatedAt: 5 });
  } finally { restore(); }
});

test("only ambiguous prompt failures retain an unknown-operation hint", () => {
  assert.equal(retainLocalMutationIntentAfterError({ status: 400, code: "invalid-input" }), false);
  assert.equal(retainLocalMutationIntentAfterError({ status: 409, code: "client-operation-conflict" }), false);
  assert.equal(retainLocalMutationIntentAfterError({ status: 409, code: "outcome-unknown" }), true);
  assert.equal(retainLocalMutationIntentAfterError(new Error("network")), true);
});

test("native staged metadata stays scoped and has a stable deterministic destination", () => {
  const restore = installStorage();
  try {
    scope("connection-a", "usr_user1");
    const staged = registerNativeStagedAttachment(null, {
      id: "b2719d26-743e-4f7f-8cb0-55c3e5ad5d7b",
      stagingPath: "/native/private/staged/a.png",
      name: "a strange image.png",
      mimeType: "image/png",
      size: 12,
      lastModified: 4,
    });
    assert.equal(staged.destination, "_inbox/b2719d26-743e-4f7f-8cb0-55c3e5ad5d7b-a_strange_image.png");
    assert.equal(nativeStagedAttachments(null)[0]?.stagingPath, "/native/private/staged/a.png");
    scope("connection-a", "usr_user2");
    assert.deepEqual(nativeStagedAttachments(null), []);
    scope("connection-a", "usr_user1");
    removeNativeStagedAttachment(null, staged.id);
    assert.deepEqual(nativeStagedAttachments(null), []);
  } finally { restore(); }
});

test("legacy migration refuses ambiguity and only deletes a provably owned record", () => {
  const restore = installStorage();
  try {
    scope("connection-a", "usr_user1");
    localStorage.setItem("polyth.draft.s", JSON.stringify({ v: 1, revision: 1, updatedAt: 1, text: "legacy", attachments: [] }));
    const current = clientPersistenceScope({ sessionId: "s" });
    assert.equal(migrateLegacyClientRecord("polyth.draft.s", "draft-record", current, false), false);
    assert.ok(localStorage.getItem("polyth.draft.s"));
    assert.equal(loadDraft("s"), "");
    assert.equal(migrateLegacyClientRecord("polyth.draft.s", "draft-record", current, true), true);
    assert.equal(localStorage.getItem("polyth.draft.s"), null);
    assert.equal(loadDraft("s"), "legacy");
  } finally {
    restore();
  }
});

test("authenticated proxy context selects an opaque async store across dynamic origins", async () => {
  const restore = installStorage();
  const previousFetch = globalThis.fetch;
  const values = new Map<string, string>();
  const remote: AsyncKeyValueStore = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); },
    remove: async (key) => { values.delete(key); },
  };
  try {
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      if (path === "/__polyth/client-context") {
        return new Response(JSON.stringify({ protocolVersion: 1, connectionScope: "opaque-connection" }), { status: 200 });
      }
      const key = path.slice("/__polyth/client-context/storage/".length);
      if (init?.method === "PUT") { values.set(key, String(init.body)); return new Response(null, { status: 204 }); }
      if (init?.method === "DELETE") { values.delete(key); return new Response(null, { status: 204 }); }
      const value = values.get(key);
      return value === undefined ? new Response(null, { status: 404 }) : new Response(JSON.stringify({ value }), { status: 200 });
    };
    setClientPersistenceBackend(null);
    setClientReliabilitySpace("default");
    setClientReliabilityProject("p");
    acceptAuthenticatedBrowserAccount("usr_user1");
    await initializeClientReliabilityContext();
    saveDraft("s", "survives-port-change");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Simulate a fresh renderer at another loopback port: only the opaque
    // connection scope and remote store identify the existing record.
    setClientPersistenceBackend(remote);
    const restored = await hydrateClientRecord("draft-record", clientPersistenceScope({ sessionId: "s" }));
    assert.equal((JSON.parse(restored ?? "{}") as { text?: unknown }).text, "survives-port-change");
    assert.ok([...values.keys()].every((key) => /^[A-Za-z0-9._-]{1,128}$/.test(key)));
    assert.equal([...values.keys()].some((key) => key.includes("connection") || key.includes("user1")), false);
  } finally {
    globalThis.fetch = previousFetch;
    setClientPersistenceBackend(null);
    restore();
  }
});

test("a loopback read carries a deadline while writes keep their ordering", async () => {
  const previousFetch = globalThis.fetch;
  const signals = new Map<string, AbortSignal | null | undefined>();
  try {
    globalThis.fetch = async (_input, init) => {
      const method = init?.method ?? "GET";
      signals.set(method, init?.signal);
      return new Response(null, { status: method === "GET" ? 404 : 204 });
    };
    const loopback = clientContextStore();
    assert.equal(await loopback.get("k"), null);
    await loopback.set("k", "v");
    await loopback.remove("k");
    // A stalled read would otherwise hang every session open behind draft
    // hydration; an abandoned PUT could land after a newer one.
    assert.ok(signals.get("GET") instanceof AbortSignal);
    assert.equal(signals.get("PUT"), undefined);
    assert.equal(signals.get("DELETE"), undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a deadline aborts on time, also where AbortSignal.timeout is missing", async () => {
  const timeout = AbortSignal.timeout;
  const native = deadlineSignal(5);
  let fallback: AbortSignal;
  try {
    // The native app's iOS 15 WebView has no AbortSignal.timeout.
    (AbortSignal as { timeout?: unknown }).timeout = undefined;
    fallback = deadlineSignal(5);
  } finally {
    AbortSignal.timeout = timeout;
  }
  assert.equal(native.aborted || fallback.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(native.aborted, true);
  assert.equal(fallback.aborted, true);
});

test("an in-flight native hydration cannot overwrite a newer local edit", async () => {
  const restore = installStorage();
  let release: ((value: string | null) => void) | undefined;
  const remote: AsyncKeyValueStore = {
    get: async () => await new Promise<string | null>((resolve) => { release = resolve; }),
    set: async () => {},
    remove: async () => {},
  };
  try {
    setClientReliabilityContext({ connectionScope: "connection-a", spaceId: "default" });
    setClientReliabilityProject("p");
    setActiveBrowserAccount("usr_user1");
    setClientPersistenceBackend(remote);
    const hydration = hydrateClientRecord("draft-record", clientPersistenceScope({ sessionId: "s" }));
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    saveDraft("s", "typed-during-hydration");
    release(JSON.stringify({ v: 1, revision: 1, updatedAt: 1, text: "older", attachments: [] }));
    const resolved = JSON.parse(await hydration ?? "{}") as { text?: string };
    assert.equal(resolved.text, "typed-during-hydration");
    assert.equal(loadDraft("s"), "typed-during-hydration");
  } finally {
    setClientPersistenceBackend(null);
    restore();
  }
});

test("native persistence serializes revisions of one scoped draft", async () => {
  const restore = installStorage();
  let releaseFirst: (() => void) | undefined;
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const values = new Map<string, string>();
  const remote: AsyncKeyValueStore = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      values.set(key, value);
      active -= 1;
    },
    remove: async (key) => { values.delete(key); },
  };
  try {
    setClientReliabilityContext({ connectionScope: "connection-a", spaceId: "default" });
    setClientReliabilityProject("p");
    setActiveBrowserAccount("usr_user1");
    setClientPersistenceBackend(remote);
    saveDraft("s", "older");
    saveDraft("s", "newest");
    while (!releaseFirst) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 1);
    releaseFirst();
    await flushClientPersistence();
    assert.equal(calls, 2);
    assert.equal(maxActive, 1);
    const stored = JSON.parse([...values.values()][0] ?? "{}") as { text?: string };
    assert.equal(stored.text, "newest");
  } finally {
    setClientPersistenceBackend(null);
    restore();
  }
});

test("unknown client mutation reconciliation is read-only and clears only authoritative outcomes", async () => {
  const restore = installStorage();
  const previousFetch = globalThis.fetch;
  try {
    scope("connection-a", "usr_user1");
    const token = "d2719d26-743e-4f7f-8cb0-55c3e5ad5d7b";
    stageLocalMutationIntent("s", "turn-submit", token);
    globalThis.fetch = async () => new Response(JSON.stringify({ state: "unknown" }), { status: 200 });
    assert.equal(await reconcileLocalMutationIntent("s"), "unknown");
    assert.equal(loadLocalMutationIntent("s")?.operationId, token);
    globalThis.fetch = async () => new Response(JSON.stringify({ state: "confirmed" }), { status: 200 });
    assert.equal(await reconcileLocalMutationIntent("s"), "applied");
    assert.equal(loadLocalMutationIntent("s"), null);
  } finally {
    globalThis.fetch = previousFetch;
    restore();
  }
});

test("fenced and in-flight absent mutations remain unknown until authoritative evidence", async () => {
  const restore = installStorage();
  const previousFetch = globalThis.fetch;
  try {
    scope("connection-a", "usr_user1");
    const neverToken = "c2719d26-743e-4f7f-8cb0-55c3e5ad5d7b";
    stageLocalMutationIntent("s", "turn-submit", neverToken);
    globalThis.fetch = async () => new Response(JSON.stringify({ state: "absent" }), { status: 200 });
    assert.equal(await reconcileLocalMutationIntent("s"), "not-applied");
    assert.equal(loadLocalMutationIntent("s"), null);

    const fencedToken = "e2719d26-743e-4f7f-8cb0-55c3e5ad5d7b";
    const fenced = stageLocalMutationIntent("s", "turn-submit", fencedToken);
    markLocalMutationUnknown("s", fenced);
    globalThis.fetch = async () => new Response(JSON.stringify({ state: "fenced" }), { status: 200 });
    assert.equal(await reconcileLocalMutationIntent("s"), "unknown");
    assert.equal(loadLocalMutationIntent("s")?.operationId, fencedToken);

    const absentToken = "f2719d26-743e-4f7f-8cb0-55c3e5ad5d7b";
    const absent = stageLocalMutationIntent("s", "turn-submit", absentToken);
    markLocalMutationUnknown("s", absent);
    globalThis.fetch = async () => new Response(JSON.stringify({ state: "absent" }), { status: 200 });
    assert.equal(await reconcileLocalMutationIntent("s"), "unknown");
    assert.equal(loadLocalMutationIntent("s")?.operationId, absentToken);

    globalThis.fetch = async () => new Response(JSON.stringify({ state: "not-applied" }), { status: 200 });
    assert.equal(await reconcileLocalMutationIntent("s"), "not-applied");
    assert.equal(loadLocalMutationIntent("s"), null);
  } finally {
    globalThis.fetch = previousFetch;
    restore();
  }
});

test("a direct prompt persists unknown before its POST can leave the client", async () => {
  const restore = installStorage();
  const previousFetch = globalThis.fetch;
  const persisted = new Map<string, string>();
  const remote: AsyncKeyValueStore = {
    get: async (key) => persisted.get(key) ?? null,
    set: async (key, value) => { persisted.set(key, value); },
    remove: async (key) => { persisted.delete(key); },
  };
  let releasePost: (() => void) | undefined;
  let postStarted = false;
  try {
    scope("connection-a", "usr_user1");
    setClientPersistenceBackend(remote);
    globalThis.fetch = async (_input, init) => {
      if (init?.method === "POST") {
        postStarted = true;
        await new Promise<void>((resolve) => { releasePost = resolve; });
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response(JSON.stringify({ state: "absent" }), { status: 200 });
    };
    const sending = submitDirectPrompt("s", { text: "exactly once" });
    while (!postStarted) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(loadLocalMutationIntent("s")?.state, "unknown");
    assert.equal((JSON.parse([...persisted.values()][0] ?? "null") as { state?: string } | null)?.state, "unknown");
    assert.equal(await reconcileLocalMutationIntent("s"), "unknown");
    assert.equal(loadLocalMutationIntent("s")?.state, "unknown");
    releasePost!();
    await sending;
    await flushClientPersistence();
    assert.equal(loadLocalMutationIntent("s"), null);
    assert.equal(persisted.size, 0);
  } finally {
    releasePost?.();
    globalThis.fetch = previousFetch;
    setClientPersistenceBackend(null);
    restore();
  }
});

test("a captured prompt scope cannot transmit after a server/account switch", async () => {
  const restore = installStorage();
  const previousFetch = globalThis.fetch;
  let transmissions = 0;
  try {
    scope("connection-a", "usr_user1");
    const captured = clientPersistenceScope({ sessionId: "s" });
    scope("connection-b", "usr_user2");
    globalThis.fetch = async () => {
      transmissions += 1;
      return new Response("{}", { status: 200 });
    };
    await assert.rejects(
      () => submitDirectPrompt("s", { text: "must stay on A" }, captured),
      (error: Error & { code?: string }) => error.code === "client-context-changed",
    );
    assert.equal(transmissions, 0);
    scope("connection-a", "usr_user1");
    assert.equal(loadLocalMutationIntent("s")?.state, "never-transmitted");
  } finally {
    globalThis.fetch = previousFetch;
    setClientPersistenceBackend(null);
    restore();
  }
});

test("a scope switch during native intent persistence cannot transmit to the new server", async () => {
  const restore = installStorage();
  const previousFetch = globalThis.fetch;
  let releaseUnknownWrite: (() => void) | undefined;
  let writes = 0;
  let transmissions = 0;
  const remote: AsyncKeyValueStore = {
    get: async () => null,
    set: async () => {
      writes += 1;
      if (writes === 2) await new Promise<void>((resolve) => { releaseUnknownWrite = resolve; });
    },
    remove: async () => undefined,
  };
  try {
    scope("connection-a", "usr_user1");
    setClientPersistenceBackend(remote);
    globalThis.fetch = async () => {
      transmissions += 1;
      return new Response("{}", { status: 200 });
    };
    const sending = submitDirectPrompt("s", { text: "must stay on A" });
    while (!releaseUnknownWrite) await new Promise((resolve) => setTimeout(resolve, 0));
    scope("connection-b", "usr_user2");
    releaseUnknownWrite();
    await assert.rejects(
      () => sending,
      (error: Error & { code?: string }) => error.code === "client-context-changed",
    );
    assert.equal(transmissions, 0);
  } finally {
    releaseUnknownWrite?.();
    globalThis.fetch = previousFetch;
    setClientPersistenceBackend(null);
    restore();
  }
});

test("a stalled native draft read cannot fail the session open, and is asked again next time", async () => {
  const restore = installStorage();
  const warn = console.warn;
  let reads = 0;
  try {
    scope("draft-deadline", "usr_user1");
    setClientPersistenceBackend({
      async get() {
        reads++;
        // What WebKit rejects with once the read's deadline aborts it.
        if (reads === 1) throw new DOMException("Fetch is aborted", "AbortError");
        return null;
      },
      async set() {},
      async remove() {},
    });
    console.warn = () => {};
    await hydrateComposerDraft("s-deadline");
    assert.equal(reads, 1, "one read per hydration");
    await hydrateComposerDraft("s-deadline");
    assert.equal(reads, 2, "a failed read is not cached as an empty draft");
  } finally {
    console.warn = warn;
    setClientPersistenceBackend(null);
    restore();
  }
});
