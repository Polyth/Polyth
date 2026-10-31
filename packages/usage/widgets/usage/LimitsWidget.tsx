import type { CSSProperties } from "react";
import type { SessionProjection } from "@polyth/contracts";
import type { WidgetRenderContext, WidgetSettingsContext } from "@polyth/web-sdk";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import { Checkbox, EmptyState, IconButton, RefreshIcon, Select } from "../../../../apps/web/src/components/ui/index.ts";
import { displayProvider } from "../../src/providerIdentity.ts";
import { Figure } from "./Figure.tsx";
import { useUsageLimits } from "./limitsClient.ts";
import { sourceId, useUsageLimitsPrefs } from "./limitsPrefs.ts";
import {
  LIMITS_WIDGET_STYLES,
  limitGroups,
  limitProviders,
  limitSourceName,
  limitsHarnessName,
  orderLimitSources,
  limitsWidgetPreferences,
  type LimitGroupView,
  type LimitRowView,
  type LimitsWidgetStyle,
} from "./limitsModel.ts";
import { usageWidgetCompact } from "./widgetPresentation.ts";

const SEGMENTS = 10;

const SOURCE_LABEL = {
  current: "usage.limitsSourceCurrent",
  selected: "usage.limitsSourceSelected",
  all: "usage.limitsSourceAll",
} as const;

const STYLE_LABEL = {
  bars: "usage.limitsStyleBars",
  pace: "usage.limitsStylePace",
  rings: "usage.limitsStyleRings",
  segments: "usage.limitsStyleSegments",
  chips: "usage.limitsStyleChips",
  table: "usage.limitsStyleTable",
  hero: "usage.limitsStyleHero",
} as const satisfies Record<LimitsWidgetStyle, string>;

type Item = { group: LimitGroupView; row: LimitRowView };
/** `compact` is the Workspace panel's glance: one line per window, the reset
 *  and the pace verdict move into the row's tooltip. */
interface ItemsProps { items: readonly Item[]; multi: boolean; showReset: boolean; compact: boolean }

/** The row's whole reading on hover, for the styles and sizes that leave part of it out. */
const rowTitle = (row: LimitRowView): string => [
  `${row.label}: ${row.value}${row.detail ? ` (${row.detail})` : ""}`,
  row.reset ? `Resets ${row.reset}` : null,
  row.pace?.text,
].filter(Boolean).join(" · ");
const resetText = (row: LimitRowView, showReset: boolean): string | null => (showReset && row.reset ? `Resets ${row.reset}` : null);
const itemLabel = ({ group, row }: Item, multi: boolean, separator: string): string => (multi ? `${group.name}${separator}${row.label}` : row.label);

// A source that reports no comparable cap is text only; it must not claim a meter value.
const meterAria = (row: LimitRowView) => row.fill === null ? {} : {
  role: "meter",
  "aria-label": row.label,
  "aria-valuemin": 0,
  "aria-valuemax": 100,
  "aria-valuenow": Math.round(row.fill * 100),
  "aria-valuetext": row.value,
};

/**
 * The fill's colour, following the bar-colour preference: `pace` and `percent`
 * feed the shared heat ramp from `--usage-limits-pace`, `static` pins the
 * chosen palette slot. A row without a usable reading stays neutral.
 */
const meterStyle = (row: LimitRowView): CSSProperties => {
  const style = {} as Record<string, string>;
  if (row.bar.pressure !== null) style["--usage-limits-pace"] = String(row.bar.pressure);
  if (row.bar.color) style["--usage-limits-static"] = `var(--usage-bar-${row.bar.color})`;
  return style as CSSProperties;
};

type RowsVariant = "bar" | "pace" | "segments";

function Meter({ row, variant }: { row: LimitRowView; variant: RowsVariant }) {
  if (row.fill === null) return null;
  const lit = Math.min(SEGMENTS, Math.ceil(row.fill * SEGMENTS - 1e-9));
  return <div
    className={`usage-limits-meter usage-limits-meter--${variant}`}
    data-bar={row.bar.factor}
    data-bar-tone={row.bar.pressure === null ? "none" : row.bar.tone}
    style={meterStyle(row)}
    {...meterAria(row)}
  >
    {variant === "segments"
      ? Array.from({ length: SEGMENTS }, (_, index) => <i key={index} data-on={index < lit} />)
      : <i style={{ inlineSize: `${row.fill * 100}%` }} />}
    {variant === "pace" && row.tick !== null ? <b aria-hidden="true" style={{ insetInlineStart: `${row.tick * 100}%` }} /> : null}
  </div>;
}

