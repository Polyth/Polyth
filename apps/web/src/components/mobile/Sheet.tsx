// ONE surface system for mobile overlays. Compact
// anchored pickers use Popover; sheet-capable surfaces (starter picker,
// navigation destinations, and explicit Picker sheet opt-ins) share this
// grabber, focus, and keyboard-safe geometry. Navigation destinations exchange
// the grabber for Back while retaining the same contract.
//
// Phone layer stack: a full-screen destination (the Workspace) can also sit
// UNDER a package window. `stackPhase` is the presentation contract for that:
// `enter` slides in from the inline-end edge, `covered` keeps the sheet mounted
// but inert beneath another layer, `revealed` is the pop back to it. The
// owner (MobileWorkspaceLayer) derives the phase; the sheet only honours it.
//
// Geometry rules that make the sheet keyboard-safe:
//   * height is capped against --visual-vh (mobileViewport.ts), never 100vh;
//   * --visual-vh is already the visible band, so the keyboard is never
//     subtracted or offset a second time (§21, §47);
//   * the search field is NEVER autofocused (§25) — opening a sheet must not
//     summon the keyboard; focus starts on the sheet itself.
import {
  useEffect, useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode, type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useModalSurface } from "../a11y/Dialog.tsx";
import { isImeComposing } from "../input/editorCore.ts";
import Icon from "../ui/Icon.tsx";
import { BackIcon, CloseIcon } from "../ui/icons.ts";
import { tr } from "../../i18n/index.ts";
import type { LayerStackPhase } from "../../mobileLayerStack.ts";
import { attachSheetDrag, SHEET_DISMISS_DISTANCE } from "../../sheetDrag.ts";
import { useExitGhost } from "../../exitGhost.ts";

/** Drag distance (CSS px) past which a slow release dismisses the sheet (see sheetDrag.ts). */
export { SHEET_DISMISS_DISTANCE };

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
  /**
   * `switch` draws a labelled on/off switch (a mode such as Edit) instead of
   * a text button; `pressed` is its state. Defaults to a button.
   */
  kind?: "button" | "switch";
}

export interface SheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Optional leading identity mark in the title row. */
  headerLeading?: ReactNode;
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
  /** Presentation-only exit state; the owner unmounts after the motion ends. */
  closing?: boolean;
  /** Full-screen navigation destinations use Back; transient sheets use Close. */
  dismiss?: "close" | "back";
  /** Explicit focus destination after every close path. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
  /** Phone layer-stack role (see the header comment). Omitted for ordinary sheets. */
  stackPhase?: SheetStackPhase;
  /**
   * Mounted only because a swipe is pulling the layer in: positioned by the
   * finger, inert and not yet the active modal. Releasing it either opens it
   * (the prop clears and the stack entrance carries on) or unmounts it.
   */
  peeking?: boolean;
}

export type SheetStackPhase = LayerStackPhase;

/** Body scroll lock: a sheet is modal, the page behind it must not scroll. */
let openSheets = 0;

