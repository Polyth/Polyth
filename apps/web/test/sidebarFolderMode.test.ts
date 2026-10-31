// Sidebar tree mode: projects contain worktrees, and worktrees contain
// sessions. Rail mode reuses the same SessionList for the focused project.
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
// Mutable shell width so one file can exercise both the wide persistent
// sidebar and the compact drawer without a second happy-dom instance. The
// media-query objects are created once by useShellMode, so `matches` stays a
// live getter over this value.
let shellWidth = 1400;
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    get matches() {
      if (query.includes("960px")) return shellWidth <= 960;
      if (query.includes("480px")) return shellWidth <= 480;
      return false;
    },
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
const sessionsByProject: Record<string, SessionProjection[]> = {
  alpha: [
    { id: "a1", projectId: "alpha", title: "Alpha session one", status: "idle", createdAt: now, updatedAt: now, lastTurnAt: now },
    { id: "a2", projectId: "alpha", title: "Alpha session two", status: "idle", createdAt: now, updatedAt: now, lastTurnAt: now, worktreePath: "/work/alpha-feature", branch: "feature/ui" },
  ],
  beta: [
    { id: "b1", projectId: "beta", title: "Beta session", status: "idle", createdAt: now, updatedAt: now, lastTurnAt: now },
  ],
};

(globalThis as { fetch?: unknown }).fetch = async (url: string) => {
  const u = new URL(String(url), "http://localhost:3000");
  const body: unknown = u.pathname === "/api/sessions"
    ? sessionsByProject[u.searchParams.get("projectId") ?? ""] ?? []
    : u.pathname === "/api/worktrees"
      ? [
          { path: `/work/${u.searchParams.get("projectId")}`, branch: "master", head: "a", isMain: true },
          ...(u.searchParams.get("projectId") === "alpha"
            ? [{ path: "/work/alpha-feature", branch: "feature/ui", head: "b", isMain: false }]
            : u.searchParams.get("projectId") === "worktree-pagination"
              ? [{ path: "/work/pagination-feature", branch: "feature/pagination", head: "b", isMain: false }]
            : []),
        ]
      : [];
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const store = await import("../src/store.ts");
const { getSidebarViewMode, parseSidebarViewMode, setSidebarViewMode, VIEW_MODE_KEY, DATE_GROUPS_KEY, getShowDateGroups, parseShowDateGroups, setShowDateGroups, getGroupingMode, getSessionSortMode, setSessionSortMode } = await import("../src/sidebarPrefs.ts");
const { default: Sidebar, PEEK_LEAVE_MS, RAIL_COLLAPSE_CLICK_DELAY_MS } = await import("../src/components/Sidebar.tsx");
const { default: MobileNavigator } = await import("../src/components/mobile/MobileNavigator.tsx");
const { default: SessionList } = await import("../src/components/sidebar/SessionList.tsx");
const { getSidebarLayout, setSidebarLayout, SIDEBAR_RAIL_WIDTH } = await import("../src/sidebarLayout.ts");
const { registerWorkbenchProfile } = await import("../src/workbench/profiles.ts");
const { activateWorkbenchProfile, resetWorkbenchForTest, setWorkbenchProject } = await import("../src/workbench/store.ts");
const { resetWorkbenchPrefsCache } = await import("../src/workbench/prefs.ts");

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const KeyboardEventCtor = (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
const PointerEventCtor = (dom as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
const click = (el: Element) => el.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
// React maps onPointerEnter/onPointerLeave onto native pointerover/pointerout,
// so hover intent is driven through those (relatedTarget null = from/to window).
const pointer = (el: EventTarget, type: string) =>
  el.dispatchEvent(new PointerEventCtor(type, { bubbles: true, pointerType: "mouse" }));
const contextMenu = (el: Element) => el.dispatchEvent(new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true }));
const dismissMenu = () => document.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Escape", bubbles: true }));
const menuActionLabels = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  .map((item) => item.textContent?.trim() ?? "");

const project = (id: string): Project => ({ id, path: `/work/${id}`, name: id, createdAt: 1 });

for (const presentation of ["phone", "tree", "rail", "collapsed rail", "compact rail"] as const) {
  test(`${presentation}: project clicks toggle sessions while preserving the open chat`, async () => {
    const ticket = store.beginProjectListRequest();
    store.publishProjectList(ticket, [project("alpha"), project("beta")]);
    store.activateProject("alpha");
    store.setSessions("alpha", sessionsByProject.alpha!);
    store.setSessions("beta", sessionsByProject.beta!);
    store.activateSession("a1");
    store.setSidebarOpen(true);
    const sessionIntent = store.getState().newSessionIntent;
    localStorage.setItem("polyth.sidebar.expandedProjects", '["alpha"]');
    setSidebarViewMode(presentation.includes("rail") ? "rail" : "tree");
    setSidebarLayout({ collapsed: presentation === "collapsed rail", restoreViewMode: "rail" });
    shellWidth = presentation === "phone" ? 390 : presentation === "compact rail" ? 700 : 1400;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(presentation === "phone" ? MobileNavigator : Sidebar)); });
      const selector = presentation === "phone"
        ? '[data-project-id="beta"] .mobile-nav-project-main'
        : presentation === "tree"
          ? '[data-project-id="beta"] .project-card'
          : '.sidebar-project-rail-item[aria-label="beta"]';
      const button = container.querySelector<HTMLButtonElement>(selector)!;
      assert.ok(button);
      assert.equal(button.getAttribute("aria-expanded"), "false");
      for (const expanded of [true, false, true]) {
        await act(async () => { click(button); });
        assert.equal(button.getAttribute("aria-expanded"), String(expanded));
        assert.equal(store.getState().activeProjectId, "alpha", "browsing another project preserves the workspace");
        assert.equal(store.getState().activeSessionId, "a1", "the current chat stays open");
        assert.equal(store.getState().newSessionIntent, sessionIntent, "no new chat is started");
        assert.equal(store.getState().sidebarOpen, true, "the navigator stays open");
        if (expanded) {
          const sessions = container.querySelector('[data-project-id="beta"]');
          assert.match(sessions?.parentElement?.textContent ?? "", /Beta session/);
        }
      }
      if (presentation.includes("rail")) {
        const compose = container.querySelector<HTMLButtonElement>(presentation === "compact rail"
          ? ".sidebar-drawer-tool-compose" : ".sidebar-focused-project .sidebar-header-compose")!;
        assert.equal(compose.getAttribute("aria-label"), "New chat in beta");
        await act(async () => { click(compose); });
        assert.equal(store.getState().activeProjectId, "beta", "explicit new chat opens the browsed project");
        assert.equal(store.getState().newSessionIntent?.projectId, "beta");
      }
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      shellWidth = 1400;
      setSidebarLayout({ collapsed: false });
      setSidebarViewMode("tree");
      store.setSidebarOpen(false);
      store.activateSession(null);
      localStorage.removeItem("polyth.sidebar.expandedProjects");
    }
  });
}

