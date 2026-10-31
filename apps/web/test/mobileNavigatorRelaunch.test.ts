// The mobile app serves its shell from a new loopback port on every launch, so
// the phone navigator's localStorage is empty each time. Mounts the real
// navigator and replays a launch: the projects the user left open and the
// "Show more" they chose must come back from the app-owned store.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { Project, SessionProjection } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  Event: dom.Event,
  getComputedStyle: (elt: Element, pseudo?: string | null) =>
    (dom as unknown as { getComputedStyle(el: Element, pseudo?: string | null): CSSStyleDeclaration })
      .getComputedStyle(elt, pseudo),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
Object.defineProperty(globalThis, "HTMLElement", {
  value: (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement,
  configurable: true,
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  value: (callback: FrameRequestCallback) => { callback(0); return 0; },
  configurable: true,
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { value: () => {}, configurable: true });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = Date.now();
const session = (projectId: string, index: number): SessionProjection => ({
  id: `${projectId}${index}`,
  projectId,
  title: `${projectId} session ${index}`,
  status: "idle",
  createdAt: now - index,
  updatedAt: now - index,
  lastTurnAt: now - index,
});
const sessions: SessionProjection[] = [
  session("alpha", 1),
  ...Array.from({ length: 5 }, (_, index) => session("beta", index + 1)),
];
// Flip on in a test: the server has a newer summary page the navigator has
// not loaded, which is what raises the navigator's remote "load more".
let summariesPaged = false;
const summaryPage = (archived: boolean) => {
  // The archive probe asks for archived rows; there are none.
  if (archived) return { sessions: [], revision: 0, complete: true };
  if (!summariesPaged) return { sessions, revision: 0, complete: true };
  const last = sessions[sessions.length - 1]!;
  return { sessions, revision: 0, complete: false, next: { id: last.id, updatedAt: last.updatedAt } };
};
(globalThis as { fetch?: unknown }).fetch = async (url: string) => {
  const u = new URL(String(url), "http://localhost:3000");
  const projectId = u.searchParams.get("projectId");
  const body: unknown = u.pathname === "/api/sessions/summaries"
    ? summaryPage(u.searchParams.get("archived") === "true")
    : u.pathname === "/api/sessions" ? sessions.filter((row) => !projectId || row.projectId === projectId) : [];
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const store = await import("../src/store.ts");
const { setClientPersistenceBackend } = await import("../src/clientPersistence.ts");
const { hydrateNavigatorState, resetNavigatorStateForTest } = await import("../src/navigatorState.ts");
const { default: MobileNavigator } = await import("../src/components/mobile/MobileNavigator.tsx");

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const click = (el: Element) => el.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(condition: () => boolean, message: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await act(async () => { await sleep(10); });
  }
}

const scope = { connectionScope: "link-a", accountId: "usr_owner" };
const records = new Map<string, string>();
const appStore = {
  async get(key: string) { return records.get(key) ?? null; },
  async set(key: string, value: string) { records.set(key, value); },
  async remove(key: string) { records.delete(key); },
};
const savedValues = () => [...records.values()];

/** A launch on a new loopback port: nothing is in the shell's localStorage. */
async function launch(options: { appStore: boolean }): Promise<void> {
  dom.localStorage.clear();
  setClientPersistenceBackend(options.appStore ? appStore : null);
  resetNavigatorStateForTest();
  if (options.appStore) assert.equal(await hydrateNavigatorState(scope), true);
}

function seed() {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [
    { id: "alpha", path: "/work/alpha", name: "alpha", createdAt: 2 } satisfies Project,
    { id: "beta", path: "/work/beta", name: "beta", createdAt: 1 } satisfies Project,
  ]);
  store.activateProject("alpha");
  store.setSessions("alpha", sessions.filter((row) => row.projectId === "alpha"));
  store.setSessions("beta", sessions.filter((row) => row.projectId === "beta"));
  store.updateSettings({ defaultVisibleSessionCount: 2 });
  store.setSidebarOpen(true);
}

async function withNavigator<T>(run: (container: HTMLElement) => Promise<T>): Promise<T> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    seed();
    await act(async () => { root.render(createElement(MobileNavigator)); });
    return await run(container);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    store.setSidebarOpen(false);
  }
}

