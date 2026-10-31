import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { BrowserContext, BrowserSessionDto } from "@polyth/contracts";
import { setClientReliabilityContext } from "../../../apps/web/src/reliabilityContext.ts";

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

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  constructor() { Socket.instances.push(this); queueMicrotask(() => this.onopen?.()); }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.closed = true; }
  frame(label: string, revision = 3) { this.onmessage?.({ data: JSON.stringify({ type: "browser/frame", revision, mime: "image/png", data: label }) }); }
}
Object.assign(globalThis, { WebSocket: Socket });
register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("@polyth/session/web-api");
const { default: PreviewView } = await import("../widgets/PreviewView.tsx");
const { pendingAttachments, clearAttachments } = await import("../../../apps/web/src/attachments.ts");
const original = { ...api };

const tab = (id: string, sessionId?: string): BrowserSessionDto => ({ id, sessionId, projectId: "p", title: id,
  url: `https://example.com/${id}`, viewport: { width: 1280, height: 800, deviceScaleFactor: 1 }, revision: 3, status: "ready", colorScheme: "light", engine: "fake", viewportMode: "custom" });
const context = (id: string): BrowserContext => ({ id, type: "element", browserSessionId: "a", projectId: "p", sessionId: "one",
  frameRevision: 3, url: "https://example.com/pricing", title: "Pricing", viewport: { width: 1280, height: 800 }, capturedAt: "2026-09-30T10:00:00Z",
  point: { x: 640, y: 400 }, element: { tag: "button", role: "button", name: "Upgrade", selector: "#upgrade", bounds: { x: 600, y: 380, width: 100, height: 40 } } });
