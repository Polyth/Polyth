// Opening a chat on a mouse or trackpad screen puts the caret in its composer
// (docs/dev/ui.md, "Focus when a chat opens"), without taking focus from a text
// field, dialog, menu or popover, and never on touch.
// DOM nodes are compared with `===` only: a failing assert.equal on a
// happy-dom node inspects the whole window graph.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const { focusOnChatOpen, openFocusIsFree } = await import("../src/components/composerOpenFocus.ts");

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

function mount(): { composer: HTMLElement; input: HTMLTextAreaElement; outside: HTMLElement } {
  document.body.innerHTML = `
    <nav><button id="row">Chat</button><input id="search"></nav>
    <div id="composer"><textarea data-composer-input=""></textarea><button id="send">Send</button></div>
    <div role="dialog"><button id="in-dialog">Ok</button></div>
    <div role="menu"><button id="menu-item">New chat</button></div>
    <div class="ui-popover"><button id="in-popover">Pick</button></div>
    <div contenteditable="true"><span id="in-editor" tabindex="0">x</span></div>`;
  return {
    composer: document.getElementById("composer")!,
    input: document.querySelector("textarea")!,
    outside: document.getElementById("row")!,
  };
}

const byId = (id: string) => document.getElementById(id)!;

test("free: nothing focused, a navigator row, or the composer itself", () => {
  const { composer, input, outside } = mount();
  assert.ok(openFocusIsFree(null, composer));
  assert.ok(openFocusIsFree(document.body, composer));
  assert.ok(openFocusIsFree(outside, composer));
  assert.ok(openFocusIsFree(input, composer));
  assert.ok(openFocusIsFree(byId("send"), composer));
});

test("held: a text field, dialog, menu, popover or editable region keeps focus", () => {
  const { composer } = mount();
  for (const id of ["search", "in-dialog", "menu-item", "in-popover", "in-editor"]) {
    assert.ok(!openFocusIsFree(byId(id), composer), id);
  }
});

test("an opened chat focuses its composer from a navigator row", async () => {
  const { composer, input, outside } = mount();
  outside.focus();
  focusOnChatOpen(() => composer, () => input.focus());
  await settle();
  assert.ok(document.activeElement === input);
});

test("it waits for a closing menu, then takes the focus", async () => {
  const { composer, input } = mount();
  const item = byId("menu-item");
  item.focus();
  focusOnChatOpen(() => composer, () => input.focus());
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(document.activeElement === item);
  item.closest("[role='menu']")!.remove();
  await settle();
  assert.ok(document.activeElement === input);
});

test("it never takes focus from a field being typed in", async () => {
  const { composer, input } = mount();
  const search = byId("search");
  search.focus();
  focusOnChatOpen(() => composer, () => input.focus(), 3);
  await settle();
  assert.ok(document.activeElement === search);
});

test("a cancelled open (the next chat opened) does nothing", async () => {
  const { composer, input, outside } = mount();
  outside.focus();
  focusOnChatOpen(() => composer, () => input.focus())();
  await settle();
  assert.ok(document.activeElement === outside);
});

test("the chat composer wires it for pointer screens only, skipping a starting chat", () => {
  const source = readFileSync(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  const effect = source.match(/const openedChat = session\?\.id \?\? newSessionChat;\n\s*useEffect\(\(\) => \{([\s\S]*?)\}, \[openedChat, widgetMode\]\);/);
  assert.ok(effect, "open-focus effect keyed on the opened chat");
  const body = effect[1]!;
  assert.match(body, /widgetMode \|\| !primaryPointerIsFine\(\) \|\| isActiveSessionSpawning\(getState\(\)\)\) return;/);
  assert.match(body, /return focusOnChatOpen\(/);
});
