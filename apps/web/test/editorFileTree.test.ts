// Finding 7 (UX-SHELL-CONSOLIDATION-02): Project Files tree. The selected row
// used the generic `sel` class — collided with the `.sel` select-widget rule —
// and rows had no tree semantics. This mounts the REAL EditorView and asserts
// the ARIA tree contract (role=tree/treeitem, aria-level, aria-expanded,
// aria-activedescendant) plus the namespaced ft-selected state, indentation,
// and disclosure toggling.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { FileEntry } from "../src/api.ts";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
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
(globalThis as { fetch?: unknown }).fetch = async (url: string) => {
  const u = new URL(String(url), "http://localhost:3000");
  const body: unknown = u.pathname === "/api/files/tree"
    ? tree[u.searchParams.get("path") ?? ""] ?? []
    : u.pathname === "/api/files/read"
      ? { path: u.searchParams.get("path"), content: "", truncated: false, revision: "r1" }
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
const { activateProject } = await import("../src/store.ts");
const { fileTypeKeyOf } = await import("../src/editor/fileTreeIcons.tsx");
const { default: EditorView } = await import("../src/components/EditorView.tsx");

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
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

    // Finding 1 (UX-FILES-TIMELINE-03): rows carry decorative type glyphs —
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
    const indentOf = (el: HTMLElement) => parseInt(el.style.paddingLeft || "0", 10);
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
