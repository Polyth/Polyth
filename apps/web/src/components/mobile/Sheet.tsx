// UX-MOBILE-01 §21–§24: the shared bottom sheet. Phones slide it up from the
// bottom edge above the keyboard inset; wider viewports render the same
// component as a centered bounded dialog (styles.css owns that switch).
// While any sheet is open the page behind it never scrolls
// (html[data-sheet="open"]).
import { useEffect, useRef, type ReactNode } from "react";
import { useEscape } from "../../useEscape.ts";
import { Icon } from "../../icons.tsx";

export interface SheetSearch {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
}

/** Optional head action next to the close button (e.g. Edit/Done toggles). */
export interface SheetAction {
  label: string;
  pressed?: boolean;
  onClick: () => void;
}

// Nested sheets share the scroll lock; only the last one to close releases it.
let openSheets = 0;

function lockPageScroll(): () => void {
  if (typeof document === "undefined") return () => {};
  openSheets += 1;
  document.documentElement.dataset.sheet = "open";
  return () => {
    openSheets = Math.max(0, openSheets - 1);
    if (openSheets === 0) delete document.documentElement.dataset.sheet;
  };
}

export default function Sheet({
  title,
  onClose,
  children,
  className,
  size,
  search,
  action,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  /** "tall" pins the sheet to the full visible band (model catalog). */
  size?: "tall";
  search?: SheetSearch;
  action?: SheetAction;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEscape(true, onClose);
  useEffect(() => lockPageScroll(), []);
  useEffect(() => {
    // Focus lands on the search field when there is one, else on the panel,
    // so the keyboard user is inside the dialog immediately.
    const panel = panelRef.current;
    if (!panel) return;
    const field = panel.querySelector<HTMLInputElement>(".sheet-search input");
    (field ?? panel).focus();
  }, []);

  const classes = ["sheet"];
  if (size === "tall") classes.push("sheet-tall");
  if (className) classes.push(className);

  return (
    <div
      className="sheet-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={classes.join(" ")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="sheet-grabber" aria-hidden="true" onClick={onClose}><i /></div>
        <div className="sheet-head">
          <h2 className="sheet-title">{title}</h2>
          {action && (
            <button
              type="button"
              className="sheet-head-action"
              aria-pressed={action.pressed === true}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          )}
          <button type="button" className="sheet-close" aria-label="Close" onClick={onClose}>
            <Icon.close />
          </button>
        </div>
        {search && (
          <div className="sheet-search">
            <Icon.search />
            <input
              type="search"
              value={search.value}
              placeholder={search.placeholder}
              aria-label={search.ariaLabel}
              onChange={(event) => search.onChange(event.target.value)}
            />
            {search.value && (
              <button
                type="button"
                className="sheet-search-clear"
                aria-label="Clear search"
                onClick={() => search.onChange("")}
              >
                <Icon.close />
              </button>
            )}
          </div>
        )}
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

/** One tappable row: ≥52px main target, optional icon, meta line, selection
 *  check, and trailing per-row tools that never also pick the row. */
export function SheetRow({
  title,
  meta,
  icon,
  selected,
  onClick,
  ariaLabel,
  trailing,
}: {
  title: string;
  meta?: string;
  icon?: ReactNode;
  selected?: boolean;
  onClick: () => void;
  ariaLabel?: string;
  trailing?: ReactNode;
}) {
  return (
    <div className={`sheet-row${selected ? " selected" : ""}`}>
      <button
        type="button"
        className="sheet-row-main"
        role="option"
        aria-selected={selected === true}
        aria-label={ariaLabel}
        onClick={onClick}
      >
        {icon && <span className="sheet-row-icon" aria-hidden="true">{icon}</span>}
        <span className="sheet-row-copy">
          <strong>{title}</strong>
          {meta && <small>{meta}</small>}
        </span>
        {selected && <span className="sheet-row-check" aria-hidden="true"><Icon.check /></span>}
      </button>
      {trailing}
    </div>
  );
}

/** Titled group of rows with a sticky uppercase head and an optional count. */
export function SheetSection({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
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
