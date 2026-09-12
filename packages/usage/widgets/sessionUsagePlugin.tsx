import type {
  ContextWindowState,
  JsonObject,
  RuntimeFeaturesDto,
  SessionEvent,
  TokenUsage,
} from "@polyth/contracts";
import { fmtCost, fmtTokens } from "../../../apps/web/src/format.ts";
import { useActiveModel, useStore } from "../../../apps/web/src/store.ts";
import {
  buildModel,
  contextGaugeForTelemetry,
  contextTelemetryStatus,
  formatContextPercent,
  type ContextTelemetryStatus,
  type RenderModel,
} from "../../../apps/web/src/reduce.ts";
import type {
  WidgetPlugin,
  WidgetRenderContext,
} from "../../../apps/web/src/widgets/catalog.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  USAGE_WIDGET_PLUGIN as BASE_USAGE_WIDGET_PLUGIN,
  usageMetricVisible,
} from "./usagePlugin.tsx";

const NO_EVENTS: SessionEvent[] = [];

type UsageTelemetryStatus =
  | NonNullable<RuntimeFeaturesDto["telemetry"]>["usage"]["status"]
  | "unknown";

interface UsageMetricRow {
  id: string;
  label: string;
  value: string;
  detail?: string;
  meter?: number;
  level?: string;
}

const finiteNonNegative = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

export function latestContextWindow(events: readonly SessionEvent[]): ContextWindowState | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "context/updated") continue;
    const candidate = event.data as unknown as Partial<ContextWindowState>;
    if (candidate.source !== "native"
      && candidate.source !== "derived"
      && candidate.source !== "estimated"
      && candidate.source !== "unknown") continue;
    return {
      source: candidate.source,
      updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : event.time,
      ...(typeof candidate.limitTokens === "number" ? { limitTokens: candidate.limitTokens } : {}),
      ...(typeof candidate.usedTokens === "number" ? { usedTokens: candidate.usedTokens } : {}),
      ...(typeof candidate.remainingTokens === "number" ? { remainingTokens: candidate.remainingTokens } : {}),
      ...(typeof candidate.fraction === "number" ? { fraction: candidate.fraction } : {}),
      ...(candidate.compaction ? { compaction: candidate.compaction } : {}),
      ...(typeof candidate.harnessId === "string" ? { harnessId: candidate.harnessId } : {}),
      ...(typeof candidate.generation === "number" ? { generation: candidate.generation } : {}),
    };
  }
  return null;
}

function newestContextWindow(
  first: ContextWindowState | null | undefined,
  second: ContextWindowState | null | undefined,
): ContextWindowState | null {
  if (!first) return second ?? null;
  if (!second) return first;
  return second.updatedAt >= first.updatedAt ? second : first;
}

export function sessionUsageTotals(
  model: Pick<RenderModel, "totals">,
  tokenTotals: TokenUsage | undefined,
  costTotal: number | undefined,
  usageTelemetry: UsageTelemetryStatus,
) {
  const source = tokenTotals ?? model.totals;
  const input = finiteNonNegative(source.input);
  const output = finiteNonNegative(source.output);
  const modelHasUsage = model.totals.input > 0
    || model.totals.output > 0
    || model.totals.reasoning > 0
    || model.totals.cacheRead > 0
    || model.totals.cacheWrite > 0;
  const tokensKnown = tokenTotals !== undefined || modelHasUsage || usageTelemetry === "reported";
  const resolvedCost = typeof costTotal === "number" ? costTotal : model.totals.cost;
  const cost = finiteNonNegative(resolvedCost);
  const costKnown = typeof costTotal === "number" || model.totals.cost > 0;
  return { input, output, total: input + output, cost, tokensKnown, costKnown };
}

