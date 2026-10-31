// The real Files EditorView as a file manager: quick open follows typing and
// Enter opens the best match; the options menu reorders the tree and the row
// shows the sort key; desktop files dropped on a folder upload into it, and
// dropped anywhere else on Files land in the open file's folder; a tree row
// dragged onto a folder moves there; the flat list shows every file.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { FileEntry } from "@polyth/session/web-api";

const dom = new Window({ url: "http://localhost:3000/", width: 430, height: 900 });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  // Files announces changes with window CustomEvents; they must be the DOM's.
  CustomEvent: (dom as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent,
  getComputedStyle: (elt: Element) =>
    (dom as unknown as { getComputedStyle(el: Element): CSSStyleDeclaration }).getComputedStyle(elt),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { callback(0); return 1; } });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = Date.now();
const tree: Record<string, FileEntry[]> = {
  "": [
    { name: "docs", path: "docs", dir: true, mtime: now - 60_000 },
    { name: "big.log", path: "big.log", dir: false, size: 90_000, mtime: now - 86_400_000 },
    { name: "fresh.ts", path: "fresh.ts", dir: false, size: 12, mtime: now - 120_000 },
  ],
  "docs": [{ name: "guide.md", path: "docs/guide.md", dir: false, size: 40, mtime: now - 30_000 }],
};
const listing: FileEntry[] = [
  { name: "big.log", path: "big.log", dir: false, size: 90_000, mtime: now - 86_400_000 },
  { name: "guide.md", path: "docs/guide.md", dir: false, size: 40, mtime: now - 30_000 },
  { name: "fresh.ts", path: "fresh.ts", dir: false, size: 12, mtime: now - 120_000 },
];
const renames: Array<{ from: string; to: string }> = [];
const searchCalls: string[] = [];
const uploads: string[] = [];
(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: { body?: string }) => {
  const u = new URL(String(url), "http://localhost:3000");
  const path = u.searchParams.get("path") ?? "";
  let body: unknown = {};
  if (u.pathname === "/api/files/tree") body = tree[path] ?? [];
  else if (u.pathname === "/api/files/search") {
    searchCalls.push(u.searchParams.get("q") ?? "");
    body = [{ path: "docs/guide.md", score: 2 }, { path: "fresh.ts", score: 1 }];
  } else if (u.pathname === "/api/files/stat") body = null;
  else if (u.pathname === "/api/files/upload") uploads.push(String(JSON.parse(init?.body ?? "{}").path));
  else if (u.pathname === "/api/files/read") body = { path, content: "", truncated: false, revision: "r1" };
  else if (u.pathname === "/api/files/rename") {
    const input = JSON.parse(init?.body ?? "{}") as { from: string; to: string };
    renames.push({ from: input.from, to: input.to });
    body = { ok: true };
  } else if (u.pathname === "/api/files/list") body = { entries: listing, truncated: false };
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { activateProject, getState } = await import("../../../apps/web/src/store.ts");
const { resolveAlert } = await import("../../../apps/web/src/alerts.ts");
const { default: EditorView } = await import("../widgets/EditorView.tsx");

const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const rows = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')];
const names = (container: HTMLElement) => rows(container).map((row) => row.querySelector(".ft-name")?.textContent);
const click = (element: Element) => act(async () => { element.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
const desktopFile = { name: "notes.txt", size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
const filesDrag = (type: string) => {
  const event = new dom.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [desktopFile], dropEffect: "none" } });
  return event as unknown as Event;
};
async function chooseOption(container: HTMLElement, label: string) {
  const more = container.querySelector<HTMLElement>('[aria-label="Files options"]')!;
  await click(more);
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((el) => el.textContent?.trim() === label);
  assert.ok(item, `${label} is a radio entry`);
  await click(item!);
  await wait(10);
}

async function mount(projectId: string) {
  activateProject(projectId);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(EditorView)); });
  await wait(20);
  return {
    container,
    async unmount() { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

test("quick open searches as the person types and Enter opens the best match", async () => {
  const view = await mount("p-fm-search");
  try {
    const input = view.container.querySelector<HTMLInputElement>(".files-search-field input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor((dom as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "guide");
      input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    });
    assert.deepEqual(searchCalls, [], "the first keystroke waits for the debounce");
    await wait(260);
    assert.deepEqual(searchCalls, ["guide"], "no Enter is needed to search");
    const hits = [...view.container.querySelectorAll(".files-hit")];
    assert.equal(hits.length, 2);
    assert.equal(hits[0]!.querySelector(".files-hit-name mark")?.textContent, "guide", "matched characters are marked");
    assert.equal(hits[0]!.querySelector(".files-hit-dir")?.textContent, "docs", "the folder is shown apart from the name");
    assert.match(view.container.querySelector(".files-search-count")?.textContent ?? "", /2/);

    await act(async () => { input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event); });
    assert.equal(getState().editorOpenRequest?.preview, true);
    assert.equal(getState().editorFile, "docs/guide.md", "Enter opens the first result");

    await act(async () => { input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event); });
    assert.equal(input.value, "");
    assert.equal(view.container.querySelector(".files-search-results"), null, "Escape returns to the tree");
  } finally {
    await view.unmount();
  }
});