/**
 * Bars, pace bars and segments: one block per source, one row per window.
 * `merged` means the card heading already names the only source, so its own
 * heading is kept for assistive tech only.
 */
function Rows({ groups, showReset, variant, merged, compact }: {
  groups: readonly LimitGroupView[]; showReset: boolean; variant: RowsVariant; merged: boolean; compact: boolean;
}) {
  const ticked = !compact && variant === "pace" && groups.some((group) => group.rows.some((row) => row.fill !== null && row.tick !== null));
  const sections = groups.map((group) => <section className="usage-limits-group" key={group.providerId}>
    {merged
      ? <h3 className="sr-only"><span>{group.name}</span></h3>
      : <h3 title={group.account}><span>{group.name}</span>{group.account ? <small>{group.account}</small> : null}</h3>}
    <ul>{group.rows.map((row) => {
      // Compact: window, meter and value on one line, aligned across rows.
      if (compact) {
        return <li key={row.key} data-tone={row.tone} title={rowTitle(row)}>
          <span className="usage-limits-row-label">{row.label}</span>
          {row.fill === null ? <span className="usage-limits-meter-gap" aria-hidden="true" /> : <Meter row={row} variant={variant} />}
          <strong><bdi><Figure value={row.value} /></bdi></strong>
        </li>;
      }
      const reset = resetText(row, showReset);
      const pace = variant === "pace" ? row.pace : null;
      return <li key={row.key} data-tone={row.tone} title={rowTitle(row)}>
        <div className="usage-limits-row-head"><span>{row.label}</span><strong><bdi><Figure value={row.value} /></bdi></strong></div>
        <Meter row={row} variant={variant} />
        {reset || pace ? <div className="usage-limits-row-meta">
          {reset ? <span>{reset}</span> : null}
          {pace ? <span className="usage-limits-pace" title={pace.text}>{pace.brief}</span> : null}
        </div> : null}
      </li>;
    })}</ul>
  </section>);
  // Compact rows of every source share one grid, so their meters line up.
  if (compact) return <div className="usage-limits-rows">{sections}</div>;
  return <>{sections}{ticked ? <p className="usage-limits-legend">{tr("usage.limitsTickLegend")}</p> : null}</>;
}

/**
 * A gauge per window. A balance without a cap has no arc to draw: its value
 * sits inside a dashed ring. Under the ring the window, then quieter, its
 * source when there are several and its reset, which compact leaves to the
 * tooltip.
 */
function Rings({ items, multi, showReset, compact }: ItemsProps) {
  return <ul className="usage-limits-rings">{items.map((item) => {
    const { row, group } = item;
    return <li key={row.key} data-tone={row.tone} title={rowTitle(row)}>
      <div
        className="usage-limits-ring"
        data-bar={row.bar.factor}
        data-bar-tone={row.bar.pressure === null ? "none" : row.bar.tone}
        data-capless={row.fill === null || undefined}
        style={meterStyle(row)}
        {...meterAria(row)}
      >
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <circle cx="18" cy="18" r="16" />
          {row.fill ? <circle cx="18" cy="18" r="16" pathLength="100" strokeDasharray={`${row.fill * 100} 100`} /> : null}
        </svg>
        <strong><bdi>{row.short}</bdi></strong>
        {row.word && !compact ? <small>{row.word}</small> : null}
      </div>
      <span>{row.label}</span>
      {multi ? <small>{group.name}</small> : null}
      {showReset && row.reset && !compact ? <small>{row.reset}</small> : null}
    </li>;
  })}</ul>;
}

/** Standard: a tile per window, the reset under its name. Compact: one-line pills. */
function Chips({ items, multi, showReset, compact }: ItemsProps) {
  return <ul className="usage-limits-chips">{items.map((item) => {
    const { row } = item;
    return <li key={row.key} data-tone={row.tone} title={rowTitle(row)}>
      <i className="usage-limits-dot" aria-hidden="true" />
      <span>{itemLabel(item, multi, " ")}</span>
      <strong><bdi>{row.short}</bdi></strong>
      {row.word ? <small>{row.word}</small> : null}
      {showReset && row.reset && !compact ? <small className="usage-limits-reset">{row.reset}</small> : null}
    </li>;
  })}</ul>;
}

