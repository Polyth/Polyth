// Mounted "Open links in Browser" message action and Reader view states.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { BrowserSessionDto } from "@polyth/contracts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom, document: dom.document, localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
  location: dom.location, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
  Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: clearTimeout,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { clearUiError, getState } = await import("../../../apps/web/src/store.ts");
const { default: MessageLinksAction } = await import("../widgets/MessageLinksAction.tsx");
const { default: ReaderView, readerBlocks } = await import("../widgets/ReaderView.tsx");
const { readerParagraphs } = await import("../widgets/messageLinks.ts");

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  await settle();
  return {
    container,
    rerender: async (next: ReturnType<typeof createElement>) => { await act(async () => { root.render(next); }); await settle(); },
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

const tab = (id: string): BrowserSessionDto => ({
  id, projectId: "p", sessionId: "s", status: "ready", url: "about:blank", title: id,
  viewport: { width: 1280, height: 800, deviceScaleFactor: 1 }, colorScheme: "no-preference", revision: 1, engine: "fake",
});

function deps(navigate: (url: string) => Promise<unknown>) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      list: async () => [tab("t1")],
      create: async () => tab("t1"),
      navigate: async (_id: string, url: string) => { calls.push(url); return await navigate(url) as BrowserSessionDto; },
      recalledTab: () => "t1",
      rememberTab: () => {},
    },
  };
}

const TEXT = "Docs https://example.com/docs and https://example.com/docs again, MR https://gitlab.com/g/sub/app/-/merge_requests/7, PR https://github.com/acme/app/pull/42.";
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];

test("renders nothing for a message without links", async () => {
  const view = await mount(createElement(MessageLinksAction, { text: "no links", projectId: "p", sessionId: "s", openPane: () => {} }));
  assert.equal(view.container.innerHTML, "");
  await view.unmount();
});

