// The phase-one views: cards, list, table, stats and choice. Long collections
// (usually from a `from=` file) render a page at a time.
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { MarkdownFenceContext } from "@polyth/web-sdk";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Badge,
  Button,
  ExternalLinkIcon,
  Icon,
  SortIcon,
  TextInput,
} from "../../../apps/web/src/components/ui/index.ts";
import { deltaDirection, numericValue, type ChatBlockDoc, type ChatBlockItem } from "../src/parse.ts";
import { BlockHead, InlineText, Mark, Media, imageUrl, isCompactValue, mediaRatio, safeLink, usePaging } from "./shared.tsx";
import { fill, type ChatBlockStrings } from "./strings.ts";

const TABLE_PREVIEW_ROWS = 10;
const TABLE_STEP = 50;
const TABLE_FILTER_FROM = 7;
const COLLECTION_PREVIEW = 24;
const COLLECTION_STEP = 24;

function MoreButton({ paging, t }: { paging: ReturnType<typeof usePaging>; t: ChatBlockStrings }) {
  if (paging.remaining <= 0) return null;
  return (
    <div className="chat-block-more is-bare">
      <Button size="sm" variant="ghost" onClick={paging.more}>{fill(t.showMore, { count: Math.min(COLLECTION_STEP, paging.remaining) })}</Button>
    </div>
  );
}

/** `sort=value` / `sort=-value` / `sort=title` orders cards and rows. */
export function sortItems(items: ChatBlockItem[], sort: string | undefined): ChatBlockItem[] {
  if (!sort) return items;
  const descending = sort.startsWith("-");
  const field = sort.replace(/^[-+]/, "");
  if (field !== "value" && field !== "title") return items;
  const sign = descending ? -1 : 1;
  return [...items].sort((a, b) => {
    if (field === "title") return sign * a.title.localeCompare(b.title);
    const av = numericValue(a.value);
    const bv = numericValue(b.value);
    if (av === null || bv === null) return av === null ? (bv === null ? 0 : 1) : -1;
    return sign * (av - bv);
  });
}

export interface CollectionProps {
  doc: ChatBlockDoc;
  items: ChatBlockItem[];
  selected: ReadonlySet<number>;
  toggle(index: number): void;
  t: ChatBlockStrings;
  context: MarkdownFenceContext;
  streaming: boolean;
  locked: boolean;
}

export function CardsView({ doc, items: all, selected, toggle, t, context, streaming, locked }: CollectionProps) {
  const paging = usePaging(all.length, COLLECTION_PREVIEW, COLLECTION_STEP);
  const items = all.slice(0, paging.visible);
  const ratio = mediaRatio(doc.options.ratio);
  // One card with an image gives every card a media area, so the grid stays even.
  const withMedia = Boolean(ratio) || items.some((item) => item.image);
  return (
    <>
    <ul className="chat-block-cards" style={ratio ? { ["--chat-block-media-ratio" as string]: ratio } : undefined}>
      {items.map((item) => {
        const href = safeLink(item.link);
        const isSelected = selected.has(item.index);
        return (
          <li key={item.index} className={`chat-block-card${isSelected ? " is-selected" : ""}${streaming ? " chat-block-enter" : ""}`}>
            {withMedia && <Media src={imageUrl(item.image, context)} title={item.title} />}
            {doc.pick !== "none" ? (
              <>
                <button
                  type="button"
                  className="chat-block-hit"
                  role={doc.pick === "one" ? "radio" : "checkbox"}
                  aria-checked={isSelected}
                  aria-label={fill(t.select, { title: item.title })}
                  disabled={locked}
                  onClick={() => toggle(item.index)}
                />
                <Mark />
                {href && (
                  <a className="chat-block-open" href={href} target="_blank" rel="noopener noreferrer" aria-label={fill(t.open, { title: item.title })}>
                    <Icon icon={ExternalLinkIcon} size="sm" />
                  </a>
                )}
              </>
            ) : href ? (
              <a className="chat-block-hit" href={href} target="_blank" rel="noopener noreferrer" aria-label={fill(t.open, { title: item.title })} />
            ) : null}
            <div className="chat-block-card-body">
              <span className="chat-block-card-title">{item.title}</span>
              {item.subtitle && <span className="chat-block-sub">{item.subtitle}</span>}
              {(item.value || item.badge) && (
                <div className="chat-block-card-foot">
                  {item.value && <span className={`chat-block-value${isCompactValue(item.value) ? "" : " is-long"}`}>{item.value}</span>}
                  {item.badge && <Badge tone={item.tone ?? "neutral"}>{item.badge}</Badge>}
                </div>
              )}
            </div>
          </li>
        );
      })}
      {doc.pending && <li className="chat-block-card chat-block-pending" aria-hidden="true" />}
    </ul>
    <MoreButton paging={paging} t={t} />
    </>
  );
}