test("parseSidebarViewMode starts fresh installs on the project rail; setter persists and round-trips", () => {
  assert.equal(parseSidebarViewMode(null), "rail");
  assert.equal(parseSidebarViewMode("bogus"), "tree");
  assert.equal(parseSidebarViewMode("list"), "tree", "removed project list migrates to the tree");
  assert.equal(parseSidebarViewMode("folders"), "tree", "legacy folder mode migrates");
  setSidebarViewMode("tree");
  assert.equal(getSidebarViewMode(), "tree");
  assert.equal(localStorage.getItem(VIEW_MODE_KEY), "tree");
  setSidebarViewMode("rail");
  assert.equal(getSidebarViewMode(), "rail");
  assert.equal(localStorage.getItem(VIEW_MODE_KEY), "rail");
});

test("parseShowDateGroups starts fresh installs without headings; setter persists and round-trips", () => {
  assert.equal(parseShowDateGroups(null), false);
  assert.equal(parseShowDateGroups("bogus"), true);
  assert.equal(parseShowDateGroups("false"), false);
  setShowDateGroups(true);
  assert.equal(getShowDateGroups(), true);
  assert.equal(localStorage.getItem(DATE_GROUPS_KEY), "true");
  setShowDateGroups(false);
  assert.equal(getShowDateGroups(), false);
  assert.equal(localStorage.getItem(DATE_GROUPS_KEY), "false");
  setShowDateGroups(true);
});

test("session pagination uses the configured default and remembers show more/less per view", async () => {
  const previousDefault = store.getState().settings.defaultVisibleSessionCount;
  store.updateSettings({ defaultVisibleSessionCount: 6 });
  const projectId = "pagination";
  store.activateProject(projectId);
  store.setSessions(projectId, Array.from({ length: 32 }, (_, index) => ({
    id: `${projectId}-${index}`,
    projectId,
    title: `Pagination session ${index}`,
    status: "idle" as const,
    createdAt: now - index,
    updatedAt: now - index,
    lastTurnAt: now - index,
  })));
  setSidebarViewMode("rail");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(SessionList, { projectId })); });
    assert.equal(container.querySelectorAll(".session-row").length, 6, "rail starts with the configured default");

    await act(async () => { click(container.querySelector(".show-more-sessions")!); });
    assert.equal(container.querySelectorAll(".session-row").length, 12, "show more adds one configured page");
    const pagination = container.querySelector(".session-pagination");
    assert.ok(pagination?.querySelector(".show-more-sessions"), "expanded lists keep show more available");
    assert.ok(pagination?.querySelector(".show-less-sessions"), "expanded lists expose show less beside it");
    assert.equal(pagination?.querySelector(".show-more-sessions")?.textContent?.trim(), "Show more");
    assert.equal(pagination?.querySelector(".show-less-sessions")?.textContent?.trim(), "Show less");

    await act(async () => { click(container.querySelector(".show-less-sessions")!); });
    assert.equal(container.querySelectorAll(".session-row").length, 6, "show less removes one configured page");

    await act(async () => { click(container.querySelector(".show-more-sessions")!); });
    await act(async () => { setSidebarViewMode("tree"); });
    assert.equal(container.querySelectorAll(".session-row").length, 6, "tree starts with the configured default");
    await act(async () => { click(container.querySelector(".show-more-sessions")!); });
    assert.equal(container.querySelectorAll(".session-row").length, 12, "tree remembers its own expansion");

    await act(async () => { setSidebarViewMode("rail"); });
    assert.equal(container.querySelectorAll(".session-row").length, 12, "rail restores its remembered expansion");
  } finally {
    store.updateSettings({ defaultVisibleSessionCount: previousDefault });
    setSidebarViewMode("tree");
    store.setSessions(projectId, []);
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("session pagination is independent and placed at the end of each worktree", async () => {
  const previousDefault = store.getState().settings.defaultVisibleSessionCount;
  store.updateSettings({ defaultVisibleSessionCount: 3 });
  const projectId = "worktree-pagination";
  store.activateProject(projectId);
  store.setSessions(projectId, [
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `${projectId}-main-${index}`,
      projectId,
      title: `Main pagination session ${index}`,
      status: "idle" as const,
      createdAt: now - index,
      updatedAt: now - index,
      lastTurnAt: now - index,
    })),
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `${projectId}-feature-${index}`,
      projectId,
      title: `Feature pagination session ${index}`,
      status: "idle" as const,
      createdAt: now - index,
      updatedAt: now - index,
      lastTurnAt: now - index,
      worktreePath: "/work/pagination-feature",
      branch: "feature/pagination",
    })),
  ]);
  setSidebarViewMode("tree");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(SessionList, { projectId })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const main = container.querySelector<HTMLElement>(".session-project-sessions");
    const feature = container.querySelector<HTMLElement>('[data-worktree="/work/pagination-feature"]');
    assert.ok(main, "the main worktree session group is present");
    assert.ok(feature, "the linked worktree session group is present");
    assert.equal(main?.querySelectorAll(".session-row").length, 3);
    assert.equal(feature?.querySelectorAll(".session-row").length, 3);

    const mainPagination = main?.querySelector<HTMLElement>(".session-pagination");
    const featurePagination = feature?.querySelector<HTMLElement>(".session-pagination");
    assert.ok(mainPagination, "main worktree has its own pagination");
    assert.ok(featurePagination, "linked worktree has its own pagination");
    assert.equal(main?.lastElementChild, mainPagination, "main pagination follows its sessions");
    const featureSessions = feature?.querySelector<HTMLElement>(".session-worktree-sessions");
    assert.equal(featureSessions?.lastElementChild, featurePagination, "linked pagination follows its sessions");
    assert.equal(container.querySelectorAll(".session-org > .session-pagination").length, 0, "no project-wide pagination remains");

    await act(async () => { click(featurePagination!.querySelector(".show-more-sessions")!); });
    assert.equal(main?.querySelectorAll(".session-row").length, 3, "expanding one worktree leaves main unchanged");
    assert.equal(feature?.querySelectorAll(".session-row").length, 5, "linked worktree expands independently");

    await act(async () => { click(mainPagination!.querySelector(".show-more-sessions")!); });
    assert.equal(main?.querySelectorAll(".session-row").length, 5, "main worktree expands independently");
    assert.equal(feature?.querySelectorAll(".session-row").length, 5, "linked expansion remains intact");
  } finally {
    store.updateSettings({ defaultVisibleSessionCount: previousDefault });
    store.setSessions(projectId, []);
    setSidebarViewMode("tree");
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("remote projects are marked separately from local projects in the sidebar", async () => {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [
    project("local"),
    {
      ...project("remote"),
      remote: { kind: "ssh", connectionId: "ssh_1" },
    },
  ]);
  store.activateProject("local");
  setSidebarViewMode("tree");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Sidebar)); });

    const localCard = [...container.querySelectorAll<HTMLElement>(".project-card")]
      .find((card) => (card.textContent ?? "").includes("local"));
    const remoteCard = [...container.querySelectorAll<HTMLElement>(".project-card")]
      .find((card) => (card.textContent ?? "").includes("remote"));
    const marker = remoteCard?.querySelector<HTMLElement>(".project-remote-marker");

    assert.equal(localCard?.querySelector(".project-remote-marker"), null);
    assert.equal(marker?.getAttribute("aria-label"), "Remote project");
    // Badge is an overlay on the project glyph, not an inline label next to the name.
    assert.equal(remoteCard?.querySelector(".project-name-line .project-remote-marker"), null);
    assert.ok(remoteCard?.querySelector(".project-glyph .project-remote-marker"));
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("setSessions merges per project — one project's refresh keeps the others", () => {
  store.setSessions("alpha", sessionsByProject.alpha!);
  store.setSessions("beta", sessionsByProject.beta!);
  assert.equal(store.getState().sessions.length, 3);
  // Refreshing alpha with one session must not evict beta's.
  store.setSessions("alpha", [sessionsByProject.alpha![0]!]);
  const ids = store.getState().sessions.map((s) => s.id).sort();
  assert.deepEqual(ids, ["a1", "b1"]);
});