test("bar button uses the host chat action and lists pull requests first, deduplicated", async () => {
  const view = await mount(createElement(MessageLinksAction, { text: TEXT, projectId: "p", sessionId: "s", openPane: () => {} }));
  const button = view.container.querySelector<HTMLButtonElement>('button[data-action-id="browser.message-links"]')!;
  assert.ok(button.classList.contains("chat-action-button"));
  assert.equal(button.getAttribute("aria-label"), "Open links in Browser");
  await act(async () => { button.click(); });
  await settle();
  const labels = menuItems().map((item) => item.textContent);
  assert.equal(labels.length, 3);
  assert.match(labels[0]!, /g\/sub\/app !7/);
  assert.match(labels[0]!, /Pull request · gitlab\.com/);
  assert.match(labels[1]!, /acme\/app #42/);
  assert.match(labels[2]!, /example\.com\/docs/);
  await act(async () => { button.click(); });
  await view.unmount();
});

test("an open failure surfaces in the host error banner, not only a tooltip", async () => {
  clearUiError();
  const { calls, deps: failing } = deps(async () => { throw Object.assign(new Error("Navigation to this address is blocked by the Browser policy"), { code: "blocked-scheme" }); });
  let panes = 0;
  const view = await mount(createElement(MessageLinksAction, { text: TEXT, projectId: "p", sessionId: "s", openPane: () => { panes++; }, deps: failing }));
  const button = view.container.querySelector<HTMLButtonElement>('button[data-action-id="browser.message-links"]')!;
  await act(async () => { button.click(); });
  await settle();
  await act(async () => { menuItems()[1]!.click(); });
  await settle();
  assert.deepEqual(calls, ["https://github.com/acme/app/pull/42"]);
  assert.equal(panes, 1);
  assert.match(getState().uiError ?? "", /Couldn't open link.*blocked by the Browser policy/);
  assert.equal(button.getAttribute("title"), "");
  assert.equal(button.disabled, false, "busy clears after the failure");
  clearUiError();
  await view.unmount();
});

test("a successful or approval-pending open raises no error", async () => {
  clearUiError();
  const { calls, deps: approving } = deps(async () => ({ session: null, approval: { origin: "https://example.com", message: "needs approval" } }));
  const view = await mount(createElement(MessageLinksAction, { text: "see https://example.com/x", projectId: "p", sessionId: "s", openPane: () => {}, deps: approving }));
  await act(async () => { view.container.querySelector<HTMLButtonElement>("button")!.click(); });
  await settle();
  await act(async () => { menuItems()[0]!.click(); });
  await settle();
  assert.deepEqual(calls, ["https://example.com/x"]);
  assert.equal(getState().uiError, null);
  await view.unmount();
});

test("in the More menu: no own button; a request opens the only link directly", async () => {
  const { calls, deps: ok } = deps(async () => tab("t1"));
  const anchor = document.createElement("div");
  document.body.appendChild(anchor);
  const props = { text: "PR https://github.com/acme/app/pull/42", projectId: "p", sessionId: "s", openPane: () => {}, deps: ok,
    messageActionPlacement: "menu", messageActionAnchor: () => anchor };
  const view = await mount(createElement(MessageLinksAction, { ...props, messageActionRequest: 0 }));
  assert.equal(view.container.querySelector("button"), null);
  assert.deepEqual(calls, []);
  await view.rerender(createElement(MessageLinksAction, { ...props, messageActionRequest: 1 }));
  assert.deepEqual(calls, ["https://github.com/acme/app/pull/42"]);
  await view.unmount();
  anchor.remove();
});

test("in the More menu with several links a request opens the link list", async () => {
  const anchor = document.createElement("div");
  document.body.appendChild(anchor);
  const props = { text: TEXT, projectId: "p", sessionId: "s", openPane: () => {}, messageActionPlacement: "menu", messageActionAnchor: () => anchor };
  const view = await mount(createElement(MessageLinksAction, { ...props, messageActionRequest: 0 }));
  assert.equal(menuItems().length, 0);
  await view.rerender(createElement(MessageLinksAction, { ...props, messageActionRequest: 1 }));
  assert.equal(menuItems().length, 3);
  await view.unmount();
  anchor.remove();
});

test("reader view: article text with a page table, focus moves to the title", async () => {
  const paragraphs = readerParagraphs("Title\n\nPhase\tBefore\tAfter\nLoad\t4.1s\t1.2s\n\nBody   text");
  assert.deepEqual(readerBlocks(paragraphs).map((block) => block.kind), ["text", "break", "table", "break", "text"]);
  let exits = 0;
  const view = await mount(createElement(ReaderView, { reader: { status: "ready", title: "A page", paragraphs }, fallbackTitle: "example.com", onExit: () => { exits++; } }));
  const section = view.container.querySelector(".browser-reader")!;
  assert.equal(section.getAttribute("aria-busy"), "false");
  assert.equal(document.activeElement, section.querySelector("h2"));
  const rows = [...section.querySelectorAll('[role="row"]')].map((row) => [...row.querySelectorAll('[role="cell"]')].map((cell) => cell.textContent));
  assert.deepEqual(rows, [["Phase", "Before", "After"], ["Load", "4.1s", "1.2s"]]);
  assert.equal(section.querySelector(".browser-reader-scroll .browser-reader-body")?.textContent?.includes("Body text"), true);
  await act(async () => {
    section.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
  });
  assert.equal(exits, 1);
  await view.unmount();
});

test("reader view: loading, empty and failed extraction states", async () => {
  let retries = 0;
  const base = { fallbackTitle: "example.com/page", onExit: () => {}, onRetry: () => { retries++; } };
  const view = await mount(createElement(ReaderView, { ...base, reader: { status: "loading", title: "", paragraphs: [] } }));
  assert.equal(view.container.querySelector(".browser-reader")!.getAttribute("aria-busy"), "true");
  assert.match(view.container.querySelector('[role="status"]')!.textContent!, /Reading the page/);
  assert.equal(view.container.querySelector("h2")!.textContent, "example.com/page");

  await view.rerender(createElement(ReaderView, { ...base, reader: { status: "ready", title: "", paragraphs: [] } }));
  assert.ok(view.container.querySelector(".empty-state"));
  assert.match(view.container.querySelector('[role="status"]')!.textContent!, /no readable text/);

  await view.rerender(createElement(ReaderView, { ...base, reader: { status: "error", title: "", paragraphs: [] } }));
  const alert = view.container.querySelector('[role="alert"]')!;
  assert.match(alert.textContent!, /Couldn't read this page/);
  const retry = [...alert.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
  await act(async () => { retry.click(); });
  assert.equal(retries, 1);
  await view.unmount();
});