export function ListView({ doc, items: all, selected, toggle, t, context, streaming, locked }: CollectionProps) {
  const paging = usePaging(all.length, COLLECTION_PREVIEW, COLLECTION_STEP);
  const items = all.slice(0, paging.visible);
  const anyImage = items.some((item) => item.image);
  return (
    <>
    <ul className="chat-block-list">
      {items.map((item) => {
        const href = safeLink(item.link);
        const isSelected = selected.has(item.index);
        // A short value sits at the row's end; running text reads in the body
        // under the title, so it can never squeeze the title column.
        const compact = item.value ? isCompactValue(item.value) : false;
        return (
          <li key={item.index} className={`chat-block-row${isSelected ? " is-selected" : ""}${streaming ? " chat-block-enter" : ""}`}>
            {anyImage && <Media src={imageUrl(item.image, context)} title={item.title} className="chat-block-thumb" />}
            <div className="chat-block-row-main">
              {href
                ? <a className="chat-block-link chat-block-row-title" href={href} target="_blank" rel="noopener noreferrer">{item.title}</a>
                : <span className="chat-block-row-title">{item.title}</span>}
              {item.subtitle && <span className="chat-block-sub">{item.subtitle}</span>}
              {item.value && !compact && <span className="chat-block-row-note">{item.value}</span>}
            </div>
            {((item.value && compact) || item.badge) && (
              <div className="chat-block-row-end">
                {item.value && compact && <span className="chat-block-value">{item.value}</span>}
                {item.badge && <Badge tone={item.tone ?? "neutral"}>{item.badge}</Badge>}
              </div>
            )}
            {doc.pick !== "none" && <Mark />}
            {doc.pick !== "none" && (
              <button
                type="button"
                className="chat-block-hit"
                role={doc.pick === "one" ? "radio" : "checkbox"}
                aria-checked={isSelected}
                aria-label={fill(t.select, { title: item.title })}
                disabled={locked}
                onClick={() => toggle(item.index)}
              />
            )}
          </li>
        );
      })}
      {doc.pending && <li className="chat-block-row chat-block-pending" aria-hidden="true" />}
    </ul>
    <MoreButton paging={paging} t={t} />
    </>
  );
}

// ------------------------------------------------------------------ table

