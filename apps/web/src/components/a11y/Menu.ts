import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { focusUnlessKeyboardHeld } from "../../mobileViewport.ts";
import { isImeComposing } from "../input/editorCore.ts";

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "OS", "CapsLock", "Fn", "FnLock", "AltGraph", "Hyper", "Super"]);

export interface DismissibleMenuOptions {
  open: boolean;
  menuRef: RefObject<HTMLElement | null>;
  triggerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** A passive menu (a selection toolbar over an editor) leaves focus where it
   *  is: it does not take focus on open, any key typed outside it dismisses it
   *  and still reaches its target, and dismissal only returns focus when focus
   *  had moved into the menu. Keyboard users open the focused variant instead. */
  passive?: boolean;
  /** Where focus returns on dismissal when it is not the click trigger —
   *  e.g. a context-menu opened from a row returns focus to the row. */
  restoreRef?: RefObject<HTMLElement | null>;
}

/** Shared menu interaction contract: outside press, Escape and a window blur
 * dismiss, focus returns to the opener, and arrow/Home/End navigation cycles
 * menu items (see `passive` for menus that must not take focus). Neither focus move happens while a writing surface holds the
 * software keyboard for a touch (the composer): the menu is then operated by taps. */
export function useDismissibleMenu({
  open,
  menuRef,
  triggerRef,
  onClose,
  passive = false,
  restoreRef,
}: DismissibleMenuOptions): (event: ReactKeyboardEvent<HTMLElement>) => void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    if (!passive) {
      requestAnimationFrame(() =>
        focusUnlessKeyboardHeld(menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')));
    }
    const close = () => {
      const focusInside = !!menuRef.current?.contains(document.activeElement);
      onCloseRef.current();
      if (passive && !focusInside) return;
      requestAnimationFrame(() => focusUnlessKeyboardHeld(restoreRef?.current ?? triggerRef.current));
    };
    // Dialogs render through a body portal and sit outside the menu DOM, but
    // they are still a nested surface opened from the menu: let such a dialog
    // own dismissal instead of unmounting it as an outside press. A dialog
    // that hosts the trigger (the phone Navigator) is not nested; a press
    // elsewhere in it is an ordinary outside press.
    const inNestedDialog = (target: EventTarget | null) => {
      const dialog = (target as Element | null)?.closest?.('[role="dialog"]');
      return !!dialog && !(triggerRef.current && dialog.contains(triggerRef.current));
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      if (inNestedDialog(event.target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (isImeComposing(event)) return;
      if (passive && event.key !== "Escape") {
        // Typing into the surface under the menu dismisses it; the key itself
        // is left alone so it still reaches the editor.
        if (MODIFIER_KEYS.has(event.key)) return;
        if (menuRef.current?.contains(event.target as Node)) return;
        onCloseRef.current();
        return;
      }
      if (event.key !== "Escape") return;
      if (inNestedDialog(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    // Switching to another application leaves the window without a pointer or
    // key event to dismiss on, so the menu used to stay open behind whatever
    // the user did next and the first click on it only closed the menu.
    const onWindowBlur = () => close();
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [passive, menuRef, open, restoreRef, triggerRef]);

  return (event) => {
    if ((event.target as Element | null)?.closest?.("input, textarea, select, [contenteditable='true']")) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const index =
      event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : current < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1)
      : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[index]?.focus();
  };
}
