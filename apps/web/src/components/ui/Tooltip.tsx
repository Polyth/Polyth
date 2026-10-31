// Hover/focus tooltip. Hover reveal only happens on hover-capable fine
// pointers; keyboard focus always shows it. The tooltip is a visual affordance
// — the trigger must own its accessible name (IconButton enforces this), so
// the bubble stays aria-hidden and nothing is announced twice.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPosition, type AnchoredSide } from "./useAnchoredPosition.ts";
import { usePackageWindowOwner } from "./PackageWindowContext.ts";

const SHOW_DELAY_MS = 350;

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  /** Preferred side (default up = above the trigger). */
  side?: AnchoredSide;
  /** Hover intent delay. Keyboard focus still reveals the tooltip immediately. */
  delayMs?: number;
  className?: string;
  /** Holds the bubble back while the trigger's context already shows the
   *  same content (a panel the hover opened, for example). */
  disabled?: boolean;
}

const canHover = (): boolean =>
  typeof window !== "undefined"
  && typeof window.matchMedia === "function"
  && window.matchMedia("(hover: hover) and (pointer: fine)").matches;

export default function Tooltip({ content, children, side = "up", delayMs = SHOW_DELAY_MS, className, disabled = false }: TooltipProps) {
  const [requested, setOpen] = useState(false);
  const open = requested && !disabled;
  const packageWindowOwner = usePackageWindowOwner();
  const hostRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const position = useAnchoredPosition(open, hostRef, bubbleRef, { align: "center", side, gap: 8 });

  const show = (delayed: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (disabledRef.current) return;
    if (delayed && delayMs > 0) {
      timer.current = setTimeout(() => {
        timer.current = null;
        if (!disabledRef.current) setOpen(true);
      }, delayMs);
    }
    else setOpen(true);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  // A pending or shown bubble is dropped, not deferred: it must not pop up
  // later just because what made it redundant went away.
  useEffect(() => { if (disabled) hide(); }, [disabled]);

  return (
    <span
      ref={hostRef}
      className="ui-tooltip-host"
      onMouseEnter={() => { if (canHover()) show(true); }}
      onMouseLeave={hide}
      onFocusCapture={() => show(false)}
      onBlurCapture={hide}
    >
      {children}
      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={bubbleRef}
          className={`ui-tooltip${className ? ` ${className}` : ""}`}
          style={{
            top: position.top,
            left: position.left,
            maxWidth: position.ready ? position.maxWidth : undefined,
            visibility: position.ready ? undefined : "hidden",
          }}
          data-side={position.side}
          aria-hidden="true"
          data-package-window-owner={packageWindowOwner ?? undefined}
        >
          {content}
        </div>,
        document.body,
      )}
    </span>
  );
}
