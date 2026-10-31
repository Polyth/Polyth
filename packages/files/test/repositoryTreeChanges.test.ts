// Mounted RepositoryTree: session-change badges, folder counters, changed-only
// filter (auto-open + lazy listing), ghost rows for deleted folders, a11y text.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { register } from "node:module";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  localStorage: dom.localStorage,
  location: dom.location,
  getComputedStyle: (element: Element) => dom.getComputedStyle(
    element as unknown as Parameters<Window["getComputedStyle"]>[0],
  ),
  requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
  cancelAnimationFrame: () => {},
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("@polyth/session/web-api");
const { default: RepositoryTree } = await import("../widgets/editor/RepositoryTree.tsx");
type SessionChange = import("../widgets/editor/sessionChanges.ts").SessionChange;

const FS: Record<string, string[]> = {
  "": ["docs/", "src/", "README.md"],
  docs: ["guide.md"],
  src: ["components/", "main.ts"],
  "src/components": ["Button.tsx", "Menu.tsx"],
};
const loaded: string[] = [];
api.filesTree = async (_projectId, path) => {
  loaded.push(path ?? "");
  return (FS[path ?? ""] ?? []).map((name) => {
    const dir = name.endsWith("/");
    const base = dir ? name.slice(0, -1) : name;
    return { name: base, path: path ? `${path}/${base}` : base, dir };
  });
};

const change = (kind: SessionChange["kind"], latestTurn = false): SessionChange => ({ kind, seq: 1, latestTurn });
const CHANGES = new Map<string, SessionChange>([
  ["README.md", change("modified")],
  ["src/components/Button.tsx", change("created", true)],
  ["src/legacy/Old.tsx", change("deleted")],
  ["src/legacy/deep/Older.tsx", change("deleted")],
  ["docs/removed.md", change("deleted")],
]);

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

