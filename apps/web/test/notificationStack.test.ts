// The mounted notification stack: one card per record, newest first, one
// announcement per new notification (never per patch), the visible cap and its
// "+N more" control, dismissal by button and Escape, actions, pause while
// focused, and the store's transient error drawn through it.
// Assertions compare strings/booleans only — never DOM nodes (a failing
// assert.equal on a node can exhaust memory while it is formatted).
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: NotificationStack } = await import("../src/notify/NotificationStack.tsx");
const notifyStore = await import("../src/notify/store.ts");
const { ErrorBanner } = await import("../src/components/ConnectionFeedback.tsx");
const store = await import("../src/store.ts");
const { tr } = await import("../src/i18n/index.ts");

const { notify, getNotifications, resetNotifications } = notifyStore;

async function mount(extra?: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement("div", null, createElement(NotificationStack), extra ?? null)); });
  return {
    cards: () => [...document.querySelectorAll<HTMLElement>(".notify-card:not([data-exit-ghost])")],
    async unmount() {
      await act(async () => { root.unmount(); });
      container.remove();
      resetNotifications();
    },
  };
}

const show = (input: Parameters<typeof notify>[0]) => act(async () => { notify(input); });

test("kinds render as one standard card, newest first; cards are labelled groups, not live regions", async () => {
  const view = await mount();
  try {
    assert.equal(document.querySelector(".notify-stack")?.getAttribute("role"), null, "an empty stack is no landmark");
    await show({ id: "ok", kind: "success", title: "Saved", body: "All three files", data: { source: "test" } });
    await show({ id: "bad", kind: "error", title: "Couldn’t send", excerpt: "line 1\nline 2" });
    const cards = view.cards();
    assert.deepEqual(cards.map((card) => card.getAttribute("data-kind")), ["error", "success"], "newest nearest the edge");
    assert.deepEqual(cards.map((card) => card.getAttribute("role")), ["group", "group"]);
    assert.equal(cards[0]!.getAttribute("aria-labelledby"), cards[0]!.querySelector(".notify-title")?.id);
    assert.equal(document.querySelectorAll(".notify-card [aria-live], .notify-card[aria-live]").length, 0);
    assert.equal(cards[1]!.getAttribute("data-source"), "test");
    assert.equal(cards[1]!.querySelector(".notify-title")?.textContent, "Saved");
    assert.equal(cards[1]!.querySelector(".notify-body")?.textContent, "All three files");
    assert.equal(cards[0]!.querySelector(".notify-excerpt")?.textContent, "line 1\nline 2");
    assert.equal(cards[0]!.querySelector(".notify-close")?.getAttribute("aria-label"), tr("notify.dismiss"));
    assert.equal(Boolean(cards[0]!.querySelector(".notify-life")), true, "a timed card shows its lifetime");
    assert.equal(document.querySelector(".notify-stack")?.getAttribute("aria-label"), tr("notify.region"));
    assert.equal(document.querySelector(".notify-stack")?.getAttribute("data-open"), null, "two cards fold into a deck");
    assert.equal(cards[1]!.hasAttribute("data-folded"), true);
  } finally {
    await view.unmount();
  }
});

test("at most three cards show; the rest wait behind a count", async () => {
  const view = await mount();
  try {
    for (let at = 0; at < 5; at++) await show({ id: `n${at}`, kind: "info", title: `N${at}` });
    assert.deepEqual(view.cards().map((card) => card.querySelector(".notify-title")?.textContent), ["N4", "N3", "N2"]);
    const more = document.querySelector<HTMLButtonElement>(".notify-more-open");
    assert.equal(more?.tagName, "BUTTON", "the waiting count is a real control");
    assert.equal(more?.textContent, tr("notify.more", { count: 2 }));
    assert.equal(more?.getAttribute("aria-label"), tr("notify.moreLabel", { count: 2 }));
    assert.equal(document.querySelector(".notify-clear-all"), null, "clear all only past three waiting");
    await act(async () => { more!.click(); });
    assert.equal(document.querySelector(".notify-stack")?.hasAttribute("data-open"), true, "it opens the deck");
    await act(async () => { notifyStore.dismissNotification("n4", "user"); });
    assert.deepEqual(view.cards().map((card) => card.querySelector(".notify-title")?.textContent), ["N3", "N2", "N1"]);

    for (let at = 5; at < 9; at++) await show({ id: `n${at}`, kind: "info", title: `N${at}` });
    const clear = document.querySelector<HTMLButtonElement>(".notify-clear-all");
    assert.equal(clear?.textContent, tr("notify.clearAll"));
    await act(async () => { clear!.click(); });
    assert.equal(getNotifications().items.length, 0);
  } finally {
    await view.unmount();
  }
});

