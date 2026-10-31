// Anchored non-modal overlay: portal to <body>, both-axis collision handling,
// keyboard-inset awareness (useAnchoredPosition), Escape + outside-press
// dismissal, focus restored to the anchor. Menus get role/keyboard semantics
// from Menu.tsx; content surfaces (filters, small forms) use this directly.
import { useEffect, useRef, type CSSProperties, type MouseEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useEscape } from "../../useEscape.ts";
import { useAnchoredPosition, type AnchoredAlign, type AnchoredSide } from "./useAnchoredPosition.ts";
import { usePackageWindowOwner } from "./PackageWindowContext.ts";
import { focusUnlessKeyboardHeld } from "../../mobileViewport.ts";
import { useExitGhost } from "../../exitGhost.ts";

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
  /** Surface style under the anchored geometry (which always wins). */
  style?: CSSProperties;
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
  /** A region that stays interactive while the popover is open (the rail an
   *  editor customizes, so it remains a live preview). Presses inside it do
   *  not close the surface or get swallowed by the backdrop; presses outside
   *  it still dismiss exactly like the backdrop. */
  keepInteractiveRef?: RefObject<HTMLElement | null>;
}

export default function Popover({
  open,
  onClose,
  anchorRef,
  children,
  className,
  style: surfaceStyle,
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
  keepInteractiveRef,
}: PopoverProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  // Closing unmounts the surface at once; it still fades out (exitGhost.ts).
  const surfaceGhostRef = useExitGhost<HTMLDivElement>(() => ({ kind: "popover" }), surfaceRef);
  const pointerInside = useRef(false);
  const packageWindowOwner = usePackageWindowOwner();
  const position = useAnchoredPosition(open, anchorRef, surfaceRef, { align, side, stableAnchor, compact });
  useEscape(open, onClose);

  // Same ghost-click contract as Sheet: the opening gesture's click can land
  // on the compact surface that just appeared under the finger (harness tabs
  // in the model picker). Keyboard activation (detail 0) is never swallowed.
  // A popover that keeps a region live (the rail under its Customize pencil)
  // must not paint a full-screen backdrop over that region: an editor opened
  // beside a rail is meant to leave the rail draggable. Dismissal moves to a
  // capture listener that still closes on any press outside the surface and
  // that region, swallowing that press like the backdrop did.
  useEffect(() => {
    if (!open || !keepInteractiveRef) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (surfaceRef.current?.contains(target)) return;
      if (keepInteractiveRef.current?.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, onClose, keepInteractiveRef]);

  const onPointerDownCapture = compact
    ? () => { pointerInside.current = true; }
    : undefined;
  const onClickCapture = compact
    ? (event: MouseEvent<HTMLDivElement>) => {
      if (event.detail > 0 && !pointerInside.current) {
        event.stopPropagation();
        event.preventDefault();
      }
      pointerInside.current = false;
    }
    : undefined;

  // Focus management: optional initial focus, anchor restore on close. Both
  // yield to an editor holding the software keyboard (the composer).
  useEffect(() => {
    if (!open) return;
    if (initialFocus) focusUnlessKeyboardHeld(surfaceRef.current?.querySelector<HTMLElement>(initialFocus));
    const anchor = anchorRef.current;
    return () => {
      const target = restoreFocusRef?.current ?? anchor;
      if (restoreFocus && target?.isConnected) focusUnlessKeyboardHeld(target);
    };
  }, [open, initialFocus, restoreFocus, anchorRef, restoreFocusRef]);

  if (!open || typeof document === "undefined") return null;

  const style: CSSProperties = {
    ...surfaceStyle,
    top: position.top,
    left: position.left,
    maxHeight: position.ready ? position.maxHeight : undefined,
    maxWidth: position.ready ? position.maxWidth : undefined,
    visibility: position.ready ? undefined : "hidden",
  };

  return createPortal(
    <>
      {!keepInteractiveRef && (
        <div
          className="ui-popover-backdrop"
          data-package-window-owner={packageWindowOwner ?? undefined}
          onPointerDown={onClose}
          {...(onPointerDownCapture ? { onPointerDownCapture } : {})}
          {...(onClickCapture ? { onClickCapture } : {})}
        />
      )}
      <div
        ref={surfaceGhostRef}
        {...(role === "presentation" ? {} : { role })}
        aria-label={ariaLabel}
        className={`ui-popover${className ? ` ${className}` : ""}`}
        style={style}
        data-side={position.side}
        data-overflow={overflow}
        {...(compact ? { "data-compact": "true" } : {})}
        data-package-window-owner={packageWindowOwner ?? undefined}
        {...(onPointerDownCapture ? { onPointerDownCapture } : {})}
        {...(onClickCapture ? { onClickCapture } : {})}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
