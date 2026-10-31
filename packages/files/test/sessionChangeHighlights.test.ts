// Chat change highlighting in Files: the open file's editor gets per-chat
// change marks (Git decides what changed, edit fragments decide who), the
// tree shows a dot per chat, and IDE mode keeps each chat's edited files open
// as its own tabs. Mounts the REAL FilePane / RepositoryTree / EditorView.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

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
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = "export const a = 1;\nexport const b = 2;\n";
const CURRENT = "export const a = 1;\nexport const b = 20;\nexport const c = 3;\n";
const contents: Record<string, string> = { "src/app.ts": CURRENT, "src/other.ts": "x\n" };
let sessionEdits: unknown = { sources: [] };
const requests: Array<{ path: string; body?: unknown }> = [];
let diffText = "";
(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: { method?: string; body?: string }) => {
  const u = new URL(String(url), "http://localhost:3000");
  const p = u.searchParams.get("path") ?? "";
  requests.push({ path: u.pathname, ...(init?.body ? { body: JSON.parse(init.body) as unknown } : {}) });
  const body: unknown = u.pathname === "/api/files/read"
    ? { path: p, content: contents[p] ?? "", truncated: false, revision: "r1" }
    : u.pathname === "/api/files/stat"
      ? { path: p, kind: "file", size: 1, revision: "r1" }
      : u.pathname === "/api/files/tree"
        ? (p === "src"
          ? [{ name: "app.ts", path: "src/app.ts", dir: false }, { name: "other.ts", path: "src/other.ts", dir: false }]
          : p === "" ? [{ name: "src", path: "src", dir: true }] : [])
        : u.pathname === "/api/git/diff"
          ? { path: p, diff: p === "src/app.ts" ? diffText : "", snapshotDigest: "a".repeat(64) }
          : u.pathname === "/api/files/session-edits"
            ? sessionEdits
            : u.pathname === "/api/git/hunk/discard"
              ? { ok: true }
              : {};
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { unifiedDiff } = await import("../../../apps/web/src/diff.ts");
const { resetDocsForTest } = await import("../widgets/editor/fileDocs.ts");
const { registerEditorSurface } = await import("../../../apps/web/src/resources/views.ts");
const { registerResourceProvider } = await import("../../../apps/web/src/resources/providers.ts");
const { fileResourceProvider } = await import("../widgets/fileProvider.ts");
const { default: FilePane } = await import("../widgets/editor/FilePane.tsx");
const { default: RepositoryTree } = await import("../widgets/editor/RepositoryTree.tsx");
const { default: EditorView } = await import("../widgets/EditorView.tsx");
const { buildCheckoutEdits } = await import("../widgets/editor/checkoutEdits.ts");
const { checkoutScopeKey, publishCheckoutEdits, resetCheckoutEditsForTest } = await import("../widgets/editor/sessionEditsStore.ts");
const { resetSessionEditsCacheForTest } = await import("../widgets/editor/sessionEditsClient.ts");
const { bindFilesWorkbench } = await import("../widgets/workbenchHints.ts");
const { paneStorageKey } = await import("../../../apps/web/src/components/workspace/PaneHost.tsx");
const { activateProject } = await import("../../../apps/web/src/store.ts");
type ChangeSet = import("../../../apps/web/src/resources/views.ts").EditorChangeSet;

registerResourceProvider(fileResourceProvider);
let lastChanges: ChangeSet | null | undefined;
registerEditorSurface((props) => {
  lastChanges = props.changes;
  return createElement("div", { className: "editor-code", "data-path": props.path });
});

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const EventCtor = (dom as unknown as { Event: typeof Event }).Event;
const click = (el: Element) => el.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
const settle = async (ms = 10) => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
};

const call = (callId: string, seq: number, path: string, input: Record<string, string>, time = seq) =>
  ({ callId, seq, time, tool: input.content !== undefined ? "Write" : "Edit", input, changedFiles: [path] });

test("the open file gets per-chat change marks, a review bar, Keep and Undo", async () => {
  resetDocsForTest();
  resetCheckoutEditsForTest();
  diffText = unifiedDiff(BASE, CURRENT, "src/app.ts");
  const edits = buildCheckoutEdits([
    { sessionId: "me", title: "Me", createdAt: 2, viewer: true, calls: [
      call("m1", 5, "src/app.ts", { file_path: "src/app.ts", old_string: "export const b = 2;", new_string: "export const b = 20;" }),
    ] },
    { sessionId: "child", title: "Add c", createdAt: 1, viewer: false, calls: [
      call("c1", 9, "src/app.ts", { file_path: "src/app.ts", old_string: "export const b = 20;", new_string: "export const b = 20;\nexport const c = 3;" }),
    ] },
  ], []);
  publishCheckoutEdits([checkoutScopeKey("p1", "me", undefined)], { edits, viewerFiles: ["src/app.ts"] });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(FilePane, { projectId: "p1", sessionId: "me", resource: "src/app.ts", visible: true }));
    });
    await settle();
    assert.ok(lastChanges, "Files hands the editor a change set");
    assert.deepEqual(lastChanges!.tones.map((tone) => [tone.color, tone.attributed]), [
      ["var(--session-tone-0)", true],
      ["var(--session-tone-1)", true],
    ]);
    const lines = lastChanges!.hunks.flatMap((hunk) => hunk.lines.map((line) => [line.line, lastChanges!.tones[line.tone]!.label]));
    assert.deepEqual(lines, [[2, "Changed by This chat"], [3, "Changed by Add c"]]);
    assert.deepEqual(lastChanges!.hunks[0]!.removed.map((block) => block.text), [["export const b = 2;"]]);
    const bar = container.querySelector(".files-review-bar");
    assert.ok(bar, "review bar shown");
    assert.match(bar!.textContent ?? "", /This chat/);
    assert.match(bar!.textContent ?? "", /Add c/);
    assert.match(bar!.textContent ?? "", /Changes: 1/);

    await act(async () => { lastChanges!.onAction!(lastChanges!.hunks[0]!.id, "undo"); });
    await settle();
    const discard = requests.find((request) => request.path === "/api/git/hunk/discard");
    assert.deepEqual(discard?.body, {
      projectId: "p1", sessionId: "me", path: "src/app.ts", hunkIndex: 0,
      hunkDigest: lastChanges!.hunks[0]!.id.split(":")[1], expectedSnapshotDigest: "a".repeat(64), expectedStaged: false,
    });

    const keepAll = [...container.querySelectorAll("button")].find((button) => button.textContent === "Keep all");
    assert.ok(keepAll);
    await act(async () => { click(keepAll!); });
    await settle();
    assert.equal(lastChanges, null, "kept changes are no longer drawn");
    assert.equal(container.querySelector(".files-review-bar"), null);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    localStorage.clear();
    resetCheckoutEditsForTest();
  }
});

