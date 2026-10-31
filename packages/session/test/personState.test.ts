// Each person's own view of a shared session (v21): read cursor, draft, pin,
// who queued a message, and personal composer recall.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionProjection } from "@polyth/contracts";
import { createStore } from "../src/index.ts";

const tmpStore = () => createStore(join(mkdtempSync(join(tmpdir(), "polyth-person-")), "s.db"));

const proj = (id: string): SessionProjection => ({
  id, projectId: "p", spaceId: "sp", title: id, status: "idle", createdAt: 1, updatedAt: 1,
});

test("unread counts follow each person's own cursor, else the shared pre-upgrade one", async () => {
  const store = tmpStore();
  try {
    await store.upsertProjection(proj("s"));
    const first = await store.append("s", "assistant/message", { text: "one" });
    await store.append("s", "assistant/message", { text: "two" });
    const third = await store.append("s", "assistant/message", { text: "three" });

    // Nobody has a cursor yet: everything counts as read, as before v21.
    assert.deepEqual(store.unreadFor(["s"], "usr_ann"), {});
    // The shared pre-upgrade cursor applies to everyone without their own.
    await store.setReadCursor("s", first.seq);
    assert.deepEqual(store.unreadFor(["s"], "usr_ann"), { s: 2 });
    assert.deepEqual(store.unreadFor(["s"], "usr_bea"), { s: 2 });

    assert.equal(await store.setPersonReadCursor("s", "usr_ann", third.seq), true);
    assert.equal(await store.setPersonReadCursor("s", "usr_ann", first.seq), false, "cursors never move back");
    assert.deepEqual(store.unreadFor(["s"], "usr_ann"), {});
    assert.deepEqual(store.unreadFor(["s"], "usr_bea"), { s: 2 });
    assert.equal((await store.attentionFor(["s"], "usr_ann")).s?.unread, 0);
    assert.equal((await store.attentionFor(["s"], "usr_bea")).s?.unread, 2);

    // The navigator's "needs attention" filter reads the same per-person cursor.
    const attention = async (personId: string) =>
      (await store.summaries!({ spaceId: "sp", attentionOnly: true, personId })).sessions.map((row) => row.id);
    assert.deepEqual(await attention("usr_ann"), []);
    assert.deepEqual(await attention("usr_bea"), ["s"]);
  } finally { await store.close(); }
});

test("drafts and pins are stored per person and only once chosen", async () => {
  const store = tmpStore();
  try {
    await store.upsertProjection(proj("s"));
    assert.deepEqual(store.personStates(["s"], "usr_ann"), {});
    await store.savePersonDraft("s", "usr_ann", "Ann's idea", 10);
    await store.setPersonPin("s", "usr_bea", { position: 4 });
    assert.deepEqual(store.personStates(["s"], "usr_ann"), { s: { draft: "Ann's idea", draftUpdatedAt: 10 } });
    assert.deepEqual(store.personStates(["s"], "usr_bea"), { s: { pinned: { position: 4 } } });

    // A clear keeps its stamp (the ordering witness); an unpin is recorded.
    await store.savePersonDraft("s", "usr_ann", "", 11);
    await store.setPersonPin("s", "usr_bea", null);
    assert.deepEqual(store.personStates(["s"], "usr_ann"), { s: { draftUpdatedAt: 11 } });
    assert.deepEqual(store.personStates(["s"], "usr_bea"), { s: { pinned: null } });

    await store.deleteSession("s");
    assert.deepEqual(store.personStates(["s"], "usr_ann"), {});
  } finally { await store.close(); }
});

test("mention and mute state is per person, monotonic, and released with the session", async () => {
  const store = tmpStore();
  try {
    await store.upsertProjection(proj("s"));
    assert.deepEqual(store.personStates(["s"], "usr_bea"), {});
    await store.setPersonMentionSeq("s", "usr_bea", 5);
    // A slower retry can never move the mention cursor backwards.
    await store.setPersonMentionSeq("s", "usr_bea", 3);
    await store.setPersonMute("s", "usr_bea", true);
    assert.deepEqual(store.personStates(["s"], "usr_bea"), { s: { lastMentionSeq: 5, muted: true } });
    await store.setPersonMute("s", "usr_bea", false);
    assert.deepEqual(store.personStates(["s"], "usr_bea"), { s: { lastMentionSeq: 5, muted: false } });
    await store.setPersonReadCursor("s", "usr_bea", 5);
    assert.deepEqual(store.personStates(["s"], "usr_bea").s?.readSeq, 5);
    await store.deleteSession("s");
    assert.deepEqual(store.personStates(["s"], "usr_bea"), {});
  } finally { await store.close(); }
});

