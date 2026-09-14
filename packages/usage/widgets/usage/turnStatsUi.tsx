import { useEffect, useState, type ReactNode } from "react";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { fmtCost, fmtDuration, fmtMs, fmtTokens } from "../../../../apps/web/src/format.ts";
import { formatNumber, tr } from "../../../../apps/web/src/i18n/index.ts";
import { useActiveModel, useStore } from "../../../../apps/web/src/store.ts";
import { buildModel, type RenderModel } from "../../../../apps/web/src/reduce.ts";
import type { WidgetRenderContext, WidgetSettingsContext } from "../../../../apps/web/src/widgets/catalog.ts";
import { Checkbox } from "../../../../apps/web/src/components/ui/index.ts";
import {
  deriveTurnStats,
  TURN_STATS_UNKNOWN,
  type TurnStatsDerived,
  type TurnStatsVisibilityKey,
} from "./turnStatsData.ts";

const NO_EVENTS: SessionEvent[] = [];

export function turnStatsMetricVisible(
  config: Readonly<JsonObject>,
  metric: TurnStatsVisibilityKey,
): boolean {
  return config[metric] !== false;
}

function formatTokPerSec(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return TURN_STATS_UNKNOWN;
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `~${formatNumber(rounded)} tok/s`;
}

function formatToolDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return TURN_STATS_UNKNOWN;
  if (ms >= 60_000) return fmtDuration(ms);
  return fmtMs(ms);
}

interface TurnStatsRow {
  id: string;
  label: string;
  value: string;
  valueClassName?: string;
}

export function buildTurnStatsRows(
  stats: TurnStatsDerived,
  config: Readonly<JsonObject>,
): TurnStatsRow[] {
  const rows: TurnStatsRow[] = [];
  if (turnStatsMetricVisible(config, "showResponseRate")) {
    rows.push({
      id: "responseRate",
      label: tr("widgets.usageplugin.turnStatsResponse"),
      value: formatTokPerSec(stats.responseTokPerSec),
    });
  }
  if (turnStatsMetricVisible(config, "showWholeTurnRate")) {
    rows.push({
      id: "wholeTurnRate",
      label: tr("widgets.usageplugin.turnStatsWholeTurn"),
      value: formatTokPerSec(stats.wholeTurnTokPerSec),
    });
  }
  if (turnStatsMetricVisible(config, "showModelTime")) {
    rows.push({
      id: "modelTime",
      label: tr("widgets.usageplugin.turnStatsModelTime"),
      value: stats.modelTimeMs === null ? TURN_STATS_UNKNOWN : fmtMs(stats.modelTimeMs),
    });
  }
  if (turnStatsMetricVisible(config, "showToolTime")) {
    rows.push({
      id: "toolTime",
      label: tr("widgets.usageplugin.turnStatsToolTime"),
      value: stats.toolTimeMs === null ? TURN_STATS_UNKNOWN : formatToolDurationMs(stats.toolTimeMs),
    });
  }
  if (turnStatsMetricVisible(config, "showAvgTtft")) {
    rows.push({
      id: "avgTtft",
      label: tr("widgets.usageplugin.turnStatsAvgTtft"),
      value: stats.avgTtftMs === null ? TURN_STATS_UNKNOWN : fmtMs(stats.avgTtftMs),
    });
  }
  if (turnStatsMetricVisible(config, "showSteps")) {
    rows.push({
      id: "steps",
      label: tr("widgets.usageplugin.turnStatsSteps"),
      value: stats.steps === null ? TURN_STATS_UNKNOWN : formatNumber(stats.steps),
    });
  }
  if (turnStatsMetricVisible(config, "showTokens")) {
    rows.push({
      id: "tokens",
      label: tr("widgets.usageplugin.tokens"),
      value: stats.tokensKnown && stats.inputTokens !== null && stats.outputTokens !== null
        ? `${fmtTokens(stats.inputTokens)} ↑ · ${fmtTokens(stats.outputTokens)} ↓`
        : TURN_STATS_UNKNOWN,
    });
  }
  if (turnStatsMetricVisible(config, "showCache")) {
    rows.push({
      id: "cache",
      label: tr("widgets.usageplugin.turnStatsCache"),
      value: stats.cachePercent === null ? TURN_STATS_UNKNOWN : `${Math.round(stats.cachePercent)}%`,
      ...(stats.cachePercent !== null ? { valueClassName: "usage-turn-stats-good" } : {}),
    });
  }
  if (turnStatsMetricVisible(config, "showCost")) {
    rows.push({
      id: "cost",
      label: tr("widgets.usageplugin.cost"),
      value: stats.costKnown && stats.cost !== null ? fmtCost(stats.cost) : TURN_STATS_UNKNOWN,
    });
  }
  return rows;
}