function Table({ items, multi, showReset: resetShown, compact }: ItemsProps) {
  const showReset = resetShown && !compact;
  const paced = !compact && items.some(({ row }) => row.pace);
  return <table className="usage-limits-table"><tbody>{items.map((item) => {
    const { row } = item;
    return <tr key={row.key} data-tone={row.tone} title={rowTitle(row)}>
      <th scope="row"><i className="usage-limits-dot" aria-hidden="true" />{itemLabel(item, multi, " · ")}</th>
      <td><bdi>{row.value}</bdi></td>
      {showReset ? <td className="usage-limits-col-reset">{row.reset ?? "—"}</td> : null}
      {paced ? <td className="usage-limits-col-pace">{row.pace?.label ?? "—"}</td> : null}
    </tr>;
  })}</tbody></table>;
}

/** The most constrained window in large type, every other window as a chip. */
function Hero({ items, multi, showReset, compact }: ItemsProps) {
  const measurable = items.filter(({ row }) => row.remaining !== null);
  const top = measurable.reduce((best, item) => ((item.row.remaining ?? 1) < (best.row.remaining ?? 1) ? item : best), measurable[0] ?? items[0]!);
  const rest = items.filter((item) => item !== top);
  const { row } = top;
  const detail = [resetText(row, showReset), row.pace?.label].filter(Boolean).join(" · ");
  // Compact: the figure leads the line, the window and its reset beside it.
  if (compact) {
    return <>
      <div className="usage-limits-hero" data-tone={row.tone} title={rowTitle(row)}>
        <strong><bdi><Figure value={row.value} /></bdi></strong>
        <div>
          <span><i className="usage-limits-dot" aria-hidden="true" />{itemLabel(top, multi, " · ")}</span>
          {detail ? <small>{detail}</small> : null}
        </div>
      </div>
      {rest.length ? <Chips items={rest} multi={multi} showReset={showReset} compact /> : null}
    </>;
  }
  return <>
    <div className="usage-limits-hero" data-tone={row.tone} title={rowTitle(row)}>
      <span><i className="usage-limits-dot" aria-hidden="true" />{itemLabel(top, multi, " · ")}</span>
      <strong><bdi>{row.short}</bdi></strong>
      {row.word ? <em>{row.word}</em> : null}
      {detail ? <small>{detail}</small> : null}
    </div>
    {rest.length ? <Chips items={rest} multi={multi} showReset={showReset} compact={false} /> : null}
  </>;
}

function LimitsBody({ style, groups, showReset, merged, compact }: {
  style: LimitsWidgetStyle; groups: readonly LimitGroupView[]; showReset: boolean; merged: boolean; compact: boolean;
}) {
  const items = groups.flatMap((group) => group.rows.map((row) => ({ group, row })));
  const props = { items, multi: groups.length > 1, showReset, compact };
  switch (style) {
    case "bars": return <Rows groups={groups} showReset={showReset} variant="bar" merged={merged} compact={compact} />;
    case "pace": return <Rows groups={groups} showReset={showReset} variant="pace" merged={merged} compact={compact} />;
    case "segments": return <Rows groups={groups} showReset={showReset} variant="segments" merged={merged} compact={compact} />;
    case "rings": return <Rings {...props} />;
    case "chips": return <Chips {...props} />;
    case "table": return <Table {...props} />;
    case "hero": return <Hero {...props} />;
  }
}