export function TableView({ doc, t }: { doc: ChatBlockDoc; t: ChatBlockStrings }) {
  const columns = doc.columns.length > 0 ? doc.columns : (doc.items[0]?.cells ?? []).map((_, i) => `#${i + 1}`);
  const numeric = useMemo(() => columns.map((_, col) => {
    const values = doc.items.map((item) => item.cells[col] ?? "").filter((cell) => cell !== "");
    return values.length > 0 && values.every((cell) => /^[\s\d.,%+\-−$€£₴¥]+[^\s]{0,4}$/.test(cell) && numericValue(cell) !== null);
  }), [columns, doc.items]);
  const initialSort = useMemo(() => {
    const option = doc.options.sort;
    if (!option) return null;
    const name = option.replace(/^[-+]/, "").toLowerCase();
    const index = /^\d+$/.test(name) ? Number(name) - 1 : columns.findIndex((col) => col.toLowerCase() === name);
    return index >= 0 && index < columns.length ? { col: index, dir: option.startsWith("-") ? -1 : 1 } : null;
  }, [doc.options.sort, columns]);
  const [sort, setSort] = useState<{ col: number; dir: number } | null>(initialSort);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(TABLE_PREVIEW_ROWS);
  // Mouse users have no native horizontal gesture on a narrow table (a
  // trackpad or Shift+wheel is not obvious). Pan on a left-button drag, while
  // touch keeps the browser's native inertial scrolling. A drag never turns
  // into a header sort click.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ pointerId: number; startX: number; startLeft: number; moved: boolean } | null>(null);
  const swallowClick = useRef(false);
  const [scrollable, setScrollable] = useState(false);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle ? doc.items.filter((item) => item.cells.some((cell) => cell.toLowerCase().includes(needle))) : doc.items;
    if (!sort) return filtered;
    return [...filtered].sort((a, b) => {
      const av = a.cells[sort.col] ?? "";
      const bv = b.cells[sort.col] ?? "";
      if (numeric[sort.col]) return sort.dir * ((numericValue(av) ?? 0) - (numericValue(bv) ?? 0));
      return sort.dir * av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
    });
  }, [doc.items, query, sort, numeric]);
  const visible = rows.slice(0, shown);
  const remaining = rows.length - visible.length;
  const total = doc.items.length;
  const count = rows.length === total ? String(total) : fill(t.count, { shown: rows.length, total });

  // The grab cursor is an affordance only where panning can actually do
  // something. A resize or a filter that removes the overflow turns it off.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => setScrollable(wrap.scrollWidth > wrap.clientWidth + 1);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(wrap);
    const table = wrap.querySelector("table");
    if (table) observer?.observe(table);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [columns.length, doc.items, query, shown]);

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || event.pointerId !== state.pointerId) return;
    drag.current = null;
    event.currentTarget.classList.remove("is-dragging");
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (state.moved) {
      // The click that follows this pointerup belongs to the pan.
      swallowClick.current = true;
      window.setTimeout(() => { swallowClick.current = false; }, 0);
    }
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    const wrap = event.currentTarget;
    if (wrap.scrollWidth <= wrap.clientWidth + 1) return;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startLeft: wrap.scrollLeft, moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || event.pointerId !== state.pointerId) return;
    const dx = event.clientX - state.startX;
    if (!state.moved) {
      if (Math.abs(dx) < 4) return;
      state.moved = true;
      event.currentTarget.classList.add("is-dragging");
      event.currentTarget.setPointerCapture?.(event.pointerId);
      // A pan must not leave a half-selected table behind.
      window.getSelection?.()?.removeAllRanges();
    }
    event.preventDefault();
    event.currentTarget.scrollLeft = state.startLeft - dx;
  };
  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const cycle = (col: number) => setSort((current) => {
    if (!current || current.col !== col) return { col, dir: numeric[col] ? -1 : 1 };
    return current.dir === (numeric[col] ? -1 : 1) ? { col, dir: -current.dir } : null;
  });

  return (
    <>
      <BlockHead title={doc.title} count={count}>
        {total >= TABLE_FILTER_FROM && (
          <TextInput
            uiSize="sm"
            className="chat-block-search"
            type="search"
            value={query}
            placeholder={t.filterPlaceholder}
            aria-label={t.filter}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
      </BlockHead>
      <div
        ref={wrapRef}
        className={`chat-block-table-wrap${scrollable ? " is-scrollable" : ""}`}
        {...(doc.title ? { role: "region", tabIndex: 0, "aria-label": doc.title } : scrollable ? { tabIndex: 0 } : {})}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={() => {
          drag.current = null;
          wrapRef.current?.classList.remove("is-dragging");
        }}
        onClickCapture={onClickCapture}
        onDragStart={(event) => { if (scrollable) event.preventDefault(); }}
      >
        {columns.length > 0 && (
          <table className="chat-block-table">
            <thead>
              <tr>
                {columns.map((column, col) => {
                  const active = sort?.col === col;
                  const ariaSort = active ? (sort!.dir > 0 ? "ascending" : "descending") : "none";
                  return (
                    <th key={col} scope="col" aria-sort={ariaSort} className={numeric[col] ? "is-num" : undefined}>
                      <button type="button" className="chat-block-sort" aria-label={fill(t.sortBy, { column })} onClick={() => cycle(col)}>
                        {column}
                        <Icon icon={active ? (sort!.dir > 0 ? ArrowUpIcon : ArrowDownIcon) : SortIcon} size="sm" />
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => (
                <tr key={item.index}>
                  {columns.map((_, col) => (
                    <td key={col} className={numeric[col] ? "is-num" : undefined}><InlineText text={item.cells[col] ?? ""} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {rows.length === 0 && <div className="chat-block-empty">{t.noMatches}</div>}
        {rows.length > TABLE_PREVIEW_ROWS && (
          <div className="chat-block-more">
            {remaining > 0 ? (
              <Button size="sm" variant="ghost" onClick={() => setShown((value) => value + TABLE_STEP)}>
                {remaining <= TABLE_STEP ? fill(t.showAll, { total: rows.length }) : fill(t.showMore, { count: TABLE_STEP })}
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setShown(TABLE_PREVIEW_ROWS)}>{t.showLess}</Button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ stats

function Sparkline({ points }: { points: number[] }) {
  const width = 100;
  const height = 28;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const xy = points.map((point, i) => [(i / (points.length - 1)) * width, height - 2 - ((point - min) / span) * (height - 4)] as const);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return (
    <svg className="chat-block-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path className="area" d={`${line} L${width} ${height} L0 ${height} Z`} />
      <path className="line" d={line} />
    </svg>
  );
}

export function StatsView({ doc, streaming }: { doc: ChatBlockDoc; streaming: boolean }) {
  return (
    <div className="chat-block-stats">
      {doc.items.map((item) => {
        const direction = deltaDirection(item.badge);
        return (
          <div key={item.index} className={`chat-block-stat${streaming ? " chat-block-enter" : ""}`}>
            <span className="chat-block-stat-label">{item.title}</span>
            <span className="chat-block-stat-value">{item.value ?? "—"}</span>
            {item.badge && (
              <span className={`chat-block-delta is-${direction}`}>
                {direction !== "flat" && <Icon icon={direction === "up" ? ArrowUpIcon : ArrowDownIcon} size="sm" />}
                {direction === "flat" ? item.badge : item.badge.replace(/^[+\-−↑↓▲▼]\s*/, "")}
              </span>
            )}
            {item.spark && <Sparkline points={item.spark} />}
          </div>
        );
      })}
      {doc.pending && <div className="chat-block-stat chat-block-pending" aria-hidden="true" />}
    </div>
  );
}

// ----------------------------------------------------------------- choice

export function ChoiceView({ doc, selected, toggle, locked }: {
  doc: ChatBlockDoc;
  selected: ReadonlySet<number>;
  toggle(index: number): void;
  locked: boolean;
}) {
  const single = doc.pick !== "many";
  return (
    <div className="chat-block-choices" role={single ? "radiogroup" : "group"} aria-label={doc.title || undefined} data-mode={single ? "single" : "multi"}>
      {doc.items.map((item) => {
        const isSelected = selected.has(item.index);
        return (
          <button
            key={item.index}
            type="button"
            className={`chat-block-choice${isSelected ? " is-selected" : ""}`}
            role={single ? "radio" : "checkbox"}
            aria-checked={isSelected}
            disabled={locked}
            onClick={() => toggle(item.index)}
          >
            <Mark />
            <span className="chat-block-choice-text">
              <span className="chat-block-choice-label">{item.title}</span>
              {item.subtitle && <span className="chat-block-sub">{item.subtitle}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