test("the tree shows a dot per chat and names the chats", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const changes = new Map([
    ["src/app.ts", { kind: "modified" as const, seq: 9, latestTurn: false, sessions: ["me", "child"] }],
  ]);
  try {
    await act(async () => {
      root.render(createElement(RepositoryTree, {
        projectId: "p-tree-owners",
        sessionId: "me",
        repository: { repositoryId: "primary", alias: "app", path: "/repo", state: "ready" },
        storageNamespace: "tree-owners",
        visible: true,
        activePath: null,
        compact: true,
        changes,
        changeSessions: [
          { sessionId: "me", title: "Me", viewer: true, tone: 0 },
          { sessionId: "child", title: "Add c", viewer: false, tone: 1 },
        ],
        changedOnly: true,
        onOpenFile: () => {},
        onPinFile: () => {},
        onContextMenu: () => {},
        onFocusSearch: () => {},
      }));
    });
    await settle();
    const row = [...container.querySelectorAll('[role="treeitem"]')].find((el) => el.textContent?.includes("app.ts"));
    assert.ok(row, "changed file listed");
    assert.equal(row!.querySelectorAll(".ft-change-owner").length, 2);
    assert.equal(row!.getAttribute("title"), "Modified · Changed by This chat, Add c");
    const folder = [...container.querySelectorAll('[role="treeitem"]')].find((el) => el.textContent?.startsWith("src"));
    assert.equal(folder?.querySelectorAll(".ft-change-owner").length, 2, "folders carry their descendants' chats");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("IDE mode opens every file the chat edited as its own tabs and respects a closed tab", async () => {
  resetDocsForTest();
  resetCheckoutEditsForTest();
  resetSessionEditsCacheForTest();
  localStorage.clear();
  diffText = "";
  const unbind = bindFilesWorkbench({
    getActiveProfile: () => ({ id: "ide", label: "IDE", description: "", order: 1, available: true, presentation: { openSessionEdits: true } }),
    subscribe: () => () => {},
  });
  const projectId = "p-ide";
  activateProject(projectId);
  const source = (calls: unknown[]) => ({ sources: [
    { sessionId: "s-ide", title: "Chat", createdAt: 1, viewer: true, cursor: 40, more: false, calls },
  ] });
  sessionEdits = source([
    call("w1", 10, "src/app.ts", { file_path: "src/app.ts", content: CURRENT }),
    call("w2", 20, "src/other.ts", { file_path: "src/other.ts", content: "x\n" }),
  ]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const tabTitles = () => [...container.querySelectorAll(".pane-tab .pane-tab-title")].map((el) => el.textContent);
  try {
    await act(async () => { root.render(createElement(EditorView, { projectId, sessionId: "s-ide" })); });
    await settle(20);
    assert.deepEqual(tabTitles(), ["app.ts", "other.ts"]);
    assert.ok(container.querySelector(".pane-tab .pane-tab-marker"), "edited tabs carry the chat's colour");
    assert.ok(localStorage.getItem(paneStorageKey(projectId, "s-ide"))?.includes("src/other.ts"), "the chat's own pane keeps them");

    const close = container.querySelector('[aria-label="Close other.ts"]');
    assert.ok(close);
    await act(async () => { click(close!); });
    await settle(20);
    assert.deepEqual(tabTitles(), ["app.ts"]);

    window.dispatchEvent(new EventCtor("focus"));
    await settle(20);
    assert.deepEqual(tabTitles(), ["app.ts"], "a closed tab stays closed while the chat has not edited it again");

    sessionEdits = source([call("w3", 30, "src/other.ts", { file_path: "src/other.ts", content: "y\n" })]);
    window.dispatchEvent(new EventCtor("focus"));
    await settle(20);
    assert.deepEqual(tabTitles(), ["app.ts", "other.ts"], "a new edit opens it again");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    unbind();
    localStorage.clear();
    resetCheckoutEditsForTest();
    resetSessionEditsCacheForTest();
  }
});
