// Phone keyboards (Gboard and friends) keep the word being typed in an open
// IME composition. The composer only follows committed text, so these pin the
// paths that let Send see that word: live composing text, a composition the
// browser dropped without compositionend, and committing it on a Send tap.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  HTMLTextAreaElement: (dom as unknown as { HTMLTextAreaElement: typeof HTMLTextAreaElement }).HTMLTextAreaElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);

const { act, createElement, createRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const AdaptiveTextInput = (await import("../src/components/input/AdaptiveTextInput.tsx")).default;
type TextInputHandle = import("../src/components/input/AdaptiveTextInput.tsx").TextInputHandle;
const EventCtor = (dom as unknown as { Event: typeof Event }).Event;

function fire(el: HTMLTextAreaElement, type: string, props: Record<string, unknown> = {}): void {
  const event = new EventCtor(type, { bubbles: true });
  for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value });
  el.dispatchEvent(event);
}

/** One keystroke of a composing keyboard: the field shows the word, uncommitted. */
function compose(el: HTMLTextAreaElement, value: string): void {
  el.value = value;
  fire(el, "input", { isComposing: true, inputType: "insertCompositionText" });
}

async function mount() {
  const committed: string[] = [];
  const live: (string | null)[] = [];
  const focus: boolean[] = [];
  const handle = createRef<TextInputHandle>();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(AdaptiveTextInput, {
      ref: handle,
      onTextChange: (text: string) => committed.push(text),
      onComposingText: (text: string | null) => live.push(text),
      onFocusChange: (focused: boolean) => focus.push(focused),
    }));
  });
  const ta = container.querySelector("textarea")!;
  const unmount = async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  };
  return { committed, live, focus, handle, ta, unmount };
}

test("a word still being composed is reported live but not committed", async () => {
  const { committed, live, handle, ta, unmount } = await mount();
  fire(ta, "compositionstart");
  compose(ta, "так");
  assert.equal(handle.current?.isComposing(), true);
  assert.equal(committed.length, 0, "committed edits wait for the keyboard");
  assert.equal(live.at(-1), "так", "Send can see the visible word");

  fire(ta, "compositionend");
  assert.equal(committed.at(-1), "так");
  assert.equal(live.at(-1), null, "live text is released once the word is committed");
  await unmount();
});

test("an input outside any composition reopens the gate a dropped composition left shut", async () => {
  const { committed, live, handle, ta, unmount } = await mount();
  fire(ta, "compositionstart");
  compose(ta, "сло");
  // Chromium cancels a composition silently when script writes `value`; the
  // next keystroke is plain input with no compositionend in between.
  ta.value = "сло.";
  fire(ta, "input", { isComposing: false, inputType: "insertText" });
  assert.equal(handle.current?.isComposing(), false);
  assert.equal(committed.at(-1), "сло.");
  assert.equal(live.at(-1), null);

  ta.value = "сло. ок";
  fire(ta, "input", { isComposing: false, inputType: "insertText" });
  assert.equal(committed.at(-1), "сло. ок", "later typing is committed again");
  await unmount();
});

test("a blur that arrives with the composition still open commits it", async () => {
  const { committed, handle, ta, unmount } = await mount();
  ta.focus();
  fire(ta, "compositionstart");
  compose(ta, "привіт");
  ta.blur();
  assert.equal(handle.current?.isComposing(), false);
  assert.equal(committed.at(-1), "привіт");
  await unmount();
});

test("finishComposition commits the word for a Send tap without a focus change", async () => {
  const { committed, live, focus, handle, ta, unmount } = await mount();
  ta.focus();
  focus.length = 0;
  fire(ta, "compositionstart");
  compose(ta, "ок");
  await act(async () => { handle.current?.finishComposition(); });
  assert.equal(handle.current?.isComposing(), false);
  assert.equal(committed.at(-1), "ок");
  assert.equal(live.at(-1), null);
  assert.equal(document.activeElement === ta, true, "the field keeps focus");
  assert.equal(focus.length, 0, "the commit round trip is not reported as blur/focus");

  // The submit-time clear applies at once instead of being deferred and then
  // dropped as stale when the keyboard finally ends its composition.
  handle.current?.replaceText("");
  assert.equal(ta.value, "");
  committed.length = 0;
  handle.current?.finishComposition();
  assert.equal(committed.length, 0, "no-op without a composition");
  await unmount();
});

test("unmounting mid-composition releases the live text", async () => {
  const { live, ta, unmount } = await mount();
  fire(ta, "compositionstart");
  compose(ta, "сл");
  await unmount();
  assert.equal(live.at(-1), null);
});
