// UX-FILES-TIMELINE-03 findings 3–5: FilePane mode model. Mounts the REAL
// FilePane and asserts (3) previewable files land in preview behind a real
// on/off switch whose choice persists per kind, (4) other files open straight
// into edit mode with a syntax-highlight backdrop under the textarea, and
// (5) the toolbar is trimmed — Delete/Rename/Edit/Wrap/Go to line/Add-to-chat
// live in the "⋯" actions menu, not as permanent buttons.
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
const { registerEditorSurface } = await import("../../../apps/web/src/resources/views.ts");
const { default: FilePane } = await import("../widgets/editor/FilePane.tsx");

registerEditorSurface((props) => createElement("div", {
  className: "editor-code",
  "aria-label": props.ariaLabel,
  "data-path": props.path,
}));

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const click = (el: Element) => el.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));

async function mountFile(path: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(FilePane, { projectId: "p1", sessionId: null, resource: path, visible: true }));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
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
    assert.equal(container.querySelector('[role="switch"]'), null, "non-previewable files have no mode switch");

    // Finding 5: the trimmed toolbar has no permanent single-action buttons.
    const toolbar = container.querySelector<HTMLElement>(".editor-toolbar")!;
    const toolbarLabels = [...toolbar.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
    for (const gone of ["Edit", "Rename", "Delete", "Wrap", "Go to line", "Add file to chat", "Add selection to chat"]) {
      assert.equal(toolbarLabels.includes(gone), false, `toolbar must not contain a "${gone}" button`);
    }
    const more = toolbar.querySelector<HTMLElement>('[aria-haspopup="menu"]');
    assert.ok(more, "actions menu button present");
    assert.equal(more!.getAttribute("aria-label"), "Actions for src/app.ts");

    // Every removed capability is reachable from the menu.
    await act(async () => { click(more!); });
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    assert.ok(menu, "actions menu opens");
    const items = [...menu!.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
    for (const needed of ["Add file to chat", "Copy path", "Rename / move…", "Delete…"]) {
      assert.ok(items.includes(needed), `menu offers "${needed}"`);
    }
    assert.ok(items.some((t) => t.startsWith("Add selection to chat")), "menu offers selection→chat");
    assert.ok(items.some((t) => t.startsWith("Go to line")), "menu offers go-to-line");
    const wrapItem = menu!.querySelector<HTMLElement>('[role="menuitemcheckbox"]');
    assert.ok(wrapItem, "wrap is a checkable menu item");
    assert.equal(wrapItem!.getAttribute("aria-checked"), "true", "wrap defaults on");
    assert.equal(
      container.querySelector(".editor-sel-hint"),
      null,
      "selection hint absent without an active selection",
    );
  } finally {
    await unmount();
  }
});

test("markdown opens in preview behind a real switch; the choice persists per kind", async () => {
  resetDocsForTest();
  const first = await mountFile("README.md");
  try {
    // Finding 3: preview is the landing mode…
    assert.ok(first.container.querySelector(".editor-md-preview"), "markdown lands in preview");
    assert.equal(first.container.querySelector(".editor-code"), null);
    const sw = first.container.querySelector<HTMLElement>('[role="switch"]');
    assert.ok(sw, "a real switch controls preview↔edit");
    assert.equal(sw!.getAttribute("aria-checked"), "true", "switch reports preview on");

    // …and the switch flips to edit without closing the file.
    await act(async () => { click(sw!); });
    assert.equal(first.container.querySelector(".editor-md-preview"), null, "preview hidden after flip");
    assert.ok(first.container.querySelector(".editor-code"), "edit mode active after flip");
    assert.equal(sw!.getAttribute("aria-checked"), "false");
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
    const sw = second.container.querySelector<HTMLElement>('[role="switch"]')!;
    assert.equal(sw.getAttribute("aria-checked"), "false");

    // …and flipping back to preview persists again.
    await act(async () => { click(sw); });
    assert.ok(second.container.querySelector(".editor-md-preview"), "switch returns to preview");
    assert.equal(getEditorPrefs().previewByKind.markdown, true);
  } finally {
    await second.unmount();
  }
});
