// Accessible modal dialog primitive (WP2): focus trap, Escape close, focus
// restore to the opener, aria-modal semantics. Feature dialogs (focus editor,
// image preview, mermaid fullscreen, question stepper) build on this.
import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  backdropClassName?: string;
  /** wide dialogs (focus editor, fullscreen diagram) */
  size?: "md" | "lg" | "full";
  initialFocus?: string; // CSS selector inside the dialog
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
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) {
      const target = (initialFocus ? panel.querySelector<HTMLElement>(initialFocus) : null)
        ?? panel.querySelector<HTMLElement>(FOCUSABLE)
        ?? panel;
      target.focus();
    }
    return () => {
      restoreRef.current?.focus?.();
    };
  }, [initialFocus]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const nodes = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (nodes.length === 0) { e.preventDefault(); return; }
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

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
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );
}
