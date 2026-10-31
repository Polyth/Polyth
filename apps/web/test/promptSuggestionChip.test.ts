// The harness's suggested next prompt is a chip above the composer card, never
// text inside the editor: the old placeholder + absolutely positioned pill sat
// on top of the one-line phone editor. Mounts the real Composer, like
// composerDraftRemovalOrdering.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage as unknown as Storage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as typeof globalThis & { matchMedia: typeof globalThis.matchMedia }).matchMedia = () => ({
  matches: false,
  media: "",
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return false; },
});
globalThis.fetch = async () => new Response("{}", { status: 404 });

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Composer } = await import("../src/components/Composer.tsx");
const { api } = await import("@polyth/session/web-api");
const { activateProject, activateSession, seedSessionCache, setModels } = await import("../src/store.ts");

const SUGGESTION = "Run the tests and fix what fails";

const { registerSlot } = await import("../src/slots.ts");

async function mount(sessionId: string, status: "idle" | "working" = "idle", promptSuggestion: string | undefined = SUGGESTION) {
  activateProject("suggestion-project");
  setModels([{ providerID: "test", modelID: "model", name: "Test model", connected: true }]);
  seedSessionCache({
    id: sessionId,
    projectId: "suggestion-project",
    title: "Chat",
    status,
    createdAt: 1,
    updatedAt: 1,
    ...(promptSuggestion ? { promptSuggestion } : {}),
  });
  activateSession(sessionId);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(Composer)); });
  const input = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
  assert.ok(input);
  return {
    host,
    input,
    chip: () => host.querySelector<HTMLElement>(".composer-suggestion"),
    async unmount() {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

test("the suggestion is a chip outside the editor and a tap only fills the draft", async () => {
  const originalSend = api.sendMessage;
  let sends = 0;
  api.sendMessage = (async () => { sends += 1; return { turnId: "t" }; }) as typeof api.sendMessage;
  const view = await mount("suggestion-tap");
  try {
    const chip = view.chip();
    assert.ok(chip, "an idle empty composer offers the suggestion");
    assert.equal(chip.closest(".composer-card") === null, true, "the chip is not drawn inside the composer card");
    assert.equal(view.input.placeholder === SUGGESTION, false, "the editor keeps its own placeholder");
    assert.equal(chip.querySelector(".composer-suggestion-text")?.textContent, SUGGESTION);

    await act(async () => { chip.querySelector<HTMLButtonElement>(".composer-suggestion-use")!.click(); });
    assert.equal(view.input.value, SUGGESTION, "the suggestion becomes an editable draft");
    assert.equal(sends, 0, "taking a suggestion never sends it");
    assert.equal(view.chip() === null, true, "the chip leaves once the draft has text");
  } finally {
    await view.unmount();
    api.sendMessage = originalSend;
  }
});

test("× dismisses the suggestion and Tab takes it from the keyboard", async () => {
  const dismissed = await mount("suggestion-dismiss");
  try {
    const close = dismissed.chip()?.querySelector<HTMLButtonElement>(".composer-suggestion-dismiss");
    assert.ok(close);
    await act(async () => { close.click(); });
    assert.equal(dismissed.chip() === null, true, "× hides that suggestion");
    assert.equal(dismissed.input.value, "", "dismissing leaves the draft empty");
  } finally {
    await dismissed.unmount();
  }

  const keyboard = await mount("suggestion-tab");
  try {
    await act(async () => {
      keyboard.input.focus();
      keyboard.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    assert.equal(keyboard.input.value, SUGGESTION);
  } finally {
    await keyboard.unmount();
  }
});

test("a running turn hides the suggestion", async () => {
  const view = await mount("suggestion-working", "working");
  try {
    assert.equal(view.chip() === null, true);
  } finally {
    await view.unmount();
  }
});

test("a composer.suggestion source offers on the same chip with no rail widget; the harness wins unless preferred", async () => {
  // A package (Session Assist) offers through the draft context from a headless
  // slot contribution, so hiding its rail button cannot switch it off; the
  // host owns the chip, its keyboard shortcut and its dismissal.
  const OFFER = "Commit the retry fix";
  const React = await import("react");
  let preferred = false;
  const seen: Array<{ harnessSuggestion?: string; offerSuggestion?: unknown }> = [];
  function Source({ draft }: { draft: import("@polyth/web-sdk").ComposerDraftContext }) {
    seen.push({ ...(draft.harnessSuggestion ? { harnessSuggestion: draft.harnessSuggestion } : {}), offerSuggestion: draft.offerSuggestion });
    React.useEffect(() => {
      if (draft.sessionId) draft.offerSuggestion?.({ sessionId: draft.sessionId, text: OFFER, ...(preferred ? { preferred: true } : {}) });
      return () => draft.offerSuggestion?.(null);
    }, [draft.sessionId, draft.offerSuggestion]);
    return null;
  }
  const off = registerSlot("composer.suggestion", "test.next-prompt", (context) => context.composerDraft
    ? createElement(Source, { draft: context.composerDraft as import("@polyth/web-sdk").ComposerDraftContext })
    : null);
  const text = (view: { chip(): HTMLElement | null }) => view.chip()?.querySelector(".composer-suggestion-text")?.textContent ?? null;
  try {
    const offered = await mount("suggestion-offer", "idle", "");
    try {
      assert.equal(typeof seen.at(-1)?.offerSuggestion, "function", "the host lets a source offer");
      assert.equal(text(offered), OFFER, "the offer appears as the suggestion chip");
      await act(async () => {
        offered.input.focus();
        offered.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
      });
      assert.equal(offered.input.value, OFFER, "Tab takes the offer as the draft");
    } finally {
      await offered.unmount();
    }

    const both = await mount("suggestion-offer-harness");
    try {
      assert.equal(seen.at(-1)?.harnessSuggestion, SUGGESTION, "the source sees the harness's own hint");
      assert.equal(text(both), SUGGESTION, "the harness wins by default");
      assert.equal(both.host.querySelectorAll(".composer-suggestion").length, 1, "never two chips");
    } finally {
      await both.unmount();
    }

    preferred = true;
    const first = await mount("suggestion-offer-preferred");
    try {
      assert.equal(text(first), OFFER, "a preferred offer wins over the harness");
      assert.equal(first.host.querySelectorAll(".composer-suggestion").length, 1, "still one chip");
    } finally {
      await first.unmount();
    }
  } finally {
    off();
  }
});
