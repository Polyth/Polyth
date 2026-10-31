// Charts drawn from tokens only: horizontal bars (labels stay readable in a
// chat column), line/area with a crosshair that follows the pointer or the
// arrow keys, and a donut with a legend. No chart library, no canvas.
import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { chartType, niceCeil, type ChatBlockDoc, type ChatBlockItem } from "../src/parse.ts";
import { BlockHead, formatNumber, usePaging } from "./shared.tsx";
import { fill, type ChatBlockStrings } from "./strings.ts";
import { Button } from "../../../apps/web/src/components/ui/index.ts";

const BAR_PREVIEW = 12;
const seriesClass = (index: number) => `is-s${(index % 6) + 1}`;

export default function ChartView({ doc, t, locale }: { doc: ChatBlockDoc; t: ChatBlockStrings; locale: string }) {
  const type = chartType(doc);
  const unit = doc.options.unit;
  const format = (value: number | null | undefined) => (value === null || value === undefined ? "—" : formatNumber(value, locale, unit));
  return (
    <>
      <BlockHead title={doc.title} />
      {doc.series.length > 1 && type !== "donut" && (
        <ul className="chat-block-legend" aria-label={t.legend}>
          {doc.series.map((name, i) => (
            <li key={name + i} className={seriesClass(i)}><span className="chat-block-swatch" aria-hidden="true" />{name}</li>
          ))}
        </ul>
      )}
      {type === "donut"
        ? <Donut doc={doc} format={format} t={t} />
        : type === "bar"
          ? <Bars doc={doc} format={format} t={t} />
          : <Lines doc={doc} format={format} area={type === "area"} t={t} />}
    </>
  );
}

type Format = (value: number | null | undefined) => string;

function Bars({ doc, format, t }: { doc: ChatBlockDoc; format: Format; t: ChatBlockStrings }) {
  const paging = usePaging(doc.items.length, BAR_PREVIEW, 40);
  const max = Math.max(0, ...doc.items.flatMap((item) => (item.values ?? []).map((value) => Math.abs(value ?? 0)))) || 1;
  return (
    <>
      <ul className="chat-block-bars">
        {doc.items.slice(0, paging.visible).map((item) => (
          <li key={item.index} className="chat-block-bar-row">
            <span className="chat-block-bar-label" title={item.title}>{item.title}</span>
            <span className="chat-block-bar-track" aria-hidden="true">
              {(item.values ?? []).map((value, i) => (
                <span
                  key={i}
                  className={`chat-block-bar ${seriesClass(i)}${(value ?? 0) < 0 ? " is-negative" : ""}`}
                  style={{ inlineSize: `${Math.max(value ? 0.8 : 0, (Math.abs(value ?? 0) / max) * 100)}%` }}
                />
              ))}
            </span>
            <span className="chat-block-bar-value">
              {(item.values ?? []).map((value) => format(value)).join(" · ")}
            </span>
          </li>
        ))}
      </ul>
      {paging.remaining > 0 && (
        <div className="chat-block-more is-bare">
          <Button size="sm" variant="ghost" onClick={paging.more}>{fill(t.showMore, { count: Math.min(40, paging.remaining) })}</Button>
        </div>
      )}
    </>
  );
}

const W = 600;
const H = 180;

