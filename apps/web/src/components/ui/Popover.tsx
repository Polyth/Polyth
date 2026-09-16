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
  /** Compact phone picker geometry (safe-area, finger-zone overlap, height cap). */
  compact?: boolean;
  /** Restore focus to a specific element on close instead of the anchor. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
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
  compact = false,
  restoreFocusRef,
}: PopoverProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const packageWindowOwner = usePackageWindowOwner();
  const position = useAnchoredPosition(open, anchorRef, surfaceRef, { align, side, stableAnchor, compact });
  useEscape(open, onClose);

  // Focus management: optional initial focus, anchor restore on close.
  useEffect(() => {
    if (!open) return;
    if (initialFocus) surfaceRef.current?.querySelector<HTMLElement>(initialFocus)?.focus();
    const anchor = anchorRef.current;
    return () => {
      const target = restoreFocusRef?.current ?? anchor;
      if (restoreFocus && target?.isConnected) target.focus();
    };
  }, [open, initialFocus, restoreFocus, anchorRef, restoreFocusRef]);

  if (!open || typeof document === "undefined") return null;

  const style: CSSProperties = {
    top: position.top,
    left: position.left,
    maxHeight: position.ready ? position.maxHeight : undefined,
    maxWidth: position.ready ? position.maxWidth : undefined,
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
        {...(compact ? { "data-compact": "true" } : {})}
        data-package-window-owner={packageWindowOwner ?? undefined}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
