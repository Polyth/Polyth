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
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sessionsByProject: Record<string, SessionProjection[]> = {
  alpha: [
    { id: "a1", projectId: "alpha", title: "Alpha session one", status: "idle", createdAt: 1, updatedAt: 2 },
    { id: "a2", projectId: "alpha", title: "Alpha session two", status: "idle", createdAt: 1, updatedAt: 1, worktreePath: "/work/alpha-feature", branch: "feature/ui" },
  ],
  beta: [
    { id: "b1", projectId: "beta", title: "Beta session", status: "idle", createdAt: 1, updatedAt: 1 },
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
const { getSidebarViewMode, parseSidebarViewMode, setSidebarViewMode, VIEW_MODE_KEY } = await import("../src/sidebarPrefs.ts");
const { default: Sidebar, PEEK_LEAVE_MS } = await import("../src/components/Sidebar.tsx");
const { setSidebarLayout } = await import("../src/sidebarLayout.ts");

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

test("parseSidebarViewMode defaults to the session tree; setter persists and round-trips", () => {
  assert.equal(parseSidebarViewMode(null), "tree");
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
    assert.match(focused?.textContent ?? "", /Alpha session one/);
    assert.doesNotMatch(focused?.textContent ?? "", /Beta session/);
    const betaRail = rail.querySelector<HTMLElement>('[aria-label="beta"]');
    assert.ok(betaRail);
    await act(async () => { click(betaRail!); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(betaRail?.getAttribute("aria-current"), "true");
    assert.match(container.querySelector(".sidebar-focused-project")?.textContent ?? "", /Beta session/);

    // Tree mode remains the only full-width project presentation.
    await act(async () => { setSidebarViewMode("tree"); });
    assert.equal(container.querySelectorAll(".project-tree-node").length, 2);
  } finally {
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

test("project menu selection keeps one multi-session selection across projects", async () => {
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
  setSidebarLayout({ collapsed: true });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Sidebar)); });

    // Collapsed rail view keeps the project icons; only the sessions go away.
    const rail = container.querySelector(".sidebar-project-rail");
    assert.ok(rail, "the project icon rail survives the sessions-only collapse");
    assert.equal(container.querySelector(".sidebar-collapsed-rail"), null, "rail view never falls back to the thin rail");
    const switchEl = container.querySelector<HTMLButtonElement>('.sidebar-rail-switch [role="switch"]');
    assert.equal(switchEl?.getAttribute("aria-checked"), "false", "the collapse control is an off switch");
    const peek = container.querySelector<HTMLElement>(".sidebar-sessions-peek")!;
    assert.ok(peek, "the sessions live in a peek panel while collapsed");
    assert.equal(peek.classList.contains("open"), false);

    // Hovering a project opens the peek at once.
    const betaRail = rail!.querySelector<HTMLElement>('[aria-label="beta"]')!;
    await act(async () => { pointer(betaRail, "pointerover"); });
    assert.equal(peek.classList.contains("open"), true, "the peek opens on hover without a delay");
    assert.match(peek.textContent ?? "", /Beta session/, "the peek previews the hovered project");
    assert.equal(store.getState().activeProjectId, "alpha", "previewing never steals the active project");

    // Untouched, it closes five seconds after the pointer leaves the sidebar.
    await act(async () => { pointer(betaRail, "pointerout"); });
    await act(async () => { t.mock.timers.tick(PEEK_LEAVE_MS - 1); });
    assert.equal(peek.classList.contains("open"), true, "the grace period is honoured in full");
    await act(async () => { t.mock.timers.tick(1); });
    assert.equal(peek.classList.contains("open"), false);

    // Interacted with, it stays until a click outside — leaving does not close it.
    await act(async () => { pointer(betaRail, "pointerover"); });
    await act(async () => { pointer(peek, "pointerdown"); });
    // A pinned peek re-targets across the rail without losing its pin.
    await act(async () => { pointer(rail!.querySelector<HTMLElement>('[aria-label="alpha"]')!, "pointerover"); });
    assert.match(peek.textContent ?? "", /Alpha session one/, "hovering another project re-targets the peek");
    await act(async () => { pointer(betaRail, "pointerout"); });
    await act(async () => { t.mock.timers.tick(PEEK_LEAVE_MS * 2); });
    assert.equal(peek.classList.contains("open"), true, "a touched peek ignores the leave timer");
    await act(async () => { pointer(document.body, "pointerdown"); });
    assert.equal(peek.classList.contains("open"), false, "a click outside dismisses the pinned peek");

    // Switching back on restores the inline sessions column.
    await act(async () => { click(switchEl!); });
    assert.equal(switchEl?.getAttribute("aria-checked"), "true");
    assert.equal(container.querySelector(".sidebar-sessions-peek"), null);
    assert.match(container.querySelector(".sidebar-focused-project")?.textContent ?? "", /Alpha session one/);
  } finally {
    setSidebarLayout({ collapsed: false });
    await act(async () => { root.unmount(); });
    container.remove();
    t.mock.timers.reset();
  }
});
