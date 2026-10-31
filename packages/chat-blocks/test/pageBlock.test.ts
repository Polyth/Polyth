// Mounted behaviour of the ```page renderer: placeholder while streaming, the
// sandboxed iframe, source-checked messages and the explicit Send.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);
const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  localStorage: dom.localStorage,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
after(async () => { await dom.happyDOM.close(); });

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: PageBlock } = await import("../widgets/PageBlock.tsx");

let seq = 0;
async function mount(text: string, closed: boolean, conversation = true, info?: string) {
  const sent: Array<[string, string]> = [];
  const host = {
    ui: { locale: { get: () => "en" } },
    conversation: { send: async (s: string, m: string) => { sent.push([s, m]); return true; }, insert: () => {} },
  } as never;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(PageBlock, {
      lang: "page", text, info, closed, source: null,
      context: { blockKey: `pg${++seq}`, projectId: "p1", sessionId: "s1", ...(conversation ? { conversation: true } : {}) }, host,
    }));
  });
  return { container, sent };
}

test("a streaming page shows a placeholder and no iframe", async () => {
  const { container } = await mount("Mock\n<p>par", false);
  assert.equal(container.querySelector("iframe"), null);
  assert.ok(container.textContent!.includes("Drawing page…"));
});

test("with an explicit empty info the first text line is body, not a title", async () => {
  // Old-folding host text would have been `Hello world\n<p>x</p>`; info="" says
  // there was no opening-line info, so none of it is a title.
  const { container } = await mount("Hello world\n<p>x</p>", true, true, "");
  assert.equal(container.querySelector(".chat-block-title")?.textContent, "Page");
  const doc = container.querySelector("iframe")!.getAttribute("srcdoc")!;
  assert.ok(doc.includes("Hello world"), "the first line stays in the page body");
});

test("an explicit info title and from= are read from info, not the text", async () => {
  const { container } = await mount("Checkout mockup\n<p>x</p>", true, true, "Checkout mockup");
  assert.equal(container.querySelector(".chat-block-title")?.textContent, "Checkout mockup");
  const doc = container.querySelector("iframe")!.getAttribute("srcdoc")!;
  assert.ok(doc.includes("<p>x</p>"));
  assert.equal(doc.includes("Checkout mockup"), false, "the info line is stripped from the body");
});

test("a closed page mounts a script-only sandboxed iframe with the policy first", async () => {
  const { container } = await mount("Mock\n<script>1</script><p>x</p>", true);
  const frame = container.querySelector("iframe")!;
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
  const doc = frame.getAttribute("srcdoc")!;
  assert.ok(doc.startsWith("<!doctype html><meta charset=utf-8><meta http-equiv=\"Content-Security-Policy\""));
  assert.ok(doc.indexOf("Content-Security-Policy") < doc.indexOf("<script>1</script>"));
  assert.ok(container.textContent!.includes("Mock"));
});

test("an oversized inline page is refused", async () => {
  const { container } = await mount(`T\n${"x".repeat(256 * 1024 + 1)}`, true);
  assert.equal(container.querySelector("iframe"), null);
  assert.ok(container.textContent!.includes("too large"));
});

test("a page's reply is pending until the user clicks Send; foreign sources are ignored", async () => {
  const { container, sent } = await mount("Mock\n<p>x</p>", true);
  const frame = container.querySelector("iframe")! as unknown as { contentWindow: unknown };
  const post = async (source: unknown, data: unknown) => {
    await act(async () => { (dom as unknown as { dispatchEvent(event: unknown): boolean }).dispatchEvent(Object.assign(new dom.Event("message"), { source, data })); });
  };
  const message = { channel: "polyth-page-v1", kind: "send", text: "Pick B" };
  await post({}, message);
  assert.equal(container.querySelector(".chat-block-page-pending"), null);
  assert.ok(frame.contentWindow, "iframe has a window");
  {
    await post(frame.contentWindow, message);
    assert.ok(container.querySelector(".chat-block-page-pending")!.textContent!.includes("Send: “Pick B”"));
    assert.deepEqual(sent, []);
    const button = [...container.querySelectorAll(".chat-block-page-pending button")].find((b) => b.textContent === "Send")!;
    await act(async () => { (button as HTMLElement).click(); });
    assert.deepEqual(sent, [["s1", "Pick B"]]);
  }
});

