// FilePane mode model. Mounts the REAL
// FilePane and asserts (3) previewable files land in preview behind a
// segmented Edit/Preview control whose choice persists per kind, (4) other files open straight
// into edit mode with a syntax-highlight backdrop under the textarea, and
// (5) the toolbar is trimmed — Delete/Rename/Edit/Wrap/Go to line/Add-to-chat
// live in the context menu, not as permanent buttons.
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

// Deterministic files API: reads serve fixed content, stats agree with reads.
const contents: Record<string, string> = {
  "src/app.ts": "const total = 1;\nexport default total;\n",
  "README.md": "# Title\n\nBody text\n",
  "notes.md": "# Notes\n",
  "package.json": "{\"name\":\"demo\",\"private\":true}\n",
  "index.html": "<h1>Hello</h1>\n",
  "data/people.csv": "name,age\nBob,42\nAnn,7\nCid,100\n",
  "logo.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script><rect width=\"4\" height=\"4\"/></svg>\n",
  "src/tree.ts": "export interface Node {\n}\nexport function walk() {\n}\nexport class Tree {\n  grow() {\n  }\n}\n",
};
(globalThis as { fetch?: unknown }).fetch = async (url: string) => {
  const u = new URL(String(url), "http://localhost:3000");
  const p = u.searchParams.get("path") ?? "";
  const body: unknown = u.pathname === "/api/files/read"
    ? { path: p, content: contents[p] ?? "", truncated: false, revision: "r1" }
    : u.pathname === "/api/files/stat"
      ? { path: p, kind: "file", size: 1, revision: "r1" }
      : {};
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
const { resetDocsForTest } = await import("../widgets/editor/fileDocs.ts");
const { getEditorPrefs } = await import("../../../apps/web/src/uiPrefs.ts");
const { registerEditorSurface, registerEditorSelection } = await import("../../../apps/web/src/resources/views.ts");
const { registerResourceProvider } = await import("../../../apps/web/src/resources/providers.ts");
const { fileResourceProvider } = await import("../widgets/fileProvider.ts");
const { default: FilePane } = await import("../widgets/editor/FilePane.tsx");

registerResourceProvider(fileResourceProvider);

registerEditorSurface((props) => createElement("div", {
  className: "editor-code",
  "aria-label": props.ariaLabel,
  "data-path": props.path,
  "data-group": props.groupId,
  "data-reveal": props.reveal ? String(props.reveal.startLine) : undefined,
}));
let selectionForTest: { text: string; startLine: number; endLine: number } | null = null;
registerEditorSelection(() => selectionForTest);

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const click = (el: Element) => el.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));