test("tree mode nests sessions under project worktrees", async () => {
  // Two ready projects; alpha is active.
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [project("alpha"), project("beta")]);
  store.activateProject("alpha");
  store.setSessions("alpha", sessionsByProject.alpha!);
  store.setSessions("beta", sessionsByProject.beta!);
  store.setGitBranch("trunk");
  setSidebarViewMode("tree");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Sidebar)); });

    // The toolbar edit pencil sits in the top toolbar; no empty footer bar.
    assert.ok(
      container.querySelector(".sidebar-service-bar .zone-edit-button"),
      "tree view keeps the edit pencil in the top toolbar",
    );
    assert.equal(container.querySelector(".sidebar-footer-bar"), null, "no reserved bottom footer bar");

    const options = container.querySelector<HTMLElement>('[aria-label="More sidebar actions"]');
    assert.ok(options, "desktop exposes the persisted sidebar presentation menu");
    await act(async () => { click(options!); });
    const railOption = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .find((item) => item.textContent?.trim() === "Project rail");
    assert.ok(railOption, "the new project-rail presentation is user selectable");
    assert.equal(
      [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
        .some((item) => item.textContent?.trim() === "Project list"),
      false,
      "the removed project-list presentation is not user selectable",
    );
    await act(async () => { click(railOption!); });
    assert.equal(getSidebarViewMode(), "rail");
    assert.ok(container.querySelector(".sidebar-project-rail"));
    assert.equal(container.querySelector(".session-list .session-org"), null, "the removed project list is not rendered");
    assert.equal(container.querySelector(".branch-row"), null, "the project root never exposes its current branch");
    const toggle = container.querySelector<HTMLElement>('[aria-label="Toggle project tree view"]');
    assert.equal(toggle, null, "desktop renders no sidebar footer controls");

    // Tree mode: projects become expandable roots and the active project's
    // worktrees are already visible.
    await act(async () => { setSidebarViewMode("tree"); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(localStorage.getItem(VIEW_MODE_KEY), "tree");
    const trees = [...container.querySelectorAll(".project-tree-node")];
    assert.equal(trees.length, 2, "each project renders as a tree root");
    const alphaTree = trees.find((tree) => (tree.textContent ?? "").includes("alpha"))!;
    assert.ok(
      alphaTree.querySelector(".project-tree-sessions .session-org"),
      "active project tree nests the real SessionList",
    );
    assert.match(alphaTree.textContent ?? "", /Alpha session one/);
    assert.equal(alphaTree.querySelector(".session-date-divider"), null, "the most recent session group has no date divider");
    assert.doesNotMatch(alphaTree.textContent ?? "", /master/, "the project root does not expose its current branch");
    assert.match(alphaTree.textContent ?? "", /feature\/ui/);
    const betaTree = trees.find((tree) => (tree.textContent ?? "").includes("beta"))!;
    assert.equal(betaTree.querySelector(".project-tree-sessions"), null, "other projects start collapsed");
    const betaCard = betaTree.querySelector<HTMLElement>(".project-card")!;
    assert.equal(betaCard.getAttribute("aria-expanded"), "false");

    // Per-project expand reveals that project's sessions.
    await act(async () => { click(betaCard); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(betaCard.getAttribute("aria-expanded"), "true");
    assert.match(betaTree.textContent ?? "", /Beta session/);
    assert.equal(container.querySelector(".side-folder-bar"), null, "folder toolbar is removed");

    // Rail mode keeps every project reachable in a compact switcher while
    // the detail pane renders only the selected project's real SessionList.
    await act(async () => { store.activateProject("alpha"); });
    await act(async () => { setSidebarViewMode("rail"); });
    const rail = container.querySelector(".sidebar-project-rail");
    assert.ok(rail, "desktop rail mode renders the project switcher");
    assert.equal(rail.querySelectorAll(".sidebar-project-rail-item").length, 2);
    const focused = container.querySelector(".sidebar-focused-project");
    assert.equal(focused?.querySelector(".project-name")?.textContent, "alpha");
    assert.match(container.querySelector(".sidebar-focused-sessions")?.textContent ?? "", /Alpha session one/);
    assert.doesNotMatch(focused?.textContent ?? "", /Beta session/);
    const railMain = container.querySelector<HTMLElement>(".sidebar-main")!;
    // The sessions column's content sits in its `display: contents` direction
    // wrapper (a mirrored shell gives it the document direction back).
    const railContent = railMain.querySelector<HTMLElement>(":scope > .sidebar-main-content")!;
    assert.ok(railContent, "the sessions column keeps one content wrapper");
    const railMainChildren = [...railContent.children];
    assert.equal(railMainChildren.findIndex((child) => child.classList.contains("sidebar-focused-project")), 0);
    assert.equal(railMainChildren.findIndex((child) => child.classList.contains("sidebar-service-bar")), -1,
      "the rail has no toolbar row of its own while the project row is shown");
    assert.equal(railMainChildren.findIndex((child) => child.classList.contains("side-scroll")), 1);

    const sessionIntent = store.getState().newSessionIntent;
    await act(async () => { click(focused!.querySelector(".project-card")!); });
    const railToggle = container.querySelector<HTMLElement>(".sidebar-rail-toggle")!;
    assert.equal(railToggle.getAttribute("aria-expanded"), "false", "clicking the open project hides its sessions");
    assert.equal(store.getState().newSessionIntent, sessionIntent, "clicking the open project does not start a session");
    await act(async () => { click(railToggle); });

    const betaRail = rail.querySelector<HTMLElement>('[aria-label="beta"]');
    assert.ok(betaRail);
    await act(async () => { click(betaRail!); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(betaRail?.getAttribute("aria-current"), null, "browsing beta does not activate it");
    assert.equal(betaRail?.getAttribute("aria-expanded"), "true");
    assert.equal(store.getState().activeProjectId, "alpha");
    assert.equal(container.querySelector(".sidebar-focused-project .project-name")?.textContent, "beta");
    assert.match(container.querySelector(".sidebar-focused-sessions")?.textContent ?? "", /Beta session/);

    // Tree mode remains the only full-width project presentation.
    await act(async () => { setSidebarViewMode("tree"); });
    assert.equal(container.querySelectorAll(".project-tree-node").length, 2);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("focused project rail keeps the active project's worktrees visible", async () => {
  const profileId = "rail-worktree-test";
  const projectId = "rail-worktree-project";
  const off = registerWorkbenchProfile({
    id: profileId,
    label: "Rail worktree test",
    description: "",
    order: 99,
    defaultLayout: { surfaces: [{ surface: "session", region: "primary", active: true }] },
    presentation: { navigation: "primary", sidebar: "projects" },
    sessionPurpose: "rail-worktree-test",
  });
  try {
    resetWorkbenchPrefsCache();
    resetWorkbenchForTest();
    const ticket = store.beginProjectListRequest();
    store.publishProjectList(ticket, [project(projectId)]);
    store.activateProject(projectId);
    setWorkbenchProject(projectId);
    activateWorkbenchProfile(profileId);
    store.setSessions(projectId, [{
      id: "rail-worktree-session",
      projectId,
      title: "Rail worktree session",
      purpose: "rail-worktree-test",
      status: "idle",
      createdAt: now,
      updatedAt: now,
      worktreePath: "/work/rail-feature",
      branch: "feature/rail",
    }]);
    setSidebarViewMode("tree");
    setSidebarLayout({ collapsed: true, width: 332 });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(Sidebar)); });
      assert.equal(container.querySelector(".sidebar--rail-collapsed"), null, "focused rail keeps the worktree detail pane open");
      assert.equal(container.querySelector(".sidebar-sessions-peek"), null, "worktrees are not hidden behind the hover peek");
      assert.match(container.querySelector(".sidebar-focused-sessions")?.textContent ?? "", /feature\/rail/);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  } finally {
    off();
    resetWorkbenchPrefsCache();
    resetWorkbenchForTest();
    setWorkbenchProject(null);
    localStorage.removeItem(`polyth.workbenchLayout.v1.${projectId}`);
    setSidebarViewMode("tree");
    setSidebarLayout({ collapsed: false });
  }
});

test("phone navigator in a purpose lane names the lane, says when a project has none of its chats, and leads back to Chat", async () => {
  // Opening a Playground chat moves the phone into the Playground lane, which
  // lists only Playground chats. The header's lane switch is hidden on a
  // phone, so without this every other project expanded onto an empty gap.
  const profileId = "phone-lane-test";
  const off = registerWorkbenchProfile({
    id: profileId,
    label: "Lane test",
    description: "",
    order: 99,
    defaultLayout: { surfaces: [{ surface: "session", region: "primary", active: true }] },
    presentation: { navigation: "primary" },
    sessionPurpose: profileId,
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    resetWorkbenchPrefsCache();
    resetWorkbenchForTest();
    const ticket = store.beginProjectListRequest();
    store.publishProjectList(ticket, [project("lane-plain"), project("lane-own")]);
    store.activateProject("lane-own");
    setWorkbenchProject("lane-own");
    store.setSessions("lane-plain", [{ id: "lane-plain-chat", projectId: "lane-plain", title: "Ordinary chat", status: "idle", createdAt: now, updatedAt: now }]);
    store.setSessions("lane-own", [{ id: "lane-own-chat", projectId: "lane-own", title: "Lane chat", purpose: profileId, status: "idle", createdAt: now, updatedAt: now }]);
    activateWorkbenchProfile(profileId);
    localStorage.setItem("polyth.sidebar.expandedProjects", '["lane-plain","lane-own"]');
    store.setSidebarOpen(true);
    await act(async () => { root.render(createElement(MobileNavigator)); });

    const lanes = () => container.querySelector(".mobile-nav-lanes");
    const titles = () => [...container.querySelectorAll(".mobile-nav-session-title")].map((node) => node.textContent);
    assert.equal(lanes()?.querySelector('[aria-pressed="true"]')?.textContent, "Lane test", "the active lane is named");
    assert.deepEqual(titles(), ["Lane chat"], "the lane lists only its own chats");
    assert.ok(container.querySelector('[data-project-id="lane-plain"] .mobile-nav-project-empty'),
      "a project with none of the lane's chats says so instead of expanding onto nothing");

    await act(async () => { click(lanes()!.querySelector('[aria-pressed="false"]')!); });
    assert.equal(lanes(), null, "Chat is the ordinary lane, with no lane switch");
    assert.deepEqual(titles(), ["Ordinary chat"], "ordinary chats are back");
    assert.equal(container.querySelector(".mobile-nav-project-empty")?.closest("[data-project-id]")?.getAttribute("data-project-id"), "lane-own");
  } finally {
    await act(async () => { root.unmount(); store.setSidebarOpen(false); });
    container.remove();
    off();
    localStorage.removeItem("polyth.sidebar.expandedProjects");
    resetWorkbenchPrefsCache();
    resetWorkbenchForTest();
    setWorkbenchProject(null);
  }
});

test("expanding a collapsed project tree restores the tree instead of the project rail", async () => {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [project("tree-return")]);
  store.activateProject("tree-return");
  store.setSessions("tree-return", [{
    id: "tree-return-session",
    projectId: "tree-return",
    title: "Tree return session",
    status: "idle",
    createdAt: now,
    updatedAt: now,
  }]);
  setSidebarViewMode("tree");
  setSidebarLayout({ collapsed: false, width: 332 });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Sidebar)); });
    const treeCollapse = container.querySelector<HTMLButtonElement>(".sidebar-collapse");
    assert.ok(treeCollapse, "tree mode exposes the full-sidebar collapse control");
    await act(async () => { click(treeCollapse!); });
    assert.equal(container.querySelector(".project-tree-node"), null, "the tree is replaced by the rail");
    assert.ok(container.querySelector(".sidebar-project-rail"), "tree collapse switches to Project rail");
    assert.ok(container.querySelector(".sidebar--rail-collapsed"), "tree collapse hides the sessions column");
    // The column leaves with the width transition, clipped in flow, and
    // only becomes the peek once the navigator has narrowed.
    const nav = container.querySelector<HTMLElement>(".sidebar")!;
    assert.ok(nav.classList.contains("sidebar--rail-motion"), "the navigator clips the leaving column");
    assert.ok(container.querySelector(".sidebar-main--leaving"), "the column fades in place");
    assert.equal(container.querySelector(".sidebar-sessions-peek"), null, "the column never jumps out as the peek mid-collapse");
    await act(async () => {
      nav.dispatchEvent(Object.assign(new (dom as unknown as { Event: typeof Event }).Event("transitionend", { bubbles: true }), { propertyName: "width" }));
    });
    assert.equal(nav.classList.contains("sidebar--rail-motion"), false);
    assert.ok(container.querySelector(".sidebar-sessions-peek"), "the collapsed rail keeps sessions in its hover peek");
    const railToggle = container.querySelector<HTMLButtonElement>(".sidebar-rail-toggle");
    assert.equal(railToggle?.getAttribute("aria-expanded"), "false");
    assert.equal(getSidebarViewMode(), "tree", "collapsing the tree keeps Tree as the selected presentation");
    assert.equal(getSidebarLayout().restoreViewMode, "tree");

    await act(async () => { click(railToggle!); });
    assert.equal(container.querySelectorAll(".project-tree-node").length, 1, "expanding restores the project tree");
    assert.equal(container.querySelector(".sidebar-project-rail"), null, "expanding does not keep the Project rail selected");
    assert.equal(container.querySelector(".sidebar-collapsed-rail"), null, "tree mode is not left fully collapsed");
    assert.equal(
      container.querySelector(".sidebar-collapse")?.getAttribute("aria-label"),
      "Collapse Projects and sessions",
      "the original project-tree control returns",
    );

    await act(async () => { setSidebarViewMode("rail"); });
    const expandedRailToggle = container.querySelector<HTMLButtonElement>(".sidebar-rail-toggle");
    assert.equal(expandedRailToggle?.getAttribute("aria-expanded"), "true");
    assert.match(
      expandedRailToggle?.getAttribute("aria-label") ?? "",
      /^Collapse Projects and sessions .*Project rail/,
      "the expanded rail control names the project-rail collapse action",
    );
    await act(async () => { click(expandedRailToggle!); });
    assert.equal(container.querySelector(".sidebar-rail-toggle")?.getAttribute("aria-expanded"), "false");
    assert.equal(getSidebarLayout().restoreViewMode, "rail", "an explicitly selected rail remembers itself");
    await act(async () => { click(container.querySelector<HTMLButtonElement>(".sidebar-rail-toggle")!); });
    assert.equal(getSidebarViewMode(), "rail", "expanding an explicitly selected rail keeps the rail");

    await act(async () => { setSidebarLayout({ collapsed: true, restoreViewMode: null }); });
    await act(async () => { click(container.querySelector<HTMLButtonElement>(".sidebar-rail-toggle")!); });
    assert.equal(getSidebarViewMode(), "tree", "an old unmarked collapsed rail restores the former tree presentation");
    assert.equal(container.querySelectorAll(".project-tree-node").length, 1);
  } finally {
    setSidebarViewMode("tree");
    setSidebarLayout({ collapsed: false });
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("project name and icon open the same actions menu in tree and rail views", async () => {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [project("alpha"), project("beta")]);
  store.activateProject("alpha");
  store.setSessions("alpha", sessionsByProject.alpha!);
  store.setSessions("beta", sessionsByProject.beta!);
  setSidebarViewMode("tree");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Sidebar)); });
    const alphaCard = [...container.querySelectorAll<HTMLElement>(".project-card")]
      .find((card) => (card.textContent ?? "").includes("alpha"))!;
    const ellipsis = container.querySelector<HTMLButtonElement>('[aria-label="Actions for alpha"]')!;

    await act(async () => { click(ellipsis); });
    const ellipsisLabels = menuActionLabels();
    assert.ok(ellipsisLabels.includes("Select sessions"));
    assert.ok(ellipsisLabels.includes("Close project"));
    await act(async () => { dismissMenu(); });

    await act(async () => { contextMenu(alphaCard.querySelector(".project-name")!); });
    assert.deepEqual(menuActionLabels(), ellipsisLabels, "the project name uses the same menu entries");
    await act(async () => { dismissMenu(); });

    await act(async () => { contextMenu(alphaCard.querySelector(".project-glyph")!); });
    assert.deepEqual(menuActionLabels(), ellipsisLabels, "the project icon uses the same menu entries");
    await act(async () => { dismissMenu(); });

    await act(async () => { setSidebarViewMode("rail"); });
    const railAlpha = container.querySelector<HTMLElement>('.sidebar-project-rail-item[aria-label="alpha"]')!;
    await act(async () => { contextMenu(railAlpha.querySelector(".project-glyph")!); });
    assert.deepEqual(menuActionLabels(), ellipsisLabels, "the rail icon uses the same menu entries");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("rail project icons show a compact named hover card without a native title", async () => {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [project("alpha"), project("beta")]);
  store.activateProject("alpha");
  setSidebarViewMode("rail");
  setSidebarLayout({ collapsed: false, width: 332 });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Sidebar)); });

    const railAlpha = container.querySelector<HTMLButtonElement>('.sidebar-project-rail-item[aria-label="alpha"]');
    assert.ok(railAlpha);
    assert.equal(railAlpha?.getAttribute("title"), "", "the native delayed title is suppressed");

    // Focus is the keyboard-accessible equivalent of hover and must reveal the
    // same project identity immediately.
    await act(async () => { railAlpha!.focus(); });
    const tooltip = document.body.querySelector<HTMLElement>(".sidebar-project-rail-tooltip");
    assert.ok(tooltip, "rail project focus shows the named tooltip card");
    assert.equal(tooltip?.querySelector("strong")?.textContent, "alpha");
    assert.equal(tooltip?.querySelector(".sidebar-project-rail-tooltip-copy > span")?.textContent, "/work/alpha");
    assert.equal(tooltip?.getAttribute("data-side"), "right", "the card is anchored beside the project icon");
  } finally {
    setSidebarLayout({ collapsed: false });
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("project menu selection keeps one multi-session selection across projects", async () => {
  localStorage.setItem("polyth.sidebar.expandedProjects", '["alpha"]');
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [project("alpha"), project("beta")]);
  store.activateProject("alpha");
  store.setSessions("alpha", sessionsByProject.alpha!);
  store.setSessions("beta", sessionsByProject.beta!);
  setSidebarViewMode("tree");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Sidebar)); });

    const serviceBar = container.querySelector<HTMLElement>(".sidebar-service-bar");
    const menu = container.querySelector<HTMLButtonElement>('[aria-label="Actions for alpha"]');
    assert.ok(menu, "the project row exposes its own actions");
    await act(async () => { click(menu!); });
    // The project menu renders through a ui/Menu portal on document.body.
    const select = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.trim() === "Select sessions");
    assert.ok(select, "session selection lives in the project action menu");
    assert.equal(serviceBar?.querySelector(".sidebar-title"), null, "the service bar has no visible Sessions title");
    assert.equal(container.querySelector(".sr-only")?.textContent, "Projects and sessions", "the sidebar retains its accessible heading");

    await act(async () => { click(select!); });

    const alphaCheck = container.querySelector<HTMLInputElement>('[aria-label="Select Alpha session one"]');
    assert.ok(alphaCheck, "active-project sessions expose checkboxes");
    await act(async () => { click(alphaCheck!); });
    assert.match(container.querySelector(".session-bulk-actions")?.textContent ?? "", /1 selected/);

    const betaCard = [...container.querySelectorAll<HTMLElement>(".project-card")]
      .find((card) => (card.textContent ?? "").includes("beta"));
    assert.ok(betaCard, "another project remains available while selecting");
    await act(async () => { click(betaCard!); });
    await act(async () => { await Promise.resolve(); });

    const betaCheck = container.querySelector<HTMLInputElement>('[aria-label="Select Beta session"]');
    assert.ok(betaCheck, "sessions from another project use the same selection mode");
    await act(async () => { click(betaCheck!); });
    assert.match(container.querySelector(".session-bulk-actions")?.textContent ?? "", /2 selected/);
    assert.equal(
      container.querySelectorAll<HTMLInputElement>(".session-check:checked").length,
      2,
      "both expanded projects reflect their selected sessions while the selection remains retained",
    );
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("the rail switch collapses only the sessions, which peek back on hover", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [project("alpha"), project("beta")]);
  store.activateProject("alpha");
  store.setSessions("alpha", sessionsByProject.alpha!);
  store.setSessions("beta", sessionsByProject.beta!);
  setSidebarViewMode("rail");
  setSidebarLayout({ collapsed: true, width: 332, restoreViewMode: "rail" });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Sidebar)); });

    // Collapsed rail view keeps the project icons; only the sessions go away.
    const rail = container.querySelector(".sidebar-project-rail");
    assert.ok(rail, "the project icon rail survives the sessions-only collapse");
    assert.equal(container.querySelector(".sidebar-collapsed-rail"), null, "rail view never falls back to the thin rail");
    const toggle = container.querySelector<HTMLButtonElement>(".sidebar-rail-toggle");
    assert.equal(toggle?.getAttribute("aria-expanded"), "false", "the collapse control reports the sessions column as collapsed");
    assert.ok(toggle?.querySelector("svg.ui-icon"), "the rail toggle keeps one panel glyph in both states");
    const peek = container.querySelector<HTMLElement>(".sidebar-sessions-peek")!;
    assert.ok(peek, "the sessions live in a peek panel while collapsed");
    assert.equal(peek.classList.contains("open"), false);

    // Hovering a project opens the peek at once.
    const betaRail = rail!.querySelector<HTMLElement>('[aria-label="beta"]')!;
    await act(async () => { pointer(betaRail, "pointerover"); });
    assert.equal(peek.classList.contains("open"), true, "the peek opens on hover without a delay");
    assert.match(peek.textContent ?? "", /Beta session/, "the peek previews the hovered project");
    assert.equal(store.getState().activeProjectId, "alpha", "previewing never steals the active project");
    // The open peek's header names the project; the rail's tooltip would only
    // cover it with the same name and path.
    await act(async () => { betaRail.focus(); });
    assert.equal(document.querySelectorAll(".sidebar-project-rail-tooltip").length, 0, "the open peek holds the rail tooltip back");
    await act(async () => { betaRail.blur(); });

    const resize = peek.querySelector<HTMLElement>(".sidebar-resize--peek");
    assert.ok(resize, "the open peek exposes its resize handle at the outer edge");
    await act(async () => {
      resize.dispatchEvent(new MouseEventCtor("mousedown", { bubbles: true, clientX: 100 }));
      window.dispatchEvent(new MouseEventCtor("mousemove", { bubbles: true, clientX: 132 }));
      window.dispatchEvent(new MouseEventCtor("mouseup", { bubbles: true, clientX: 132 }));
    });
    assert.equal(
      peek.style.width,
      `${332 + 32 - SIDEBAR_RAIL_WIDTH}px`,
      "dragging the peek edge resizes the sessions column; the rail track is not part of it",
    );

    // Untouched, it closes five seconds after the pointer leaves the sidebar.
    await act(async () => { pointer(betaRail, "pointerout"); });
    await act(async () => { t.mock.timers.tick(PEEK_LEAVE_MS - 1); });
    assert.equal(peek.classList.contains("open"), true, "the grace period is honoured in full");
    await act(async () => { t.mock.timers.tick(1); });
    assert.equal(peek.classList.contains("open"), false);
    await act(async () => { betaRail.focus(); });
    assert.equal(document.querySelectorAll(".sidebar-project-rail-tooltip").length, 1, "with the peek closed the tooltip names the project");
    await act(async () => { betaRail.blur(); });

    // Interacted with, it stays until a click outside — leaving does not close it.
    await act(async () => { pointer(betaRail, "pointerover"); });
    const betaSession = peek.querySelector<HTMLButtonElement>('[aria-label="Open Beta session"]')!;
    await act(async () => {
      pointer(betaSession, "pointerdown");
      click(betaSession);
      await Promise.resolve();
    });
    assert.equal(peek.classList.contains("open"), true, "clicking a session keeps the interacted peek open");
    // A pinned peek re-targets across the rail without losing its pin.
    await act(async () => { pointer(rail!.querySelector<HTMLElement>('[aria-label="alpha"]')!, "pointerover"); });
    assert.match(peek.textContent ?? "", /Alpha session one/, "hovering another project re-targets the peek");
    await act(async () => { pointer(betaRail, "pointerout"); });
    await act(async () => { t.mock.timers.tick(PEEK_LEAVE_MS * 2); });
    assert.equal(peek.classList.contains("open"), true, "a touched peek ignores the leave timer");
    await act(async () => { pointer(document.body, "pointerdown"); });
    assert.equal(peek.classList.contains("open"), false, "a click outside dismisses the pinned peek");

    // Switching back on restores the inline sessions column.
    await act(async () => { click(toggle!); });
    assert.equal(toggle?.getAttribute("aria-expanded"), "true");
    assert.equal(container.querySelector(".sidebar-sessions-peek"), null);
    assert.equal(container.querySelector(".sidebar-focused-project .project-name")?.textContent, "beta");
    assert.match(container.querySelector(".sidebar-focused-sessions")?.textContent ?? "", /Beta session/);
  } finally {
    setSidebarLayout({ collapsed: false });
    await act(async () => { root.unmount(); });
    container.remove();
    t.mock.timers.reset();
  }
});

