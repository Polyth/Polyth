// One overlay, every form factor. Callers describe the content once; the
// presentation adapts to the shell mode:
//   * phone            → bottom Sheet (swipe dismiss, keyboard-safe);
//   * desktop, anchored → Popover (collision + keyboard-inset aware);
//   * desktop, modal    → Dialog (focus trap, scrim).
// This is the pattern Picker proved (popover ⇄ sheet) promoted to a reusable
// primitive so features never fork business logic per breakpoint.
import type { ReactNode, RefObject } from "react";
import { useShellMode } from "../../responsiveShell.ts";
import Sheet, { type SheetSearch } from "../mobile/Sheet.tsx";
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
  /** Required for the popover presentation. */
  anchorRef?: RefObject<HTMLElement | null>;
  align?: AnchoredAlign;
  side?: AnchoredSide;
  className?: string;
  initialFocus?: string;
  /** Explicit focus destination after either presentation closes. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
  /** Sheet options (phone only). */
  sheetSize?: "auto" | "tall";
  sheetSearch?: SheetSearch;
  sheetAction?: { label: string; onClick: () => void; pressed?: boolean };
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
  anchorRef,
  align = "start",
  side = "down",
  className,
  initialFocus,
  restoreFocusRef,
  sheetSize = "auto",
  sheetSearch,
  sheetAction,
  sheetFooter,
  dialogSize = "md",
  dialogFooter,
}: ResponsiveOverlayProps) {
  const phone = useShellMode() === "phone";
  if (!open) return null;

  if (phone) {
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
        ariaLabel={title}
        {...(initialFocus !== undefined ? { initialFocus } : {})}
        {...(className !== undefined ? { className } : {})}
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
