// Phone surfaces keep a presentation-only closing frame mounted through their
// exit, let a reopen cancel it, then unmount. Mounts the real navigator and
// session header (happy-dom) so the lifecycle, not just the source shape, is
// covered — including the header's Tools button, which sits next to the
// overview's exit state.
import test from "node:test";
import assert from "node:assert/strict";
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
// No stylesheet is loaded, so the exit runs on the helper's 240ms fallback.
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
const sessions: SessionProjection[] = [
  { id: "a1", projectId: "alpha", title: "Alpha session one", status: "idle", createdAt: now, updatedAt: now, lastTurnAt: now },
  { id: "a2", projectId: "alpha", title: "Alpha session two", status: "idle", createdAt: now, updatedAt: now, lastTurnAt: now },
];
(globalThis as { fetch?: unknown }).fetch = async (url: string) => {
  const u = new URL(String(url), "http://localhost:3000");
  // The navigator refresh reads the paged summaries. The server holds exactly
  // the sessions under test, so the refresh upserts rows that are already there.
  const body: unknown = u.pathname === "/api/sessions/summaries"
    ? { sessions, revision: 0, complete: true }
    : u.pathname === "/api/sessions" ? sessions : [];
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const store = await import("../src/store.ts");
const { tr } = await import("../src/i18n/index.ts");
const { getMobileWorkspaceNavigationSnapshot, hideMobileWorkspaceHome } = await import("../src/mobileWorkspaceNavigation.ts");
const { closeSessionStatusPopover, openSessionStatusPopover } = await import("../src/sessionStatusPopover.ts");
const { default: MobileNavigator } = await import("../src/components/mobile/MobileNavigator.tsx");
const { default: MobileSessionHeader } = await import("../src/components/mobile/MobileSessionHeader.tsx");
const { registerSlot } = await import("../src/slots.ts");
const { IsolationListBadge } = await import("../../../packages/git/widgets/IsolationCard.tsx");
// These tests drive the session title selector, which the fresh-install
// default (`mobileSessionTitle: "hidden"`) does not render.
const { setUiSettings } = await import("../src/uiPrefs.ts");
setUiSettings({ mobileSessionTitle: "title" });

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const click = (el: Element) => el.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
const sleep = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
/** Longer than the 240ms exit plus its one-frame tail, so a surviving timer would have fired. */
const PAST_EXIT_MS = 400;
async function waitFor(condition: () => boolean, message: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await sleep(25);
  }
}

// React reports a throwing event handler through the DOM shim rather than the
// test runner, so collect what it swallows and assert on it explicitly.
const handlerErrors: string[] = [];
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => { handlerErrors.push(args.map(String).join(" ")); };
window.addEventListener("error", (event) => {
  const { error, message } = event as ErrorEvent;
  handlerErrors.push(String(error ?? message));
});
test.after(() => { console.error = originalConsoleError; });
const thrown = () => handlerErrors.filter((line) => /ReferenceError|TypeError|is not defined|Cannot read/.test(line));

function seed() {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [{ id: "alpha", path: "/work/alpha", name: "alpha", createdAt: 1 } satisfies Project]);
  store.activateProject("alpha");
  store.setSessions("alpha", sessions);
  store.activateSession("a1");
}

test("phone session rows show one package-owned isolation lock for full, summary, and legacy sessions", async () => {
  const isolation = {
    kind: "git-worktree" as const, state: "active" as const,
    worktreePath: "/work/alpha-isolated", worktreeBranch: "polyth/isolate/full",
    targetPath: "/work/alpha", targetBranch: "main", originPath: "/work/alpha",
    baseCommit: "base", createdAt: "today",
  };
  const examples: SessionProjection[] = [
    { ...sessions[0]!, id: "full", title: "Full isolation", isolation, pinned: { position: 0 },
      status: "working", attention: { unread: 1, questions: 0, permissions: 0 } },
    { ...sessions[0]!, id: "summary", title: "Summary isolation", isolationSummary: "git-worktree" },
    { ...sessions[0]!, id: "legacy", title: "Legacy isolation", branch: "polyth/isolate/legacy" },
    { ...sessions[0]!, id: "plain", title: "Plain session", branch: "main" },
  ];
  const originalSessions = [...sessions];
  sessions.push(...examples);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const offIsolation = registerSlot("session.list.badges", "git-isolation-list-badge",
    ({ sessionId }) => createElement(IsolationListBadge, { sessionId: String(sessionId) }), 20);
  const offOther = registerSlot("session.list.badges", "other-package-badge",
    () => createElement("span", { className: "other-package-badge" }, "badge"), 10);
  try {
    seed();
    store.setSidebarOpen(true);
    await act(async () => { root.render(createElement(MobileNavigator)); });
    for (const session of examples) {
      const title = [...container.querySelectorAll(".mobile-nav-session-title")]
        .find((node) => node.textContent === session.title);
      const row = title?.closest(".mobile-nav-session-row");
      assert.ok(row, `${session.id} is visible`);
      assert.equal(row.querySelectorAll("svg.lucide-lock").length, session.id === "plain" ? 0 : 1,
        `${session.id} has exactly one isolation lock, or none when not isolated`);
      assert.equal(row.querySelectorAll(".other-package-badge").length, 1,
        "other package badges remain visible");
      if (session.id === "full") {
        assert.equal(row.querySelectorAll(".mobile-nav-pin-icon").length, 1);
        // Running outranks unread for the leading mark; unread stays as the
        // emphasised title.
        assert.ok(row.querySelector(".mobile-nav-session-lead > .mobile-nav-running-ring"));
        assert.ok(row.classList.contains("is-unread"));
      }
    }
  } finally {
    await act(async () => { root.unmount(); offIsolation(); offOther(); store.setSidebarOpen(false); });
    sessions.splice(0, sessions.length, ...originalSessions);
    container.remove();
  }
});

