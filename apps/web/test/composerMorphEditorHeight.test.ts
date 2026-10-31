// The phone composer's engage morph measures the card it is moving to in a
// layout effect (composerMorph.ts). The Composer's editor auto-grow used to be
// a passive effect, so that measurement still saw the resting row's 46px
// editor: the morph aimed ~10px past the engaged card and snapped back when it
// finished (device capture, build 17). Mounts the real Composer on a phone
// layout; layout is stubbed so the card's height follows the editor's.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://127.0.0.1:4400/", width: 430, height: 932 });
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
  FocusEvent: dom.FocusEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// A phone: every shell media query that asks for a narrow, coarse viewport.
const matchMedia = (query: string) => ({
  matches: /max-width: (480|960)px|pointer: coarse/.test(query) && !/min-width|prefers-reduced-motion/.test(query),
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return false; },
});
Object.assign(globalThis, { matchMedia });
Object.assign(dom, { matchMedia });
globalThis.fetch = async () => new Response("{}", { status: 404 });

// Stub layout: the editor's content is one line (34px engaged, the 44px row
// at rest), and the engaged card is its chrome plus the editor box.
const CARD_CHROME = 98;
const RESTING_CARD = 56;
const engagedOf = (node: Element) => node.closest(".composer")?.classList.contains("composer-expanded") ?? false;
Object.defineProperty(dom.HTMLTextAreaElement.prototype, "scrollHeight", {
  configurable: true,
  get(this: HTMLTextAreaElement) { return engagedOf(this) ? 34 : 44; },
});
const proto = dom.HTMLElement.prototype as unknown as { getBoundingClientRect: () => DOMRect; animate: unknown };
const originalRect = proto.getBoundingClientRect;
proto.getBoundingClientRect = function (this: HTMLElement) {
  if (!this.classList.contains("composer-card")) return originalRect.call(this);
  const editor = this.querySelector("textarea");
  const height = engagedOf(this) ? CARD_CHROME + (parseFloat(editor?.style.height ?? "") || 0) : RESTING_CARD;
  return { height, width: 398, top: 0, left: 0, right: 398, bottom: height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
};
const morphs: Keyframe[][] = [];
proto.animate = function (this: HTMLElement, keyframes: Keyframe[]) {
  if (this.classList.contains("composer-card")) morphs.push(keyframes);
  return Object.assign(new dom.EventTarget() as unknown as EventTarget, { cancel() {}, finish() {}, effect: null });
};

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Composer } = await import("../src/components/Composer.tsx");
const { api } = await import("@polyth/session/web-api");
const { activateProject, applyProjectUpsert, setModels, startNewSession } = await import("../src/store.ts");

const settle = () => act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });

test("engaging measures the card with the editor already sized for it, not the resting row's editor", async () => {
  api.listWorktrees = (async () => [{ path: "/repo", branch: "master", head: "0000000", isMain: true }]) as typeof api.listWorktrees;
  api.gitBranches = (async () => ({ current: "master", branches: [{ name: "master", current: true }] })) as typeof api.gitBranches;
  applyProjectUpsert({ id: "polyth", path: "/projects/polyth", name: "Polyth", createdAt: 0, defaults: { isolation: "workspace" } });
  activateProject("polyth");
  setModels([{ providerID: "anthropic", modelID: "opus", name: "Opus 5.5", connected: true }]);
  startNewSession("polyth", { draft: "" });

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(Composer)); });
  await settle();
  const composer = host.querySelector<HTMLElement>(".composer")!;
  const editor = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]")!;
  assert.ok(composer.classList.contains("composer-collapsed"), "a fresh phone composer rests as one row");
  assert.equal(editor.style.height, "46px", "the resting row sizes its editor to the 44px row");

  await act(async () => { editor.focus(); });
  await settle();
  assert.ok(composer.classList.contains("composer-expanded"), "focus engages the card");
  assert.equal(editor.style.height, "36px", "the engaged editor is one line tall");
  assert.equal(morphs.length, 1, "engaging morphs the card once");
  assert.deepEqual(morphs[0], [{ height: `${RESTING_CARD}px` }, { height: `${CARD_CHROME + 36}px` }],
    "the morph ends where the engaged card settles, editor included");

  await act(async () => { root.unmount(); });
  proto.getBoundingClientRect = originalRect;
  delete (proto as { animate?: unknown }).animate;
  dom.happyDOM.abort();
});
