// The real By the way web entry, mounted in happy-dom against a fake host: the
// mode and Add-menu item register, a submitted side question shows the card
// thinking then answering, follow-ups collapse, a failure retries, Add to chat
// leaves the mode and inserts Q/A, Esc closes, and disabling cleans up.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { act, createElement, type ReactNode } from "react";
import { Window } from "happy-dom";
import type {
  ComposerAddMenuItem,
  ComposerContributionContext,
  ComposerMode,
  SlotRegistration,
  WebPackageHost,
} from "@polyth/web-sdk";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const dom = new Window({ width: 1280, height: 800, url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
globalThis.matchMedia = ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
})) as typeof matchMedia;

type Reply = { status: number; body: unknown };
const requests: Array<{ url: string; body: unknown }> = [];
const replies: Array<(value: Reply) => void> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "null")) });
  const reply = await new Promise<Reply>((resolve) => replies.push(resolve));
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { createRoot } = await import("react-dom/client");
const { default: entry } = await import("../widgets/index.tsx");

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

test("btw installs, answers on the side, follows up, retries, closes and cleans up", async () => {
  const modes: ComposerMode[] = [];
  const items: ComposerAddMenuItem[] = [];
  const slots: SlotRegistration[] = [];
  const disposed: string[] = [];
  const inserted: string[] = [];
  const setModes: Array<[string | null, string | undefined]> = [];
  let activeMode: string | null = null;
  const composerListeners = new Set<() => void>();
  const sessions: Record<string, unknown> = {
    s1: { id: "s1", title: "Login" },
    c1: { id: "c1", purpose: "conversation" },
    v1: { id: "v1", sharing: { visibility: "space", access: "view", shared: true } },
    k1: { id: "k1", sharing: { visibility: "space", access: "collaborate", shared: true } },
  };
  const host = {
    ui: {
      locale: { get: () => "en", translate: (key: string) => key },
      icons: { copy: () => "copy", close: () => "x", chevronDown: () => "v", refresh: () => "r" },
      components: {
        IconButton: ({ icon: Glyph, label, onClick, disabled }: { icon: () => ReactNode; label: string; onClick?: () => void; disabled?: boolean }) =>
          createElement("button", { type: "button", "aria-label": label, onClick, disabled }, createElement(Glyph)),
        Button: ({ children, onClick, className }: { children?: ReactNode; onClick?: () => void; className?: string }) =>
          createElement("button", { type: "button", onClick, className }, children),
        MarkdownDoc: ({ text }: { text: string }) => createElement("div", { "data-md": "" }, text),
      },
    },
    composer: {
      registerMode: (mode: ComposerMode) => { modes.push(mode); return () => disposed.push(`mode:${mode.id}`); },
      registerAddMenuItem: (item: ComposerAddMenuItem) => { items.push(item); return () => disposed.push(`item:${item.id}`); },
      registerPasteHandler: () => () => {},
      listAddMenuItems: () => items,
      listPasteHandlers: () => [],
      setMode: (modeId: string | null, options?: { sessionId?: string }) => {
        setModes.push([modeId, options?.sessionId]);
        activeMode = modeId;
        for (const listener of composerListeners) listener();
        return true;
      },
      activeMode: () => activeMode,
      subscribe: (listener: () => void) => { composerListeners.add(listener); return () => composerListeners.delete(listener); },
    },
    slots: { register: (slot: SlotRegistration) => { slots.push(slot); return () => disposed.push(`slot:${slot.id}`); } },
    sessions: { get: (id: string) => sessions[id] },
    store: { getSnapshot: () => ({ activeSessionId: "s1" }) },
    conversation: { insert: (text: string) => { inserted.push(text); } },
    errors: { friendly: (action: string) => action, show: () => {} },
  } as unknown as WebPackageHost;

  const uninstall = entry(host)();
  const mode = modes.find((candidate) => candidate.id === "btw")!;
  const item = items.find((candidate) => candidate.id === "btw.ask")!;
  const slot = slots.find((candidate) => candidate.id === "btw.card")!;
  assert.equal(mode.trigger, "/btw");
  assert.equal(typeof mode.label === "function" ? mode.label() : mode.label, "By the way");
  assert.equal(typeof mode.submitLabel === "function" ? mode.submitLabel() : mode.submitLabel, "Ask");
  assert.equal(slot.slot, "session.composer.before");

  const context = (sessionId: string | null): ComposerContributionContext => ({
    projectId: "p", sessionId, draftText: "", openDialog: () => () => {}, close() {}, insertText() {}, error() {},
    setMode: (modeId) => { host.composer!.setMode!(modeId, sessionId ? { sessionId } : {}); },
  });
  assert.equal(mode.isAvailable!(context("s1")), true);
  assert.equal(mode.isAvailable!(context("k1")), true, "a collaborator may ask");
  assert.equal(mode.isAvailable!(context(null)), false, "no chat yet");
  assert.equal(mode.isAvailable!(context("c1")), false, "a people conversation has no agent");
  assert.equal(mode.isAvailable!(context("v1")), false, "a view-only reader cannot ask");
  assert.equal(mode.isAvailable!(context("gone")), false);
  assert.equal(item.isAvailable!(context("s1")), true);
  item.activate(context("s1"));
  assert.deepEqual(setModes.at(-1), ["btw", "s1"], "the Add-menu row enters the mode");
  assert.equal(item.isAvailable!(context("s1")), false, "hidden while already in the mode");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const renderSlot = () => act(async () => { root.render(createElement("div", null, slot.render({ sessionId: "s1" }))); });
  try {
    await renderSlot();
    assert.ok(container.querySelector(".btw-card") === null, "nothing until a question is asked");

    await act(async () => { await mode.submit(context("s1"), "Which file changed?"); });
    await flush();
    assert.ok(container.querySelector(".btw-card[data-state='open']"));
    assert.equal(container.querySelector(".btw-question")?.textContent, "Which file changed?");
    assert.ok(container.querySelector(".btw-thinking"), "thinking while the answer is on its way");
    assert.equal(requests.length, 1);
    assert.match(requests[0]!.url, /\/api\/sessions\/s1\/btw$/);
    assert.deepEqual(requests[0]!.body, { question: "Which file changed?", thread: [] });
    const addToChat = () => container.querySelector<HTMLButtonElement>("button[aria-label='Add to chat']")!;
    assert.equal(addToChat().disabled, true, "nothing to add yet");

    replies.shift()!({ status: 200, body: { answer: "src/login.ts" } });
    await flush();
    assert.equal(container.querySelector(".btw-answer [data-md]")?.textContent, "src/login.ts");
    assert.ok(container.querySelector(".btw-follow-up") === null, "the composer is still in the mode");

    await act(async () => { addToChat().click(); });
    assert.deepEqual(setModes.at(-1), [null, "s1"], "Add to chat leaves the mode first");
    assert.deepEqual(inserted, ["Q: Which file changed?\nA: src/login.ts\n"]);
    await flush();
    const followUp = container.querySelector<HTMLButtonElement>(".btw-follow-up");
    assert.ok(followUp, "outside the mode the card offers a follow-up");
    await act(async () => { followUp.click(); });
    assert.deepEqual(setModes.at(-1), ["btw", "s1"]);

    await act(async () => { await mode.submit(context("s1"), "Why there?"); });
    await flush();
    assert.deepEqual(requests[1]!.body, { question: "Why there?", thread: [{ question: "Which file changed?", answer: "src/login.ts" }] });
    replies.shift()!({ status: 503, body: { error: "unavailable", message: "The model did not answer in time" } });
    await flush();
    const error = container.querySelector(".btw-error");
    assert.ok(error);
    assert.match(error.textContent ?? "", /did not answer in time/);
    const row = container.querySelector<HTMLButtonElement>(".btw-earlier-row");
    assert.equal(row?.getAttribute("aria-expanded"), "false", "the earlier question collapses to one line");
    await act(async () => { row!.click(); });
    assert.equal(container.querySelector(".btw-earlier-answer [data-md]")?.textContent, "src/login.ts");

    await act(async () => { container.querySelector<HTMLButtonElement>(".btw-error button")!.click(); });
    await flush();
    assert.equal(requests.length, 3, "Try again asks once more");
    replies.shift()!({ status: 200, body: { answer: "It owns the form." } });
    await flush();
    assert.equal(container.querySelector(".btw-answer [data-md]")?.textContent, "It owns the form.");

    // Esc inside the card closes it (reduced motion: no exit wait).
    document.documentElement.dataset.reduceAnimations = "true";
    await act(async () => {
      container.querySelector<HTMLElement>(".btw-card")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    assert.ok(container.querySelector(".btw-card") === null, "closed and forgotten");
    assert.deepEqual(setModes.at(-1), [null, "s1"], "closing the card leaves the mode");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    delete document.documentElement.dataset.reduceAnimations;
  }

  uninstall();
  assert.deepEqual(disposed.sort(), ["item:btw.ask", "mode:btw", "slot:btw.card"]);
});
