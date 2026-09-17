// UX-MOBILE-01 §28/§46: ONE surface system for mobile overlays. Compact
// anchored pickers use Popover; sheet-capable surfaces (starter picker,
// navigation destinations, and explicit Picker sheet opt-ins) share this
// grabber, focus, and keyboard-safe geometry. Navigation destinations exchange
// the grabber for Back while retaining the same contract.
//
// Geometry rules that make the sheet keyboard-safe:
//   * height is capped against --visual-vh (mobileViewport.ts), never 100vh;
//   * --visual-vh is already the visible band, so the keyboard is never
//     subtracted or offset a second time (§21, §47);
//   * the search field is NEVER autofocused (§25) — opening a sheet must not
//     summon the keyboard; focus starts on the sheet itself.
import {
  useCallback, useEffect, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useModalSurface } from "../a11y/Dialog.tsx";
import Icon from "../ui/Icon.tsx";
import { BackIcon, CloseIcon } from "../ui/icons.ts";
import { tr } from "../../i18n/index.ts";

/** Drag distance (CSS px) past which releasing dismisses the sheet. */
export const SHEET_DISMISS_DISTANCE = 88;

export interface SheetSearch {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Accessible name; defaults to the placeholder. */
  ariaLabel?: string;
  role?: "combobox" | "searchbox";
  ariaExpanded?: boolean;
  ariaControls?: string;
  ariaActiveDescendant?: string;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
}

export interface SheetAction {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  busy?: boolean;
}

export interface SheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Sticky search row under the title. Rendered unfocused (§25). */
  search?: SheetSearch;
  /** Trailing control in the title row (e.g. Edit / Done for reordering). */
  action?: SheetAction;
  /** Pinned footer (e.g. "Create a starter…"). */
  footer?: ReactNode;
  className?: string;
  /** `tall` reserves near-fullscreen height for long, searchable lists. */
  size?: "auto" | "tall";
  /** Bottom sheets rise from the composer; top sheets drop from the island. */
  origin?: "bottom" | "top";
  /** Full-screen navigation destinations use Back; transient sheets use Close. */
  dismiss?: "close" | "back";
  /** Explicit focus destination after every close path. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

/** Body scroll lock: a sheet is modal, the page behind it must not scroll. */
let openSheets = 0;

