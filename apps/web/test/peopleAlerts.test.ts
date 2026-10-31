// How a person's new message or mention reaches its reader: nothing while they
// read that chat, a banner while Polyth is on screen elsewhere, the chosen OS
// alert otherwise. Pure routing; notify.ts performs it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  addToThread,
  isPeopleKind,
  peopleNotificationTag,
  planPeopleAlert,
  recordAuthor,
  recordChat,
  THREAD_LINES,
  type PeopleAlertContext,
} from "../src/peopleAlerts.ts";
import { conversationUnread, unreadBadgeText } from "../src/sessionPeople.ts";

const base: PeopleAlertContext = {
  activeSessionId: "chat-a",
  visible: true,
  kinds: new Set(["mention", "message"]),
  osAlerts: true,
  onlyWhenHidden: true,
  sound: true,
};

test("reading that very chat on screen marks the message seen and alerts nothing", () => {
  assert.deepEqual(planPeopleAlert({ kind: "message", sessionId: "chat-a" }, base), { seen: true });
  assert.deepEqual(planPeopleAlert({ kind: "mention", sessionId: "chat-a" }, base), { seen: true });
});

test("on screen in another chat: a banner and the chosen sound; the OS alert waits for the background", () => {
  assert.deepEqual(planPeopleAlert({ kind: "message", sessionId: "chat-b" }, base), { seen: false, banner: true, os: false, sound: true });
  // With "only in the background" off, the OS alert joins the banner.
  assert.deepEqual(
    planPeopleAlert({ kind: "message", sessionId: "chat-b" }, { ...base, onlyWhenHidden: false }),
    { seen: false, banner: true, os: true, sound: true },
  );
});

test("hidden: the OS alert only, even for the chat that was open", () => {
  for (const sessionId of ["chat-a", "chat-b"]) {
    assert.deepEqual(
      planPeopleAlert({ kind: "mention", sessionId }, { ...base, visible: false }),
      { seen: false, banner: false, os: true, sound: false },
    );
  }
});

test("a kind the person switched off keeps the banner but no OS alert or sound; OS alerts off means none", () => {
  const noMessages = { ...base, kinds: new Set(["mention"]), onlyWhenHidden: false };
  assert.deepEqual(planPeopleAlert({ kind: "message", sessionId: "chat-b" }, noMessages), { seen: false, banner: true, os: false, sound: false });
  assert.deepEqual(
    planPeopleAlert({ kind: "message", sessionId: "chat-b" }, { ...base, visible: false, osAlerts: false }),
    { seen: false, banner: false, os: false, sound: false },
  );
});

test("agent notification kinds are not people alerts", () => {
  for (const kind of ["completed", "failed", "question", "permission", "subagent"]) {
    assert.equal(isPeopleKind(kind), false);
    assert.equal(planPeopleAlert({ kind, sessionId: "chat-b" }, base), null);
  }
});

test("one notification tag per chat, shared with the service worker's push copy", () => {
  assert.equal(peopleNotificationTag("sess_1"), "polyth-people-sess_1");
});

test("only a conversation counts unread messages in the navigator", () => {
  assert.equal(conversationUnread({ purpose: "conversation", attention: { unread: 3 } }), 3);
  assert.equal(conversationUnread({ attention: { unread: 3 } }), 0);
  assert.equal(conversationUnread({ purpose: "conversation" }), 0);
  assert.equal(unreadBadgeText(7), "7");
  assert.equal(unreadBadgeText(140), "99+");
});

test("people notification rows are accepted live over the socket", async () => {
  const { isSyncInbound } = await import("../src/sync.ts");
  const row = (kind: string) => ({
    type: "notification/added",
    notification: {
      id: `n-${kind}`, key: `person-message:s1:4:${kind}`, kind, sessionId: "s1", projectId: "p1",
      title: "Bea · Small talk", body: "what's up?", ts: 1, read: false,
    },
  });
  // Rejecting these once dropped every live people notification silently.
  assert.equal(isSyncInbound(row("message")), true);
  assert.equal(isSyncInbound(row("mention")), true);
  assert.equal(isSyncInbound(row("completed")), true);
  assert.equal(isSyncInbound(row("nonsense")), false);
});

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, kind: "message" as const, title: "Ann · Weekend", body: `text ${id}`, ts: Number(id.replace(/\D/g, "")) || 1,
  author: { userId: "usr_ann", name: "Ann" }, chat: "Weekend", ...over,
});

test("a burst in one chat is one thread: the newest lines, the full count, a mention that sticks", () => {
  let thread = addToThread(undefined, row("r1"));
  thread = addToThread(thread, row("r2", { kind: "mention", author: { userId: "usr_max", name: "Max" } }));
  thread = addToThread(thread, row("r3"));
  thread = addToThread(thread, row("r4"));
  assert.equal(thread.count, 4);
  assert.equal(thread.lines.length, THREAD_LINES);
  assert.deepEqual(thread.lines.map((line) => line.id), ["r2", "r3", "r4"]);
  assert.equal(thread.lines[0]!.author?.name, "Max");
  // The mention line scrolls out; the card still says the reader was mentioned.
  thread = addToThread(thread, row("r5"));
  assert.equal(thread.lines.some((line) => line.mention), false);
  assert.equal(thread.mention, true);
  // A replayed row (WS + REST race) changes nothing.
  assert.equal(addToThread(thread, row("r5")), thread);
});

test("the author and chat come from the row; malformed authors are dropped, old rows parse the title", () => {
  assert.deepEqual(recordAuthor(row("r1")), { userId: "usr_ann", name: "Ann" });
  assert.deepEqual(recordAuthor(row("r1", { author: { userId: "usr_x", name: "  " } })), { userId: "usr_x", name: "usr_x" });
  assert.equal(recordAuthor(row("r1", { author: { userId: "", name: "Ann" } })), null);
  assert.equal(recordAuthor(row("r1", { author: "Ann" })), null);
  assert.equal(recordChat(row("r1")), "Weekend");
  assert.equal(recordChat(row("r1", { chat: undefined, title: "Ann mentioned you · Release · planning" })), "planning");
  assert.equal(recordChat(row("r1", { chat: undefined, title: "Weekend" })), "Weekend");
});
