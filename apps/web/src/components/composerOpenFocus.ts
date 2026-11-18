// Opening a chat, an existing one or a new one, leaves a mouse or trackpad
// screen ready to type (docs/dev/ui.md, "Focus when a chat opens"). Touch is
// left alone: focusing a field there raises the software keyboard.

/** Focus someone else holds: a text field being typed in, or a dialog, menu or
 *  popover that owns the keyboard until it closes. */
const HELD_FOCUS = [
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  "dialog",
  "[role='dialog']",
  "[role='alertdialog']",
  "[aria-modal='true']",
  "[role='menu']",
  "[role='listbox']",
  ".ui-popover",
].join(", ");

/** The composer may take focus from `active`: nothing holds it (the page, a
 *  navigator row, a toolbar button) or it is already inside the composer. */
export function openFocusIsFree(active: Element | null, composer: Element | null): boolean {
  if (!active) return true;
  const doc = active.ownerDocument;
  if (active === doc.body || active === doc.documentElement) return true;
  if (composer?.contains(active)) return true;
  return active.closest(HELD_FOCUS) === null;
}

/** Focus the opened chat's composer once focus is free and the field can take
 *  it, retrying a few frames while the surface settles (a menu or palette
 *  closing, a drawer releasing inert). Returns a cancel for the next open. */
export function focusOnChatOpen(
  composer: () => HTMLElement | null,
  focus: () => void,
  frames = 30,
): () => void {
  let cancelled = false;
  let cancelNext: (() => void) | null = null;
  const next = (attempt: () => void) => {
    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(attempt);
      cancelNext = () => cancelAnimationFrame(frame);
    } else {
      const timer = setTimeout(attempt, 16);
      cancelNext = () => clearTimeout(timer);
    }
  };
  const attempt = (left: number) => () => {
    cancelNext = null;
    if (cancelled) return;
    const root = composer();
    const input = root?.querySelector<HTMLElement>("[data-composer-input]") ?? null;
    if (input && document.activeElement === input) return;
    if (input && openFocusIsFree(document.activeElement, root)) {
      focus();
      if (document.activeElement === input) return;
    }
    if (left > 0) next(attempt(left - 1));
  };
  next(attempt(frames));
  return () => {
    cancelled = true;
    cancelNext?.();
  };
}
