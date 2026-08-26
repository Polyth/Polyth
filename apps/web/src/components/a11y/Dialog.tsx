// Accessible modal dialog primitive (WP2): focus trap, Escape close, focus
// restore to the opener, aria-modal semantics. Feature dialogs (focus editor,
// image preview, mermaid fullscreen, question stepper) build on this.
// UX-A390: the focus logic is exported as useModalSurface so the compact
// session drawer (Sidebar) and panel sheet (ContextRail) share one
// implementation instead of copying focus traps.
import { useEffect, useRef, type ReactNode, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalSurfaceOptions {
  /** The surface is currently open and must behave as the active modal. */
  open: boolean;
  /**
   * The surface participates in modal behavior at all. When false (e.g. the
   * sidebar in wide mode) the hook removes inert/aria-hidden and does nothing,
   * so a viewport change never steals or restores focus by itself.
   */
  enabled?: boolean;
  onClose: () => void;
  containerRef: RefObject<HTMLElement | null>;
  /** CSS selector inside the container to receive initial focus. */
  initialFocus?: string;
  /** Resolve the unmount focus target from the recorded opener. Returning
   *  null delegates focus to a caller-owned handoff. */
  resolveRestoreFocus?: (opener: HTMLElement | null) => HTMLElement | null;
}

const visible = (el: HTMLElement): boolean => el.getClientRects().length > 0;
let bodyScrollLocks = 0;
let bodyOverflowBeforeLock = "";

function lockBodyScroll(): () => void {
  if (bodyScrollLocks === 0) {
    bodyOverflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  bodyScrollLocks++;
  return () => {
    bodyScrollLocks = Math.max(0, bodyScrollLocks - 1);
    if (bodyScrollLocks === 0) document.body.style.overflow = bodyOverflowBeforeLock;
  };
}

/**
 * Shared modal-surface focus contract:
 * - focuses the requested initial target or first enabled control on open;
 * - contains forward and reverse Tab traversal;
 * - closes the active surface on Escape (one layer: transient popovers that
 *   listen in the capture phase, e.g. useEscape, win and stop propagation);
 * - restores a still-connected opener on close;
 * - keeps hidden mounted content inert and aria-hidden while closed.
 */
export function useModalSurface({
  open,
  enabled = true,
  onClose,
  containerRef,
  initialFocus,
  resolveRestoreFocus,
}: ModalSurfaceOptions): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const resolverRef = useRef(resolveRestoreFocus);
  resolverRef.current = resolveRestoreFocus;

  // Hidden-but-mounted surfaces (keep-alive drawer/sheet) must not be
  // reachable by focus, pointer, or assistive technology.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (enabled && !open) {
      el.setAttribute("aria-hidden", "true");
      el.setAttribute("inert", "");
    } else {
      el.removeAttribute("aria-hidden");
      el.removeAttribute("inert");
    }
    return () => {
      el.removeAttribute("aria-hidden");
      el.removeAttribute("inert");
    };
  }, [enabled, open, containerRef]);

  useEffect(() => {
    if (!enabled || !open) return;
    const el = containerRef.current;
    if (!el) return;
    const unlockBodyScroll = lockBodyScroll();
    const opener = document.activeElement as HTMLElement | null;
    const target = (initialFocus ? el.querySelector<HTMLElement>(initialFocus) : null)
      ?? el.querySelector<HTMLElement>(FOCUSABLE)
      ?? el;
    target.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Nested menus own their first Escape. In particular, a session-row
        // menu inside the compact project drawer must close back to its
        // ellipsis without dismissing the drawer around it.
        const eventTarget = e.target instanceof Element ? e.target : null;
        if (eventTarget?.closest('[role="menu"]')) return;
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const nodes = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((n) => visible(n) || n === document.activeElement);
      if (nodes.length === 0) {
        e.preventDefault();
        return;
      }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("keydown", onKeyDown);
      unlockBodyScroll();
      const connectedOpener = opener && opener !== document.body && opener.isConnected && visible(opener)
        ? opener
        : null;
      const target = resolverRef.current ? resolverRef.current(connectedOpener) : connectedOpener;
      target?.focus();
    };
  }, [enabled, open, initialFocus, containerRef]);
}

export interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  backdropClassName?: string;
  /** wide dialogs (focus editor, fullscreen diagram) */
  size?: "md" | "lg" | "full";
  initialFocus?: string; // CSS selector inside the dialog
  /** Explicit exit-focus intent (UX-ONBOARDING): given the recorded opener,
   *  return the element to focus on unmount — a fallback when the opener has
   *  unmounted, or null when the caller owns a queued focus handoff instead.
   *  Default behavior (no prop) restores the opener. `BODY` is never a valid
   *  destination. */
  resolveRestoreFocus?: (opener: HTMLElement | null) => HTMLElement | null;
  ariaDescribedBy?: string;
}

export default function Dialog({
  title,
  onClose,
  children,
  className,
  backdropClassName,
  size = "md",
  initialFocus,
  ariaDescribedBy,
  resolveRestoreFocus,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalSurface({
    open: true,
    onClose,
    containerRef: panelRef,
    initialFocus,
    resolveRestoreFocus,
  });

  return (
    <div
      className={`dialog-backdrop${backdropClassName ? ` ${backdropClassName}` : ""}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby={ariaDescribedBy}
        tabIndex={-1}
        className={`dialog-panel dialog-${size}${className ? ` ${className}` : ""}`}
      >
        {children}
      </div>
    </div>
  );
}
