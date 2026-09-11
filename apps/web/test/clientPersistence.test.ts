import assert from "node:assert/strict";
import { test } from "node:test";
import { addAttachment, pendingAttachmentEntryCountForTest, pendingAttachments } from "../src/attachments.ts";
import { activeBrowserAccountId, setActiveBrowserAccount } from "../src/accountStorage.ts";
import { acceptAuthenticatedBrowserAccount } from "../src/authPrefetch.ts";
import {
  hydrateClientRecord,
  clientPersistenceCacheSizeForTest,
  flushClientPersistence,
  migrateLegacyClientRecord,
  readClientRecord,
  setClientPersistenceBackend,
  type AsyncKeyValueStore,
} from "../src/clientPersistence.ts";
import { loadSeedRecord, saveSeedRecord } from "../src/drafts.ts";
import { loadLocalMutationIntent, markLocalMutationUnknown, reconcileLocalMutationIntent, retainLocalMutationIntentAfterError, stageLocalMutationIntent, submitDirectPrompt } from "../src/mutationIntent.ts";
import {
  acknowledgeDraftRevision, adoptServerDraft, loadScopedDraftRecord, nativeStagedAttachments,
  recordLocalDraftEdit, registerNativeStagedAttachment, removeNativeStagedAttachment,
} from "../src/draftRecord.ts";
import {
  clientPersistenceScope,
  initializeClientReliabilityContext,
  setClientReliabilityContext,
  setClientReliabilityProject,
  setClientReliabilitySpace,
} from "../src/reliabilityContext.ts";
import { activateProject, activateSession, clearNewSessionDraft, hydrateClientNavigation, saveNewSessionDraftText, startNewSession } from "../src/store.ts";
import { loadDraft, saveDraft } from "../src/utils.ts";

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
    assert.equal(older.conflict?.text, "server-old");
    const newer = adoptServerDraft("s", "server-new", 9);
    assert.equal(newer.text, "local-new");
    assert.equal(newer.conflict?.text, "server-new");
    // A newer keystroke makes the previous network acknowledgement stale.
    const second = recordLocalDraftEdit("s", "local-newer");
    assert.equal(acknowledgeDraftRevision("s", first.revision, 10).dirty, true);
    const acknowledged = acknowledgeDraftRevision("s", second.revision, 11);
    assert.equal(acknowledged.dirty, false);
    assert.equal(loadScopedDraftRecord("s").serverUpdatedAt, 11);
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