async function mountFile(path: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(FilePane, { projectId: "p1", sessionId: null, resource: path, visible: true }));
  });
  for (let i = 0; i < 8; i++) {
    await act(async () => { await Promise.resolve(); });
  }
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("code files open straight into edit mode; toolbar is trimmed", async () => {
  resetDocsForTest();
  const { container, unmount } = await mountFile("src/app.ts");
  try {
    // Finding 4: no Edit-button detour — the editor surface IS the first view.
    const surface = container.querySelector(".editor-code");
    assert.ok(surface, "editor surface rendered on first open");
    assert.equal(surface!.getAttribute("aria-label"), "Edit src/app.ts");
    assert.equal(container.querySelector(".editor-mode-switch"), null, "non-previewable files have no mode switch");

    assert.equal(container.querySelector(".editor-head"), null, "the tab is the only file title row");
    assert.equal(
      container.querySelector('[aria-label="Close file"]'),
      null,
      "FilePane does not duplicate the tab close action",
    );
    assert.equal(container.querySelector(".editor-more-btn"), null, "no permanent overflow button");
    assert.equal(container.querySelector('[aria-label="Actions for src/app.ts"]'), null, "no permanent actions trigger");

    const editSurface = container.querySelector<HTMLElement>(".editor-edit")!;
    assert.ok(editSurface, "editor edit surface present");
    await act(async () => {
      editSurface.dispatchEvent(new MouseEventCtor("contextmenu", { bubbles: true, clientX: 48, clientY: 48 }));
    });
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    assert.ok(menu, "file actions context menu opens");
    const items = [...menu!.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
    for (const needed of ["Add file to chat", "Copy path", "Rename / move…", "Delete…"]) {
      assert.ok(items.includes(needed), `menu offers "${needed}"`);
    }
    assert.ok(items.some((t) => t.startsWith("Add selection to chat")), "menu offers selection→chat");
    assert.ok(items.some((t) => t.startsWith("Go to line")), "menu offers go-to-line");
    const wrapItem = menu!.querySelector<HTMLElement>('[role="menuitemcheckbox"]');
    assert.ok(wrapItem, "wrap is a checkable menu item");
    assert.equal(wrapItem!.getAttribute("aria-checked"), "true", "wrap defaults on");
    assert.equal(container.querySelector(".editor-sel-hint"), null, "legacy @ hint removed");
  } finally {
    await unmount();
  }
});

const modeTab = (container: Element, id: "edit" | "preview") =>
  [...container.querySelectorAll<HTMLElement>('.editor-mode-switch [role="tab"]')][id === "edit" ? 0 : 1];

test("markdown opens in preview behind an Edit/Preview control; the choice persists per kind", async () => {
  resetDocsForTest();
  const first = await mountFile("README.md");
  try {
    // Finding 3: preview is the landing mode…
    assert.ok(first.container.querySelector(".editor-md-preview"), "markdown lands in preview");
    assert.equal(first.container.querySelector(".editor-code"), null);
    const preview = modeTab(first.container, "preview");
    assert.ok(preview, "a segmented control names both modes");
    assert.equal(preview!.textContent, "Preview");
    assert.equal(preview!.getAttribute("aria-selected"), "true", "the control reports preview on");

    // …and choosing Edit flips modes without closing the file.
    await act(async () => { click(modeTab(first.container, "edit")!); });
    assert.equal(first.container.querySelector(".editor-md-preview"), null, "preview hidden after flip");
    assert.ok(first.container.querySelector(".editor-code"), "edit mode active after flip");
    assert.equal(modeTab(first.container, "edit")!.getAttribute("aria-selected"), "true");
    assert.equal(getEditorPrefs().previewByKind.markdown, false, "flip persists the per-kind choice");
  } finally {
    await first.unmount();
  }

  // A fresh markdown file honors the persisted edit-first choice…
  resetDocsForTest();
  const second = await mountFile("notes.md");
  try {
    assert.ok(second.container.querySelector(".editor-code"), "persisted choice lands in edit mode");
    assert.equal(second.container.querySelector(".editor-md-preview"), null);
    assert.equal(modeTab(second.container, "preview")!.getAttribute("aria-selected"), "false");

    // …and flipping back to preview persists again.
    await act(async () => { click(modeTab(second.container, "preview")!); });
    assert.ok(second.container.querySelector(".editor-md-preview"), "switch returns to preview");
    assert.equal(getEditorPrefs().previewByKind.markdown, true);
  } finally {
    await second.unmount();
  }
});

test("json and html files land in preview", async () => {
  resetDocsForTest();
  const json = await mountFile("package.json");
  try {
    assert.ok(json.container.querySelector(".editor-json-preview"), "json lands in tree preview");
    assert.equal(json.container.querySelector(".editor-code"), null);
    const tree = modeTab(json.container, "preview");
    assert.ok(tree, "json has a preview mode");
    assert.equal(tree!.getAttribute("aria-selected"), "true");
  } finally {
    await json.unmount();
  }

  resetDocsForTest();
  const html = await mountFile("index.html");
  try {
    assert.ok(html.container.querySelector(".editor-html-preview"), "html lands in sandboxed preview");
    assert.ok(html.container.querySelector("iframe.html-preview-frame"), "html preview uses an iframe");
    assert.equal(html.container.querySelector(".editor-code"), null);
  } finally {
    await html.unmount();
  }
});

test("selecting text opens the selection menu with chat, explain, and fix", async () => {
  resetDocsForTest();
  selectionForTest = { text: "const total = 1;", startLine: 1, endLine: 1 };
  const { container, unmount } = await mountFile("src/app.ts");
  try {
    const editSurface = container.querySelector<HTMLElement>(".editor-edit")!;
    assert.ok(editSurface, "editor edit surface present");
    await act(async () => {
      editSurface.dispatchEvent(new MouseEventCtor("mouseup", { bubbles: true, button: 0, clientX: 64, clientY: 80 }));
    });
    const menus = [...document.querySelectorAll<HTMLElement>('[role="menu"]')];
    const menu = menus.find((node) =>
      [...node.querySelectorAll(".ui-menu-item-label")].some((label) => (label.textContent ?? "").trim() === "Explain"),
    );
    assert.ok(menu, "selection menu opens on mouseup");
    const labels = [...menu!.querySelectorAll(".ui-menu-item-label")].map((node) => (node.textContent ?? "").trim());
    assert.deepEqual(labels, ["Add to chat", "Explain", "Fix inline"]);
    assert.equal(menu!.querySelectorAll("svg").length, 3, "selection actions have icons");
    const detail = menu!.querySelector(".ui-menu-item-detail")?.textContent ?? "";
    assert.match(detail, /\+L$/);
  } finally {
    selectionForTest = null;
    await unmount();
  }
});


test("CSV opens as a sortable, filterable table; SVG previews as an image", async () => {
  resetDocsForTest();
  const csv = await mountFile("data/people.csv");
  try {
    const switcher = csv.container.querySelector(".editor-mode-switch");
    assert.ok(switcher, "CSV has an Edit/Table switch");
    assert.match(switcher!.textContent ?? "", /Table/);
    const cells = () => [...csv.container.querySelectorAll(".editor-csv-table tbody tr")].map((row) => row.querySelectorAll("td")[1]?.textContent);
    assert.deepEqual([...csv.container.querySelectorAll(".editor-csv-table thead th")].map((cell) => cell.textContent?.trim()), ["#", "name", "age"]);
    assert.deepEqual(cells(), ["Bob", "Ann", "Cid"]);
    assert.match(csv.container.querySelector(".editor-csv-summary")?.textContent ?? "", /3 rows × 2 columns/);
    const ageHeader = csv.container.querySelectorAll(".editor-csv-sort")[1]!;
    await act(async () => { click(ageHeader); });
    assert.deepEqual(cells(), ["Ann", "Bob", "Cid"], "numbers sort numerically");
    assert.ok(csv.container.querySelectorAll(".editor-csv-table td.numeric").length >= 3, "numeric cells align as numbers");
    await act(async () => { click(ageHeader); });
    assert.deepEqual(cells(), ["Cid", "Bob", "Ann"], "second click reverses");
    const filter = csv.container.querySelector<HTMLInputElement>(".editor-csv-bar input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor((dom as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement.prototype, "value")!.set!;
      setter.call(filter, "an");
      filter.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(cells(), ["Ann"]);
  } finally {
    await csv.unmount();
  }
  const svg = await mountFile("logo.svg");
  try {
    const image = svg.container.querySelector<HTMLImageElement>(".editor-image img");
    assert.ok(image, "SVG previews through the image viewer");
    assert.match(image!.getAttribute("src") ?? "", /^data:image\/svg\+xml;charset=utf-8,/, "rendered as an image: its script never runs");
    assert.equal(svg.container.querySelector("iframe"), null);
  } finally {
    await svg.unmount();
  }
});

test("Go to symbol lists the file's declarations and reveals the picked line", async () => {
  resetDocsForTest();
  const { container, unmount } = await mountFile("src/tree.ts");
  try {
    await act(async () => {
      window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "O", ctrlKey: true, shiftKey: true, bubbles: true }) as unknown as Event);
    });
    const panel = document.querySelector(".files-symbols");
    assert.ok(panel, "Ctrl+Shift+O opens the symbol list");
    const names = () => [...document.querySelectorAll(".files-symbol-name")].map((node) => node.textContent);
    assert.deepEqual(names(), ["Node", "walk", "Tree", "grow"]);
    const input = panel!.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor((dom as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "gr");
      input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    });
    assert.deepEqual(names(), ["grow"]);
    await act(async () => { input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event); });
    assert.equal(document.querySelector(".files-symbols"), null, "picking closes the list");
    assert.equal(container.querySelector(".editor-code")?.getAttribute("data-reveal"), "6", "the editor reveals the symbol's line");
  } finally {
    await unmount();
  }
});
