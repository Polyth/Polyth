// Project Files tree. The selected row
// used the generic `sel` class — collided with the `.sel` select-widget rule —
// and rows had no tree semantics. This mounts the REAL EditorView and asserts
// the ARIA tree contract (role=tree/treeitem, aria-level, aria-expanded,
// aria-activedescendant) plus the namespaced ft-selected state, indentation,
// and disclosure toggling.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import type { FileEntry } from "@polyth/session/web-api";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  getComputedStyle: (elt: Element) =>
    (dom as unknown as { getComputedStyle(el: Element): CSSStyleDeclaration }).getComputedStyle(elt),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: () => {},
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Deterministic files API: one root listing, one src/ listing, empty reads.
const tree: Record<string, FileEntry[]> = {
  "": [
    { name: "src", path: "src", dir: true },
    { name: "README.md", path: "README.md", dir: false, size: 12 },
  ],
  "src": [
    { name: "index.ts", path: "src/index.ts", dir: false, size: 34 },
  ],
};
interface PendingTreeReply { scope: string; resolve: (body: FileEntry[]) => void }
const pendingTreeReplies: PendingTreeReply[] = [];
interface PendingLanguageReply { resolve: (body: unknown) => void }
const pendingLanguageReplies: PendingLanguageReply[] = [];
const treeCalls: Array<{ projectId: string; path: string; repositoryId: string | null }> = [];
const languageCalls: string[] = [];
const deterministicFetch = async (url: string, init?: { body?: string }) => {
  const u = new URL(String(url), "http://localhost:3000");
  const projectId = u.searchParams.get("projectId") ?? "";
  const path = u.searchParams.get("path") ?? "";
  if (u.pathname === "/api/editor/language") {
    const body = init?.body ? JSON.parse(init.body) as { projectId?: string } : {};
    languageCalls.push(body.projectId ?? projectId);
    return {
      ok: true, status: 200, statusText: "OK",
      json: async () => await new Promise<unknown>((resolve) => pendingLanguageReplies.push({ resolve })),
      text: async () => "{}",
    };
  }
  if (u.pathname === "/api/files/tree") treeCalls.push({ projectId, path, repositoryId: u.searchParams.get("repositoryId") });
  const body: unknown = projectId === "p-files-stale" && u.pathname === "/api/files/tree"
    ? await new Promise<FileEntry[]>((resolve) => pendingTreeReplies.push({
      scope: `${projectId}:${u.searchParams.get("sessionId") ?? ""}`,
      resolve,
    }))
    : u.pathname === "/api/files/tree"
      ? tree[path] ?? []
    : u.pathname === "/api/files/read"
      ? { path: u.searchParams.get("path"), content: u.searchParams.get("path") === "src/current.ts" ? "const first = false;\nconst current = true;\n" : "", truncated: false, revision: "r1" }
      : {};
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
};
(globalThis as { fetch?: unknown }).fetch = deterministicFetch;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
  activateProject, activateSession, applyProjectUpsert, closeWorkspacePane, getState,
  openEditorFile, openWorkspacePane, setEditorFile, startNewSession, useStore, workspacePresentationKey,
} = await import("../../../apps/web/src/store.ts");
const { registerSurface } = await import("../../../apps/web/src/surfaces.ts");
const { PaneVisibilityContext } = await import("../../../apps/web/src/workspace/paneVisibility.ts");
const { getWorkspaceContentMode, setWorkspaceMode } = await import("../../../apps/web/src/widgets/workspaceMode.ts");
const { treeScopeKey } = await import("../widgets/editor/treeState.ts");
const { fileTypeKeyOf } = await import("../widgets/editor/fileTreeIcons.tsx");
const { default: EditorView } = await import("../widgets/EditorView.tsx");
const { paneStorageKey } = await import("../../../apps/web/src/components/workspace/PaneHost.tsx");

