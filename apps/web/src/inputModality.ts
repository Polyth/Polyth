// Last input modality, published as `<html data-input-modality>`.
//
// WebKit (iOS) and Chromium match `:focus-visible` on any element that gets
// focus from script, even when the person just tapped: a sheet or Workspace
// closing hands focus back to its phone-header trigger, and that control then
// wore a hard focus ring until the next tap. CSS reads this flag to keep the
// ring for keyboard navigation while dropping it after a pointer or touch.

export type InputModality = "pointer" | "keyboard";

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "AltGraph"]);

/** A key press switches to keyboard mode unless it is a bare modifier or a
 *  key chord (Cmd/Ctrl/Alt+key is a shortcut, not focus navigation). */
export function keyMeansKeyboardModality(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">): boolean {
  if (MODIFIER_KEYS.has(event.key)) return false;
  return !(event.metaKey || event.ctrlKey || event.altKey);
}

let installed: (() => void) | null = null;

export function installInputModality(root: HTMLElement = document.documentElement, target: Window = window): () => void {
  if (installed) return installed;
  const set = (modality: InputModality) => {
    if (root.dataset.inputModality !== modality) root.dataset.inputModality = modality;
  };
  const onPointer = () => set("pointer");
  const onKey = (event: KeyboardEvent) => {
    if (keyMeansKeyboardModality(event)) set("keyboard");
  };
  target.addEventListener("pointerdown", onPointer, true);
  target.addEventListener("keydown", onKey, true);
  installed = () => {
    target.removeEventListener("pointerdown", onPointer, true);
    target.removeEventListener("keydown", onKey, true);
    delete root.dataset.inputModality;
    installed = null;
  };
  return installed;
}
