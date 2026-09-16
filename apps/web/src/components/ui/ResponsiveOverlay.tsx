// One overlay, every form factor. Callers describe the content once; the
// presentation adapts to the shell mode:
//   * phone + anchor (default) → compact anchored Popover in the finger zone;
//   * phone + no anchor, or phone="sheet" → bottom Sheet (destinations);
//   * desktop, anchored → Popover (collision + keyboard-inset aware);
//   * desktop, modal    → Dialog (focus trap, scrim).
// This is the pattern Picker proved (popover ⇄ sheet) promoted to a reusable
// primitive so features never fork business logic per breakpoint.
import type { ReactNode, RefObject } from "react";
import { useShellMode } from "../../responsiveShell.ts";
import Sheet, { type SheetAction, type SheetSearch } from "../mobile/Sheet.tsx";
import Popover from "./Popover.tsx";
import Dialog, { type DialogSize } from "./Dialog.tsx";
import type { AnchoredAlign, AnchoredSide } from "./useAnchoredPosition.ts";

export interface ResponsiveOverlayProps {
  open: boolean;
  onClose: () => void;
  /** Sheet/dialog title and popover accessible name. */
  title: string;
  children: ReactNode;
  /**
   * Desktop presentation. Defaults to "popover" when an anchor is provided,
   * "dialog" otherwise.
   */
  desktop?: "popover" | "dialog";
  /**
   * Phone presentation. Defaults to compact anchored popover when `anchorRef`
   * is present; bottom sheet when there is no anchor or `phone="sheet"`.
   */
  phone?: "popover" | "sheet";
  /** Required for the popover presentation. */
  anchorRef?: RefObject<HTMLElement | null>;
  align?: AnchoredAlign;
  side?: AnchoredSide;
  /** Preserve an open popover when its trigger changes width or position. */
  stableAnchor?: boolean;
  className?: string;
  initialFocus?: string;
  /** Desktop popover overflow policy. */
  popoverOverflow?: "auto" | "visible";
  /** Explicit focus destination after either presentation closes. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
  /** Sheet options (phone sheet only). */
  sheetSize?: "auto" | "tall";
  sheetSearch?: SheetSearch;
  sheetAction?: SheetAction;
  sheetFooter?: ReactNode;
  /** Dialog options (desktop modal only). */
  dialogSize?: DialogSize;
  dialogFooter?: ReactNode;
}

export default function ResponsiveOverlay({
  open,
  onClose,
  title,
  children,
  desktop,
  phone,
  anchorRef,
  align = "start",
  side = "down",
  stableAnchor = false,
  className,
  initialFocus,
  popoverOverflow,
  restoreFocusRef,
  sheetSize = "auto",
  sheetSearch,
  sheetAction,
  sheetFooter,
  dialogSize = "md",
  dialogFooter,
}: ResponsiveOverlayProps) {
  const isPhone = useShellMode() === "phone";
  if (!open) return null;

  const phonePopover = isPhone && anchorRef && (phone === "popover" || (phone !== "sheet"));
  if (phonePopover) {
    return (
      <Popover
        open
        onClose={onClose}
        anchorRef={anchorRef}
        align={align}
        side={side}
        stableAnchor={stableAnchor}
        compact
        ariaLabel={title}
        {...(initialFocus !== undefined ? { initialFocus } : {})}
        {...(popoverOverflow !== undefined ? { overflow: popoverOverflow } : {})}
        {...(className !== undefined ? { className } : {})}
        {...(restoreFocusRef !== undefined ? { restoreFocusRef } : {})}
      >
        {children}
      </Popover>
    );
  }

  if (isPhone) {
    return (
      <Sheet
        title={title}
        onClose={onClose}
        size={sheetSize}
        {...(sheetSearch !== undefined ? { search: sheetSearch } : {})}
        {...(sheetAction !== undefined ? { action: sheetAction } : {})}
        {...(sheetFooter !== undefined ? { footer: sheetFooter } : {})}
        {...(className !== undefined ? { className } : {})}
        {...(restoreFocusRef !== undefined ? { restoreFocusRef } : {})}
      >
        {children}
      </Sheet>
    );
  }

  const mode = desktop ?? (anchorRef ? "popover" : "dialog");
  if (mode === "popover" && anchorRef) {
    return (
      <Popover
        open
        onClose={onClose}
        anchorRef={anchorRef}
        align={align}
        side={side}
        stableAnchor={stableAnchor}
        ariaLabel={title}
        {...(initialFocus !== undefined ? { initialFocus } : {})}
        {...(popoverOverflow !== undefined ? { overflow: popoverOverflow } : {})}
        {...(className !== undefined ? { className } : {})}
        {...(restoreFocusRef !== undefined ? { restoreFocusRef } : {})}
      >
        {children}
      </Popover>
    );
  }

  return (
    <Dialog
      title={title}
      onClose={onClose}
      size={dialogSize}
      {...(dialogFooter !== undefined ? { footer: dialogFooter } : {})}
      {...(initialFocus !== undefined ? { initialFocus } : {})}
      {...(className !== undefined ? { className } : {})}
    >
      {children}
    </Dialog>
  );
}
