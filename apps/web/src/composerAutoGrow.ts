// Composer auto-grow measurement without resizing the live editor.
//
// The old measure set the editor's height to `auto` (or `0px` on phones),
// read `scrollHeight` and wrote the result back on every keystroke. Each
// write resized the composer dock for one forced layout, and the transcript
// observes that dock: two style writes per key became two synchronous
// transcript refreshes (and, with heavy selectors, two full-document style
// recalcs). Clamping during the transient size could also move a reader at
// the tail.
//
// Instead an inert twin of the editor, a sibling with the same classes and
// therefore the same cascade, takes the content and reports its natural
// height. It is out of flow and invisible, so measuring moves nothing; the
// live editor's height is written only when the result differs.

const twins = new WeakMap<HTMLTextAreaElement, HTMLTextAreaElement>();

const TWIN_STYLE: Readonly<Record<string, string>> = {
  position: "absolute",
  top: "0",
  "inset-inline-start": "0",
  visibility: "hidden",
  "pointer-events": "none",
  overflow: "hidden",
  "box-sizing": "border-box",
  "z-index": "-1",
  transition: "none",
  animation: "none",
  resize: "none",
};

function syncAttribute(element: Element, name: string, value: string | null): void {
  // Setting an attribute to its current value still queues a mutation record.
  if (element.getAttribute(name) === value) return;
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

function syncStyle(element: HTMLElement, property: string, value: string): void {
  if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value);
}

/** Pixel lengths compare by value: CSSOM may serialize a fraction differently
 *  from how it was written, and every needless write is a mutation the
 *  transcript observes. */
function samePixels(current: string, value: number): boolean {
  return current.endsWith("px") && Math.abs(Number.parseFloat(current) - value) < 0.01;
}

function twinFor(editor: HTMLTextAreaElement): HTMLTextAreaElement | null {
  const parent = editor.parentNode;
  if (!parent || !editor.isConnected) return null;
  const known = twins.get(editor);
  if (known && known.parentNode === parent && known.previousSibling === editor) return known;
  known?.remove();
  // A remounted editor leaves its old twin behind in the same parent.
  for (const stale of Array.from(parent.childNodes)) {
    if (stale.nodeType === 1 && (stale as Element).hasAttribute("data-composer-measure")) stale.remove();
  }
  const twin = editor.ownerDocument.createElement("textarea");
  twin.setAttribute("aria-hidden", "true");
  twin.setAttribute("tabindex", "-1");
  twin.setAttribute("data-composer-measure", "");
  twin.setAttribute("inert", "");
  twin.readOnly = true;
  for (const [property, value] of Object.entries(TWIN_STYLE)) twin.style.setProperty(property, value);
  editor.after(twin);
  twins.set(editor, twin);
  return twin;
}

/**
 * The editor's natural content height (its `scrollHeight` at `height: auto`,
 * or at `0px` when `collapse`), measured on the twin. Falls back to the old
 * in-place measure where no twin can be placed.
 */
export function measureComposerEditor(editor: HTMLTextAreaElement, collapse: boolean): number {
  const twin = twinFor(editor);
  if (!twin) {
    const previous = editor.style.height;
    editor.style.height = collapse ? "0px" : "auto";
    const measured = editor.scrollHeight;
    editor.style.height = previous;
    return measured;
  }
  syncAttribute(twin, "class", editor.getAttribute("class"));
  syncAttribute(twin, "rows", editor.getAttribute("rows"));
  // The placeholder only sizes an empty editor. Chromium restyles a textarea's
  // placeholder on every value change, which re-runs `:has()` invalidation up
  // the ancestors; a twin without one adds no such work per keystroke.
  syncAttribute(twin, "placeholder", editor.value ? null : editor.getAttribute("placeholder"));
  syncAttribute(twin, "dir", editor.getAttribute("dir"));
  const width = Math.round(editor.getBoundingClientRect().width * 100) / 100;
  if (!samePixels(twin.style.width, width)) twin.style.width = `${width}px`;
  syncStyle(twin, "height", collapse ? "0px" : "auto");
  if (twin.value !== editor.value) twin.value = editor.value;
  return twin.scrollHeight;
}

/** Write a height only when it changes: an unchanged write still restyles. */
export function applyComposerEditorHeight(editor: HTMLTextAreaElement, height: number): void {
  if (!samePixels(editor.style.height, height)) editor.style.height = `${height}px`;
}
