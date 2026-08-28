// Reusable searchable listbox replacing native <select>s: compact chip
// trigger, type-to-filter popover, ↑↓ Enter Esc keyboard nav, grouped options
// with a checkmark on the current one. Pass `values` for multi-select.
import {
  Fragment, useEffect, useId, useMemo, useRef, useState,
  type KeyboardEvent, type ReactNode,
} from "react";
import { filterPickerItems, type PickerItem } from "../picker.ts";
import { useEscape } from "../useEscape.ts";
import { useShellMode } from "../responsiveShell.ts";
import { dismissKeyboard } from "../mobileViewport.ts";
import { tapFeedback } from "../haptics.ts";
import Sheet, { SheetRow } from "./mobile/Sheet.tsx";
import { useSheetTrigger } from "./mobile/sheetTrigger.ts";
import { tr } from "../i18n/index.ts";
import { usePopoverPlacement } from "../usePopoverPlacement.ts";
import Button from "./ui/Button.tsx";

const MAX_SHOWN = 200;

export interface PickerProps {
  label: string;
  items: PickerItem[];
  value?: string;
  /** Multi-select mode: toggles stay open, chip shows a count. */
  values?: readonly string[];
  onPick: (id: string) => void;
  placeholder?: string;
  direction?: "up" | "down";
  disabled?: boolean;
  /** Trailing per-row action (e.g. create/edit profile). Never also picks the
   *  row. Label and accessible name are item-specific (UX-COMPOSER-DISC). */
  trailingAction?: {
    labelFor: (id: string) => string;
    nameFor: (id: string) => string;
    onAction: (id: string) => void;
  };
  /** Named list-footer action (e.g. `Create profile…`). A disabledReason is
   *  visible text, with an optional operable secondary route. */
  footerAction?: {
    label: string;
    run: () => void;
    disabledReason?: string;
    secondaryLabel?: string;
    secondaryRun?: () => void;
  };
  /** Extra class on the root (responsive layout hooks, e.g. picker-profile). */
  className?: string;
  /** Accessible trigger name; keeps the full label when text is condensed. */
  ariaLabel?: string;
  /** Icon rendered in place of the uppercase label key (compact triggers). */
  triggerIcon?: ReactNode;
  /** UX-MOBILE-01 §46: open as the shared bottom sheet on phones instead of a
   *  desktop popover. Opt-in, so only the surfaces redesigned for touch (the
   *  composer's mode selector) change behavior. */
  mobileSheet?: boolean;
}

