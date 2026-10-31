import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionPromptPageDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom, document: dom.document, location: dom.location,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
  Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: clearTimeout,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const PromptBookmark = (await import("../src/components/PromptBookmark.tsx")).default;
const all = Array.from({ length: 85 }, (_, i) => ({ id: `prompt-${i + 1}`, seq: i + 1, preview: `Prompt ${i + 1}` }));
const page = (before = 86): SessionPromptPageDto => {
  const prompts = all.filter((p) => p.seq < before).toReversed().slice(0, 40);
  return { prompts, beforeSeq: prompts.at(-1)!.seq > 1 ? prompts.at(-1)!.seq : null };
};
const rows = () => [...document.querySelectorAll<HTMLButtonElement>('.prompt-bookmark-peek-button')];
const click = async (selector: string) => {
  const button = document.querySelector<HTMLButtonElement>(selector);
  assert.ok(button, selector);
  await act(async () => button.click());
};
async function mount(over: Partial<Parameters<typeof PromptBookmark>[0]> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let props: Parameters<typeof PromptBookmark>[0] = {
    sessionId: "s", spaceId: "sp", revision: "v1", prompt: all.at(-1)!,
    onJump: async () => {}, onCancelJump: () => {}, ...over,
  };
  const render = async (patch: Partial<typeof props> = {}) => {
    props = { ...props, ...patch };
    await act(async () => root.render(createElement(PromptBookmark, props)));
  };
  await render();
  return { render, cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
}

test("bookmark lazily pages all 85 prompts, bounds DOM rows, and reuses preview pages without event hydration", async () => {
  const original = api.sessionPrompts;
  const originalEvents = api.getEvents;
  const calls: Array<number | undefined> = [];
  api.sessionPrompts = async (_sid, before) => { calls.push(before); return page(before); };
  api.getEvents = async () => { assert.fail("Browsing previews must not hydrate the transcript"); };
  const t = await mount();
  try {
    assert.equal(calls.length, 0, "closed bookmark performs no fetch");
    await click('.prompt-bookmark-toggle');
    assert.equal(rows().length, 8);
    assert.equal(document.activeElement?.classList.contains('prompt-nav-row'), true, "opening focuses a prompt");
    assert.deepEqual(rows().map((p) => p.textContent), all.slice(-8).map((p) => p.preview));
    const seen = new Set(rows().map((p) => p.textContent));
    for (let i = 0; i < 10; i++) {
      await click('.prompt-bookmark-peek [aria-label="Load earlier history"]');
      assert.ok(rows().length <= 8);
      rows().forEach((p) => seen.add(p.textContent));
    }
    assert.equal(seen.size, 85, "every prompt can be reached without gaps");
    assert.deepEqual(calls, [undefined, 46, 6]);
    assert.equal(document.querySelector('[aria-label="Load earlier history"]'), null);
    for (let i = 0; i < 10; i++) await click('.prompt-bookmark-peek [aria-label="Show later messages"]');
    await click('.prompt-bookmark-toggle');
    await click('.prompt-bookmark-toggle');
    assert.equal(calls.length, 3, "warm reopen reuses the preview cache");
  } finally { await t.cleanup(); api.sessionPrompts = original; api.getEvents = originalEvents; }
});

test("an error keeps the page and can be retried, and failed jumps keep the list available", async () => {
  const original = api.sessionPrompts;
  let requests = 0;
  api.sessionPrompts = async () => { if (++requests === 1) throw new Error("offline"); return page(); };
  const t = await mount({ onJump: async () => { throw new Error("offline jump"); } });
  try {
    await click('.prompt-bookmark-toggle');
    assert.ok(document.querySelector('[role="alert"]'));
    await click('.prompt-bookmark-peek [role="alert"] button');
    assert.equal(rows().length, 8);
    await act(async () => rows()[0]!.click());
    assert.ok(document.querySelector('[role="alert"]'));
    assert.equal(rows().length, 8);
    assert.equal(document.querySelector('.prompt-bookmark-toggle')!.getAttribute('aria-expanded'), "true");
  } finally { await t.cleanup(); api.sessionPrompts = original; }
});

test("stale preview responses cannot cross sessions or Spaces and are aborted on unmount", async () => {
  const original = api.sessionPrompts;
  const pending: Array<{ resolve: (value: SessionPromptPageDto) => void; signal: AbortSignal }> = [];
  api.sessionPrompts = (_sid, _before, init) => new Promise((resolve) => pending.push({ resolve, signal: init!.signal! }));
  const t = await mount();
  try {
    await click('.prompt-bookmark-toggle');
    await t.render({ sessionId: "other", spaceId: "other-space", prompt: { id: "other", preview: "Other session" } });
    assert.equal(pending[0]!.signal.aborted, true);
    await act(async () => pending[0]!.resolve(page()));
    assert.equal(rows().some((p) => p.textContent === "Prompt 85"), false);
    await act(async () => pending[1]!.resolve({ prompts: [{ id: "other", seq: 1, preview: "Other session" }], beforeSeq: null }));
    assert.deepEqual(rows().map((p) => p.textContent), ["Other session"]);
    await t.render({ revision: "v2" });
    assert.equal(pending.length, 3);
    await t.cleanup();
    assert.equal(pending[2]!.signal.aborted, true);
  } finally { api.sessionPrompts = original; }
});

test("dismissal cancels a pending jump and its stale outcome cannot close a reopened panel", async () => {
  const original = api.sessionPrompts;
  api.sessionPrompts = async () => page();
  let finish: () => void = () => {};
  let cancelled = 0;
  const t = await mount({ onJump: () => new Promise<void>((resolve) => { finish = resolve; }), onCancelJump: () => { cancelled++; } });
  try {
    await click('.prompt-bookmark-toggle');
    await act(async () => rows()[0]!.click());
    await click('.prompt-bookmark-toggle');
    assert.equal(cancelled, 1);
    assert.equal(document.activeElement, document.querySelector('.prompt-bookmark-toggle'), "dismissal restores the bookmark");
    await click('.prompt-bookmark-toggle');
    await act(async () => finish());
    assert.equal(document.querySelector('.prompt-bookmark-toggle')!.getAttribute('aria-expanded'), "true");
  } finally { await t.cleanup(); api.sessionPrompts = original; }
});

test("a completed jump keeps focus on the selected message", async () => {
  const original = api.sessionPrompts;
  api.sessionPrompts = async () => page();
  const message = document.createElement("div");
  message.tabIndex = -1;
  document.body.append(message);
  const t = await mount({ onJump: async () => { message.focus(); } });
  try {
    await click('.prompt-bookmark-toggle');
    await act(async () => rows()[0]!.click());
    assert.equal(document.querySelector('.prompt-bookmark-peek'), null);
    assert.equal(document.activeElement, message);
  } finally { await t.cleanup(); message.remove(); api.sessionPrompts = original; }
});
