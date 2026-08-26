// Sidebar tree mode: projects contain worktrees, and worktrees contain
// sessions. The same SessionList is reused by the flat project list.
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
const { default: Sidebar } = await import("../src/components/Sidebar.tsx");

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const click = (el: Element) => el.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));

const project = (id: string): Project => ({ id, path: `/work/${id}`, name: id, createdAt: 1 });

test("parseSidebarViewMode defaults to the session tree; setter persists and round-trips", () => {
  assert.equal(parseSidebarViewMode(null), "tree");
  assert.equal(parseSidebarViewMode("bogus"), "list");
  assert.equal(parseSidebarViewMode("folders"), "tree", "legacy folder mode migrates");
  setSidebarViewMode("tree");
  assert.equal(getSidebarViewMode(), "tree");
  assert.equal(localStorage.getItem(VIEW_MODE_KEY), "tree");
  setSidebarViewMode("list");
  assert.equal(getSidebarViewMode(), "list");
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
  setSidebarViewMode("list");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Sidebar)); });

    assert.ok(container.querySelector(".session-list .session-org"), "list mode renders the active project sessions");
    assert.equal(container.querySelector(".branch-row"), null, "the project root never exposes its current branch");
    assert.equal(container.querySelector(".project-tree-node"), null);
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

    // Back to list mode restores the classic layout.
    await act(async () => { setSidebarViewMode("list"); });
    assert.ok(container.querySelector(".session-list .session-org"), "list layout restored");
    assert.equal(container.querySelector(".project-tree-node"), null);
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
  setSidebarViewMode("list");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Sidebar)); });

    const serviceBar = container.querySelector<HTMLElement>(".sidebar-service-bar");
    const menu = container.querySelector<HTMLButtonElement>('[aria-label="Actions for alpha"]');
    assert.ok(menu, "the project row exposes its own actions");
    await act(async () => { click(menu!); });
    const select = container.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]');
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
      1,
      "the visible project reflects its selected session while the first selection remains retained",
    );
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("settings is only exposed while Shift is held", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Sidebar)); });
    assert.equal(container.querySelector('[aria-label="Settings"]'), null);

    await act(async () => { (dom as unknown as EventTarget).dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Shift", shiftKey: true }) as unknown as Event); });
    assert.ok(container.querySelector('[aria-label="Settings"]'));

    await act(async () => { (dom as unknown as EventTarget).dispatchEvent(new dom.KeyboardEvent("keyup", { key: "Shift" }) as unknown as Event); });
    assert.equal(container.querySelector('[aria-label="Settings"]'), null);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
