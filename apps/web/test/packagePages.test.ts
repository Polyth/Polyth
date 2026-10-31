// Package pages take Chat's place in the main canvas, the way a chat opens
// from the navigator (an agent's own screen). Mounted through a real React
// root: the page renders instead of Chat and gives the canvas back on every
// chat navigation, a project switch drops another project's page, a throwing
// page stays isolated, and the package host reports and cleans up its page.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window();
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The package host imports real .tsx primitives.
register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerWorkspaceSurface } = await import("../src/workspace/surfaceRegistry.ts");
const { registerPage } = await import("../src/pages.ts");
const { default: WorkspaceHost } = await import("../src/components/workspace/WorkspaceHost.ts");
const { webPackageHost } = await import("../src/packages/webHost.ts");
const store = await import("../src/store.ts");

function seedProjects(...ids: string[]): void {
  store.publishProjectList(store.beginProjectListRequest(), ids.map((id) => ({ id, name: id, path: `/tmp/${id}`, createdAt: 1 })));
}

async function mountHost() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(WorkspaceHost)); });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

const offChat = registerWorkspaceSurface({
  id: "session",
  title: "Chat",
  order: 0,
  component: () => createElement("div", { className: "probe-chat" }, "chat surface"),
});
const offPage = registerPage({
  id: "agents",
  title: "Agents",
  component: ({ resource, projectId }) => createElement("div", { className: "probe-page" }, `agent ${resource ?? "home"} in ${projectId ?? "-"}`),
});

test("a registered page takes Chat's place and gives the canvas back", async () => {
  seedProjects("p1");
  store.activateProject("p1");
  const view = await mountHost();
  try {
    assert.match(view.container.textContent ?? "", /chat surface/);
    assert.equal(store.openPage("missing", "x"), false, "an unknown page is refused");
    assert.equal(store.getState().activePage, null);

    await act(async () => { assert.equal(store.openPage("agents", "a1"), true); });
    assert.match(view.container.textContent ?? "", /agent a1 in p1/);
    assert.equal(view.container.querySelector(".probe-chat"), null, "Chat is not on screen behind it");
    assert.equal(view.container.querySelector(".page-canvas")?.getAttribute("aria-label"), "Agents");

    await act(async () => { store.openPage("agents", "a2"); });
    assert.match(view.container.textContent ?? "", /agent a2/, "another agent replaces the page");

    await act(async () => { store.closePage(); });
    assert.match(view.container.textContent ?? "", /chat surface/);
  } finally {
    await view.unmount();
  }
});

test("opening a chat or switching project returns the canvas to Chat; the same project keeps the page", async () => {
  seedProjects("p1", "p2");
  store.activateProject("p1");
  store.openPage("agents", "a1");
  store.showSessionChat();
  assert.equal(store.getState().activePage, null, "a chat opened by the person replaces the page");

  store.openPage("agents", "a1");
  store.activateProject("p1");
  assert.deepEqual(store.getState().activePage, { pageId: "agents", resource: "a1" }, "re-activating the project keeps it");

  store.activateProject("p2");
  assert.equal(store.getState().activePage, null, "another project's page never stays over this one");

  store.openPage("agents", "a1");
  store.closeAllModules();
  assert.equal(store.getState().activePage, null, "dismissing every module returns to Chat");
});

test("a page opened for another project moves the workspace there", () => {
  seedProjects("p1", "p2");
  store.activateProject("p1");
  store.activateSession(null);
  assert.equal(store.openPage("agents", "a9", { projectId: "p2" }), true);
  assert.equal(store.getState().activeProjectId, "p2");
  assert.deepEqual(store.getState().activePage, { pageId: "agents", resource: "a9" });
  store.closePage();
});

test("a page that throws is isolated behind its boundary", async () => {
  seedProjects("p1");
  store.activateProject("p1");
  const off = registerPage({ id: "broken", title: "Broken", component: () => { throw new Error("boom"); } });
  const errors = console.error;
  console.error = () => {};
  const view = await mountHost();
  try {
    await act(async () => { store.openPage("broken", null); });
    assert.ok(view.container.querySelector(".page-canvas"), "the canvas frame survives");
    assert.doesNotMatch(view.container.textContent ?? "", /chat surface/);
  } finally {
    console.error = errors;
    store.closePage();
    off();
    await view.unmount();
  }
});

test("the package host reports the open page and takes it away with its package", () => {
  seedProjects("p1");
  store.activateProject("p1");
  const off = webPackageHost.pages!.register({ id: "notes", title: "Notes", component: () => null });
  assert.equal(webPackageHost.navigation.openPage!("notes", "n1"), true);
  assert.deepEqual(webPackageHost.store.getSnapshot().activePage, { pageId: "notes", resource: "n1" });
  off();
  assert.equal(store.getState().activePage, null, "a disabled package's page closes");
  assert.equal(webPackageHost.store.getSnapshot().activePage, null);
});

test("switching to Canvas from a page leaves the page; without a chat it opens the first listed one", async () => {
  const { switchWorkspaceMode } = await import("../src/workbench/profileNavigation.ts");
  const { setWorkbenchProject, rememberWorkbenchProfileSession } = await import("../src/workbench/store.ts");
  const { getWorkspaceContentMode } = await import("../src/widgets/workspaceMode.ts");
  seedProjects("p-canvas");
  store.activateProject("p-canvas");
  setWorkbenchProject("p-canvas");
  const row = (id: string, at: number, extra: Record<string, unknown> = {}) => ({
    id, projectId: "p-canvas", title: id, status: "idle" as const, createdAt: at, updatedAt: at, lastTurnAt: at, ...extra,
  });
  store.setSessions("p-canvas", [
    row("older", 1),
    row("newest", 3),
    row("child", 4, { parentId: "older" }),
    row("gone", 5, { status: "archived" }),
  ]);

  store.activateSession("older");
  store.openPage("agents", "a1");
  switchWorkspaceMode("widgets");
  assert.equal(store.getState().activePage, null, "the page no longer covers the workspace");
  assert.equal(getWorkspaceContentMode(), "widgets");
  assert.equal(store.getState().activeSessionId, "older", "the chat behind the page stays");

  store.activateSession(null);
  rememberWorkbenchProfileSession("conversation", null);
  store.openPage("agents", "a1");
  switchWorkspaceMode("widgets");
  assert.equal(store.getState().activePage, null);
  assert.equal(store.getState().newSessionIntent, null, "no empty new chat");
  assert.equal(store.getState().openingSessionId, "newest", "the first listed chat opens");
  store.setOpeningSession(null);
});

test.after(() => {
  offPage();
  offChat();
});