test("file-tree CSS keeps semantic density roles and mobile hit-area seams", async () => {
  const css = await readFile(new URL("../widgets/styles.css", import.meta.url), "utf8");
  const ruleBody = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`));
    assert.ok(match, `${selector} rule is present`);
    return match![1]!;
  };

  const treeRoles = ruleBody(".ft-tree");
  const rowRule = ruleBody(".ft-row");
  const mobileTree = ruleBody(".editor-view .ft-tree");
  for (const role of [
    "--ft-row-min-height", "--ft-row-block-pad", "--ft-icon-label-gap", "--ft-indent",
    "--ft-chevron-size", "--ft-icon-size", "--ft-label-font", "--ft-label-line",
  ]) {
    assert.match(treeRoles, new RegExp(`${role.replaceAll("-", "\\-")}\\s*:`), `${role} is locally defined`);
  }
  assert.match(treeRoles, /--ft-row-min-height:\s*max\(calc\(var\(--control-h-sm\) - var\(--space-2\)\),\s*var\(--hit-min\)\)/);
  assert.match(treeRoles, /--ft-row-block-pad:\s*0px/);
  assert.match(treeRoles, /--ft-icon-label-gap:\s*var\(--space-1\)/);
  assert.match(treeRoles, /--ft-indent:\s*var\(--space-2\)/);
  assert.match(treeRoles, /--ft-chevron-size:\s*var\(--icon-md\)/);
  assert.match(treeRoles, /--ft-icon-size:\s*var\(--icon-md\)/);
  assert.match(treeRoles, /--ft-label-font:\s*var\(--font-label\)/);
  assert.match(rowRule, /gap:\s*var\(--ft-icon-label-gap\)/);
  assert.match(rowRule, /min-height:\s*var\(--ft-row-min-height\)/);
  assert.match(rowRule, /padding-block:\s*var\(--ft-row-block-pad\)/);
  assert.match(rowRule, /font:\s*400\s+var\(--ft-label-font\)\/var\(--ft-label-line\)/);
  assert.match(css, /\.ft-chevron[\s\S]*width:\s*var\(--ft-chevron-size/);
  assert.match(css, /\.ft-icon[\s\S]*width:\s*var\(--ft-icon-size/);
  assert.match(css, /\.file-tree-glyph[\s\S]*var\(--ft-icon-size/);
  assert.match(css, /\.ft-name[\s\S]*font-size:\s*var\(--ft-label-font\)/);
  assert.match(css, /\.ft-name[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(mobileTree, /--ft-row-min-height:\s*max\(calc\(var\(--control-h-sm\) - var\(--space-3\)\),\s*var\(--hit-min\)\)/);
  assert.match(mobileTree, /--ft-row-block-pad:\s*0px/);
  assert.ok(
    css.indexOf("var(--space-3)), var(--hit-min)") > css.indexOf("var(--space-2)), var(--hit-min)"),
    "mobile row min-height keeps the hit-area floor while using a smaller visual minimum",
  );
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*min-height:\s*var\(--tap\)\s*!important/);
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /prefers-reduced-motion/);
});

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const CustomEventCtor = (dom as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent;
const click = (el: Element) => el.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));

test("file tree renders an ARIA tree with disclosure, indentation, and namespaced selection", async () => {
  activateProject("p-files");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(EditorView)); });
    await act(async () => { await Promise.resolve(); });

    const treeEl = container.querySelector<HTMLElement>('[role="tree"]');
    assert.ok(treeEl, "role=tree container rendered");
    assert.equal(treeEl!.getAttribute("aria-label"), "Project files");
    assert.equal(treeEl!.getAttribute("tabindex"), "0", "tree is the single tab stop");

    const items = () => [...treeEl!.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    assert.equal(items().length, 2, "root listing rendered");
    const dir = items().find((el) => (el.textContent ?? "").includes("src"))!;
    assert.equal(dir.getAttribute("aria-level"), "1");
    assert.equal(dir.getAttribute("aria-expanded"), "false", "collapsed dir advertises state");
    const file = items().find((el) => (el.textContent ?? "").includes("README.md"))!;
    assert.equal(file.hasAttribute("aria-expanded"), false, "leaf has no aria-expanded");
    assert.ok(dir.querySelector(".ft-chevron"), "disclosure chevron rendered");
    assert.ok(file.querySelector(".ft-name"), "name span rendered");
    assert.equal(file.querySelector(".file-row-actions"), null, "leaf rows have no per-row overflow menu");

    // Rows carry decorative type glyphs —
    // a folder icon on directories, a family-tinted file icon on leaves, and
    // an SVG disclosure only on directories. All glyphs are aria-hidden.
    const dirIcon = dir.querySelector<HTMLElement>(".ft-icon");
    assert.ok(dirIcon?.querySelector("svg"), "directory renders a folder glyph");
    assert.equal(dirIcon!.getAttribute("data-ft"), "folder");
    assert.equal(dirIcon!.getAttribute("aria-hidden"), "true", "glyphs stay out of the a11y tree");
    assert.ok(dir.querySelector(".ft-chevron svg"), "directory disclosure is an svg chevron");
    const fileIcon = file.querySelector<HTMLElement>(".ft-icon");
    assert.ok(fileIcon?.querySelector("svg"), "file renders a type glyph");
    assert.equal(fileIcon!.getAttribute("data-ft"), "doc", "README.md maps to the doc family");
    assert.equal(file.querySelector(".ft-chevron svg"), null, "leaf rows render no disclosure");
    assert.equal(dirIcon!.querySelector("svg")!.getAttribute("fill"), "currentColor", "folder glyph is filled");
    assert.equal(dirIcon!.querySelector("svg")!.getAttribute("stroke"), null, "folder glyph is not an outline");
    assert.equal(fileIcon!.querySelector("svg")!.getAttribute("fill"), "currentColor", "file glyph is filled");

    // Expand the directory: child appears one level deeper, indented further.
    await act(async () => { click(dir); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(dir.getAttribute("aria-expanded"), "true");
    assert.ok(
      dir.querySelector(".ft-chevron")!.classList.contains("open"),
      "expanded directory rotates its chevron",
    );
    assert.ok(
      dir.querySelector(".ft-icon")!.classList.contains("open"),
      "expanded directory switches to the open folder state",
    );
    const child = items().find((el) => (el.textContent ?? "").includes("index.ts"));
    assert.ok(child, "child row rendered after expand");
    assert.equal(child!.getAttribute("aria-level"), "2");
    assert.equal(
      child!.querySelector(".ft-icon")!.getAttribute("data-ft"),
      "code",
      "index.ts maps to the code family",
    );
    const indentOf = (el: HTMLElement) => Number(el.style.getPropertyValue("--ft-depth") || "0");
    assert.ok(indentOf(child!) > indentOf(dir), "child indents deeper than its parent");

    // Selecting a file uses the NAMESPACED class — never the `.sel` widget class.
    await act(async () => { click(child!.querySelector(".ft-name")!); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(child!.getAttribute("aria-selected"), "true");
    assert.ok(child!.classList.contains("ft-selected"), "selected row carries ft-selected");
    for (const el of items()) {
      assert.equal(el.classList.contains("sel"), false, "generic sel class must not appear on tree rows");
    }
    assert.equal(
      treeEl!.getAttribute("aria-activedescendant"),
      child!.id,
      "tree points its active descendant at the selected row",
    );
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("single click opens a preview and double click pins the same mounted file tab", async () => {
  const projectId = "p-files-preview";
  const storageKey = paneStorageKey(projectId, null);
  localStorage.removeItem(storageKey);
  activateProject(projectId);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(EditorView)); });
    await act(async () => { await Promise.resolve(); });
    const file = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
      .find((el) => (el.textContent ?? "").includes("README.md"));
    assert.ok(file, "file row rendered");

    await act(async () => { click(file!); });
    await act(async () => { await Promise.resolve(); });
    let pane = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    assert.equal(pane.tabs.length, 1);
    assert.equal(pane.tabs[0].resource, "README.md");
    assert.equal(pane.tabs[0].preview, true, "single click remains replaceable");

    await act(async () => {
      file!.dispatchEvent(new MouseEventCtor("dblclick", { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });
    pane = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    assert.equal(pane.tabs.length, 1, "pinning does not duplicate the resource");
    assert.equal(pane.tabs[0].preview, undefined, "double click makes the tab permanent");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    localStorage.removeItem(storageKey);
  }
});

test("a Canvas Files widget opens the clicked file in its own pane and keeps the workspace on Canvas", async () => {
  const projectId = "p-files-widget-canvas";
  const storageKey = paneStorageKey(projectId, null);
  localStorage.removeItem(storageKey);
  // The package always registers the Files surface, so the navigating adapter
  // can reach Chat — the widget is what must not use it.
  const unregister = registerSurface({
    id: "files",
    title: "Files",
    order: 1,
    component: () => null,
    presentation: {
      kind: "workspace", defaultRatio: 0.6, minWidth: 380,
      preferredMaxWidth: 760, keepAlive: true, escape: "close",
    },
  });
  activateProject(projectId);
  setWorkspaceMode("widgets");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(EditorView, { projectId, embedded: true })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(getWorkspaceContentMode(), "widgets", "the widget starts on Canvas");

    const file = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
      .find((el) => (el.textContent ?? "").includes("README.md"));
    assert.ok(file, "file row rendered");
    await act(async () => { click(file!); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    const pane = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    assert.equal(pane.tabs.length, 1, "the widget's own pane host opened the file");
    assert.equal(pane.tabs[0].resource, "README.md");
    assert.equal(pane.tabs[0].preview, true, "a single click stays a replaceable preview");
    assert.equal(getState().editorFile, "README.md", "the shared selection follows the widget");
    assert.equal(getState().railPlugin, null, "no Files workspace pane was opened");
    assert.equal(getWorkspaceContentMode(), "widgets", "the click does not replace Canvas with Chat");

    // A double click pins the same tab, and still never leaves Canvas.
    await act(async () => {
      file!.dispatchEvent(new MouseEventCtor("dblclick", { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const pinned = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    assert.equal(pinned.tabs.length, 1, "pinning does not duplicate the resource");
    assert.equal(pinned.tabs[0].preview, undefined, "double click makes the tab permanent");
    assert.equal(getWorkspaceContentMode(), "widgets", "pinning does not replace Canvas with Chat");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    localStorage.removeItem(storageKey);
    unregister();
    setWorkspaceMode("chat");
  }
});

test("a file dropped on a Canvas Files widget opens in place, with its range revealed", async () => {
  const projectId = "p-files-widget-drop";
  const storageKey = paneStorageKey(projectId, null);
  localStorage.removeItem(storageKey);
  const unregister = registerSurface({
    id: "files",
    title: "Files",
    order: 1,
    component: () => null,
    presentation: {
      kind: "workspace", defaultRatio: 0.6, minWidth: 380,
      preferredMaxWidth: 760, keepAlive: true, escape: "close",
    },
  });
  const { setDragResource } = await import("../../../apps/web/src/dnd.ts");
  activateProject(projectId);
  setWorkspaceMode("widgets");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(EditorView, { projectId, embedded: true })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const dropZone = container.querySelector<HTMLElement>(".editor-pane-drop");
    assert.ok(dropZone, "the editor pane is a drop target");

    const values = new Map<string, string>();
    const transfer = {
      setData: (key: string, value: string) => { values.set(key, value); },
      getData: (key: string) => values.get(key) ?? "",
      types: [],
      files: [],
    } as unknown as DataTransfer;
    setDragResource(transfer, { scheme: "file", projectId, sessionId: null, repositoryId: "primary", locator: "src/index.ts" }, { startLine: 4, endLine: 6 });
    const drop = new (dom as unknown as { Event: typeof Event }).Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: transfer });
    await act(async () => { dropZone!.dispatchEvent(drop); });
    // The reveal range is one-shot: the file body consumes it once the document
    // loads, so the published range is asserted before that read settles.
    assert.deepEqual(
      getState().editorLocation,
      { path: "src/index.ts", startLine: 4, endLine: 6 },
      "the drop publishes its reveal range for the widget's own file body",
    );
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    const pane = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    assert.equal(pane.tabs.length, 1, "the drop opened the file in the widget's pane host");
    assert.equal(pane.tabs[0].resource, "src/index.ts");
    assert.equal(getState().railPlugin, null, "the drop did not open the Files workspace pane");
    assert.equal(getWorkspaceContentMode(), "widgets", "the drop does not replace Canvas with Chat");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    localStorage.removeItem(storageKey);
    unregister();
    setWorkspaceMode("chat");
  }
});

test("the standalone Files surface still opens the file by leaving Canvas for Chat", async () => {
  const projectId = "p-files-surface-canvas";
  const storageKey = paneStorageKey(projectId, null);
  localStorage.removeItem(storageKey);
  const unregister = registerSurface({
    id: "files",
    title: "Files",
    order: 1,
    component: () => null,
    presentation: {
      kind: "workspace", defaultRatio: 0.6, minWidth: 380,
      preferredMaxWidth: 760, keepAlive: true, escape: "close",
    },
  });
  activateProject(projectId);
  setWorkspaceMode("widgets");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(EditorView, { projectId })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const file = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
      .find((el) => (el.textContent ?? "").includes("README.md"));
    assert.ok(file, "file row rendered");
    await act(async () => { click(file!); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    // The navigating adapter owns the surface: it selects Chat and opens the
    // Files pane. This is the contrast that gives the widget assertions teeth.
    assert.equal(getWorkspaceContentMode(), "chat");
    assert.equal(getState().railPlugin, "files");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    localStorage.removeItem(storageKey);
    unregister();
    setWorkspaceMode("chat");
  }
});

test("a consumed external open is not replayed when the active tab syncs selection", async () => {
  const projectId = "p-files-open-request";
  const storageKey = paneStorageKey(projectId, null);
  localStorage.removeItem(storageKey);
  activateProject(projectId);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(EditorView, { projectId })); });
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      openEditorFile("README.md", undefined, { preview: true });
      await Promise.resolve();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    let pane = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    assert.equal(pane.tabs.length, 1);
    assert.equal(pane.tabs[0].resource, "README.md");

    // PaneHost tab activation synchronizes editorFile through setEditorFile.
    // That sync must not cause the old request to open the newly selected path
    // a second time.
    await act(async () => {
      setEditorFile("src/index.ts");
      await Promise.resolve();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    pane = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    assert.equal(pane.tabs.length, 1, "selection sync does not replay the old open request");
    assert.equal(pane.tabs[0].resource, "README.md");
    assert.equal(getState().editorFile, "src/index.ts");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    localStorage.removeItem(storageKey);
  }
});

test("same file paths remain separate tabs when external opens name repositories", async () => {
  const projectId = "p-files-repository-tabs";
  const storageKey = paneStorageKey(projectId, null);
  localStorage.removeItem(storageKey);
  applyProjectUpsert({
    id: projectId,
    name: "Repository tabs",
    path: "/repo/first",
    createdAt: Date.now(),
    repositories: [
      { id: "first", alias: "first", path: "/repo/first" },
      { id: "second", alias: "second", path: "/repo/second" },
    ],
    primaryRepositoryId: "first",
  });
  activateProject(projectId);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(EditorView, { projectId })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    const panels = [...container.querySelectorAll<HTMLElement>(".files-repository-panel")];
    assert.equal(panels.length, 2, "desktop renders one independent section per repository");
    const headings = [...container.querySelectorAll<HTMLButtonElement>(".files-repository-heading")];
    assert.equal(headings.length, 2);
    await act(async () => { headings.forEach((heading) => heading.click()); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    const firstDir = panels[0]!.querySelector<HTMLElement>('[role="treeitem"]');
    const secondDir = panels[1]!.querySelector<HTMLElement>('[role="treeitem"]');
    assert.equal(firstDir?.textContent?.includes("src"), true);
    assert.equal(secondDir?.textContent?.includes("src"), true);
    await act(async () => { click(firstDir!); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await act(async () => { click(secondDir!); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(firstDir?.getAttribute("aria-expanded"), "true", "expanding the second repository preserves the first");
    assert.equal(secondDir?.getAttribute("aria-expanded"), "true");
    assert.ok(panels[0]!.textContent?.includes("index.ts"));
    assert.ok(panels[1]!.textContent?.includes("index.ts"));
    await act(async () => {
      openEditorFile("README.md", undefined, { preview: false, repositoryId: "first" });
      await Promise.resolve();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await act(async () => {
      openEditorFile("README.md", undefined, { preview: false, repositoryId: "second" });
      await Promise.resolve();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });

    const pane = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    assert.equal(pane.tabs.length, 2, "repository identity prevents same-path tab replacement");
    assert.deepEqual(
      pane.tabs.map((tab: { resource: string; repositoryId?: string }) => [tab.resource, tab.repositoryId]),
      [["README.md", "first"], ["README.md", "second"]],
    );
    assert.deepEqual(
      [...container.querySelectorAll<HTMLElement>(".pane-tab-context")].map((element) => element.textContent),
      ["first", "second"],
      "same-title tabs carry repository labels for disambiguation",
    );
    assert.ok(treeCalls.some((call) => call.projectId === projectId && call.repositoryId === "first"));
    assert.ok(treeCalls.some((call) => call.projectId === projectId && call.repositoryId === "second"));
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    localStorage.removeItem(storageKey);
  }
});

test("an external file open waits while Files is hidden, then reveals visible ancestors", async () => {
  const projectId = "p-files-reveal";
  const storageKey = paneStorageKey(projectId, null);
  localStorage.removeItem(storageKey);
  function VisibleFiles({ visible }: { visible: boolean }) {
    return createElement(
      PaneVisibilityContext.Provider,
      { value: visible },
      createElement(EditorView, { projectId }),
    );
  }
  activateProject(projectId);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(VisibleFiles, { visible: false })); });
    await act(async () => { openEditorFile("src/index.ts"); });
    assert.equal(treeCalls.filter((call) => call.projectId === projectId).length, 0, "hidden Files does not fetch a tree for an external open");

    await act(async () => { root.render(createElement(VisibleFiles, { visible: true })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const dir = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
      .find((el) => (el.textContent ?? "").includes("src"));
    assert.equal(dir?.getAttribute("aria-expanded"), "true", "the ancestor opens when the pane becomes visible");
    assert.ok(
      [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
        .some((el) => (el.textContent ?? "").includes("index.ts")),
      "the active file becomes visible after its ancestors load",
    );
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    localStorage.removeItem(storageKey);
  }
});

test("late tree replies from a previous project/session scope are ignored", async () => {
  pendingTreeReplies.length = 0;
  function ScopedFiles({ sessionId }: { sessionId: string }) {
    return createElement(EditorView, { projectId: "p-files-stale", sessionId });
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(ScopedFiles, { sessionId: "old" })); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { root.render(createElement(ScopedFiles, { sessionId: "new" })); });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(pendingTreeReplies.map((entry) => entry.scope), ["p-files-stale:old", "p-files-stale:new"]);

    await act(async () => {
      pendingTreeReplies[0]!.resolve([{ name: "old.txt", path: "old.txt", dir: false }]);
      await Promise.resolve();
    });
    assert.equal(container.textContent?.includes("old.txt"), false, "the old reply cannot populate the new scope");
    await act(async () => {
      pendingTreeReplies[1]!.resolve([{ name: "new.txt", path: "new.txt", dir: false }]);
      await Promise.resolve();
    });
    assert.equal(container.textContent?.includes("new.txt"), true);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("late Peek language and file replies cannot cross a relocated repository scope", async () => {
  pendingLanguageReplies.length = 0;
  languageCalls.length = 0;
  const first = "p-peek-first";
  const project = (id: string, path: string) => applyProjectUpsert({
    id, name: id, path, createdAt: Date.now(),
    repositories: [{ id: "repo", alias: "repo", path }], primaryRepositoryId: "repo",
  });
  project(first, "/peek/first");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(EditorView, { projectId: first })); });
    await act(async () => { await Promise.resolve(); });
    window.dispatchEvent(new CustomEventCtor("polyth:editor-context-menu", { detail: {
      projectId: first, sessionId: null, repositoryId: "repo", path: "src/old.ts",
      position: { line: 1, character: 0 }, selection: "old",
    } }));
    await act(async () => { await Promise.resolve(); });
    const peek = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Peek definition"));
    assert.ok(peek, "Peek command is available for the scoped editor");
    await act(async () => { peek!.click(); });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(languageCalls, [first]);

    // Keep the same project and repository IDs while relocating the registered
    // checkout path; this must invalidate the old async request too.
    project(first, "/peek/relocated");
    await act(async () => { root.render(createElement(EditorView, { projectId: first })); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      pendingLanguageReplies[0]!.resolve({ definitions: [{
        projectId: first, sessionId: null, repositoryId: "repo", path: "src/old.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      }] });
      await Promise.resolve();
    });
    assert.equal(container.textContent?.includes("src/old.ts"), false, "old language response does not revive Peek");
    assert.equal(languageCalls.length, 1, "scope switch does not issue a second old-scope language call");

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    window.dispatchEvent(new CustomEventCtor("polyth:editor-definition-list", { detail: { definitions: [{
      projectId: first, sessionId: null, repositoryId: "repo", path: "src/current.ts",
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
    }] } }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.match(document.body.textContent ?? "", /const current = true;/, "valid Peek displays an authorized code excerpt");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    pendingLanguageReplies.length = 0;
  }
});

test("tree context menu anchors to document.body at the click", async () => {
  activateProject("p-files");
  localStorage.removeItem(treeScopeKey({
    projectId: "p-files",
    sessionId: null,
    repositoryId: "primary",
    storageNamespace: workspacePresentationKey("files.tree", "p-files", null),
  }));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(EditorView, { projectId: "p-files", sessionId: null })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const treeEl = container.querySelector<HTMLElement>('[role="tree"]');
    assert.ok(treeEl, "role=tree container rendered");
    const file = [...treeEl!.querySelectorAll<HTMLElement>('[role="treeitem"]')]
      .find((el) => (el.textContent ?? "").includes("README.md"));
    assert.ok(file, "file row rendered");
    await act(async () => {
      file!.dispatchEvent(new MouseEventCtor("contextmenu", { bubbles: true, clientX: 120, clientY: 80 }));
    });
    const anchor = document.body.querySelector<HTMLElement>(".files-ctx-anchor");
    assert.ok(anchor, "click anchor is portaled to document.body");
    assert.equal(anchor!.parentElement, document.body);
    assert.equal(anchor!.style.left, "120px");
    assert.equal(anchor!.style.top, "80px");
    assert.equal(container.querySelector(".files-ctx-anchor"), null, "anchor is not trapped in the files pane");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a hidden Files editor does not reopen when the session scope changes", async () => {
  const projectId = "p-files-closed";
  const pane = (path: string) => JSON.stringify({
    tabs: [{ id: `file:${path}`, kind: "file", resource: path, title: path }],
    activeId: `file:${path}`,
  });
  localStorage.setItem(paneStorageKey(projectId, "first"), pane("first.ts"));
  localStorage.setItem(paneStorageKey(projectId, "second"), pane("second.ts"));
  localStorage.setItem(paneStorageKey(projectId, null), pane("new.ts"));
  const unregister = registerSurface({
    id: "files",
    title: "Files",
    order: 1,
    component: () => null,
    presentation: {
      kind: "workspace", defaultRatio: 0.6, minWidth: 380,
      preferredMaxWidth: 760, keepAlive: true, escape: "close",
    },
  });
  function KeptAliveFiles() {
    const visible = useStore((state) => state.railPlugin === "files");
    return createElement(
      PaneVisibilityContext.Provider,
      { value: visible },
      createElement(EditorView),
    );
  }

  activateProject(projectId);
  activateSession("first");
  openWorkspacePane("files");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(KeptAliveFiles)); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { closeWorkspacePane(); });
    assert.equal(getState().railPlugin, null);

    await act(async () => { activateSession("second"); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(getState().railPlugin, null, "switching sessions keeps the closed Files pane closed");

    await act(async () => { startNewSession(projectId); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(getState().railPlugin, null, "starting a new session keeps the closed Files pane closed");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    unregister();
  }
});

test("fileTypeKeyOf maps names to icon families", () => {
  assert.equal(fileTypeKeyOf("app.ts"), "code");
  assert.equal(fileTypeKeyOf("main.go"), "code");
  assert.equal(fileTypeKeyOf("index.html"), "markup");
  assert.equal(fileTypeKeyOf("README.md"), "doc");
  assert.equal(fileTypeKeyOf("package.json"), "data");
  assert.equal(fileTypeKeyOf("styles.css"), "style");
  assert.equal(fileTypeKeyOf("logo.png"), "image");
  assert.equal(fileTypeKeyOf("build.sh"), "shell");
  assert.equal(fileTypeKeyOf(".gitignore"), "config", "dotfiles read as configuration");
  assert.equal(fileTypeKeyOf("LICENSE"), "file", "no extension falls back to the plain file glyph");
  assert.equal(fileTypeKeyOf("weird.xyz"), "file", "unknown extensions fall back safely");
});