test("a page that navigates its own frame is put back on its document, then given up on", async () => {
  const { container } = await mount("Mock\n<p>x</p>", true);
  const wait = () => new Promise((resolve) => setTimeout(resolve, 450));
  const frame = () => container.querySelector("iframe") as unknown as (HTMLIFrameElement & { contentWindow: unknown }) | null;
  const ready = async (target: { contentWindow: unknown }) => {
    await act(async () => {
      (dom as unknown as { dispatchEvent(event: unknown): boolean }).dispatchEvent(
        Object.assign(new dom.Event("message"), { source: target.contentWindow, data: { channel: "polyth-page-v1", kind: "ready" } }),
      );
    });
  };
  const load = async (target: HTMLIFrameElement) => {
    await act(async () => { target.dispatchEvent(new dom.Event("load") as unknown as Event); });
    await act(async () => { await wait(); });
  };
  const first = frame();
  assert.ok(first !== null, "iframe mounted");
  // happy-dom fires one load of its own at mount without running the bridge
  // (a real engine announces before every load of its own document). That
  // load comes before any announcement, so it may never reset; let its check
  // pass before simulating the engine's real sequence.
  await act(async () => { await wait(); });
  assert.equal(container.textContent!.includes("was reloaded"), false);
  // Its own document: announced, then loaded.
  await ready(first);
  await load(first);
  await ready(first);
  await load(first);
  assert.ok(frame() === first, "announced loads (including a reload) keep the frame");
  assert.equal(container.textContent!.includes("was reloaded"), false);
  // A foreign document: a load with no announcement.
  await load(first);
  const second = frame();
  assert.ok(second !== null && second !== first, "an unannounced load remounts the frame");
  assert.ok(container.textContent!.includes("was reloaded"));
  for (let i = 0; i < 4; i++) {
    const current = frame();
    if (!current) break;
    await ready(current);
    await load(current);
    await load(current);
  }
  assert.ok(frame() === null, "a refresh loop stops being remounted");
});

test("a page outside an agent answer (a file, an issue) waits for Run", async () => {
  const { container } = await mount("Readme demo\n<script>1</script>", true, false);
  assert.ok(container.querySelector("iframe") === null, "no frame before the click");
  assert.ok(container.textContent!.includes("not written by the agent"));
  const run = [...container.querySelectorAll("button")].find((b) => b.textContent === "Run page");
  assert.ok(run !== undefined, "Run page button");
  await act(async () => { (run as HTMLElement).click(); });
  assert.ok(container.querySelector("iframe") !== null, "the click runs the page");
  assert.equal(container.querySelector("iframe")!.getAttribute("sandbox"), "allow-scripts");
});