let mountIndex = 0;
async function mount(props: Record<string, unknown>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const opened: string[] = [];
  const menus: string[] = [];
  const render = async (extra: Record<string, unknown> = {}) => act(async () => {
    root.render(createElement(RepositoryTree, {
      projectId: "p", sessionId: "s",
      repository: { repositoryId: "r", alias: "app", path: "/repo", state: "ready" },
      storageNamespace: `tree-changes-${mountIndex}`,
      visible: true, activePath: null, compact: true, autoReveal: false,
      onOpenFile: (path: string) => opened.push(path), onPinFile: () => {},
      onContextMenu: (_event: unknown, entry: { path: string } | null) => menus.push(entry?.path ?? "-"),
      onFocusSearch: () => {},
      ...props, ...extra,
    }));
  });
  mountIndex++;
  await render();
  await settle();
  const rows = () => [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const row = (name: string) => rows().find((item) => item.querySelector(".ft-name")?.textContent === name);
  return {
    container, rows, row, opened, menus, render,
    names: () => rows().map((item) => item.querySelector(".ft-name")?.textContent),
    click: async (name: string) => { await act(async () => { row(name)!.click(); }); await settle(); },
    key: async (key: string) => {
      await act(async () => {
        container.querySelector('[role="tree"]')!.dispatchEvent(new dom.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event);
      });
      await settle();
    },
    active: () => {
      const id = container.querySelector('[role="tree"]')!.getAttribute("aria-activedescendant");
      return id ? document.getElementById(id)?.querySelector(".ft-name")?.textContent : null;
    },
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("files get a letter badge plus spoken kind; folders count descendants", async () => {
  const tree = await mount({ changes: CHANGES });
  const readme = tree.row("README.md")!;
  const badge = readme.querySelector(".ft-change-badge")!;
  assert.equal(badge.textContent, "M");
  assert.equal(badge.getAttribute("aria-hidden"), "true");
  assert.match(readme.querySelector(".sr-only")!.textContent!, /Modified in this session/);
  assert.equal(readme.getAttribute("title"), "Modified in this session");
  const src = tree.row("src")!;
  assert.equal(src.querySelector(".ft-change-badge")!.textContent, "3");
  assert.match(src.querySelector(".sr-only")!.textContent!, /3 changed in this session · Changed in the last turn/);
  assert.equal(src.querySelector(".ft-change-badge")!.getAttribute("data-recent"), "true");
  // The latest turn marks the badge, never the row background (reads as selection).
  assert.ok(src.classList.contains("ft-changed-recent"));
  assert.equal(tree.row("docs")!.querySelector(".ft-change-badge")!.textContent, "1");
  await tree.unmount();
});

test("deleted files inside a deleted folder stay reachable as ghost rows", async () => {
  const tree = await mount({ changes: CHANGES });
  await tree.click("src");
  const legacy = tree.row("legacy")!;
  assert.ok(legacy, "ghost folder for the removed src/legacy");
  assert.ok(legacy.classList.contains("ft-ghost"));
  assert.equal(legacy.getAttribute("aria-expanded"), "false");
  assert.match(legacy.querySelector(".sr-only")!.textContent!, /Deleted in this session/);
  const before = loaded.length;
  await tree.click("legacy");
  assert.equal(loaded.length, before, "a ghost folder is never listed from disk");
  assert.deepEqual(tree.names().slice(tree.names().indexOf("legacy"), tree.names().indexOf("legacy") + 3), ["legacy", "deep", "Old.tsx"]);
  assert.equal(tree.row("Old.tsx")!.getAttribute("aria-level"), "3");
  assert.equal(tree.row("Old.tsx")!.getAttribute("draggable"), "false");
  // Ghost files are not opened and get no file context menu.
  await tree.click("Old.tsx");
  assert.deepEqual(tree.opened, []);
  await act(async () => {
    tree.row("Old.tsx")!.dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event);
  });
  assert.deepEqual(tree.menus, []);
  await tree.unmount();
});

test("changed-only opens and lists every folder with changes, and can fold one", async () => {
  loaded.length = 0;
  const tree = await mount({ changes: CHANGES, changedOnly: true });
  assert.ok(loaded.includes("src/components"), "auto-opened folders are listed, not shown empty");
  assert.deepEqual(tree.names(), ["docs", "removed.md", "src", "components", "Button.tsx", "legacy", "deep", "Older.tsx", "Old.tsx", "README.md"]);
  assert.equal(tree.row("src")!.getAttribute("aria-expanded"), "true");
  await tree.click("components");
  assert.equal(tree.row("components")!.getAttribute("aria-expanded"), "false");
  assert.equal(tree.row("Button.tsx"), undefined);
  await tree.click("components");
  assert.ok(tree.row("Button.tsx"));
  await tree.unmount();
});

test("changed-only with nothing changed shows the shared empty state outside the tree", async () => {
  const tree = await mount({ changes: new Map(), changedOnly: true });
  const empty = tree.container.querySelector(".empty-state")!;
  assert.ok(empty);
  assert.match(empty.textContent!, /No files changed by chats yet/);
  assert.equal(empty.closest('[role="tree"]'), null);
  assert.equal(tree.rows().length, 0);
  await tree.unmount();
});

test("keyboard: Home/End, ArrowRight enters an open folder, levels and expansion are exposed", async () => {
  const tree = await mount({ changes: CHANGES });
  await tree.key("ArrowDown");
  assert.equal(tree.active(), "docs");
  await tree.key("End");
  assert.equal(tree.active(), "README.md");
  await tree.key("Home");
  assert.equal(tree.active(), "docs");
  await tree.key("ArrowRight");
  assert.equal(tree.row("docs")!.getAttribute("aria-expanded"), "true");
  await tree.key("ArrowRight");
  assert.equal(tree.active(), "guide.md");
  assert.equal(tree.row("guide.md")!.getAttribute("aria-level"), "2");
  await tree.key("ArrowLeft");
  assert.equal(tree.active(), "docs");
  await tree.key("ArrowLeft");
  assert.equal(tree.row("docs")!.getAttribute("aria-expanded"), "false");
  await tree.unmount();
});

test("unchanged trees carry no change marks", async () => {
  const tree = await mount({});
  assert.equal(tree.container.querySelectorAll(".ft-change-badge, .sr-only").length, 0);
  assert.equal(tree.container.querySelector(".empty-state"), null);
  await tree.unmount();
});
