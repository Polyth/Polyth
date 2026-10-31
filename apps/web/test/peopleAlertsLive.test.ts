// The live side of people alerts: a `notification/added` row for the chat the
// person is reading is marked seen (no banner); one for another chat raises a
// single messenger card per chat that collects the burst; a replay of the
// same row never alerts twice; a reply from the card posts a person message
// and marks the chat read; opening the chat clears its card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { NotificationRecord } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  location: dom.location,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });

const reads: string[][] = [];
const posted: Array<{ url: string; body: { text?: string; clientOperationId?: string } }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/person-messages") && init?.method === "POST" && typeof init.body === "string") {
    posted.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ seq: 9, mentions: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes("/api/notifications") && init?.method === "POST" && typeof init.body === "string") {
    const ids = (JSON.parse(init.body) as { ids?: string[] }).ids;
    if (ids) reads.push(ids);
  }
  return new Response(JSON.stringify({ updated: 1, unread: 0, items: [] }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

register("./tsxHooks.mjs", import.meta.url);
const { alertPersonMessage, installNotify } = await import("../src/notify.ts");
const { getNotifications, resetNotifications } = await import("../src/notify/store.ts");
const { notificationCentre } = await import("../src/notificationCentre.ts");
const { activateProject, activateSession, setSessions } = await import("../src/store.ts");

const row = (id: string, sessionId: string, kind: NotificationRecord["kind"] = "message"): NotificationRecord => ({
  id, key: `person-message:${sessionId}:${id}:${kind}`, kind, sessionId, projectId: "family",
  title: "Bea · Small talk", body: "what's up?", ts: Date.now(), read: false,
  author: { userId: "usr_bea", name: "Bea" }, chat: "Small talk",
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

installNotify();
setSessions("family", [
  { id: "chat-a", projectId: "family", title: "Small talk", status: "idle", purpose: "conversation", createdAt: 1, updatedAt: 1 },
  { id: "chat-b", projectId: "family", title: "Plans", status: "idle", purpose: "conversation", createdAt: 1, updatedAt: 1 },
]);
activateProject("family");
activateSession("chat-a");

test("a message in the chat being read is marked seen and raises no banner", async () => {
  resetNotifications();
  reads.length = 0;
  const record = row("n1", "chat-a");
  notificationCentre.append(record);
  alertPersonMessage(record);
  await settle();
  assert.equal(getNotifications().items.length, 0);
  assert.ok(reads.some((ids) => ids.includes("n1")), "the inbox row is marked read");
});

test("a message in another chat raises one card per chat that collects the burst", async () => {
  resetNotifications();
  const first = row("n2", "chat-b");
  notificationCentre.append(first);
  alertPersonMessage(first);
  alertPersonMessage(first); // a replay never alerts twice
  const second: NotificationRecord = {
    ...row("n3", "chat-b", "mention"), title: "Cy mentioned you · Plans", body: "@Ann lunch?",
    author: { userId: "usr_cy", name: "Cy" }, chat: "Plans",
  };
  notificationCentre.append(second);
  alertPersonMessage(second);
  const banners = getNotifications().items;
  assert.equal(banners.length, 1, "a burst updates the chat's one card");
  assert.equal(banners[0]!.id, "people:chat-b");
  assert.equal(banners[0]!.kind, "mention");
  assert.equal(banners[0]!.title, "Cy mentioned you · Plans", "what a screen reader hears");
  const notice = banners[0]!.conversation!;
  assert.equal(notice.sessionId, "chat-b");
  assert.equal(notice.chat, "Plans");
  assert.equal(notice.count, 2);
  assert.equal(notice.mention, true);
  assert.deepEqual(notice.lines.map((line) => [line.author?.name, line.text, line.mention]), [
    ["Bea", "what's up?", false],
    ["Cy", "@Ann lunch?", true],
  ]);
  assert.equal(typeof notice.reply, "function");
});

test("a reply from the card posts a person message to that chat and marks it read", async () => {
  reads.length = 0;
  posted.length = 0;
  await getNotifications().items[0]!.conversation!.reply!("On my way");
  await settle();
  assert.equal(posted.length, 1);
  assert.match(posted[0]!.url, /\/api\/sessions\/chat-b\/person-messages$/);
  assert.equal(posted[0]!.body.text, "On my way");
  assert.equal(typeof posted[0]!.body.clientOperationId, "string", "a retry stays idempotent");
  const marked = reads.flat();
  assert.ok(marked.includes("n2") && marked.includes("n3"), `marked ${marked.join(",")}`);
});

test("opening the chat clears its card and marks its unread people rows read", async () => {
  const third = row("n4", "chat-b");
  notificationCentre.append(third);
  alertPersonMessage(third);
  assert.equal(getNotifications().items.some((item) => item.id === "people:chat-b"), true);
  reads.length = 0;
  activateSession("chat-b");
  await settle();
  assert.equal(getNotifications().items.some((item) => item.id === "people:chat-b"), false);
  const marked = reads.flat();
  assert.ok(marked.includes("n4"), `marked ${marked.join(",")}`);
});