test("a page that leaves right after it loaded is caught (two loads inside the grace)", async () => {
  const { container } = await mount("Quick\n<p>x</p>", true);
  const frame = container.querySelector("iframe") as unknown as (HTMLIFrameElement & { contentWindow: unknown }) | null;
  assert.ok(frame !== null, "iframe mounted");
  // Let happy-dom's own unannounced mount load pass its check first (see above).
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
  await act(async () => {
    (dom as unknown as { dispatchEvent(event: unknown): boolean }).dispatchEvent(
      Object.assign(new dom.Event("message"), { source: frame.contentWindow, data: { channel: "polyth-page-v1", kind: "ready" } }),
    );
  });
  // Its own document loads, then a meta refresh or an early redirect loads a
  // foreign one before the first check has run.
  await act(async () => { frame.dispatchEvent(new dom.Event("load") as unknown as Event); });
  await act(async () => { frame.dispatchEvent(new dom.Event("load") as unknown as Event); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
  assert.ok(container.textContent!.includes("was reloaded"), "the second, unannounced load resets the page");
  assert.ok(container.querySelector("iframe") !== frame, "a fresh frame replaced the one that left");
});

// Full screen: the native API keeps the same iframe so the page's state
// survives; the Dialog is only the no-API fallback.
type FullscreenGlobal = typeof globalThis & { __fs?: { element: Element | null; enabled: boolean; requests: number; exits: number } };

function installFullscreen(enabled: boolean): { restore(): void } {
  const doc = dom.document as unknown as Record<string, unknown>;
  const store = { element: null as Element | null, enabled, requests: 0, exits: 0 };
  (globalThis as FullscreenGlobal).__fs = store;
  Object.defineProperty(doc, "fullscreenEnabled", { get: () => store.enabled, configurable: true });
  Object.defineProperty(doc, "fullscreenElement", { get: () => store.element, configurable: true });
  const proto = (dom as unknown as { HTMLElement: { prototype: Record<string, unknown> } }).HTMLElement.prototype;
  proto.requestFullscreen = function requestFullscreen(this: Element) {
    store.requests += 1;
    store.element = this;
    (dom.document as unknown as { dispatchEvent(e: Event): boolean }).dispatchEvent(new dom.Event("fullscreenchange") as unknown as Event);
    return Promise.resolve();
  };
  doc.exitFullscreen = () => {
    store.exits += 1;
    store.element = null;
    (dom.document as unknown as { dispatchEvent(e: Event): boolean }).dispatchEvent(new dom.Event("fullscreenchange") as unknown as Event);
    return Promise.resolve();
  };
  return {
    restore() {
      delete doc.fullscreenEnabled;
      delete doc.fullscreenElement;
      delete doc.exitFullscreen;
      delete proto.requestFullscreen;
      delete (globalThis as FullscreenGlobal).__fs;
    },
  };
}

const pressFullscreen = async (container: Element) => {
  const button = container.querySelector('button[aria-label="Full screen"]')
    ?? container.querySelector('button[aria-label="Close"]');
  assert.ok(button, "fullscreen button");
  await act(async () => { (button as HTMLElement).click(); });
};

test("full screen uses the Fullscreen API on the block section and keeps the same iframe", async () => {
  const fs = installFullscreen(true);
  try {
    const { container } = await mount("Mock\n<p>x</p>", true);
    const before = container.querySelector("iframe")!;
    assert.ok(before !== null, "iframe mounted");
    await pressFullscreen(container);
    const section = container.querySelector(".chat-block--page")!;
    assert.equal((globalThis as FullscreenGlobal).__fs!.requests, 1, "requested full screen once");
    assert.ok((globalThis as FullscreenGlobal).__fs!.element === section, "the block section is fullscreen, not a new Dialog");
    assert.ok(container.querySelector("iframe") === before, "the same iframe element is kept");
    assert.equal(container.querySelector(".chat-block-page-dialog"), null, "no Dialog while the API is available");
    const close = container.querySelector('button[aria-label="Close"]') as HTMLElement | null;
    assert.ok(close !== null, "button label reflects the active state");
    assert.equal(close!.getAttribute("aria-pressed"), "true");
    // Toggling again exits.
    await act(async () => { close!.click(); });
    assert.equal((globalThis as FullscreenGlobal).__fs!.exits, 1, "exited once");
    assert.ok(container.querySelector("iframe") === before, "still the same iframe");
  } finally {
    fs.restore();
  }
});

test("full screen falls back to the Dialog when the API is unavailable", async () => {
  const fs = installFullscreen(false);
  try {
    const { container } = await mount("Mock\n<p>x</p>", true);
    await pressFullscreen(container);
    assert.equal((globalThis as FullscreenGlobal).__fs!.requests, 0, "no native request");
    // The Dialog portals to document.body, outside the mounted container.
    assert.ok(document.body.querySelector(".chat-block-page-dialog") !== null, "the Dialog fallback opens");
    assert.equal(document.body.querySelectorAll(".chat-block-page-dialog iframe").length, 1, "the Dialog mounts a second iframe");
    await act(async () => {
      [...document.body.querySelectorAll(".chat-block-page-dialog button")].forEach((b) => { if ((b as HTMLElement).textContent === "Close") (b as HTMLElement).click(); });
    });
  } finally {
    fs.restore();
  }
});
