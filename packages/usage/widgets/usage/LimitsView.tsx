import { useCallback, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { QuotaPace, QuotaWindow } from "@polyth/contracts";
import { Button, EmptyState } from "../../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import {
  ARRANGE_LIST_LIFT_MS,
  useArrange,
  type ArrangeEngine,
  type ArrangeItem,
} from "../../../../apps/web/src/workspaceArrange.ts";
import {
  balanceValue,
  classifyLimitPace,
  formatLimitPaceBudget,
  formatLimitReset,
  limitBarColor,
  limitSourceName,
  measurableValue,
  mergeLimitSourceOrder,
  orderLimitSources,
  paceLabel,
  pacePressure,
  paceProjection,
  relativeTime,
  remainingFraction,
  splitWindowLabel,
  type LimitBarColorView,
} from "./limitsModel.ts";
import {
  isLimitSourceVisible,
  setLimitSourceOrder,
  sourceId,
  useUsageLimitsPrefs,
} from "./limitsPrefs.ts";
import { useUsageLimits, type UsageLimitSnapshotDto } from "./limitsClient.ts";

export { classifyLimitPace, formatLimitPaceBudget, formatLimitReset, pacePressure, paceProjection };

/** CSS custom properties a fill reads for its colour; `--usage-limit-color` is only set in static mode. */
const barStyle = (bar: LimitBarColorView): CSSProperties => {
  const style = {} as Record<string, string>;
  if (bar.pressure !== null) style["--usage-limit-pace"] = String(bar.pressure);
  if (bar.color) style["--usage-limit-color"] = `var(--usage-bar-${bar.color})`;
  return style as CSSProperties;
};

function LimitWindowRow({
  window,
  pace,
  now,
}: {
  window: QuotaWindow;
  pace: QuotaPace | null | undefined;
  now: number;
}) {
  const prefs = useUsageLimitsPrefs();
  const remaining = remainingFraction(window);
  const remainingPercent = remaining === null ? null : Math.round(remaining * 100);
  const usedPercent = remaining === null ? null : Math.round((1 - remaining) * 100);
  const { label } = splitWindowLabel(window.label);
  const value = measurableValue(window, prefs.displayMode);
  const reset = formatLimitReset(window.resetsAt, prefs.resetFormat, now);
  const state = classifyLimitPace(pace, window, prefs.paceSensitivity);
  const budget = pace ? formatLimitPaceBudget(pace) : null;
  const projection = prefs.showProjections && pace ? paceProjection(pace, window, now) : null;
  // The fill follows the bar-colour preference (`percent`, `pace` or a static
  // colour); the window itself stays neutral, so a low remaining share no
  // longer tints the whole row. The pace reading, shown as text, is unchanged.
  const bar = limitBarColor(window, pace, prefs);
  const paceEligible = window.resetsAt !== undefined && window.periodMs !== undefined;

  return (
    <div
      className="usage-limit-window"
      data-pace={bar.pressure === null ? "none" : undefined}
      data-color={bar.factor}
      style={barStyle(bar)}
    >
      <div className="usage-limit-window-head">
        <div>
          <strong>{label}</strong>
          {/* A measurable row's value and meter already carry the numbers; the
              sub-line only explains a row that has no meter to read. */}
          {usedPercent === null ? <small>{value.detail}</small> : null}
        </div>
        <span className="usage-limit-window-value">{value.primary}</span>
      </div>

      {usedPercent !== null ? (
        <div
          className="usage-limit-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={prefs.displayMode === "remaining" ? remainingPercent ?? 0 : usedPercent}
          aria-label={`${label}: ${value.primary}`}
        >
          <i style={{ width: `${usedPercent}%` }} />
        </div>
      ) : null}

      <div className="usage-limit-window-meta">
        {reset ? <span>{tr("usage.limitResetsWhen", { when: reset })}</span> : <span>{tr("usage.limitNoReset")}</span>}
        {prefs.showPace && paceEligible ? (
          state && pace ? (
            <span className={`usage-limit-pace ${state}`}>
              {paceLabel(state)}
              {budget ? ` · ${budget}` : ""}
              {projection ? ` · ${projection}` : ""}
            </span>
          ) : (
            <span className="usage-limit-pace unavailable">{pace ? tr("usage.paceCollecting") : tr("usage.paceUnavailable")}</span>
          )
        ) : null}
      </div>
    </div>
  );
}

