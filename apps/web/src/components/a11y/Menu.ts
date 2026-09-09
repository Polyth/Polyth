import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

export interface DismissibleMenuOptions {
  open: boolean;
  menuRef: RefObject<HTMLElement | null>;
  triggerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  focusFirst?: boolean;
  /** Where focus returns on dismissal when it is not the click trigger —
   *  e.g. a context-menu opened from a row returns focus to the row. */
  restoreRef?: RefObject<HTMLElement | null>;
}

/** Shared menu interaction contract: outside press and Escape dismiss, focus
 * returns to the opener, and arrow/Home/End navigation cycles menu items. */
export function useDismissibleMenu({
  open,
  menuRef,
  triggerRef,
  onClose,
  focusFirst = true,
  restoreRef,
}: DismissibleMenuOptions): (event: ReactKeyboardEvent<HTMLElement>) => void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    if (focusFirst) {
      requestAnimationFrame(() =>
        menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus());
    }
    const close = () => {
      onCloseRef.current();
      requestAnimationFrame(() => (restoreRef?.current ?? triggerRef.current)?.focus());
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [focusFirst, menuRef, open, restoreRef, triggerRef]);

  return (event) => {
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