export function TurnStatsView({
  model,
  config,
  now,
}: {
  model: Pick<RenderModel, "turn" | "messages">;
  config: Readonly<JsonObject>;
  now?: number;
}) {
  if (!model.turn) {
    return (
      <div className="usage-turn-stats">
        <div className="usage-inline-empty">
          <strong>{tr("widgets.usageplugin.turnStatsAppearAfterRun")}</strong>
        </div>
      </div>
    );
  }
  const stats = deriveTurnStats(model.turn, model.messages, now);
  const rows = buildTurnStatsRows(stats, config);
  if (rows.length === 0) {
    return (
      <div className="usage-turn-stats">
        <div className="usage-inline-empty">
          <strong>{tr("widgets.usageplugin.chooseMetricsInWidgetSettings")}</strong>
        </div>
      </div>
    );
  }
  return (
    <div className="usage-turn-stats">
      <div className="usage-widget-stat-grid usage-turn-stats-grid">
        {rows.map((row) => (
          <div key={row.id} data-turn-stat={row.id}>
            <span>{row.label}</span>
            <strong className={row.valueClassName}>{row.value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

const TURN_STATS_METRICS: ReadonlyArray<{ id: TurnStatsVisibilityKey; label: string }> = [
  { id: "showResponseRate", label: tr("widgets.usageplugin.turnStatsResponse") },
  { id: "showWholeTurnRate", label: tr("widgets.usageplugin.turnStatsWholeTurn") },
  { id: "showModelTime", label: tr("widgets.usageplugin.turnStatsModelTime") },
  { id: "showToolTime", label: tr("widgets.usageplugin.turnStatsToolTime") },
  { id: "showAvgTtft", label: tr("widgets.usageplugin.turnStatsAvgTtft") },
  { id: "showSteps", label: tr("widgets.usageplugin.turnStatsSteps") },
  { id: "showCache", label: tr("widgets.usageplugin.turnStatsCache") },
  { id: "showTokens", label: tr("widgets.usageplugin.tokens") },
  { id: "showCost", label: tr("widgets.usageplugin.cost") },
];

export const TURN_STATS_SETTINGS_SCHEMA = {
  type: "object",
  properties: {
    showResponseRate: { type: "boolean", title: tr("widgets.usageplugin.turnStatsResponse"), default: true },
    showWholeTurnRate: { type: "boolean", title: tr("widgets.usageplugin.turnStatsWholeTurn"), default: true },
    showModelTime: { type: "boolean", title: tr("widgets.usageplugin.turnStatsModelTime"), default: true },
    showToolTime: { type: "boolean", title: tr("widgets.usageplugin.turnStatsToolTime"), default: true },
    showAvgTtft: { type: "boolean", title: tr("widgets.usageplugin.turnStatsAvgTtft"), default: true },
    showSteps: { type: "boolean", title: tr("widgets.usageplugin.turnStatsSteps"), default: true },
    showTokens: { type: "boolean", title: tr("widgets.usageplugin.tokens"), default: true },
    showCache: { type: "boolean", title: tr("widgets.usageplugin.turnStatsCache"), default: true },
    showCost: { type: "boolean", title: tr("widgets.usageplugin.cost"), default: true },
  },
} as const;

function TurnStatsWidgetSettings({ config, updateConfig }: WidgetSettingsContext) {
  return (
    <div className="widget-schema-settings" aria-label={tr("widgets.usageplugin.turnStatsMetrics")}>
      {TURN_STATS_METRICS.map((metric) => (
        <Checkbox
          key={metric.id}
          checked={turnStatsMetricVisible(config, metric.id)}
          onChange={(checked) => updateConfig({ ...config, [metric.id]: checked })}
          label={metric.label}
        />
      ))}
    </div>
  );
}

function TurnStatsWidget({ config, sessionId }: WidgetRenderContext) {
  const activeSessionId = useStore((state) => state.activeSessionId);
  const resolvedSessionId = sessionId ?? activeSessionId;
  const activeRenderModel = useActiveModel();
  const events = useStore((state) =>
    (resolvedSessionId ? state.events[resolvedSessionId] : undefined) ?? NO_EVENTS);
  const model = resolvedSessionId === activeSessionId ? activeRenderModel : buildModel(events);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!resolvedSessionId || model.turn?.status !== "working") return;
    const tick = () => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [resolvedSessionId, model.turn?.turnId, model.turn?.status]);

  if (!resolvedSessionId) {
    return (
      <div className="usage-turn-stats">
        <div className="usage-inline-empty">
          <strong>{tr("widgets.usageplugin.chooseASessionForUsage")}</strong>
        </div>
      </div>
    );
  }
  return <TurnStatsView model={model} config={config} now={now} />;
}

export function turnStatsWidgetRender(context: WidgetRenderContext): ReactNode {
  return <TurnStatsWidget {...context} />;
}

export function turnStatsWidgetSettingsRender(context: WidgetSettingsContext): ReactNode {
  return <TurnStatsWidgetSettings {...context} />;
}