export default function Picker({
  label,
  items,
  value,
  values,
  onPick,
  placeholder = tr("picker.default"),
  direction: _direction = "down",
  disabled,
  trailingAction,
  footerAction,
  className,
  ariaLabel,
  triggerIcon,
  mobileSheet,
}: PickerProps) {
  const multi = values !== undefined;
  const asSheet = useShellMode() === "phone" && mobileSheet === true;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const pickerId = useId();
  const listId = `${pickerId}-listbox`;
  const direction = usePopoverPlacement(open && !asSheet, triggerRef, popoverRef);

  const close = () => {
    setOpen(false);
    if (!asSheet) triggerRef.current?.focus();
  };
  useEscape(open && !asSheet, close);
  // §22: never raise a sheet under an open keyboard.
  const toggleOpen = () => {
    if (open) {
      close();
      return;
    }
    setQ("");
    if (asSheet) {
      // Open first, dismiss the keyboard after: see sheetTrigger.ts.
      setOpen(true);
      void dismissKeyboard();
    } else {
      setOpen(true);
    }
  };
  const triggerHandlers = useSheetTrigger(asSheet, toggleOpen);

  const hits = useMemo(() => filterPickerItems(items, q), [items, q]);
  const shown = hits.slice(0, MAX_SHOWN);

  useEffect(() => {
    setActive(0);
  }, [q, open]);
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, shown.length]);

  const isCurrent = (id: string) => (multi ? values.includes(id) : id === value);
  const pick = (id: string) => {
    if (asSheet) tapFeedback();
    onPick(id);
    if (!multi) close();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((n) => Math.min(n + 1, Math.max(shown.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((n) => Math.max(n - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(shown.length - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = shown[active];
      if (it) pick(it.id);
    }
  };

  const current = multi ? undefined : items.find((i) => i.id === value);
  const chipText = multi
    ? values.length > 0
      ? `${values.length} selected`
      : placeholder
    : current?.label ?? placeholder;

  return (
    <span className={`picker${className ? ` ${className}` : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="chip picker-chip"
        title={ariaLabel ?? label}
        aria-label={ariaLabel}
        aria-haspopup={asSheet ? "dialog" : "listbox"}
        aria-expanded={open}
        aria-controls={open && !asSheet ? listId : undefined}
        disabled={disabled}
        {...triggerHandlers}
      >
        {triggerIcon
          ? <span className="picker-trigger-icon" aria-hidden="true">{triggerIcon}</span>
          : <span className="chip-k">{label}</span>}
        <span className="picker-chip-text">{chipText}</span>
        <span className="picker-caret">▾</span>
      </button>
      {open && asSheet && (
        <Sheet
          title={label}
          className="picker-sheet"
          onClose={close}
          {...(items.length > 8 ? {
            search: {
              value: q,
              onChange: setQ,
              placeholder: tr("picker.searchValue", { value: label.toLowerCase() }),
              ariaLabel: `Filter ${label}`,
            },
          } : {})}
        >
          <div role="listbox" aria-label={label}>
            {shown.map((it) => (
              <SheetRow
                key={it.id || "(default)"}
                title={it.label}
                {...(it.detail ? { meta: it.detail } : {})}
                selected={isCurrent(it.id)}
                onClick={() => pick(it.id)}
              />
            ))}
            {shown.length === 0 && <p className="sheet-empty">{tr("picker.noMatches")}</p>}
          </div>
          {footerAction && (
            <button
              type="button"
              className="sheet-foot-action"
              aria-disabled={footerAction.disabledReason ? true : undefined}
              onClick={() => {
                if (footerAction.disabledReason) return;
                close();
                footerAction.run();
              }}
            >{footerAction.label}</button>
          )}
        </Sheet>
      )}
      {open && !asSheet && (
        <>
          <div className="menu-backdrop" onClick={close} />
          <div ref={popoverRef} className={`picker-pop ${direction}`}>
            <input
              autoFocus
              value={q}
              placeholder={tr("picker.filterValue", { value: label.toLowerCase() })}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKey}
              role="combobox"
              aria-label={tr("picker.filterValue2", { label: label })}
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={shown[active] ? `${pickerId}-option-${active}` : undefined}
            />
            <div
              id={listId}
              className="picker-list"
              role="listbox"
              aria-label={label}
              aria-multiselectable={multi || undefined}
              ref={listRef}
            >
              {shown.map((it, n) => (
                <Fragment key={it.id || "(default)"}>
                  {it.group !== "" && (n === 0 || shown[n - 1]!.group !== it.group) && (
                    <div className="picker-group" role="presentation">{it.group}</div>
                  )}
                  <div
                    id={`${pickerId}-option-${n}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={isCurrent(it.id)}
                    data-active={n === active ? "true" : undefined}
                    className={`picker-item${n === active ? " active" : ""}${isCurrent(it.id) ? " current" : ""}`}
                    onClick={() => pick(it.id)}
                    onMouseEnter={() => setActive(n)}
                  >
                    <span className="picker-check">{isCurrent(it.id) ? "✓" : ""}</span>
                    <span className="palette-label">{it.label}</span>
                    {it.detail && <span className="palette-meta">{it.detail}</span>}
                    {trailingAction && it.id && (
                      <button
                        type="button"
                        className="picker-trail"
                        aria-label={trailingAction.nameFor(it.id)}
                        title={trailingAction.nameFor(it.id)}
                        onClick={(e) => { e.stopPropagation(); trailingAction.onAction(it.id); close(); }}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        {trailingAction.labelFor(it.id)}
                      </button>
                    )}
                  </div>
                </Fragment>
              ))}
              {shown.length === 0 && <div className="palette-empty">{tr("picker.noMatches")}</div>}
              {hits.length > MAX_SHOWN && (
                <div className="picker-more">{hits.length - MAX_SHOWN} {tr("picker.moreRefineTheFilter")}</div>
              )}
            </div>
            {footerAction && (
              <div className="picker-footer">
                <button
                  type="button"
                  className="picker-footer-action"
                  aria-disabled={footerAction.disabledReason ? true : undefined}
                  onClick={() => {
                    if (footerAction.disabledReason) return;
                    close();
                    footerAction.run();
                  }}
                >
                  {footerAction.label}
                </button>
                {footerAction.disabledReason && (
                  <div className="picker-footer-reason">
                    <span>{footerAction.disabledReason}</span>
                    {footerAction.secondaryLabel && footerAction.secondaryRun && (
                      <Button
                        size="sm"
                        onClick={() => { close(); footerAction.secondaryRun!(); }}
                      >
                        {footerAction.secondaryLabel}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </span>
  );
}