test("the options menu sorts by modified time or size and the row shows that value", async () => {
  const view = await mount("p-fm-sort");
  try {
    assert.deepEqual(names(view.container), ["docs", "big.log", "fresh.ts"]);
    assert.equal(view.container.querySelector(".ft-meta"), null, "name order shows no metadata");
    const choose = async (label: string) => {
      const more = view.container.querySelector<HTMLElement>('[aria-label="Files options"]')!;
      await act(async () => { more.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((el) => el.textContent?.trim() === label);
      assert.ok(item, `${label} is a radio entry`);
      await act(async () => { item!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
      await wait(10);
    };
    await choose("Last modified");
    assert.deepEqual(names(view.container), ["docs", "fresh.ts", "big.log"], "newest file first, folders stay on top");
    assert.deepEqual(rows(view.container).map((row) => row.querySelector(".ft-meta")?.textContent), ["1m", "2m", "1d"]);
    await choose("Size");
    assert.deepEqual(names(view.container), ["docs", "big.log", "fresh.ts"]);
    assert.deepEqual(rows(view.container).map((row) => row.querySelector(".ft-meta")?.textContent ?? null), [null, "88 KB", "12 B"]);
    const stored = Object.entries({ ...localStorage })
      .find(([key]) => key.includes("files.tree-options") && key.includes("p-fm-sort"))?.[1];
    assert.match(String(stored), /"sort":"size"/, "the order is remembered with the other tree options");
  } finally {
    await view.unmount();
  }
});

test("desktop files dropped on a folder upload into that folder", async () => {
  const view = await mount("p-fm-drop");
  try {
    const docs = rows(view.container).find((row) => row.dataset.path === "docs")!;
    const file = { name: "notes.txt", size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    const dragEvent = (type: string) => {
      const event = new dom.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [file], dropEffect: "none" } });
      return event as unknown as Event;
    };
    await act(async () => { docs.querySelector(".ft-name")!.dispatchEvent(dragEvent("dragover")); });
    assert.ok(docs.classList.contains("ft-drop-target"), "the folder under the pointer is highlighted");
    assert.match(view.container.querySelector(".ft-drop-hint")?.textContent ?? "", /docs/);
    await act(async () => { docs.querySelector(".ft-name")!.dispatchEvent(dragEvent("drop")); });
    await wait(30);
    assert.deepEqual(uploads, ["docs/notes.txt"]);
    assert.equal(view.container.querySelector(".ft-drop-hint"), null);
    assert.match(view.container.querySelector(".files-upload-status")?.textContent ?? "", /Uploaded 1/);
  } finally {
    await view.unmount();
  }
});

test("desktop files dropped on the editor land in the open file's folder", async () => {
  uploads.length = 0;
  const view = await mount("p-fm-window-drop");
  try {
    const docs = rows(view.container).find((row) => row.dataset.path === "docs")!;
    await click(docs);
    await wait(20);
    const guide = rows(view.container).find((row) => row.dataset.path === "docs/guide.md")!;
    await click(guide);
    await wait(40);
    const pane = view.container.querySelector<HTMLElement>(".editor-pane-drop")!;
    await act(async () => {
      pane.dispatchEvent(filesDrag("dragenter"));
      pane.dispatchEvent(filesDrag("dragover"));
    });
    const overlay = view.container.querySelector(".files-window-drop");
    assert.ok(overlay, "dragging desktop files over the editor shows where they will go");
    assert.match(overlay!.textContent ?? "", /Drop to upload into docs/);
    await act(async () => { view.container.querySelector(".files-window-drop")!.dispatchEvent(filesDrag("drop")); });
    await wait(30);
    assert.deepEqual(uploads, ["docs/notes.txt"], "the open file's folder receives the upload");
    assert.equal(view.container.querySelector(".files-window-drop"), null);
  } finally {
    await view.unmount();
  }
});

test("a tree row dropped on a folder moves there after one confirmation", async () => {
  renames.length = 0;
  const view = await mount("p-fm-move");
  try {
    const source = rows(view.container).find((row) => row.dataset.path === "fresh.ts")!;
    const docs = rows(view.container).find((row) => row.dataset.path === "docs")!;
    const data = new Map<string, string>();
    const transfer = {
      types: [] as string[], files: [], dropEffect: "none", effectAllowed: "all",
      setData(type: string, value: string) { data.set(type, value); if (!this.types.includes(type)) this.types.push(type); },
      getData: (type: string) => data.get(type) ?? "",
    };
    const drag = (type: string) => {
      const event = new dom.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      return event as unknown as Event;
    };
    await act(async () => { source.dispatchEvent(drag("dragstart")); });
    await act(async () => { source.dispatchEvent(drag("dragover")); });
    assert.equal(view.container.querySelector(".ft-drop-hint"), null, "its own folder is not a target");
    await act(async () => { docs.querySelector(".ft-name")!.dispatchEvent(drag("dragover")); });
    assert.ok(docs.classList.contains("ft-drop-target"));
    assert.match(view.container.querySelector(".ft-drop-hint")?.textContent ?? "", /Drop to move into docs/);
    await act(async () => { docs.querySelector(".ft-name")!.dispatchEvent(drag("drop")); });
    await act(async () => { resolveAlert(true); });
    await wait(30);
    assert.deepEqual(renames, [{ from: "fresh.ts", to: "docs/fresh.ts" }]);
    assert.match(view.container.querySelector(".files-upload-status")?.textContent ?? "", /Moved fresh\.ts to docs/);
  } finally {
    await view.unmount();
  }
});

test("the flat list shows every file with its folder, in the tree's order", async () => {
  const view = await mount("p-fm-flat");
  try {
    await chooseOption(view.container, "List");
    await wait(30);
    const flat = () => [...view.container.querySelectorAll<HTMLElement>(".files-flat-row")];
    assert.deepEqual(flat().map((row) => row.querySelector(".files-hit-name")?.textContent), ["big.log", "guide.md", "fresh.ts"], "path order by default");
    assert.equal(flat()[1]!.querySelector(".files-hit-dir")?.textContent, "docs");
    assert.equal(rows(view.container).length, 0, "the tree is replaced");
    await chooseOption(view.container, "Last modified");
    assert.deepEqual(flat().map((row) => row.querySelector(".files-hit-name")?.textContent), ["guide.md", "fresh.ts", "big.log"], "newest first across folders");
    await click(flat()[0]!);
    assert.equal(getState().editorFile, "docs/guide.md");
  } finally {
    await view.unmount();
  }
});
