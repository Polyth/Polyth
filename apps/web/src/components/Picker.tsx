// Reusable searchable listbox replacing native <select>s: compact chip
// trigger, type-to-filter popover, ↑↓ Enter Esc keyboard nav, grouped options
// with a checkmark on the current one. Pass `values` for multi-select.
import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { filterPickerItems, type PickerItem } from "../picker.ts";
import { useEscape } from "../useEscape.ts";

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
  /** Trailing per-row action (e.g. pin-to-profile). Never also picks the row. */
  trailingAction?: { label: string; title?: string; onAction: (id: string) => void };
}

export default function Picker({
  label,
  items,
  value,
  values,
  onPick,
  placeholder = "Default",
  direction = "down",
  disabled,
  trailingAction,
}: PickerProps) {
  const multi = values !== undefined;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickerId = useId();
  const listId = `${pickerId}-listbox`;

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  useEscape(open, close);

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
    <span className="picker">
      <button
        ref={triggerRef}
        type="button"
        className="chip picker-chip"
        title={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => {
          setOpen((v) => !v);
          setQ("");
        }}
      >
        <span className="chip-k">{label}</span>
        <span className="picker-chip-text">{chipText}</span>
        <span className="picker-caret">▾</span>
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={close} />
          <div className={`picker-pop ${direction}`}>
            <input
              autoFocus
              value={q}
              placeholder={`Filter ${label.toLowerCase()}…`}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKey}
              role="combobox"
              aria-label={`Filter ${label}`}
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
                        title={trailingAction.title ?? trailingAction.label}
                        onClick={(e) => { e.stopPropagation(); trailingAction.onAction(it.id); close(); }}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        {trailingAction.label}
                      </button>
                    )}
                  </div>
                </Fragment>
              ))}
              {shown.length === 0 && <div className="palette-empty">No matches</div>}
              {hits.length > MAX_SHOWN && (
                <div className="picker-more">{hits.length - MAX_SHOWN} more — refine the filter</div>
              )}
            </div>
          </div>
        </>
      )}
    </span>
  );
}
