// Anchored non-modal overlay: portal to <body>, both-axis collision handling,
// keyboard-inset awareness (useAnchoredPosition), Escape + outside-press
// dismissal, focus restored to the anchor. Menus get role/keyboard semantics
// from Menu.tsx; content surfaces (filters, small forms) use this directly.
import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useEscape } from "../../useEscape.ts";
import { useAnchoredPosition, type AnchoredAlign, type AnchoredSide } from "./useAnchoredPosition.ts";
import { usePackageWindowOwner } from "./PackageWindowContext.ts";

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
  align?: AnchoredAlign;
  side?: AnchoredSide;
  stableAnchor?: boolean;
  /** Accessible name for the surface (role dialog by default). */
  ariaLabel?: string;
  role?: "dialog" | "menu" | "listbox" | "presentation";
  /** CSS selector focused when the popover opens. */
  initialFocus?: string;
  /** Restore focus to the anchor on close (default true). */
  restoreFocus?: boolean;
  /** Allow an attached surface to extend beyond a self-scrolling popover. */
  overflow?: "auto" | "visible";
}

export default function Popover({
  open,
  onClose,
  anchorRef,
  children,
  className,
  align = "start",
  side = "down",
  stableAnchor = false,
  ariaLabel,
  role = "dialog",
  initialFocus,
  restoreFocus = true,
  overflow = "auto",
}: PopoverProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const packageWindowOwner = usePackageWindowOwner();
  const position = useAnchoredPosition(open, anchorRef, surfaceRef, { align, side, stableAnchor });
  useEscape(open, onClose);

  // Focus management: optional initial focus, anchor restore on close.
  useEffect(() => {
    if (!open) return;
    if (initialFocus) surfaceRef.current?.querySelector<HTMLElement>(initialFocus)?.focus();
    const anchor = anchorRef.current;
    return () => {
      if (restoreFocus && anchor?.isConnected) anchor.focus();
    };
  }, [open, initialFocus, restoreFocus, anchorRef]);

  if (!open || typeof document === "undefined") return null;

  const style: CSSProperties = {
    top: position.top,
    left: position.left,
    maxHeight: position.maxHeight || undefined,
    maxWidth: position.maxWidth || undefined,
    visibility: position.ready ? undefined : "hidden",
  };

  return createPortal(
    <>
      <div className="ui-popover-backdrop" data-package-window-owner={packageWindowOwner ?? undefined} onPointerDown={onClose} />
      <div
        ref={surfaceRef}
        {...(role === "presentation" ? {} : { role })}
        aria-label={ariaLabel}
        className={`ui-popover${className ? ` ${className}` : ""}`}
        style={style}
        data-side={position.side}
        data-overflow={overflow}
        data-package-window-owner={packageWindowOwner ?? undefined}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