test("phone navigator keeps its closing frame, a reopen cancels the exit, then it unmounts", async () => {
  seed();
  store.setSidebarOpen(true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const nav = () => container.querySelector<HTMLElement>("nav.mobile-navigator");
  try {
    await act(async () => { root.render(createElement(MobileNavigator)); });
    assert.equal(nav()?.getAttribute("data-drawer-state"), "open");
    assert.ok(!nav()!.classList.contains("is-closing"));

    await act(async () => { store.setSidebarOpen(false); });
    assert.equal(nav()?.getAttribute("data-drawer-state"), "closing", "the exit frame stays mounted");
    assert.ok(nav()!.classList.contains("is-closing"));
    assert.ok(container.querySelector(".mobile-nav-backdrop.is-closing"), "the backdrop leaves with it");

    await sleep(100);
    await act(async () => { store.setSidebarOpen(true); });
    await sleep(PAST_EXIT_MS);
    assert.equal(nav()?.getAttribute("data-drawer-state"), "open", "reopening cancelled the pending unmount");

    await act(async () => { store.setSidebarOpen(false); });
    await waitFor(() => nav() === null, "the drawer unmounts once its exit finishes");
    assert.deepEqual(thrown(), []);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    store.setSidebarOpen(false);
  }
});

test("header overview keeps its full-screen exit frame and the Tools button still opens the Workspace", async () => {
  const originalTitle = sessions[0]!.title;
  sessions[0]!.title = "Компактний прозорий заголовок поточної сесії з повною назвою, яку можна прочитати в огляді";
  seed();
  hideMobileWorkspaceHome();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const selector = () => container.querySelector<HTMLButtonElement>(".mobile-session-selector")!;
  const toolsButton = () => container.querySelector<HTMLButtonElement>(`button[aria-label="${tr("mobile.island.openTools")}"]`)!;
  const sheet = () => document.querySelector<HTMLElement>(".mobile-island-sheet");
  try {
    await act(async () => { root.render(createElement(MobileSessionHeader)); });
    assert.equal(selector().getAttribute("aria-expanded"), "false");
    assert.ok(selector().getAttribute("aria-label")?.includes(sessions[0]!.title), "the accessible name retains the full title");
    assert.equal(selector().closest(".ui-glass-island"), null, "the title has no glass container");
    assert.equal(sheet(), null);

    await act(async () => { click(selector()); });
    assert.equal(selector().getAttribute("aria-expanded"), "true");
    assert.ok(sheet() && !sheet()!.classList.contains("is-closing"), "the overview opens");
    assert.ok(sheet()!.classList.contains("mobile-island-sheet--full-screen"), "the header opens the phone overview");
    assert.equal(sheet()!.querySelector(".mobile-island-current-session h2")?.textContent, sessions[0]!.title,
      "the overview reveals the current session name, even though its recent list excludes it");

    await act(async () => { click(selector()); });
    assert.equal(selector().getAttribute("aria-expanded"), "false", "aria-expanded follows the semantic state at once");
    assert.ok(sheet()?.classList.contains("is-closing"), "the exit frame stays mounted and animates out");
    assert.ok(sheet()!.classList.contains("mobile-island-sheet--full-screen"), "the exit keeps the presentation it opened with");

    await sleep(100);
    await act(async () => { click(selector()); });
    await sleep(PAST_EXIT_MS);
    assert.ok(sheet() && !sheet()!.classList.contains("is-closing"), "reopening cancelled the pending unmount");

    await act(async () => { click(selector()); });
    await waitFor(() => sheet() === null, "the overview unmounts once its exit finishes");

    // Tools while the overview is open: the overview leaves, the Workspace opens.
    await act(async () => { click(selector()); });
    assert.ok(sheet());
    await act(async () => { click(toolsButton()); });
    assert.equal(getMobileWorkspaceNavigationSnapshot().homeOpen, true, "the Tools click reached the Workspace");
    assert.equal(toolsButton().getAttribute("aria-expanded"), "true");
    assert.equal(selector().getAttribute("aria-expanded"), "false");
    await waitFor(() => sheet() === null, "the overview exit finished while the Workspace opened");
    assert.deepEqual(thrown(), []);
  } finally {
    sessions[0]!.title = originalTitle;
    hideMobileWorkspaceHome();
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("dock-opened overview keeps its compact exit frame instead of flipping to full screen", async () => {
  seed();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const sheet = () => document.querySelector<HTMLElement>(".mobile-island-sheet");
  try {
    await act(async () => { root.render(createElement(MobileSessionHeader)); });
    await act(async () => { openSessionStatusPopover(null, "dock"); });
    assert.ok(sheet() && !sheet()!.classList.contains("is-closing"), "the dock opens the overview");
    assert.ok(!sheet()!.classList.contains("mobile-island-sheet--full-screen"), "the dock opens the compact sheet");

    await act(async () => { closeSessionStatusPopover(); });
    assert.ok(sheet()?.classList.contains("is-closing"), "the exit frame stays mounted");
    assert.ok(!sheet()!.classList.contains("mobile-island-sheet--full-screen"), "closing does not flip to the full-screen variant");
    await waitFor(() => sheet() === null, "the overview unmounts once its exit finishes");
    assert.deepEqual(thrown(), []);
  } finally {
    closeSessionStatusPopover();
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
