// `@` chat references: the picker's Chats group and the timeline chip.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ChatMentionCandidateDto, SessionProjection } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom, document: dom.document, location: dom.location, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
  getComputedStyle: dom.getComputedStyle, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");

const chats: ChatMentionCandidateDto[] = [
  { sessionId: "s-old", title: "Billing import", updatedAt: 10 },
  { sessionId: "s-new", title: "Billing export", updatedAt: 20 },
  { sessionId: "s-other", title: "Garden", updatedAt: 30 },
];

const { chatMentionOptions, mentionAndFileAutocomplete, groupAutocompleteOptions } = await import("../src/composer/discovery.ts");
const { setSessions } = await import("../src/store.ts");
const { SessionChatChip, renderMarkdown } = await import("../src/markdown/render.tsx");
const { tr } = await import("../src/i18n/index.ts");

test("the picker lists chats newest first, matched by title, as the exact message token", () => {
  assert.deepEqual(chatMentionOptions(chats, "").map((o) => o.chat?.sessionId), ["s-other", "s-new", "s-old"]);
  const hits = chatMentionOptions(chats, "BILLING");
  assert.deepEqual(hits.map((o) => o.chat?.sessionId), ["s-new", "s-old"]);
  assert.equal(hits[0]!.value, "[@Billing export](polyth://session/s-new) ");
  assert.equal(hits[0]!.presentation?.groupId, "chats");
});

test("Chats sit between People and Files in the one @ picker", () => {
  const view = mentionAndFileAutocomplete(
    [{ userId: "u1", name: "Bill", access: "view" }], "bill", "done", [{ path: "bill.ts", kind: "file" }], [], chats,
  );
  const groups = groupAutocompleteOptions(view.options);
  assert.deepEqual(groups.map((g) => g.id), ["people", "chats", "files"]);
  assert.equal(groups[1]!.label, tr("composer.chats.group"));
  // Nothing offered (a new chat has no chats list): files alone, as before.
  assert.deepEqual(mentionAndFileAutocomplete([], "zz", "done", [], [], []).options, []);
});

const row = (id: string, title: string): SessionProjection =>
  ({ id, projectId: "p", title, status: "idle", createdAt: 1, updatedAt: 1 }) as SessionProjection;

async function mount(node: unknown): Promise<HTMLElement> {
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => { root.render(node as never); });
  return container;
}

test("a viewer who can open the chat sees its live title as a button; anyone else a plain \"a chat\"", async () => {
  setSessions("p", [row("s-ok", "Live title")]);
  const allowed = await mount(createElement(SessionChatChip, { sessionId: "s-ok" }));
  const button = allowed.querySelector("button.chat-mention");
  assert.equal(button?.textContent, "Live title");
  const denied = await mount(createElement(SessionChatChip, { sessionId: "s-hidden" }));
  assert.equal(denied.innerHTML, `<span class="chat-mention chat-mention-plain">${tr("timeline.chatMention.unavailable")}</span>`);
});

test("a token in message text renders the chip and never the embedded label for a viewer who cannot open it", async () => {
  setSessions("p", [row("s-ok", "Live title")]);
  const box = await mount(createElement("div", null, renderMarkdown(
    "see [@Stale label](polyth://session/s-ok) and [@Secret plans](polyth://session/s-hidden)", "m1", {},
  )));
  assert.match(box.innerHTML, />Live title</);
  assert.ok(!box.innerHTML.includes("Stale label") && !box.innerHTML.includes("Secret plans"));
  assert.ok(box.innerHTML.includes(tr("timeline.chatMention.unavailable")));
});

test("malformed or unknown-scheme links still render as before", async () => {
  const box = await mount(createElement("div", null, renderMarkdown(
    "[a](polyth://session/) [b](polyth://file/x) [c](https://example.com)", "m2", {},
  )));
  assert.ok(!box.innerHTML.includes("chat-mention"));
  assert.match(box.innerHTML, /href="https:\/\/example.com"/);
});