export function SessionUsageStats({
  model,
  contextTokens,
  contextWindow = null,
  contextTelemetry = "unknown",
  usageTelemetry = "unknown",
  tokenTotals,
  costTotal,
  config,
}: {
  model: Pick<RenderModel, "contextUsage" | "totals">;
  contextTokens?: number;
  contextWindow?: ContextWindowState | null;
  contextTelemetry?: ContextTelemetryStatus;
  usageTelemetry?: UsageTelemetryStatus;
  tokenTotals?: TokenUsage;
  costTotal?: number;
  config: Readonly<JsonObject>;
}) {
  const totals = sessionUsageTotals(model, tokenTotals, costTotal, usageTelemetry);
  const gauge = contextGaugeForTelemetry(model, contextTokens, contextWindow, contextTelemetry);
  const contextPercent = formatContextPercent(gauge);
  const rows: UsageMetricRow[] = [];

  if (usageMetricVisible(config, "showContext")) {
    rows.push({
      id: "context",
      label: tr("widgets.usageplugin.context"),
      value: contextPercent ?? tr("railsurfaces.unknown"),
      ...(gauge.known
        ? { detail: `${fmtTokens(gauge.inputTokens)} / ${fmtTokens(gauge.contextTokens)}` }
        : {}),
      ...(gauge.percent !== null && (gauge.known || gauge.quality === "fraction")
        ? { meter: gauge.percent, level: gauge.level }
        : {}),
    });
  }
  if (usageMetricVisible(config, "showInput")) {
    rows.push({
      id: "input",
      label: tr("widgets.usageplugin.input"),
      value: totals.tokensKnown ? fmtTokens(totals.input) : "—",
    });
  }
  if (usageMetricVisible(config, "showOutput")) {
    rows.push({
      id: "output",
      label: tr("widgets.usageplugin.output"),
      value: totals.tokensKnown ? fmtTokens(totals.output) : "—",
    });
  }
  if (usageMetricVisible(config, "showTotal")) {
    rows.push({
      id: "total",
      label: tr("widgets.usageplugin.total"),
      value: totals.tokensKnown ? fmtTokens(totals.total) : "—",
    });
  }
  if (usageMetricVisible(config, "showCost")) {
    rows.push({
      id: "cost",
      label: tr("widgets.usageplugin.cost"),
      value: totals.costKnown ? fmtCost(totals.cost) : "—",
    });
  }

  return (
    <div className="usage-session-widget">
      <div className={`usage-widget-stat-grid usage-session-stats${totals.tokensKnown ? "" : " usage-session-stats-partial"}`}>
        {rows.map((row) => (
          <div key={row.id} data-usage-metric={row.id}>
            <span>{row.label}</span>
            <strong>{row.value}</strong>
            {row.detail && <small>{row.detail}</small>}
            {row.meter !== undefined && (
              <div className={`usage-context-meter ${row.level ?? ""}`} aria-hidden="true">
                <i style={{ width: `${row.meter}%` }} />
              </div>
            )}
          </div>
        ))}
        {rows.length === 0 && <div className="widget-empty">{tr("widgets.usageplugin.chooseMetricsInWidgetSettings")}</div>}
      </div>
    </div>
  );
}

function SessionUsageWidget({ config, sessionId }: WidgetRenderContext) {
  const activeSessionId = useStore((state) => state.activeSessionId);
  const resolvedSessionId = sessionId ?? activeSessionId;
  const activeRenderModel = useActiveModel();
  const events = useStore((state) =>
    (resolvedSessionId ? state.events[resolvedSessionId] : undefined) ?? NO_EVENTS);
  const model = resolvedSessionId === activeSessionId ? activeRenderModel : buildModel(events);
  const models = useStore((state) => state.models);
  const session = useStore((state) =>
    state.sessions.find((item) => item.id === resolvedSessionId) ?? null);
  const runtimeFeatures = useStore((state) =>
    resolvedSessionId ? state.runtimeFeatures[resolvedSessionId] : undefined);

  const modelRef = model.contextUsage?.model ?? model.turn?.model ?? session?.model;
  const descriptor = modelRef
    ? models.find((candidate) =>
        candidate.providerID === modelRef.providerID && candidate.modelID === modelRef.modelID)
    : undefined;

  const eventContextWindow = latestContextWindow(events);
  const liveContextWindow = newestContextWindow(runtimeFeatures?.contextWindow, eventContextWindow)
    ?? session?.contextWindow
    ?? null;
  const runtimeContextStatus = contextTelemetryStatus(runtimeFeatures?.telemetry);
  const contextStatus: ContextTelemetryStatus = liveContextWindow?.source
    && liveContextWindow.source !== "unknown"
    ? "reported"
    : runtimeContextStatus;
  const usageStatus: UsageTelemetryStatus = runtimeFeatures?.telemetry?.usage.status ?? "unknown";

  return <SessionUsageStats
    model={model}
    contextTokens={descriptor?.context}
    contextWindow={liveContextWindow}
    contextTelemetry={contextStatus}
    usageTelemetry={usageStatus}
    tokenTotals={session?.tokenTotals}
    costTotal={session?.costTotal}
    config={config}
  />;
}

export const USAGE_WIDGET_PLUGIN: WidgetPlugin = {
  ...BASE_USAGE_WIDGET_PLUGIN,
  widgets: (BASE_USAGE_WIDGET_PLUGIN.widgets ?? []).map((widget) =>
    widget.id === "usage.session"
      ? { ...widget, render: (context) => <SessionUsageWidget {...context} /> }
      : widget),
};