const betaHead = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('[data-project-id="beta"] .mobile-nav-project-main')!;
const alphaHead = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('[data-project-id="alpha"] .mobile-nav-project-main')!;
const remoteMore = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>(".mobile-nav-scroll > .mobile-nav-more-sessions");
const betaRows = (container: HTMLElement) =>
  container.querySelectorAll('[data-project-id="beta"] .mobile-nav-session-row').length;
const betaButton = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[data-project-id="beta"] button.mobile-nav-more-sessions')]
    .find((button) => (button.textContent ?? "").trim() === label);

test("the phone navigator opens a relaunched app with the projects and Show more the user left", async () => {
  await launch({ appStore: true });
  await withNavigator(async (container) => {
    assert.equal(betaHead(container).getAttribute("aria-expanded"), "false", "beta starts closed");
    await act(async () => { click(betaHead(container)); });
    assert.equal(betaHead(container).getAttribute("aria-expanded"), "true");
    assert.equal(betaRows(container), 2, "the configured default is shown first");

    await act(async () => { click(betaButton(container, "Show more")!); });
    assert.equal(betaRows(container), 5, "Show more lists every loaded chat");

    await waitFor(
      () => savedValues().includes('["alpha","beta"]') && savedValues().includes('["beta"]'),
      "the open projects and the Show more choice reach the app-owned store",
    );
  });

  // The app is launched again on another port: localStorage is empty, the
  // app-owned store is not.
  await launch({ appStore: true });
  await withNavigator(async (container) => {
    assert.equal(betaHead(container).getAttribute("aria-expanded"), "true", "beta is still open");
    assert.equal(betaRows(container), 5, "beta still shows every chat");
    assert.ok(betaButton(container, "Show less"), "Show less is offered, as when the app was left");
    assert.equal(betaButton(container, "Show more"), undefined);
  });
});

test("without the app-owned store a new origin forgets them, which is what the store fixes", async () => {
  await launch({ appStore: true });
  assert.ok(savedValues().includes('["alpha","beta"]'), "the previous launch's state is in the store");

  await launch({ appStore: false });
  await withNavigator(async (container) => {
    assert.equal(betaHead(container).getAttribute("aria-expanded"), "false");
    assert.equal(betaRows(container), 0);
  });
});

test("the phone navigator's remote load-more link waits for an open session list", async () => {
  // A newer summary page exists on the server; the pager can fetch it, but the
  // footer link only makes sense while the user is looking at a session list.
  summariesPaged = true;
  try {
    await launch({ appStore: false });
    await withNavigator(async (container) => {
      // alpha is the active project and starts open, exactly as a launch leaves it.
      await waitFor(() => remoteMore(container) !== null, "an open session list offers the next remote page");

      await act(async () => { click(alphaHead(container)); });
      assert.equal(alphaHead(container).getAttribute("aria-expanded"), "false");
      assert.equal(remoteMore(container), null, "with every project collapsed there is no list to continue");

      await act(async () => { click(alphaHead(container)); });
      assert.ok(remoteMore(container), "reopening a list brings the remote page link back");
    });
  } finally {
    summariesPaged = false;
  }
});

test("the phone navigator's search grows out of its tool and folds back into it", async () => {
  const { dismissTopEscapeLayer } = await import("../src/useEscape.ts");
  await launch({ appStore: false });
  await withNavigator(async (container) => {
    const toolbar = container.querySelector(".mobile-nav-toolbar")!;
    const row = container.querySelector(".mobile-nav-toolbar-row")!;
    const bar = container.querySelector(".mobile-nav-search-bar")!;
    const tool = container.querySelector<HTMLButtonElement>(".mobile-nav-search-toggle")!;
    const input = container.querySelector<HTMLInputElement>(".mobile-nav-search input")!;
    const addProject = () => container.querySelector(".mobile-nav-scroll > .mobile-nav-add-project");
    assert.equal(bar.hasAttribute("inert"), true, "the closed field can take neither focus nor a tap");
    assert.equal(row.hasAttribute("inert"), false);
    assert.equal(tool.getAttribute("aria-expanded"), "false");
    assert.ok(addProject(), "Add project closes the list instead of taking a tool's place");

    await act(async () => { click(tool); });
    assert.ok(toolbar.classList.contains("is-searching"));
    assert.equal(tool.getAttribute("aria-expanded"), "true");
    assert.equal(bar.hasAttribute("inert"), false);
    assert.equal(row.hasAttribute("inert"), true, "the title and tools step aside while the field is open");
    assert.equal(document.activeElement, input, "the field takes focus inside the tap, so iOS raises the keyboard");
    assert.equal(addProject(), null, "search results end without the Add project row");

    await act(async () => { click(container.querySelector(".mobile-nav-search-back")!); });
    assert.ok(!toolbar.classList.contains("is-searching"));
    assert.equal(bar.hasAttribute("inert"), true);
    assert.equal(document.activeElement, tool, "focus returns to the tool the field came from");

    // Escape and Android Back close the field before the drawer.
    await act(async () => { click(tool); });
    await act(async () => { assert.equal(dismissTopEscapeLayer(), true); });
    assert.ok(!toolbar.classList.contains("is-searching"));
    assert.equal(store.getState().sidebarOpen, true, "the drawer stays open");
  });
});