const KeyboardEventCtor = (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
const latestSocket = () => Socket.instances.at(-1)!;

async function mount(sessionId: string | null) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const render = async (id: string | null) => { await act(async () => { root.render(createElement(PreviewView, { projectId: "p", sessionId: id })); }); };
  await render(sessionId);
  return { container, render, unmount: async () => { await act(async () => root.unmount()); container.remove(); Object.assign(api, original); } };
}
async function click(view: HTMLElement, label: string) {
  const control = [...view.querySelectorAll<HTMLElement>("button")].find((button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label);
  assert.ok(control, `missing control: ${label}`);
  await act(async () => { control.click(); });
}
async function pick(view: HTMLElement) {
  await act(async () => latestSocket().frame("first-image"));
  await click(view, "Add context");
  await click(document.body, "Point to an element");
  const image = view.querySelector(".browser-frame-img")!;
  await act(async () => { image.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
}

test("the mounted viewer switches tabs and sessions without retaining an old frame or socket", async () => {
  localStorage.clear();
  const tabs = [tab("a", "one"), tab("a2", "one"), tab("b", "two"), tab("fresh")];
  api.browserList = async () => tabs;
  api.browserCapability = async () => ({ available: true, engine: "fake" });
  const view = await mount("one");
  try {
    assert.deepEqual([...view.container.querySelectorAll('[role="tab"]')].map((el) => el.textContent), ["a", "a2"]);
    const first = latestSocket();
    await act(async () => first.frame("first-image"));
    assert.match(view.container.querySelector("img")!.src, /first-image/);
    await click(view.container, "a2");
    assert.equal(first.closed, true);
    assert.equal(view.container.querySelector(".browser-frame-img"), null);
    assert.equal(latestSocket().sent[0]?.browserSessionId, "a2");
    assert.equal(document.activeElement?.textContent, "a2");
    await view.render("two");
    assert.deepEqual([...view.container.querySelectorAll('[role="tab"]')].map((el) => el.textContent), ["b"]);
    await act(async () => first.frame("late-old-image"));
    assert.equal(view.container.querySelector(".browser-frame-img"), null);
    await view.render("one");
    assert.equal(latestSocket().sent[0]?.browserSessionId, "a2", "returning restores the selected own tab");
    await view.render(null);
    assert.deepEqual([...view.container.querySelectorAll('[role="tab"]')].map((el) => el.textContent), ["fresh"]);
  } finally { await view.unmount(); }
});

test("changing Space resets the viewer even when its project and session props stay unchanged", async () => {
  localStorage.clear();
  setClientReliabilityContext({ connectionScope: "browser-origin", spaceId: "space-one" });
  let tabs = [tab("a", "one")];
  api.browserList = async () => tabs;
  api.browserCapability = async () => ({ available: true, engine: "fake" });
  const view = await mount("one");
  try {
    const first = latestSocket();
    await act(async () => first.frame("old-space-image"));
    setClientReliabilityContext({ connectionScope: "browser-origin", spaceId: "valid-foreign-space" });
    tabs = [tab("other-space-tab", "one")];
    await view.render("one");
    assert.equal(first.closed, true);
    assert.equal(latestSocket().sent[0]?.browserSessionId, "other-space-tab");
    await act(async () => first.frame("late-old-space-image"));
    assert.equal(view.container.querySelector(".browser-frame-img"), null);
  } finally {
    await view.unmount();
    setClientReliabilityContext({ connectionScope: "browser-origin", spaceId: "default" });
  }
});

test("selection is readable and only enters the owning chat draft after explicit Add", async () => {
  localStorage.clear(); clearAttachments("one"); clearAttachments("two");
  api.browserList = async () => [tab("a", "one")];
  api.browserCapability = async () => ({ available: true, engine: "fake" });
  api.browserCaptureContext = async (_id, input) => ({ context: context(input.id) });
  const view = await mount("one");
  try {
    await pick(view.container);
    assert.equal(pendingAttachments("one").length, 0);
    const preview = view.container.querySelector(".browser-context-preview")!;
    assert.match(preview.textContent ?? "", /Upgrade/);
    assert.match(preview.textContent ?? "", /example.com\/pricing/);
    assert.match(preview.textContent ?? "", /#upgrade/);
    assert.equal(latestSocket().sent.at(-1)?.visible, false, "review keeps frame streaming paused");
    await act(async () => latestSocket().frame("late-during-review", 4));
    assert.match(view.container.querySelector<HTMLImageElement>(".browser-frame-img")!.src, /first-image/);
    assert.ok(view.container.querySelector(".browser-annotation-pin"), "the selected point stays on its captured frame");
    await click(view.container, "Add to message");
    assert.equal(pendingAttachments("one").length, 1);
    assert.equal(pendingAttachments("two").length, 0);
    assert.deepEqual(pendingAttachments("one")[0]?.browserContext?.point, { x: 640, y: 400 });
    assert.equal(view.container.querySelector(".browser-context-preview"), null);
  } finally { clearAttachments("one"); await view.unmount(); }
});

test("a capture completing after a session switch cannot attach to either draft", async () => {
  localStorage.clear(); clearAttachments("one"); clearAttachments("two");
  api.browserList = async () => [tab("a", "one"), tab("b", "two")];
  api.browserCapability = async () => ({ available: true, engine: "fake" });
  let resolveCapture!: (value: { context: BrowserContext }) => void;
  api.browserCaptureContext = () => new Promise((resolve) => { resolveCapture = resolve; });
  const view = await mount("one");
  try {
    await pick(view.container);
    await view.render("two");
    await act(async () => { resolveCapture({ context: context("late") }); });
    assert.equal(view.container.querySelector(".browser-context-preview"), null);
    assert.equal(pendingAttachments("one").length, 0);
    assert.equal(pendingAttachments("two").length, 0);
    assert.equal(latestSocket().sent[0]?.browserSessionId, "b");
  } finally { await view.unmount(); }
});

const { openUrlInBrowser } = await import("../widgets/openInBrowser.ts");
const { publishBrowserSessionEvent } = await import("../widgets/browserSignals.ts");
const addressValue = (view: HTMLElement) => view.querySelector<HTMLInputElement>('input[aria-label="Address"]')!.value;
const sessionEvent = (type: string, sessionId: string) => ({ id: `${type}-${sessionId}`, sessionId, seq: 1, time: 0, type, data: {}, v: 1 as const });
const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

test("a second chat link opened in the reused tab moves the address bar to the loaded page", async () => {
  localStorage.clear();
  let current = { ...tab("a", "one"), url: "https://github.com/acme/app/pull/128" };
  api.browserList = async () => [current];
  api.browserCapability = async () => ({ available: true, engine: "fake" });
  const view = await mount("one");
  try {
    assert.equal(addressValue(view.container), "https://github.com/acme/app/pull/128");
    // The same path MessageLinksAction takes: list → reuse tab "a" → user navigation.
    await act(async () => {
      await openUrlInBrowser({ projectId: "p", sessionId: "one" }, "https://nodejs.org/en", {
        list: async () => [current],
        create: async () => { throw new Error("must reuse the tab"); },
        navigate: async (id, url) => { current = { ...current, id, url }; return current; },
        recalledTab: () => "a",
        rememberTab: () => {},
        openPane: () => {},
      });
    });
    assert.equal(addressValue(view.container), "https://nodejs.org/en");
  } finally { await view.unmount(); }
});

test("a navigation event shows the committed URL even if the follow-up read is stale", async () => {
  localStorage.clear();
  const stale = { ...tab("a", "one"), url: "https://github.com/acme/app/pull/128" };
  api.browserList = async () => [stale];
  api.browserCapability = async () => ({ available: true, engine: "fake" });
  let reads = 0;
  // The read raced the navigation and still reports the page being left.
  api.browserGet = async () => { reads += 1; return { ...stale, title: "Node.js" }; };
  const view = await mount("one");
  try {
    await act(async () => {
      latestSocket().onmessage?.({ data: JSON.stringify({ type: "browser/event", event: { kind: "navigation", url: "https://nodejs.org/en" } }) });
    });
    await wait(0);
    assert.equal(reads, 1);
    assert.equal(addressValue(view.container), "https://nodejs.org/en");
  } finally { await view.unmount(); }
});

test("the tab list refreshes on this chat's browser facts instead of polling", async () => {
  localStorage.clear();
  const tabs = [tab("a", "one")];
  let lists = 0;
  api.browserList = async () => { lists += 1; return [...tabs]; };
  api.browserCapability = async () => ({ available: true, engine: "fake" });
  const view = await mount("one");
  try {
    await wait(1_700);
    assert.equal(lists, 1, "no list request while idle (was every 1.5 s)");
    tabs.push(tab("b", "one"));
    await act(async () => { publishBrowserSessionEvent(sessionEvent("browser/action-completed", "two")); });
    await wait(250);
    assert.equal(lists, 1, "another chat's browser facts are ignored");
    await act(async () => { publishBrowserSessionEvent(sessionEvent("browser/action-completed", "one")); });
    await wait(250);
    assert.equal(lists, 2);
    assert.deepEqual([...view.container.querySelectorAll('[role="tab"]')].map((el) => el.textContent), ["a", "b"]);
  } finally { await view.unmount(); }
});

const { createBrowserService, createFakeDriver } = await import("../src/index.ts");
const { pinTabColorScheme } = await import("../widgets/appAppearance.ts");
const setAppearance = async (value: "light" | "dark" | null) => {
  await act(async () => {
    if (value) document.documentElement.dataset.appearance = value;
    else delete document.documentElement.dataset.appearance;
    window.dispatchEvent(new dom.Event("polyth:theme") as unknown as Event);
  });
  await wait(0);
};

test("Browser pages follow the app's light/dark appearance by media emulation, never by navigating", async () => {
  localStorage.clear();
  const HOME = "http://127.0.0.1:5173/";
  const svc = createBrowserService({
    driver: createFakeDriver({ pages: { [HOME]: { title: "App", text: "home" } } }),
    allowedOrigins: () => ["http://127.0.0.1:5173"],
    resolve: async () => ["93.184.216.34"],
  });
  // An agent-opened tab: created without any scheme preference.
  const agentTab = await svc.create({ projectId: "p", sessionId: "one", url: HOME });
  assert.equal(agentTab.colorScheme, "no-preference");
  const navigations: string[] = [];
  const subscription = svc.onEvent((event) => { if (event.kind === "navigation") navigations.push(event.url ?? ""); });
  const pageScheme = async () => ((await svc.action(agentTab.id, { kind: "inspect", selector: "main" }, "user")).result as { styles?: { colorScheme?: string } }).styles?.colorScheme;
  const created: Array<string | undefined> = [];
  api.browserList = async () => svc.list();
  api.browserCapability = async () => ({ available: true, engine: "fake" });
  api.browserGet = async (id) => svc.get(id)!;
  // Mirrors the /actions route: the appearance-sync variant takes the
  // record-free service path; anything else is a normal action.
  const actions: string[] = [];
  api.browserAction = async (id, action, actor = "user") => {
    if ((action as { source?: unknown }).source === "appearance-sync" && action.kind === "color-scheme") {
      actions.push(`sync:${action.colorScheme}`);
      return { actionId: "", session: await svc.syncAppearanceColorScheme(id, action.colorScheme) };
    }
    actions.push(action.kind);
    return await svc.action(id, action, actor);
  };
  api.browserCreate = async (input) => { created.push(input.colorScheme); return await svc.create(input); };
  await setAppearance("dark");
  const view = await mount("one");
  try {
    await wait(0);
    assert.equal(svc.get(agentTab.id)?.colorScheme, "dark");
    assert.equal(await pageScheme(), "dark");

    await setAppearance("light");
    assert.equal(svc.get(agentTab.id)?.colorScheme, "light", "a theme switch follows live");
    assert.equal(await pageScheme(), "light");
    assert.deepEqual(navigations, [], "no reload or navigation to change the scheme");
    assert.deepEqual(actions.filter((kind) => kind !== "inspect"), ["sync:dark", "sync:light"], "only the record-free variant");
    assert.equal(svc.get(agentTab.id)?.url, HOME);

    // A scheme picked in this tab's device controls wins over the app.
    pinTabColorScheme(agentTab.id);
    await setAppearance("dark");
    assert.equal(svc.get(agentTab.id)?.colorScheme, "light");

    // A tab opened from a chat link starts in the app's scheme.
    await act(async () => {
      await openUrlInBrowser({ projectId: "p", sessionId: "two" }, `${HOME}`, {
        list: async () => [], create: (input) => api.browserCreate(input),
        navigate: async (id, url) => await svc.navigate(id, url, "user"),
        recalledTab: () => null, rememberTab: () => {}, openPane: () => {}, appearance: () => "dark",
      });
    });
    assert.deepEqual(created, ["dark"]);
  } finally {
    subscription.dispose();
    await view.unmount();
    await setAppearance(null);
    for (const tab of svc.list()) await svc.close(tab.id);
  }
});