test("session list options group and sort chats through two drill-in rows", async () => {
  const now = Date.now();
  const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [project("alpha")]);
  store.activateProject("alpha");
  store.setSessions("alpha", [
    {
      id: "a-pin", projectId: "alpha", title: "Pinned chat", status: "idle",
      createdAt: now, updatedAt: now, pinned: { position: 0 },
    },
    {
      id: "a-today", projectId: "alpha", title: "Today chat", status: "idle",
      createdAt: now, updatedAt: now, lastTurnAt: now,
    },
    {
      id: "a-older", projectId: "alpha", title: "Older chat", status: "idle",
      createdAt: twoDaysAgo, updatedAt: twoDaysAgo, lastTurnAt: twoDaysAgo, isolationSummary: "git-worktree",
    },
  ]);
  setSidebarViewMode("tree");
  setShowDateGroups(true);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const headings = () => [...container.querySelectorAll(".session-date-divider:not(.session-pinned-divider)")]
    .map((heading) => heading.textContent?.trim());
  const rowTitles = () => [...container.querySelectorAll(".session-worktree-sessions .session-row")]
    .map((row) => row.querySelector(".session-title")?.textContent?.trim() ?? row.textContent?.trim());
  const items = () => [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
  const item = (text: string) => items().find((entry) => entry.textContent?.trim().startsWith(text));
  const openOptions = async () => {
    const options = container.querySelector<HTMLElement>('[aria-label="More sidebar actions"]');
    assert.ok(options);
    await act(async () => { click(options!); });
  };
  try {
    await act(async () => { root.render(createElement(Sidebar)); });
    assert.equal(headings().length, 1, "older days keep a date heading; today draws none");
    assert.ok(container.querySelector(".session-pinned-divider"), "pinned chats keep their own heading");

    await openOptions();
    // One row per setting, naming the current choice; the old switch is gone.
    assert.equal(item("Date groups"), undefined);
    const groupBy = item("Group by");
    assert.ok(groupBy, "the options menu offers Group by");
    assert.equal(groupBy!.getAttribute("aria-haspopup"), "menu");
    assert.match(groupBy!.textContent ?? "", /Date/);
    assert.match(item("Sort by")?.textContent ?? "", /Recent activity/);

    await act(async () => { click(groupBy!); });
    // The drilled-in list replaces the menu: Back, then the choices.
    assert.deepEqual(items().map((entry) => entry.textContent?.trim()), ["Group by", "None", "Date", "Type"]);
    assert.equal(item("Date")!.getAttribute("aria-checked"), "true");
    assert.equal(item("Sort by"), undefined);
    await act(async () => { click(item("Type")!); });
    assert.equal(getGroupingMode(), "type");
    assert.equal(document.querySelector('[role="menu"]'), null, "a choice closes the menu");
    assert.deepEqual(headings(), ["Isolated", "Shared workspace"]);
    assert.deepEqual(rowTitles().map((title) => title?.replace(/\s.*$/, "")), ["Older", "Today"]);

    // Keyboard: ArrowRight drills in, ArrowLeft comes back to the same row.
    await openOptions();
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    item("Sort by")!.focus();
    await act(async () => {
      item("Sort by")!.dispatchEvent(new KeyboardEventCtor("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    assert.deepEqual(items().map((entry) => entry.textContent?.trim()),
      ["Sort by", "Recent activity", "Date created", "Title", "Type"]);
    await act(async () => {
      menu.dispatchEvent(new KeyboardEventCtor("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    });
    assert.ok(item("Group by"), "ArrowLeft returns to the top level");
    await act(async () => { click(item("Sort by")!); });
    await act(async () => { click(item("Title")!); });
    assert.equal(getSessionSortMode(), "title");

    await openOptions();
    await act(async () => { click(item("Group by")!); });
    await act(async () => { click(item("None")!); });
    assert.deepEqual(headings(), [], "ungrouped chats draw no headings");
    assert.ok(container.querySelector(".session-pinned-divider"));
    assert.match(container.textContent ?? "", /Today chat/);
    assert.match(container.textContent ?? "", /Older chat/);
    assert.match(container.textContent ?? "", /Pinned chat/);
  } finally {
    setSessionSortMode("recent");
    setShowDateGroups(true);
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("desktop rail: the project row is the header and search opens in its place", async () => {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [project("alpha"), project("beta")]);
  store.activateProject("alpha");
  store.setSessions("alpha", sessionsByProject.alpha!);
  store.setSessions("beta", sessionsByProject.beta!);
  setSidebarViewMode("rail");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const FocusEventCtor = (dom as unknown as { FocusEvent: typeof FocusEvent }).FocusEvent;
  const typeQuery = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new (dom as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
  };
  try {
    await act(async () => { root.render(createElement(Sidebar)); });

    const header = () => container.querySelector<HTMLElement>(".sidebar-focused-project[data-tools]");
    const bar = () => container.querySelector<HTMLElement>(".sidebar-service-bar");
    assert.ok(header(), "the focused project row is the column's header");
    assert.equal(bar(), null, "no separate toolbar row under it");
    assert.deepEqual(
      [...header()!.querySelectorAll<HTMLButtonElement>(".project-actions button")]
        .filter((button) => getComputedStyle(button).display !== "none" && !button.classList.contains("project-new-session"))
        // The toolbar's Customize pencil shows only in Edit mode / Shift.
        .filter((button) => !button.classList.contains("zone-customize-trigger"))
        .map((button) => button.getAttribute("aria-label")),
      ["Search projects, worktrees, and sessions", "New chat in alpha", "More sidebar actions", "Actions for alpha"],
      "search, new chat, list options, then the project's ⋮",
    );
    assert.ok(
      header()!.querySelector('.sidebar-header-tools > .zone-customize-trigger[aria-label="Customize Sidebar"]'),
      "the sessions toolbar keeps its own editor; the rail's pencil edits the rail",
    );
    const options = header()!.querySelector<HTMLElement>('[aria-label="More sidebar actions"]')!;
    assert.equal(options.classList.contains("active"), false, "the rail layout alone does not light the list options");
    assert.equal(container.querySelector(".sidebar-select-toggle"), null, "selection lives in the project's ⋮ menu");

    // Search takes the header row; the project row comes back when it closes.
    await act(async () => { click(header()!.querySelector(".sidebar-header-search")!); });
    assert.equal(header(), null, "the field replaces the project row");
    assert.ok(bar()?.hasAttribute("data-rail"), "the search row is the rail's toolbar row");
    const input = bar()!.querySelector<HTMLInputElement>(".sidebar-search input")!;
    assert.equal(document.activeElement, input, "the field takes focus as it opens");
    assert.ok(bar()!.querySelector(".sidebar-search-clear"), "an open field can always be closed");
    assert.equal(bar()!.querySelector(".sidebar-select-toggle"), null);
    await act(async () => { typeQuery(input, "beta"); });
    assert.match(container.querySelector(".sidebar-search-results")?.textContent ?? "", /Beta session/);
    await act(async () => {
      input.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    assert.ok(header(), "Escape gives the row back to the project");
    assert.equal(bar(), null);
    assert.equal(container.querySelector(".sidebar-search-results"), null, "Escape also clears the query");
    assert.equal(document.activeElement, header()!.querySelector(".sidebar-header-search"), "focus returns to the search button");

    // An empty field closes once focus moves on outside the toolbar; a query keeps it.
    await act(async () => { click(header()!.querySelector(".sidebar-header-search")!); });
    const row = container.querySelector<HTMLButtonElement>(".sidebar-focused-sessions .session-btn")!;
    await act(async () => {
      bar()!.querySelector("input")!.dispatchEvent(new FocusEventCtor("focusout", { bubbles: true, relatedTarget: row }));
    });
    assert.ok(header(), "leaving an empty field restores the project row");
    await act(async () => { click(header()!.querySelector(".sidebar-header-search")!); });
    await act(async () => { typeQuery(bar()!.querySelector("input")!, "alpha"); });
    await act(async () => {
      bar()!.querySelector("input")!.dispatchEvent(new FocusEventCtor("focusout", { bubbles: true, relatedTarget: row }));
    });
    assert.ok(bar(), "a field with a query stays open");
    await act(async () => { click(bar()!.querySelector(".sidebar-search-clear")!); });
    assert.ok(header(), "× clears and closes");

    // A filter lights the button; when it hides the focused project the
    // toolbar row stays so the filter can be turned off again.
    await act(async () => { click(header()!.querySelector('[aria-label="More sidebar actions"]')!); });
    const attention = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')]
      .find((item) => item.textContent?.trim() === "Needs attention");
    assert.ok(attention);
    await act(async () => { click(attention!); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(header(), null, "no project needs attention, so none is focused");
    const fallback = bar()?.querySelector<HTMLElement>('[aria-label="More sidebar actions"]');
    assert.ok(fallback, "the toolbar row keeps the list options reachable");
    assert.equal(fallback!.classList.contains("active"), true, "an active filter lights the button");
    assert.equal(bar()!.querySelector(".sidebar-search-clear"), null, "a closed, empty field has no ×");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    setSidebarViewMode("tree");
  }
});

test("compact drawers offer the project rail, its customize pencil and the layout switch", async () => {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [project("alpha"), project("beta")]);
  store.activateProject("alpha");
  store.setSessions("alpha", sessionsByProject.alpha!);
  store.setSessions("beta", sessionsByProject.beta!);
  setSidebarViewMode("tree");
  setSidebarLayout({ collapsed: false, width: 332 });
  shellWidth = 700;
  store.setOverlay(null);
  store.setSidebarOpen(true);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Sidebar)); });

    // The compact drawer carries the presentation switch in its options menu.
    const options = container.querySelector<HTMLElement>(
      '.sidebar-drawer-header [aria-label="More sidebar actions"]',
    );
    assert.ok(options, "the compact drawer exposes its sidebar options");
    await act(async () => { click(options!); });
    const railOption = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .find((item) => item.textContent?.trim() === "Project rail");
    assert.ok(railOption, "compact users can select the project rail presentation");
    await act(async () => { click(railOption!); });
    assert.equal(getSidebarViewMode(), "rail");
    await act(async () => { await Promise.resolve(); });
    assert.equal(
      container.querySelector('.sidebar-drawer-header [aria-label="More sidebar actions"]')?.classList.contains("active"),
      false,
      "the rail is a layout, not a sort or filter: the drawer's sort button stays unlit",
    );

    const rail = container.querySelector<HTMLElement>(".sidebar-project-rail");
    assert.ok(rail, "the compact drawer renders the project rail");
    assert.ok(
      container.querySelector(".sidebar--compact-rail"),
      "the compact rail drawer widens so the switcher does not squeeze the sessions toolbar",
    );
    assert.match(
      container.querySelector(".sidebar-focused-sessions")?.textContent ?? "",
      /Alpha session one/,
      "the rail still shows the selected project's sessions",
    );
    assert.equal(
      container.querySelector(".sidebar-rail-toggle"),
      null,
      "the desktop sessions-only collapse stays desktop-only",
    );

    const actions = rail.querySelector(".sidebar-project-rail-actions");
    assert.ok(actions, "rail footer groups its actions without empty spacer controls");
    assert.equal(container.querySelector(".sidebar-connection-dot"), null, "sidebar omits the connection status control");
    assert.equal(rail.querySelector(".sidebar-project-rail-divider"), null);
    // Settings and Add project are rail items (projectRailZone.test.ts), not
    // fixed footer buttons that could neither move nor hide.
    assert.equal(actions.querySelector('[aria-label="Settings"]'), null);
    assert.equal(actions.querySelector('[aria-label="Add project"]'), null);
    assert.ok(actions.querySelector('[aria-label="Customize Project rail"]'), "the footer keeps the rail's pencil");

    // Switching back to the tree removes the rail again.
    store.setOverlay(null);
    store.setSidebarOpen(true);
    await act(async () => { await Promise.resolve(); });
    const optionsAgain = container.querySelector<HTMLElement>(
      '.sidebar-drawer-header [aria-label="More sidebar actions"]',
    );
    assert.ok(optionsAgain);
    await act(async () => { click(optionsAgain!); });
    const treeOption = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .find((item) => item.textContent?.trim() === "Project tree");
    assert.ok(treeOption, "the compact drawer can switch back to the project tree");
    await act(async () => { click(treeOption!); });
    assert.equal(getSidebarViewMode(), "tree");
    assert.equal(container.querySelector(".sidebar-project-rail"), null);
  } finally {
    shellWidth = 1400;
    setSidebarViewMode("tree");
    setSidebarLayout({ collapsed: false });
    store.setOverlay(null);
    store.setSidebarOpen(false);
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

// Kept last in the file: publishing the project list resumes the (single)
// boot restoration, whose session fetch the shared mock answers with an empty
// page — harmless here, but it must not disturb the exact-count assertions
// above.
test("double-clicking a project icon does not collapse the sessions column", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [project("alpha"), project("beta")]);
  store.activateProject("alpha");
  store.setSessions("alpha", sessionsByProject.alpha!);
  store.setSessions("beta", sessionsByProject.beta!);
  setSidebarViewMode("rail");
  setSidebarLayout({ collapsed: false, width: 332 });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const doubleClick = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new MouseEventCtor("click", { bubbles: true, detail: 1 }));
    });
    await act(async () => {
      element.dispatchEvent(new MouseEventCtor("click", { bubbles: true, detail: 2 }));
    });
    await act(async () => { t.mock.timers.tick(RAIL_COLLAPSE_CLICK_DELAY_MS); });
  };
  try {
    await act(async () => { root.render(createElement(Sidebar)); });

    // The focused project's icon would collapse on a lone click, not on a double-click.
    const alphaRail = container.querySelector<HTMLElement>('.sidebar-project-rail-item[aria-label="alpha"]')!;
    await doubleClick(alphaRail);
    assert.equal(getSidebarLayout().collapsed, false, "the focused project's double-click keeps the sessions open");
    assert.equal(container.querySelector(".sidebar--rail-collapsed"), null);
    assert.equal(alphaRail.getAttribute("aria-expanded"), "true");

    // The first click of a double-click on another project browses it; the second does not collapse.
    const betaRail = container.querySelector<HTMLElement>('.sidebar-project-rail-item[aria-label="beta"]')!;
    await doubleClick(betaRail);
    assert.equal(getSidebarLayout().collapsed, false, "double-clicking another project keeps its sessions open");
    assert.equal(container.querySelector(".sidebar--rail-collapsed"), null);
    assert.equal(betaRail.getAttribute("aria-expanded"), "true");
    assert.match(container.querySelector(".sidebar-focused-sessions")?.textContent ?? "", /Beta session/);

    // Any press elsewhere in the sidebar cancels a pending collapse.
    await act(async () => {
      betaRail.dispatchEvent(new MouseEventCtor("click", { bubbles: true, detail: 1 }));
    });
    await act(async () => { pointer(container.querySelector(".sidebar-main")!, "pointerdown"); });
    await act(async () => { t.mock.timers.tick(RAIL_COLLAPSE_CLICK_DELAY_MS); });
    assert.equal(container.querySelector(".sidebar--rail-collapsed"), null, "another press cancels the pending collapse");

    // A deliberate single click still collapses after the double-click window.
    await act(async () => {
      betaRail.dispatchEvent(new MouseEventCtor("click", { bubbles: true, detail: 1 }));
    });
    await act(async () => { t.mock.timers.tick(RAIL_COLLAPSE_CLICK_DELAY_MS - 1); });
    assert.equal(container.querySelector(".sidebar--rail-collapsed"), null, "the collapse waits out the double-click window");
    await act(async () => { t.mock.timers.tick(1); });
    assert.ok(container.querySelector(".sidebar--rail-collapsed"), "a single click still collapses the sessions");
  } finally {
    setSidebarLayout({ collapsed: false });
    await act(async () => { root.unmount(); });
    container.remove();
    t.mock.timers.reset();
  }
});
