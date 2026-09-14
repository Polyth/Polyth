import { useSyncExternalStore } from "react";

// One shared Shift-modifier store for every Shift+hover quick-action surface
// (session rows, the new-chat hero, the right rail, the sidebar gear). Shift
// is tracked at the window before any hover begins, so pressing Shift and
// then pointing at a row still arms it; keyup or window blur disarms.
let shiftKeyDown = false;
let listening = false;
const subscribers = new Set<() => void>();
const FINE_HOVER_QUERY = "(hover: hover) and (pointer: fine)";

const snapshot = (): boolean => shiftKeyDown;

export function shouldArmShift(key: string, editingText: boolean): boolean {
  return key === "Shift" && !editingText;
}

/** Desktop Shift+hover customization needs a hover-capable fine pointer.
 *  Coarse/touch shells (tablets) must not latch this mode from a virtual
 *  Shift key, a bluetooth keyboard, or a stuck modifier. */
export function canArmShiftPointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(FINE_HOVER_QUERY).matches;
}

function isTextEditing(target: EventTarget | null): boolean {
  const element = target && "closest" in target ? target as Element : document.activeElement;
  return element?.closest(
    "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [data-composer-input]",
  ) !== null;
}

// Chrome retroactively marks the pointer-focused element :focus-visible on
// ANY keydown — including a bare Shift — which painted a stark focus ring
// ("black borders") the instant the quick-action modifier was held. This body
// flag lets core CSS suppress that repaint for the bare-Shift hold only; any
// other key pressed during the hold clears it immediately, so Shift+Tab
// keyboard navigation keeps its ring.
function setBodyShiftFlag(on: boolean): void {
  if (typeof document === "undefined") return;
  if (on) document.body.dataset.shiftHeld = "true";
  else delete document.body.dataset.shiftHeld;
}

function setKeyDown(down: boolean): void {
  setBodyShiftFlag(down);
  if (shiftKeyDown === down) return;
  shiftKeyDown = down;
  for (const notify of [...subscribers]) notify();
}

function ensureListeners(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("keydown", (event) => {
    if (!canArmShiftPointer()) {
      setKeyDown(false);
      return;
    }
    setKeyDown(shouldArmShift(event.key, isTextEditing(event.target)));
  });
  window.addEventListener("keyup", (event) => {
    if (event.key === "Shift") setKeyDown(false);
  });
  window.addEventListener("blur", () => setKeyDown(false));
  const hoverPointer = typeof window.matchMedia === "function"
    ? window.matchMedia(FINE_HOVER_QUERY)
    : null;
  hoverPointer?.addEventListener?.("change", () => {
    if (!hoverPointer.matches) setKeyDown(false);
  });
}

/** True while the Shift key is held. Arms the shift-hover customization
 *  affordances (session quick actions, hero customize, rail customize). */
export function useShiftArmed(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      ensureListeners();
      subscribers.add(onChange);
      return () => { subscribers.delete(onChange); };
    },
    snapshot,
    () => false,
  );
}

/** Shift quick-edit. `enabled` lets a surface opt out without unmounting. */
export function useCustomizeActive(enabled = true): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (!enabled) return () => {};
      ensureListeners();
      subscribers.add(onChange);
      return () => { subscribers.delete(onChange); };
    },
    enabled ? snapshot : () => false,
    () => false,
  );
}