test("the phone navigator unfolds the current chat's project and scrolls to it", async () => {
  // happy-dom has no layout: give the list a 300px viewport and put beta's
  // project row 600px down it, its second chat just below.
  const proto = (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement.prototype;
  const saved = (["getBoundingClientRect", "clientHeight", "scrollHeight"] as const)
    .map((name) => [name, Object.getOwnPropertyDescriptor(proto, name)] as const);
  const scrollerOf = (el: Element) => el.closest<HTMLElement>(".mobile-nav-scroll");
  const at = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top }) as DOMRect;
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      if (this.classList.contains("mobile-nav-scroll")) return at(0, 300);
      const scrolled = scrollerOf(this)?.scrollTop ?? 0;
      if (this.matches('[data-project-id="beta"] > .mobile-nav-project-head')) return at(600 - scrolled, 44);
      if (this.matches('[data-project-id="beta"] .mobile-nav-session-row.is-active')) return at(720 - scrolled, 44);
      return at(0, 0);
    },
  });
  for (const [name, value] of [["clientHeight", 300], ["scrollHeight", 2000]] as const) {
    Object.defineProperty(proto, name, {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains("mobile-nav-scroll") ? value : 0; },
    });
  }
  try {
    await launch({ appStore: false });
    await withNavigator(async (container) => {
      const scroller = container.querySelector<HTMLElement>(".mobile-nav-scroll")!;
      assert.equal(betaHead(container).getAttribute("aria-expanded"), "false", "only the active project starts open");

      // A chat in beta becomes current while the navigator is up.
      await act(async () => { store.activateSession("beta2"); });
      assert.equal(betaHead(container).getAttribute("aria-expanded"), "true", "its project unfolds");
      assert.equal(scroller.scrollTop, 600, "the project's row leads the list, its chat in view below");

      // The user folds it and scrolls away; the next opening brings it back.
      await act(async () => { click(betaHead(container)); });
      scroller.dispatchEvent(new (dom as unknown as { Event: typeof Event }).Event("pointerdown", { bubbles: true }));
      scroller.scrollTop = 0;
      assert.equal(betaHead(container).getAttribute("aria-expanded"), "false", "a fold made while open stands");
      await act(async () => { store.setSidebarOpen(false); });
      await act(async () => { store.setSidebarOpen(true); });
      assert.equal(betaHead(container).getAttribute("aria-expanded"), "true", "reopening unfolds it again");
      assert.equal(container.querySelector<HTMLElement>(".mobile-nav-scroll")!.scrollTop, 600);
    });
  } finally {
    store.activateSession(null);
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, name, descriptor);
      else delete (proto as unknown as Record<string, unknown>)[name];
    }
  }
});

test("the wide navigator and the boot sequence use the same durable state", async () => {
  const [sidebar, bootstrap] = await Promise.all([
    readFile(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/bootstrap.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(sidebar, /writeNavigatorState\(EXPANDED_PROJECTS_KEY, JSON\.stringify\(\[\.\.\.expandedTrees\]\)\)/);
  assert.doesNotMatch(sidebar, /localStorage\.(?:get|set)Item\(EXPANDED_PROJECTS_KEY/);

  // Restored before the app is allowed to render, after the app-owned store
  // exists and the account scope is known.
  const context = bootstrap.indexOf("await initializeClientReliabilityContext()");
  const restore = bootstrap.indexOf("await hydrateNavigatorState(clientAccountPersistenceScope())");
  const ready = bootstrap.indexOf("setPhase(nextPhase)");
  assert.ok(context > 0 && restore > context && ready > restore,
    "navigator state is hydrated between the client context and the first render");
});
