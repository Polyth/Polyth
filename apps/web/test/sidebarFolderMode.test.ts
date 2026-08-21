// UX-FILES-TIMELINE-03 finding 9: sidebar folder view mode. Projects render
// as collapsible folders with their sessions nested (the SAME SessionList the
// list mode uses), expand/collapse works per project and for all projects at
// once, the toggle persists, and setSessions merges per project so several
// projects' sessions can coexist in the store.
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
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sessionsByProject: Record<string, SessionProjection[]> = {
  alpha: [
    { id: "a1", projectId: "alpha", title: "Alpha session one", status: "idle", createdAt: 1, updatedAt: 2 },
    { id: "a2", projectId: "alpha", title: "Alpha session two", status: "idle", createdAt: 1, updatedAt: 1 },
  ],
  beta: [
    { id: "b1", projectId: "beta", title: "Beta session", status: "idle", createdAt: 1, updatedAt: 1 },
  ],
};

(globalThis as { fetch?: unknown }).fetch = async (url: string) => {
  const u = new URL(String(url), "http://localhost:3000");
  const body: unknown = u.pathname === "/api/sessions"
    ? sessionsByProject[u.searchParams.get("projectId") ?? ""] ?? []
    : []; // /api/folders, /api/labels
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

test("parseSidebarViewMode falls back to list; setter persists and round-trips", () => {
  assert.equal(parseSidebarViewMode(null), "list");
  assert.equal(parseSidebarViewMode("bogus"), "list");
  assert.equal(parseSidebarViewMode("folders"), "folders");
  setSidebarViewMode("folders");
  assert.equal(getSidebarViewMode(), "folders");
  assert.equal(localStorage.getItem(VIEW_MODE_KEY), "folders");
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

test("folder mode nests each project's sessions with per-project and expand/collapse-all", async () => {
  // Two ready projects; alpha is active.
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

    // List mode: classic layout — one Sessions section, no folder chevrons.
    assert.ok(container.querySelector(".session-heading"), "list mode keeps the Sessions heading");
    assert.equal(container.querySelector(".project-folder"), null);
    const toggle = container.querySelector<HTMLElement>('[aria-label="Toggle project folder view"]');
    assert.ok(toggle, "view-mode toggle rendered");
    assert.equal(toggle!.getAttribute("aria-pressed"), "false");

    // Flip to folder mode: persisted, projects become folders, the active
    // project's sessions are already nested.
    await act(async () => { click(toggle!); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(toggle!.getAttribute("aria-pressed"), "true");
    assert.equal(localStorage.getItem(VIEW_MODE_KEY), "folders");
    const folders = [...container.querySelectorAll(".project-folder")];
    assert.equal(folders.length, 2, "each project renders as a folder");
    assert.equal(container.querySelector(".session-heading"), null, "no separate Sessions section in folder mode");
    const alphaFolder = folders.find((f) => (f.textContent ?? "").includes("alpha"))!;
    assert.ok(
      alphaFolder.querySelector(".project-folder-sessions .session-org"),
      "active project folder nests the real SessionList",
    );
    assert.match(alphaFolder.textContent ?? "", /Alpha session one/);
    const betaFolder = folders.find((f) => (f.textContent ?? "").includes("beta"))!;
    assert.equal(betaFolder.querySelector(".project-folder-sessions"), null, "other projects start collapsed");
    const betaChevron = betaFolder.querySelector<HTMLElement>(".project-folder-chevron")!;
    assert.equal(betaChevron.getAttribute("aria-expanded"), "false");

    // Per-project expand reveals that project's sessions.
    await act(async () => { click(betaChevron); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(betaChevron.getAttribute("aria-expanded"), "true");
    assert.match(betaFolder.textContent ?? "", /Beta session/);

    // Collapse all, then expand all.
    const bar = container.querySelector<HTMLElement>(".side-folder-bar")!;
    const buttons = [...bar.querySelectorAll("button")];
    const collapseAll = buttons.find((b) => (b.textContent ?? "").includes("Collapse all"))!;
    const expandAll = buttons.find((b) => (b.textContent ?? "").includes("Expand all"))!;
    await act(async () => { click(collapseAll); });
    assert.equal(container.querySelectorAll(".project-folder-sessions").length, 0, "collapse all hides every nested list");
    await act(async () => { click(expandAll); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(container.querySelectorAll(".project-folder-sessions").length, 2, "expand all reveals every project");

    // Back to list mode restores the classic layout.
    await act(async () => { click(toggle!); });
    assert.equal(toggle!.getAttribute("aria-pressed"), "false");
    assert.ok(container.querySelector(".session-heading"), "list layout restored");
    assert.equal(container.querySelector(".project-folder"), null);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