test("close, Escape and actions dismiss as the person; keepOpen actions do not", async () => {
  const view = await mount();
  const reasons: string[] = [];
  const ran: string[] = [];
  try {
    await show({
      id: "u",
      kind: "update",
      title: "Polyth 2 is ready",
      progress: 0.4,
      dismissLabel: "Later",
      onDismiss: (reason) => reasons.push(`u:${reason}`),
      actions: [
        { label: "Restart", primary: true, keepOpen: true, run: () => { ran.push("restart"); } },
        { label: "Notes", run: () => { ran.push("notes"); } },
      ],
    });
    const card = () => view.cards().find((item) => item.getAttribute("data-kind") === "update");
    assert.equal(card()?.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow"), "40");
    const button = (label: string) => [...(card()?.querySelectorAll("button") ?? [])].find((item) => item.textContent === label || item.getAttribute("aria-label") === label);
    assert.equal(button("Restart")?.className.includes("ui-btn--primary"), true);
    await act(async () => { button("Restart")!.click(); });
    assert.deepEqual(ran, ["restart"]);
    assert.equal(Boolean(card()), true, "keepOpen leaves it on screen");
    await act(async () => { button("Notes")!.click(); });
    assert.deepEqual(ran, ["restart", "notes"]);
    assert.equal(Boolean(card()), false);
    assert.deepEqual(reasons, ["u:user"]);

    await show({ id: "esc", kind: "hint", title: "Tip", onDismiss: (reason) => reasons.push(`esc:${reason}`) });
    const tip = view.cards()[0]!;
    await act(async () => {
      tip.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
    });
    assert.deepEqual(reasons, ["u:user", "esc:user"]);

    await show({ id: "fixed", kind: "progress", title: "Indexing", dismissible: false });
    assert.equal(view.cards()[0]!.querySelector(".notify-close"), null, "no close control when it cannot be dismissed");
    assert.equal(Boolean(view.cards()[0]!.querySelector(".ui-spinner")), true, "progress without a value shows activity");
    assert.equal(view.cards()[0]!.hasAttribute("data-owns-swipe"), false);
  } finally {
    await view.unmount();
  }
});

test("focus inside the stack opens the deck and pauses every countdown", async () => {
  const view = await mount();
  try {
    await show({ id: "a", kind: "info", title: "A" });
    await show({ id: "b", kind: "info", title: "B" });
    const close = view.cards()[0]!.querySelector<HTMLElement>(".notify-close")!;
    await act(async () => { close.focus(); });
    assert.equal(getNotifications().paused, true);
    assert.equal(document.querySelector(".notify-stack")?.hasAttribute("data-open"), true);
    await act(async () => { close.blur(); });
    assert.equal(getNotifications().paused, false);
  } finally {
    await view.unmount();
  }
});

test("the store's transient error is an assertive notification; closing it clears the error", async () => {
  const catchUp = { fresh: true, indicator: "hidden" as const, holdNetworkErrors: false };
  const ran: string[] = [];
  const view = await mount(createElement(ErrorBanner, { catchUp }));
  try {
    await act(async () => { store.setUiError("Rename project: name already exists", { label: "Retry", run: () => { ran.push("retry"); } }); });
    const card = view.cards()[0];
    assert.match(document.querySelector(".notify-live[aria-live=assertive]")?.textContent ?? "", /name already exists/, "said assertively");
    assert.equal(card?.getAttribute("data-kind"), "error");
    assert.equal(card?.querySelector(".notify-close")?.getAttribute("aria-label"), tr("app.dismissError"));
    assert.match(card?.textContent ?? "", /name already exists/);

    await act(async () => { store.setUiError("Delete chat: not allowed"); });
    assert.equal(view.cards().length, 1, "a newer error replaces the old one in place");

    await act(async () => { (view.cards()[0]!.querySelector(".notify-close") as HTMLElement).click(); });
    assert.equal(store.getState().uiError, null);
    assert.equal(view.cards().length, 0);

    await act(async () => { store.setUiError("Send: failed", { label: "Retry", run: () => { ran.push("retry"); } }); });
    const retry = [...view.cards()[0]!.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
    await act(async () => { retry.click(); });
    assert.deepEqual(ran, ["retry"]);
    assert.equal(store.getState().uiError, null, "acting on the error ends it");
  } finally {
    await act(async () => { store.clearUiError(); });
    await view.unmount();
  }
});

test("one polite and one assertive region announce each new notification once, never a patch", async () => {
  const view = await mount();
  try {
    const regions = () => [...document.querySelectorAll<HTMLElement>(".notify-live")];
    assert.deepEqual(regions().map((region) => region.getAttribute("aria-live")), ["polite", "assertive"], "mounted before anything shows");
    const polite = () => regions()[0]!.textContent!.replace(/\u00a0$/, "");
    const assertive = () => regions()[1]!.textContent!.replace(/\u00a0$/, "");

    await show({ id: "run", kind: "progress", title: "Build", body: "Running 1s", excerpt: "line 1" });
    assert.equal(polite(), "Build — Running 1s");
    const before = regions()[0]!.textContent;
    await act(async () => { notifyStore.updateNotification("run", { body: "Running 2s", excerpt: "line 2", progress: 0.5 }); });
    assert.equal(regions()[0]!.textContent, before, "a ticking body is not re-read");

    await act(async () => { notifyStore.updateNotification("run", { kind: "success", title: "Build passed", body: "12 s" }); });
    assert.equal(polite(), "Build passed — 12 s", "a kind/title change is news");

    await show({ id: "bad", kind: "error", title: "Couldn’t send", body: createElement("span", null, "Network ", createElement("b", null, "down")) });
    assert.equal(assertive(), "Couldn’t send — Network down", "errors are assertive, as plain text");
    assert.equal(polite(), "Build passed — 12 s");

    const said = regions()[1]!.textContent;
    await show({ id: "bad", kind: "error", title: "Couldn’t send", body: "Network down" });
    assert.notEqual(regions()[1]!.textContent, said, "the same error raised again is said again");
  } finally {
    await view.unmount();
  }
});

test("the same error raised again restarts its card's lifetime", async () => {
  const catchUp = { fresh: true, indicator: "hidden" as const, holdNetworkErrors: false };
  const view = await mount(createElement(ErrorBanner, { catchUp }));
  try {
    await act(async () => { store.setUiError("Send: failed"); });
    const life = getNotifications().items[0]!.life;
    await act(async () => { store.setUiError("Send: failed"); });
    assert.equal(view.cards().length, 1);
    assert.equal(getNotifications().items[0]!.life, life + 1, "re-notified, so the countdown starts over");

    await act(async () => { store.setUiError("Nothing to compact yet", null, undefined, "info"); });
    assert.equal(view.cards()[0]!.getAttribute("data-kind"), "info", "a calm word is no error");
  } finally {
    await act(async () => { store.clearUiError(); });
    await view.unmount();
  }
});

test("a person's message is a messenger card: who and where, the newest voices in colour, a reply in place", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ items: [] }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof fetch;
  const view = await mount();
  const replies: string[] = [];
  let opened = 0;
  try {
    const now = Date.now();
    await show({
      id: "people:chat-b", kind: "mention", title: "Olena mentioned you · Release", body: "@Ines docs?",
      conversation: {
        sessionId: "chat-b", chat: "Release", count: 4, mention: true,
        lines: [
          { id: "r1", author: { userId: "usr_max", name: "Max Petrenko" }, text: "Build is green", mention: false, ts: now },
          { id: "r2", author: { userId: "usr_olena", name: "Olena Bondar" }, text: "@Ines docs?", mention: true, ts: now },
        ],
        open: () => { opened++; },
        reply: async (text) => { replies.push(text); },
      },
    });
    const card = view.cards()[0]!;
    assert.equal(card.hasAttribute("data-conversation"), true);
    assert.equal(card.getAttribute("aria-labelledby"), card.querySelector(".notify-conversation-title")?.id);
    // Two voices: the chat is the title, each line names its author in colour.
    assert.equal(card.querySelector(".notify-conversation-title")?.textContent, "Release");
    assert.equal(card.querySelector(".notify-conversation-mentioned")?.textContent, tr("notify.people.mentionedYou"));
    assert.equal(card.querySelector(".notify-conversation-where")?.textContent?.includes(tr("notify.people.newMessages", { count: 4 })), true);
    assert.equal(card.querySelector(".notify-conversation-earlier")?.textContent, tr("notify.people.earlier", { count: 2 }));
    const who = [...card.querySelectorAll(".notify-conversation-who")];
    assert.deepEqual(who.map((node) => node.textContent), ["Max Petrenko", "Olena Bondar"]);
    const tones = who.map((node) => node.getAttribute("data-person-tone"));
    assert.notEqual(tones[0], tones[1], "two people never share a colour");
    // The avatar is the newest sender's, in her colour, with the mention mark.
    const mark = card.querySelector(".notify-conversation-mark");
    assert.equal(mark?.textContent, "OB");
    assert.equal(mark?.getAttribute("data-person-tone"), tones[1]);
    assert.equal(Boolean(card.querySelector(".notify-conversation-badge")), true);
    assert.equal(card.querySelector(".notify-conversation-open")?.getAttribute("aria-label"), tr("notify.people.open", { chat: "Release" }));

    // Reply in place: the send wakes with words, the card says it went.
    const input = card.querySelector<HTMLInputElement>(".notify-reply-input")!;
    assert.equal(input.getAttribute("placeholder"), tr("notify.people.replyInChat", { chat: "Release" }));
    assert.equal(card.querySelector(".notify-reply-send")?.hasAttribute("disabled"), true);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
      setter.call(input, "Posting it now");
      input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    });
    assert.equal(getNotifications().items[0]!.duration, "sticky", "a started reply keeps the card");
    // The chat's next message replaces the record (with a countdown): the
    // draft still holds the card and keeps its words.
    const current = getNotifications().items[0]!;
    await show({ id: current.id, kind: current.kind, title: current.title, body: current.body, conversation: { ...current.conversation!, count: 5 } });
    assert.equal(getNotifications().items[0]!.duration, "sticky", "a new message does not start the clock under a draft");
    assert.equal(card.querySelector<HTMLInputElement>(".notify-reply-input")?.value, "Posting it now");
    await act(async () => { card.querySelector<HTMLButtonElement>(".notify-reply-send")!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(replies, ["Posting it now"]);
    assert.equal(card.querySelector(".notify-reply-sent")?.textContent, tr("notify.people.sent"));

    // One sender: their name is the title, the chat under it; the head opens the chat.
    await show({
      id: "people:chat-c", kind: "message", title: "Max Petrenko · Weekend", body: "Hike?",
      conversation: {
        sessionId: "chat-c", chat: "Weekend", count: 1,
        lines: [{ id: "r3", author: { userId: "usr_max", name: "Max Petrenko" }, text: "Hike?", mention: false, ts: now }],
        open: () => { opened++; },
        reply: async () => undefined,
      },
    });
    const single = view.cards()[0]!;
    assert.equal(single.querySelector(".notify-conversation-title")?.textContent, "Max Petrenko");
    assert.equal(single.querySelector(".notify-conversation-chat")?.textContent, "Weekend");
    assert.equal(single.querySelectorAll(".notify-conversation-who").length, 0, "one voice needs no names on its lines");
    assert.equal(single.querySelector<HTMLInputElement>(".notify-reply-input")?.getAttribute("placeholder"), tr("notify.people.replyTo", { name: "Max" }));
    await act(async () => { single.querySelector<HTMLButtonElement>(".notify-conversation-open")!.click(); });
    assert.equal(opened, 1);
    assert.equal(getNotifications().items.some((item) => item.id === "people:chat-c"), false, "opening dismisses the card");
  } finally {
    await view.unmount();
    globalThis.fetch = original;
  }
});