function ProviderCard({
  provider,
  now,
  onRefresh,
  arrangeId,
  engine,
  held,
  reorderable,
  onMove,
}: {
  provider: UsageLimitSnapshotDto;
  now: number;
  onRefresh(providerId: string): Promise<void>;
  arrangeId: string;
  engine: ArrangeEngine;
  held: boolean;
  reorderable: boolean;
  onMove(id: string, delta: -1 | 1): void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const label = limitSourceName(provider);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh(provider.providerId);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section
      className={`usage-limit-provider${reorderable ? " is-reorderable" : ""}${provider.stale ? " stale" : ""}${held ? " is-arrange-held" : ""}`}
      data-source-id={arrangeId}
      tabIndex={reorderable ? 0 : undefined}
      aria-keyshortcuts={reorderable ? "Alt+Shift+ArrowUp Alt+Shift+ArrowDown" : undefined}
      onKeyDown={(event) => {
        // Same shortcut the navigator's project rows use, so a panel moves
        // without a pointer.
        if (!reorderable || event.target !== event.currentTarget) return;
        if (!event.altKey || !event.shiftKey) return;
        if (event.key === "ArrowUp") {
          event.preventDefault();
          onMove(arrangeId, -1);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          onMove(arrangeId, 1);
        }
      }}
      {...engine.itemProps(arrangeId)}
    >
      <header className="usage-limit-provider-head">
        <div className="usage-limit-provider-copy">
          <h3>{label}</h3>
          <p>
            {provider.accountLabel ? <span>{provider.accountLabel}</span> : null}
            {provider.fetchedAt > 0 ? <span>{tr("usage.limitUpdatedWhen", { when: relativeTime(provider.fetchedAt, now) })}</span> : <span>{tr("usage.limitNotFetched")}</span>}
            {provider.stale ? <span className="usage-limit-stale">{tr("usage.limitStale")}</span> : null}
          </p>
        </div>
        <div className="usage-limit-provider-actions" data-arrange-control="">
          <Button size="sm" variant="quiet" busy={refreshing} onClick={() => void refresh()}>
            {tr("usage.limitRefresh")}
          </Button>
        </div>
      </header>

      {provider.error ? (
        <div className="usage-limit-source-error" role="status">{provider.error.message}</div>
      ) : null}

      {provider.balances.length ? (
        <div className="usage-limit-balances">
          {provider.balances.map((balance) => (
            <div className="usage-limit-balance" key={balance.id}>
              <span>{balance.label}</span>
              <strong>{balanceValue(balance)}</strong>
            </div>
          ))}
        </div>
      ) : null}

      {provider.windows.length ? (
        <div className="usage-limit-windows">
          {provider.windows.map((window) => (
            <LimitWindowRow
              key={window.id}
              window={window}
              pace={provider.pace?.[window.id]}
              now={now}
            />
          ))}
        </div>
      ) : provider.balances.length === 0 ? (
        <div className="usage-limit-empty">{tr("usage.limitNoWindows")}</div>
      ) : null}
    </section>
  );
}

function SummaryStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="usage-limit-summary-stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