export default function Sheet({
  title,
  onClose,
  children,
  search,
  action,
  footer,
  className,
  size = "auto",
  origin = "bottom",
  dismiss = "close",
  restoreFocusRef,
}: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(0);
  const dragFrom = useRef<number | null>(null);
  /** A pointer press has started inside this sheet (see the ghost-click guard). */
  const pointerInside = useRef(false);

  useModalSurface({
    open: true,
    onClose,
    containerRef: panelRef,
    // The panel itself takes focus: sheets open silently, without raising the
    // keyboard through an autofocused search field.
    initialFocus: "[data-sheet-focus]",
    ...(restoreFocusRef ? { resolveRestoreFocus: () => restoreFocusRef.current } : {}),
  });

  useEffect(() => {
    openSheets += 1;
    document.documentElement.dataset.sheet = "open";
    return () => {
      openSheets = Math.max(0, openSheets - 1);
      if (openSheets === 0) delete document.documentElement.dataset.sheet;
    };
  }, []);

  // Escape closes the TOPMOST sheet wherever focus happens to be. The panel's
  // own key handler (useModalSurface) only sees keys while focus is inside it,
  // and a tap on a non-interactive part of a sheet can park focus on <body>.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const sheets = [...document.querySelectorAll(".sheet-backdrop")];
      if (sheets[sheets.length - 1] !== panelRef.current?.parentElement) return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const endDrag = useCallback((distance: number) => {
    dragFrom.current = null;
    if (distance >= SHEET_DISMISS_DISTANCE) onClose();
    else setDrag(0);
  }, [onClose]);

  const onGrabberDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragFrom.current = event.clientY;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onGrabberMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragFrom.current === null) return;
    const delta = origin === "top"
      ? dragFrom.current - event.clientY
      : event.clientY - dragFrom.current;
    setDrag(Math.max(0, delta));
  };
  const onGrabberUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragFrom.current === null) return;
    const delta = origin === "top"
      ? dragFrom.current - event.clientY
      : event.clientY - dragFrom.current;
    endDrag(Math.max(0, delta));
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const surface = (
    <div
      className={`sheet-backdrop${origin === "top" ? " sheet-backdrop-top" : ""}`}
      // Ghost-click guard. The gesture that opens a sheet finishes with a
      // click delivered at the finger's position — which the sheet now covers,
      // so a row right under the trigger would be "chosen" instantly. A
      // pointer click with no matching pointer-down inside the sheet is that
      // ghost; keyboard activation (detail 0) is never swallowed.
      onPointerDownCapture={() => { pointerInside.current = true; }}
      onClickCapture={(event) => {
        if (event.detail > 0 && !pointerInside.current) {
          event.stopPropagation();
          event.preventDefault();
        }
        pointerInside.current = false;
      }}
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-sheet-focus=""
        className={`sheet sheet-${size}${origin === "top" ? " sheet-origin-top" : ""}${className ? ` ${className}` : ""}`}
        style={drag > 0 ? { transform: `translateY(${origin === "top" ? -drag : drag}px)` } : undefined}
        onPointerDown={(event) => {
          // Keep focus (and therefore Escape and the Tab trap) inside the
          // sheet when a press lands on non-interactive chrome.
          const target = event.target as HTMLElement | null;
          if (!target?.closest("button, a, input, textarea, select, [tabindex]")) {
            panelRef.current?.focus();
          }
        }}
      >
        {dismiss === "close" && (
          <div
            className="sheet-grabber"
            onPointerDown={onGrabberDown}
            onPointerMove={onGrabberMove}
            onPointerUp={onGrabberUp}
            onPointerCancel={() => { dragFrom.current = null; setDrag(0); }}
          >
            <i aria-hidden="true" />
          </div>
        )}
        <div className="sheet-head">
          {dismiss === "back" && (
            <button type="button" className="sheet-back" aria-label={tr("common.back")} onClick={onClose}>
              <Icon icon={BackIcon} size="lg" />
            </button>
          )}
          <h2 className="sheet-title">{title}</h2>
          {action && (
            <button
              type="button"
              className="sheet-head-action"
              aria-pressed={action.pressed}
              aria-busy={action.busy || undefined}
              disabled={Boolean(action.disabled || action.busy)}
              onClick={() => {
                if (action.disabled || action.busy) return;
                action.onClick();
              }}
            >
              {action.label}
            </button>
          )}
          {dismiss === "close" && (
            <button type="button" className="sheet-close" aria-label={tr("mobile.sheet.closeValue", { title: title })} onClick={onClose}>
              <Icon icon={CloseIcon} size="lg" />
            </button>
          )}
        </div>
        {search && (
          <div className="sheet-search">
            <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="search"
              value={search.value}
              placeholder={search.placeholder}
              aria-label={search.ariaLabel ?? search.placeholder}
              {...(search.role ? { role: search.role } : {})}
              {...(search.ariaExpanded !== undefined ? { "aria-expanded": search.ariaExpanded } : {})}
              {...(search.ariaControls ? { "aria-controls": search.ariaControls } : {})}
              {...(search.ariaActiveDescendant
                ? { "aria-activedescendant": search.ariaActiveDescendant }
                : {})}
              {...(search.role === "combobox" ? { "aria-autocomplete": "list" as const } : {})}
              enterKeyHint="search"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => search.onChange(event.target.value)}
              {...(search.onKeyDown ? { onKeyDown: search.onKeyDown } : {})}
            />
            {search.value !== "" && (
              <button
                type="button"
                className="sheet-search-clear"
                aria-label={tr("mobile.sheet.clearSearch")}
                onClick={() => search.onChange("")}
              >
                <svg className="ui-icon ui-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              </button>
            )}
          </div>
        )}
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );

  // Portalled to <body> on purpose: a `position: fixed` sheet rendered inside
  // its trigger's subtree is captured by any ancestor that creates a
  // containing block — the docked composer's own backdrop-filter did exactly
  // that, trapping the picker inside a 60px strip where it looked like it
  // never opened. The portal makes the sheet independent of where it is used.
  return typeof document !== "undefined" && document.body
    ? createPortal(surface, document.body)
    : surface;
}

/** Sticky category header inside a sheet body. */
export function SheetSection({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="sheet-section">
      <h3 className="sheet-section-head">
        <span>{title}</span>
        {count !== undefined && <small>{count}</small>}
      </h3>
      {children}
    </section>
  );
}

export interface SheetRowProps {
  title: string;
  meta?: ReactNode;
  icon?: ReactNode;
  selected?: boolean;
  onClick: () => void;
  /** Trailing control (favorite star, drag handle). Never picks the row. */
  trailing?: ReactNode;
  ariaLabel?: string;
}

/** One ≥48px list row: title, optional metadata microtext, optional trailing. */
export function SheetRow({ title, meta, icon, selected, onClick, trailing, ariaLabel }: SheetRowProps) {
  return (
    <div className={`sheet-row${selected ? " selected" : ""}`} role="presentation">
      <button
        type="button"
        className="sheet-row-main"
        role="option"
        aria-selected={selected ?? false}
        aria-label={ariaLabel ?? title}
        onClick={onClick}
      >
        {icon && <span className="sheet-row-icon" aria-hidden="true">{icon}</span>}
        <span className="sheet-row-copy">
          <strong>{title}</strong>
          {meta && <small>{meta}</small>}
        </span>
        {selected && (
          <span className="sheet-row-check" aria-hidden="true">
            <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12 4 4L19 6" />
            </svg>
          </span>
        )}
      </button>
      {trailing}
    </div>
  );
}