test("the pinned catalog filter returns each person's pins, however old, past the recency page", async () => {
  const store = tmpStore();
  try {
    // Sixty newer chats push the two pinned ones far past a 50-row page.
    await store.upsertProjection({ ...proj("own-pin"), updatedAt: 1 });
    await store.upsertProjection({ ...proj("legacy-pin"), updatedAt: 2, pinned: { position: 0 } });
    for (let i = 0; i < 60; i++) await store.upsertProjection({ ...proj(`new-${i}`), updatedAt: 100 + i });
    await store.setPersonPin("own-pin", "usr_ann", { position: 1 });
    await store.setPersonPin("legacy-pin", "usr_bea", null);

    const recent = await store.summaries!({ spaceId: "sp", projectId: "p", limit: 50 });
    assert.equal(recent.sessions.some((row) => row.id === "own-pin" || row.id === "legacy-pin"), false);

    const pinned = async (personId?: string) =>
      (await store.summaries!({ spaceId: "sp", projectId: "p", pinned: true, ...(personId ? { personId } : {}) }))
        .sessions.map((row) => row.id).sort();
    // Ann's own pin plus the shared pre-v21 pin she never changed.
    assert.deepEqual(await pinned("usr_ann"), ["legacy-pin", "own-pin"]);
    // Bea explicitly unpinned the shared one.
    assert.deepEqual(await pinned("usr_bea"), []);
    // Without a person only the shared pin counts.
    assert.deepEqual(await pinned(), ["legacy-pin"]);
  } finally { await store.close(); }
});

test("a queued message remembers who queued it; malformed authors are dropped", async () => {
  const store = tmpStore();
  try {
    await store.upsertProjection(proj("s"));
    const queued = await store.enqueue("s", "later", "queue", undefined, undefined, undefined, undefined, undefined,
      { userId: "usr_bea", name: "Bea", extra: "dropped" } as never);
    assert.deepEqual(queued.item.author, { userId: "usr_bea", name: "Bea" });
    const forged = await store.enqueue("s", "odd", "queue", undefined, undefined, undefined, undefined, undefined,
      { name: "no id" } as never);
    assert.equal(forged.item.author, undefined);
    assert.deepEqual((await store.queueList("s")).map((item) => item.author?.userId), ["usr_bea", undefined]);
  } finally { await store.close(); }
});

test("composer recall returns only the person's own prompts and older unauthored ones", async () => {
  const store = tmpStore();
  try {
    await store.upsertProjection(proj("s"));
    await store.append("s", "user/message", { text: "from before authorship" });
    await store.append("s", "user/message", { text: "Ann asks", author: { userId: "usr_ann" } });
    await store.append("s", "user/message", { text: "Bea asks", author: { userId: "usr_bea" } });
    const recall = async (personId?: string) =>
      (await store.listPromptHistory({ spaceId: "sp", limit: 20, ...(personId ? { personId } : {}) }))
        .map((entry) => entry.text);
    assert.deepEqual(await recall("usr_ann"), ["from before authorship", "Ann asks"]);
    assert.deepEqual(await recall("usr_bea"), ["from before authorship", "Bea asks"]);
    assert.deepEqual(await recall(), ["from before authorship", "Ann asks", "Bea asks"]);
  } finally { await store.close(); }
});

test("composer recall skips prompts from chats the reader cannot open", async () => {
  const store = tmpStore();
  try {
    await store.upsertProjection(proj("open"));
    await store.upsertProjection(proj("closed"));
    await store.append("open", "user/message", { text: "shared old prompt" });
    await store.append("closed", "user/message", { text: "private old prompt" });
    const checked: string[] = [];
    const entries = await store.listPromptHistory({
      spaceId: "sp",
      limit: 20,
      personId: "usr_ann",
      visible: (sessionId) => { checked.push(sessionId); return sessionId === "open"; },
    });
    assert.deepEqual(entries.map((entry) => entry.text), ["shared old prompt"]);
    assert.deepEqual(checked.sort(), ["closed", "open"], "each chat is checked once");
  } finally { await store.close(); }
});