function Lines({ doc, format, area, t }: { doc: ChatBlockDoc; format: Format; area: boolean; t: ChatBlockStrings }) {
  const id = useId();
  const items = doc.items;
  const [active, setActive] = useState<number | null>(null);
  const { min, max } = useMemo(() => {
    const values = items.flatMap((item) => (item.values ?? []).filter((value): value is number => value !== null));
    // Axis ends on round numbers (2 592 → 3 000) so the labels read cleanly.
    const low = Math.min(0, ...values);
    const high = Math.max(...values, 0);
    return { min: low < 0 ? -niceCeil(-low) : 0, max: high > 0 ? niceCeil(high) : (low < 0 ? 0 : 1) };
  }, [items]);
  const x = (index: number) => (items.length <= 1 ? W / 2 : (index / (items.length - 1)) * W);
  const y = (value: number) => H - ((value - min) / (max - min)) * H;
  const paths = doc.series.map((_, s) => {
    let d = "";
    let started = false;
    items.forEach((item, i) => {
      const value = item.values?.[s];
      if (value === null || value === undefined) { started = false; return; }
      d += `${started ? "L" : "M"}${x(i).toFixed(1)} ${y(value).toFixed(1)} `;
      started = true;
    });
    return d.trim();
  });
  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0 || items.length === 0) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    setActive(Math.round(ratio * (items.length - 1)));
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (items.length === 0) return;
    const last = items.length - 1;
    const next = event.key === "ArrowRight" ? Math.min(last, (active ?? -1) + 1)
      : event.key === "ArrowLeft" ? Math.max(0, (active ?? last + 1) - 1)
        : event.key === "Home" ? 0 : event.key === "End" ? last : null;
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  };
  const activeItem: ChatBlockItem | undefined = active === null ? undefined : items[active];
  const left = active === null ? 0 : (x(active) / W) * 100;
  const middle = items.length > 2 ? items[Math.floor((items.length - 1) / 2)] : undefined;
  const summary = fill(t.chartSummary, { count: items.length, first: items[0]?.title ?? "", last: items.at(-1)?.title ?? "" });
  return (
    <div className="chat-block-plot">
      <div className="chat-block-plot-y" aria-hidden="true">
        <span>{format(max)}</span>
        <span>{format(min)}</span>
      </div>
      <div
        className="chat-block-plot-area"
        tabIndex={0}
        role="img"
        aria-label={summary}
        aria-describedby={activeItem ? `${id}-tip` : undefined}
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={() => setActive(null)}
        onKeyDown={key}
        onBlur={() => setActive(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {[0.25, 0.5, 0.75].map((f) => <line key={f} className="chat-block-grid" x1="0" x2={W} y1={H * f} y2={H * f} />)}
          {min < 0 && <line className="chat-block-zero" x1="0" x2={W} y1={y(0)} y2={y(0)} />}
          {paths.map((d, s) => d && (
            <g key={s} className={seriesClass(s)}>
              {area && <path className="chat-block-area" d={`${d} L${x(lastIndex(items, s)).toFixed(1)} ${y(Math.max(min, 0)).toFixed(1)} L${x(firstIndex(items, s)).toFixed(1)} ${y(Math.max(min, 0)).toFixed(1)} Z`} />}
              <path className="chat-block-line" d={d} />
            </g>
          ))}
        </svg>
        {activeItem && (
          <>
            <span className="chat-block-crosshair" style={{ insetInlineStart: `${left}%` }} aria-hidden="true" />
            {(activeItem.values ?? []).map((value, s) => value !== null && (
              <span
                key={s}
                className={`chat-block-dot ${seriesClass(s)}`}
                style={{ insetInlineStart: `${left}%`, insetBlockStart: `${(y(value) / H) * 100}%` }}
                aria-hidden="true"
              />
            ))}
            <div id={`${id}-tip`} className={`chat-block-tip${left > 60 ? " is-end" : ""}`} style={{ insetInlineStart: `${left}%` }} role="status">
              <strong>{activeItem.title}</strong>
              {doc.series.map((name, s) => (
                <span key={s} className={seriesClass(s)}>
                  <span className="chat-block-swatch" aria-hidden="true" />
                  {doc.series.length > 1 ? `${name}: ` : ""}{format(activeItem.values?.[s])}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="chat-block-plot-x" aria-hidden="true">
        <span>{items[0]?.title}</span>
        {middle && <span>{middle.title}</span>}
        {items.length > 1 && <span>{items.at(-1)?.title}</span>}
      </div>
    </div>
  );
}

const firstIndex = (items: ChatBlockItem[], s: number) => Math.max(0, items.findIndex((item) => item.values?.[s] !== null && item.values?.[s] !== undefined));
const lastIndex = (items: ChatBlockItem[], s: number) => {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.values?.[s] !== null && items[i]!.values?.[s] !== undefined) return i;
  return 0;
};

const DONUT_SLICES = 8;

function Donut({ doc, format, t }: { doc: ChatBlockDoc; format: Format; t: ChatBlockStrings }) {
  const [focus, setFocus] = useState<number | null>(null);
  const slices = useMemo(() => {
    const positive = doc.items
      .map((item) => ({ title: item.title, value: Math.max(0, item.values?.[0] ?? 0) }))
      .filter((slice) => slice.value > 0)
      .sort((a, b) => b.value - a.value);
    if (positive.length <= DONUT_SLICES) return positive;
    const rest = positive.slice(DONUT_SLICES - 1).reduce((sum, slice) => sum + slice.value, 0);
    return [...positive.slice(0, DONUT_SLICES - 1), { title: t.other, value: rest }];
  }, [doc.items, t.other]);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  let offset = 0;
  return (
    <div className="chat-block-donut">
      <svg viewBox="0 0 42 42" className="chat-block-donut-ring" role="img" aria-label={fill(t.donutSummary, { total: format(total), count: slices.length })}>
        <circle className="chat-block-donut-track" cx="21" cy="21" r="15.915" />
        {slices.map((slice, i) => {
          const share = total > 0 ? (slice.value / total) * 100 : 0;
          const dash = `${Math.max(0, share - (slices.length > 1 ? 0.6 : 0))} ${100 - Math.max(0, share - (slices.length > 1 ? 0.6 : 0))}`;
          const element = (
            <circle
              key={slice.title + i}
              className={`chat-block-donut-slice ${seriesClass(i)}${focus !== null && focus !== i ? " is-dim" : ""}`}
              cx="21" cy="21" r="15.915"
              strokeDasharray={dash}
              strokeDashoffset={25 - offset}
            />
          );
          offset += share;
          return element;
        })}
        <text x="21" y="21" className="chat-block-donut-total">{format(total)}</text>
      </svg>
      <ul className="chat-block-donut-legend">
        {slices.map((slice, i) => (
          <li
            key={slice.title + i}
            className={`${seriesClass(i)}${focus === i ? " is-focus" : ""}`}
            onPointerEnter={() => setFocus(i)}
            onPointerLeave={() => setFocus(null)}
          >
            <span className="chat-block-swatch" aria-hidden="true" />
            <span className="chat-block-donut-label">{slice.title}</span>
            <span className="chat-block-donut-value">{format(slice.value)}</span>
            <span className="chat-block-donut-share">{total > 0 ? `${Math.round((slice.value / total) * 100)}%` : ""}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