export default function Sheet({
  title,
  onClose,
  children,
  headerLeading,
  search,
  action,
  footer,
  className,
  size = "auto",
  origin = "bottom",
  closing = false,
  dismiss = "close",
  restoreFocusRef,
  stackPhase,
  peeking = false,
}: SheetProps) {
  // A covered layer is not the active modal: another layer owns focus, Escape
  // and pointer input until it is revealed again. Neither is a peek: it takes
  // over focus, the scroll lock and Escape only once the swipe opens it.
  const inactive = stackPhase === "covered" || peeking;
  const panelRef = useRef<HTMLDivElement>(null);
  /** A pointer press has started inside this sheet (see the ghost-click guard). */
  const pointerInside = useRef(false);
  const closingRef = useRef(closing);
  closingRef.current = closing;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // A transient sheet its owner unmounts at once still leaves the way it came
  // (exitGhost.ts). Stack layers and presence-managed sheets play their own
  // exit through `closing`, and a peek never opened.
  const leaving = useRef({ stackPhase, peeking });
  leaving.current = { stackPhase, peeking };
  const backdropRef = useExitGhost<HTMLDivElement>(() =>
    closingRef.current || leaving.current.stackPhase || leaving.current.peeking ? null : { kind: "sheet" });

  useModalSurface({
    open: !inactive,
    onClose: () => { if (!closing && !inactive) onClose(); },
    containerRef: panelRef,
    // The panel itself takes focus: sheets open silently, without raising the
    // keyboard through an autofocused search field.
    initialFocus: "[data-sheet-focus]",
    // Going under another layer must not pull focus back to the opener: the
    // layer on top is the one the user is working in.
    ...(inactive
      ? { resolveRestoreFocus: () => null }
      : restoreFocusRef ? { resolveRestoreFocus: () => restoreFocusRef.current } : {}),
  });

  useEffect(() => {
    // A covered layer sits under a package window, which owns its own scrolling
    // (and keyboard handling); the page lock belongs to whatever is on top.
    if (inactive) return;
    openSheets += 1;
    document.documentElement.dataset.sheet = "open";
    return () => {
      openSheets = Math.max(0, openSheets - 1);
      if (openSheets === 0) delete document.documentElement.dataset.sheet;
    };
  }, [inactive]);

  // Drag to dismiss (sheetDrag.ts): a sheet that shows its grabber follows a
  // finger pulling it toward the edge it came from — by the grabber or the
  // title row, or by content already scrolled to its start — and a release
  // either dismisses it, carrying on from the finger, or springs it back.
  // Full-screen destinations (Back sheets, stack layers) navigate instead.
  const draggable = dismiss === "close" && !stackPhase && !peeking;
  useEffect(() => {
    if (!draggable) return;
    return attachSheetDrag({
      sheet: () => panelRef.current,
      origin: () => origin,
      enabled: () => {
        const grabber = panelRef.current?.querySelector<HTMLElement>(":scope > .sheet-grabber");
        return !closingRef.current && Boolean(grabber && grabber.getClientRects().length > 0);
      },
      onDismiss: () => { if (!closingRef.current) onCloseRef.current(); },
    });
  }, [draggable, origin]);

  // Reopened during its exit: whatever a drag handed to that exit is spent.
  useEffect(() => {
    if (closing) return;
    const panel = panelRef.current;
    if (!panel?.style.getPropertyValue("--sheet-from")) return;
    panel.style.removeProperty("--sheet-from");
    panel.style.removeProperty("--sheet-settle");
    panel.style.removeProperty("transform");
    panel.removeAttribute("data-drag-dismissed");
  }, [closing]);

  // Escape closes the TOPMOST sheet wherever focus happens to be. The panel's
  // own key handler (useModalSurface) only sees keys while focus is inside it,
  // and a tap on a non-interactive part of a sheet can park focus on <body>.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isImeComposing(event)) return;
      if (event.key !== "Escape" || closing || inactive) return;
      // A sheet that just left may still be playing its exit ghost; it is not a sheet.
      const sheets = [...document.querySelectorAll(".sheet-backdrop:not([data-exit-ghost])")];
      if (sheets[sheets.length - 1] !== panelRef.current?.parentElement) return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [closing, inactive, onClose]);

  const surface = (
    <div
      ref={backdropRef}
      className={`sheet-backdrop${origin === "top" ? " sheet-backdrop-top" : ""}${closing ? " is-closing" : ""}`}
      data-sheet-state={closing ? "closing" : "open"}
      data-stack={stackPhase}
      data-swipe-peek={peeking ? "" : undefined}
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
      // A stack layer is a full-screen destination, not a popover: the strip a
      // slide still shows is not an outside tap, and dismissing on it would
      // close the layer the moment it opened.
      onPointerDown={(event) => { if (!closing && !stackPhase && event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-sheet-focus=""
        className={`sheet sheet-${size}${origin === "top" ? " sheet-origin-top" : ""}${closing ? " is-closing" : ""}${className ? ` ${className}` : ""}`}
        onPointerDown={(event) => {
          if (closing) return;
          // Keep focus (and therefore Escape and the Tab trap) inside the
          // sheet when a press lands on non-interactive chrome.
          const target = event.target as HTMLElement | null;
          if (!target?.closest("button, a, input, textarea, select, [tabindex]")) {
            panelRef.current?.focus();
          }
        }}
      >
        {dismiss === "close" && (
          <div className="sheet-grabber">
            <i aria-hidden="true" />
          </div>
        )}
        <div className="sheet-head">
          {dismiss === "back" && (
            <button type="button" className="sheet-back" aria-label={tr("common.back")} onClick={() => { if (!closing) onClose(); }}>
              <Icon icon={BackIcon} size="lg" />
            </button>
          )}
          {headerLeading && <span className="sheet-head-leading" aria-hidden="true">{headerLeading}</span>}
          <h2 className="sheet-title">{title}</h2>
          {action && action.kind === "switch" ? (
            // A mode, not a command: the label names it and the switch shows
            // whether it is on. The whole pill is the target.
            <button
              type="button"
              className="sheet-head-switch"
              role="switch"
              aria-checked={action.pressed === true}
              aria-busy={action.busy || undefined}
              disabled={Boolean(action.disabled || action.busy)}
              onClick={() => {
                if (closing || action.disabled || action.busy) return;
                action.onClick();
              }}
            >
              <span className="sheet-head-switch-label">{action.label}</span>
              <span className="switch" data-checked={action.pressed === true} aria-hidden="true">
                <span className="switch-track"><i /></span>
              </span>
            </button>
          ) : action && (
            <button
              type="button"
              className="sheet-head-action"
              aria-pressed={action.pressed}
              aria-busy={action.busy || undefined}
              disabled={Boolean(action.disabled || action.busy)}
              onClick={() => {
                if (closing || action.disabled || action.busy) return;
                action.onClick();
              }}
            >
              {action.label}
            </button>
          )}
          {dismiss === "close" && (
            <button type="button" className="sheet-close" aria-label={tr("mobile.sheet.closeValue", { title: title })} onClick={() => { if (!closing) onClose(); }}>
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