export function LimitsView(): ReactNode {
  const limits = useUsageLimits();
  const prefs = useUsageLimitsPrefs();
  const now = Date.now();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const allOrdered = useMemo(
    () => orderLimitSources(limits.providers, prefs.sourceOrder),
    [limits.providers, prefs.sourceOrder],
  );
  const visible = useMemo(
    () => allOrdered.filter((provider) => isLimitSourceVisible(provider.providerId, prefs)),
    [allOrdered, prefs],
  );
  const arrangeItems = useMemo<ArrangeItem[]>(
    () => visible.map((provider) => ({ id: sourceId(provider.providerId), shape: "row" })),
    [visible],
  );
  const commitOrder = useCallback((next: readonly string[], id: string) => {
    const visibleBefore = visible.map((provider) => sourceId(provider.providerId));
    // Hidden panels keep their slots: showing one again returns it where it was.
    setLimitSourceOrder(mergeLimitSourceOrder(
      allOrdered.map((provider) => sourceId(provider.providerId)),
      visibleBefore,
      next,
    ));
    const moved = allOrdered.find((provider) => sourceId(provider.providerId) === id);
    setAnnouncement(tr("usage.blockMoved", {
      block: moved ? limitSourceName(moved) : id,
      position: next.indexOf(id) + 1,
      count: next.length,
    }));
  }, [allOrdered, visible]);
  const arrange = useArrange({
    items: arrangeItems,
    enabled: visible.length > 1,
    // A still press lifts a panel, exactly like a project row in the navigator;
    // a tap or a scroll still belongs to the page.
    touchLiftMs: ARRANGE_LIST_LIFT_MS,
    scroller: () => listRef.current?.closest<HTMLElement>(".usage-clean") ?? listRef.current,
    ghostHost: () => listRef.current,
    onCommit: (next, id) => commitOrder(next, id),
  });
  const moveSourceBy = (id: string, delta: -1 | 1) => {
    const shown = visible.map((provider) => sourceId(provider.providerId));
    const index = shown.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= shown.length) return;
    [shown[index], shown[target]] = [shown[target]!, shown[index]!];
    arrange.engine.animateNextLayout();
    commitOrder(shown, id);
  };
  const listElement = useCallback((element: HTMLDivElement | null) => {
    listRef.current = element;
    arrange.engine.listRef(element);
  }, [arrange.engine]);
  const shownProviders = useMemo(() => {
    if (!arrange.draggingId) return visible;
    const byId = new Map(visible.map((provider) => [sourceId(provider.providerId), provider]));
    return arrange.order.flatMap((id) => byId.get(id) ?? []);
  }, [arrange.draggingId, arrange.order, visible]);

  const summary = useMemo(() => {
    const measurable = visible.flatMap((provider) =>
      provider.windows.flatMap((window) => {
        const remaining = remainingFraction(window);
        return remaining === null
          ? []
          : [{ provider, window, remaining, pace: provider.pace?.[window.id] }];
      }));
    const lowest = [...measurable].sort((a, b) => a.remaining - b.remaining)[0];
    const resets = visible.flatMap((provider) => provider.windows
      .filter((window) => typeof window.resetsAt === "number" && window.resetsAt > now)
      .map((window) => ({ provider, window })));
    const nextReset = resets.sort((a, b) => a.window.resetsAt! - b.window.resetsAt!)[0];
    const needsAttention = measurable.filter((row) => {
      const remainingPercent = row.remaining * 100;
      const state = classifyLimitPace(row.pace, row.window, prefs.paceSensitivity);
      return remainingPercent <= prefs.lowRemainingPercent
        || (prefs.paceWarnings && (state === "likely" || state === "exhausted"));
    }).length;
    return { lowest, nextReset, needsAttention };
  }, [visible, now, prefs.lowRemainingPercent, prefs.paceSensitivity, prefs.paceWarnings]);

  if (limits.loading && limits.providers.length === 0) {
    return <EmptyState variant="panel" title={tr("usage.limitsLoading")} description={tr("usage.limitsReading")} />;
  }

  if (limits.error && limits.providers.length === 0) {
    return (
      <EmptyState
        variant="panel"
        title={tr("usage.limitsUnavailable")}
        description={limits.error}
        actionLabel={tr("usage.limitsRetry")}
        onAction={limits.refresh}
      />
    );
  }

  return (
    <div className="usage-limits">
      <div className="usage-limits-intro">
        <div>
          <h2>{tr("usage.limits")}</h2>
          <p>{tr("usage.limitsIntro")}</p>
        </div>
        <Button size="sm" variant="quiet" busy={limits.refreshing} onClick={limits.refresh}>
          {tr("usage.limitRefreshAll")}
        </Button>
      </div>

      {limits.error ? (
        <div className="usage-limit-source-error" role="status">
          {tr("usage.limitsRefreshFailed", { error: limits.error })}
        </div>
      ) : null}

      <div className="usage-limit-summary">
        <SummaryStat label={tr("usage.limitsSummarySources")} value={String(visible.length)} />
        <SummaryStat
          label={tr("usage.limitsSummaryLowest")}
          value={summary.lowest ? `${Math.round(summary.lowest.remaining * 100)}%` : "—"}
          detail={summary.lowest ? limitSourceName(summary.lowest.provider) : undefined}
        />
        <SummaryStat
          label={tr("usage.limitsSummaryNextReset")}
          value={summary.nextReset?.window.resetsAt ? relativeTime(summary.nextReset.window.resetsAt, now) : "—"}
          detail={summary.nextReset ? limitSourceName(summary.nextReset.provider) : undefined}
        />
        <SummaryStat
          label={tr("usage.limitsSummaryAttention")}
          value={String(summary.needsAttention)}
          detail={tr(prefs.paceWarnings ? "usage.limitsAttentionBoth" : "usage.limitsAttentionLow")}
        />
      </div>

      {visible.length ? (
        <div
          ref={listElement}
          className="usage-limit-provider-list"
          data-arranging={arrange.draggingId ? "" : undefined}
        >
          {shownProviders.map((provider) => {
            const arrangeId = sourceId(provider.providerId);
            return (
              <ProviderCard
                key={provider.providerId}
                provider={provider}
                now={now}
                onRefresh={limits.refreshProvider}
                arrangeId={arrangeId}
                engine={arrange.engine}
                held={arrange.draggingId === arrangeId}
                reorderable={visible.length > 1}
                onMove={moveSourceBy}
              />
            );
          })}
        </div>
      ) : (
        <EmptyState
          variant="panel"
          title={tr(limits.providers.length ? "usage.limitsAllHidden" : "usage.limitsNoneDetected")}
          description={tr(limits.providers.length ? "usage.limitsEnableSource" : "usage.limitsWillShow")}
        />
      )}

      <p className="sr-only" aria-live="polite">{announcement}</p>
    </div>
  );
}

export default LimitsView;
