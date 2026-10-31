import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window();
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useInlineRename } = await import("../src/components/input/inlineRename.ts");

interface Log { commits: number; cancels: number }

function mount(opts: { closeOnSettle?: boolean } = {}) {
  // Real fields close themselves when they commit. A row menu that switches
  // the open field to another row batches that close with the next open, so
  // the rendered identity can go straight from one row to the next.
  const closeOnSettle = opts.closeOnSettle ?? true;
  const log: Log = { commits: 0, cancels: 0 };
  let handlers!: ReturnType<typeof useInlineRename>;
  let setEditing!: (value: string | null) => void;

  function Harness() {
    const [editing, set] = useState<string | null>("a");
    setEditing = set;
    handlers = useInlineRename({
      editing,
      commit: () => { log.commits += 1; if (closeOnSettle) set(null); },
      cancel: () => { log.cancels += 1; if (closeOnSettle) set(null); },
    });
    return createElement("input", { value: "", readOnly: true });
  }

  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  act(() => { root.render(createElement(Harness)); });
  return {
    log,
    key: (key: string, native?: { isComposing?: boolean; keyCode?: number }) =>
      act(() => { handlers.onKeyDown({ key, ...(native ? { nativeEvent: native } : {}) }); }),
    blur: () => act(() => { handlers.onBlur(); }),
    open: (id: string) => act(() => { setEditing(id); }),
    unmount: () => act(() => { root.unmount(); }),
  };
}

// Committing detaches the field, and detaching fires blur. Without a latch the
// same edit is submitted twice — two rename requests racing each other.
test("Enter commits exactly once even though it triggers a blur", () => {
  const h = mount();
  h.key("Enter");
  h.blur();
  assert.equal(h.log.commits, 1);
  assert.equal(h.log.cancels, 0);
  h.unmount();
});

test("Escape cancels, and the blur it causes does not then commit", () => {
  const h = mount();
  h.key("Escape");
  h.blur();
  assert.equal(h.log.cancels, 1);
  assert.equal(h.log.commits, 0);
  h.unmount();
});

test("blur alone commits once", () => {
  const h = mount();
  h.blur();
  h.blur();
  assert.equal(h.log.commits, 1);
  h.unmount();
});

// An Enter that ends an IME composition is choosing a candidate. Committing
// there would save the raw phonetic text instead of what the user typed.
test("Enter during an IME composition neither commits nor cancels", () => {
  const h = mount();
  h.key("Enter", { isComposing: true });
  assert.equal(h.log.commits, 0);

  // Mobile browsers drop isComposing and report the legacy keyCode instead.
  h.key("Enter", { keyCode: 229 });
  assert.equal(h.log.commits, 0);

  // The Enter that actually submits, once composition has ended.
  h.key("Enter", { isComposing: false, keyCode: 13 });
  assert.equal(h.log.commits, 1);
  h.unmount();
});

test("reopening the field — including straight onto another row — arms it again", () => {
  const h = mount();
  h.key("Enter");
  assert.equal(h.log.commits, 1);

  h.open("a");
  h.key("Enter");
  assert.equal(h.log.commits, 2, "the same row renames a second time");
  h.unmount();

  // Clicking rename on another row while one is open: the blur that commits
  // the first and the state change that opens the second land in one render,
  // so the identity goes straight from "a" to "b" with no closed state in
  // between. The latch must still re-arm.
  const direct = mount({ closeOnSettle: false });
  direct.blur();
  assert.equal(direct.log.commits, 1);
  direct.open("b");
  direct.key("Enter");
  assert.equal(direct.log.commits, 2, "a different row renames without a reset in between");
  direct.unmount();
});