export function LimitsWidget({ session, config, editing, panelSize }: Pick<WidgetRenderContext, "config" | "editing" | "panelSize"> & {
  session: SessionProjection | null;
}) {
  const limits = useUsageLimits();
  const limitsPrefs = useUsageLimitsPrefs();
  const prefs = limitsWidgetPreferences(config);
  const current = prefs.source === "current";
  const shown = limitProviders(limits.providers, prefs, limitsPrefs, session);
  const groups = limitGroups(shown, limitsPrefs, Date.now(), current ? { id: session?.model?.modelID } : undefined);
  const filled = groups.filter((group) => group.rows.length > 0);
  const failed = groups.filter((group) => group.rows.length === 0 && group.error);
  const staleError = limits.error ?? filled.find((group) => group.stale)?.error;
  const stale = limits.error !== null || filled.some((group) => group.stale);
  const headline = current
    ? [session?.resolvedHarnessId ? limitsHarnessName(session.resolvedHarnessId, limits.providers) : "", session?.model?.modelID ?? ""].filter(Boolean).join(" · ")
    : prefs.source === "selected" ? shown.map(limitSourceName).join(", ") : "";

  const unavailable = limits.error !== null && limits.providers.length === 0;
  const empty: { title: string; description?: string; retry?: boolean } | null =
    limits.loading && limits.providers.length === 0 ? { title: tr("usage.limitsLoading") }
    : unavailable ? { title: tr("usage.limitsUnavailable"), description: limits.error ?? "", retry: true }
    : groups.length > 0 ? null
    : current
      ? session
        ? { title: tr("usage.limitsNoCurrent", { name: headline || session.title }) }
        : { title: tr("usage.noActiveSession"), description: tr("usage.openSessionToInspect") }
      : { title: tr("usage.limitsNoSources"), description: tr(prefs.source === "selected" ? "usage.limitsChooseSources" : "usage.limitsNoSourcesDescription") };

  // One source under a harness/model headline: the headline already names it,
  // so the plan moves up beside it instead of repeating the source as a heading.
  const merged = !!headline && filled.length === 1 && failed.length === 0;
  const plan = merged ? filled[0]!.account : undefined;
  const compact = usageWidgetCompact(panelSize);

  return <div className="usage-limits-widget" data-style={prefs.style} data-compact={compact || undefined} aria-busy={limits.loading || limits.refreshing}>
    <div className="usage-widget-scroll" role="region" tabIndex={0} aria-label={tr("usage.limitsWidgetTitle")}>
      <div className="usage-widget-content">
        <header className="usage-widget-heading">
          <div><span className={headline ? "sr-only" : undefined}>{tr(SOURCE_LABEL[prefs.source])}</span>{headline ? <strong title={headline}>{headline}</strong> : null}</div>
          {plan ? <span className="usage-limits-plan" title={plan}>{plan}</span> : null}
          {!editing ? <IconButton icon={RefreshIcon} size="sm" variant="quiet" label={tr("usage.limitsRefresh")}
            busy={limits.refreshing} onClick={limits.refresh} /> : null}
        </header>
        {empty ? <div className="usage-widget-state" role="status">
          <EmptyState variant="compact" title={empty.title}
            {...(empty.description ? { description: empty.description } : {})}
            {...(empty.retry && !editing ? { actionLabel: tr("usage.retry"), onAction: limits.refresh } : {})} />
        </div> : null}
        {failed.map((group) => <div className="usage-widget-note" role="status" key={group.providerId}>
          <span>{group.name}: {group.error}</span>
        </div>)}
        {filled.length > 0 ? <LimitsBody style={prefs.style} groups={filled} showReset={prefs.showReset} merged={merged} compact={compact} /> : null}
        {stale && filled.length > 0 ? <div className="usage-widget-note" role="status">
          <span title={staleError}>{tr("usage.showingLastSuccessfulReport")}</span>
        </div> : null}
      </div>
    </div>
  </div>;
}

export function LimitsWidgetSettings({ config, updateConfig }: WidgetSettingsContext) {
  const prefs = limitsWidgetPreferences(config);
  const limits = useUsageLimits();
  const update = (patch: Record<string, string | boolean | string[]>) => updateConfig({ ...config, ...patch });
  // A source chosen earlier stays listed after it disappears, so it can still be unchecked.
  const ordered = orderLimitSources(limits.providers);
  const ids = [...new Set([...ordered.map((provider) => sourceId(provider.providerId)), ...prefs.sources])];
  const sourceLabel = (id: string): string => {
    const provider = ordered.find((entry) => sourceId(entry.providerId) === id);
    return provider ? limitSourceName(provider) : displayProvider(id) || id;
  };
  return <div className="usage-widget-settings">
    <label><span>{tr("usage.limitsShow")}</span><Select label={tr("usage.limitsShow")} value={prefs.source} onChange={(source) => update({ source })}
      options={(Object.keys(SOURCE_LABEL) as (keyof typeof SOURCE_LABEL)[]).map((value) => ({ value, label: tr(SOURCE_LABEL[value]) }))} /></label>
    {prefs.source === "selected" ? <fieldset>
      <legend>{tr("usage.limitSources")}</legend>
      {ids.map((id) => <Checkbox key={id} label={sourceLabel(id)} checked={prefs.sources.includes(id)}
        onChange={(on) => update({ sources: on ? [...prefs.sources, id] : prefs.sources.filter((source) => source !== id) })} />)}
    </fieldset> : null}
    <label><span>{tr("usage.limitsStyle")}</span><Select label={tr("usage.limitsStyle")} value={prefs.style} onChange={(style) => update({ style })}
      options={LIMITS_WIDGET_STYLES.map((value) => ({ value, label: tr(STYLE_LABEL[value]) }))} /></label>
    <Checkbox checked={prefs.showReset} onChange={(showReset) => update({ showReset })} label={tr("usage.limitsShowReset")} />
  </div>;
}
