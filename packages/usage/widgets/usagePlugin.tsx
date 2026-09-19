import { useMemo, useState, type ReactNode } from "react";
import type { JsonObject } from "@polyth/contracts";
import { fmtCost, fmtTokens } from "../../../apps/web/src/format.ts";
import { useActiveModel, useStore } from "../../../apps/web/src/store.ts";
import { contextGauge, type RenderModel } from "../../../apps/web/src/reduce.ts";
import {
  ProviderUsageDonut,
  projectUsageStats,
  sessionTokens,
  topProjectSessions,
  type SessionUsageSort,
} from "./usage/projectUi.tsx";
import { useQuotaSnapshots } from "./usage/quotaUi.tsx";
import ProviderLogo from "../../models/widgets/ProviderLogo.tsx";
import { useUsagePrefs } from "./usagePrefs.ts";
import { USAGE_WIDGETS } from "./catalog.ts";
import {
  defineWidgetPlugin,
  registerWidgetPlugin,
  type PluginWidgetDef,
  type WidgetRenderContext,
  type WidgetSettingsContext,
} from "../../../apps/web/src/widgets/catalog.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Checkbox, Select } from "../../../apps/web/src/components/ui/index.ts";
import {
  TURN_STATS_SETTINGS_SCHEMA,
  turnStatsWidgetRender,
  turnStatsWidgetSettingsRender,
} from "./usage/turnStatsUi.tsx";
import {
  UsageAnalyticsWidgetView,
  UsageQuotasBlock,
  scopeFromWidget,
  type UsageAnalyticsWidgetKind,
} from "./usage/analyticsPresentation.tsx";

export type SessionUsageMetric =
  | "showContext"
  | "showCost"
  | "showInput"
  | "showOutput"
  | "showTotal";

interface UsageMetricRow {
  id: string;
  label: string;
  value: string;
  detail?: string;
}

const SESSION_USAGE_METRICS: ReadonlyArray<{ id: SessionUsageMetric; label: string }> = [
  { id: "showContext", label: tr("widgets.usageplugin.contextWindow") },
  { id: "showCost", label: tr("widgets.usageplugin.sessionCost") },
  { id: "showInput", label: tr("widgets.usageplugin.inputTokens") },
  { id: "showOutput", label: tr("widgets.usageplugin.outputTokens") },
  { id: "showTotal", label: tr("widgets.usageplugin.totalTokens") },
];

const SESSION_USAGE_SETTINGS = {
  type: "object",
  properties: {
    showContext: { type: "boolean", title: tr("widgets.usageplugin.contextWindow"), default: true },
    showCost: { type: "boolean", title: tr("widgets.usageplugin.sessionCost"), default: true },
    showInput: { type: "boolean", title: tr("widgets.usageplugin.inputTokens"), default: true },
    showOutput: { type: "boolean", title: tr("widgets.usageplugin.outputTokens"), default: true },
    showTotal: { type: "boolean", title: tr("widgets.usageplugin.totalTokens"), default: true },
  },
} as const;

export function usageMetricVisible(config: Readonly<JsonObject>, metric: SessionUsageMetric): boolean {
  return config[metric] !== false;
}

export function SessionUsageStats({
  model,
  contextTokens,
  config,
}: {
  model: Pick<RenderModel, "contextUsage" | "totals">;
  contextTokens?: number;
  config: Readonly<JsonObject>;
}) {
  const total = model.totals.input + model.totals.output;
  const gauge = contextGauge(model, contextTokens);
  const rows: UsageMetricRow[] = [];
  if (usageMetricVisible(config, "showContext")) {
    rows.push({
      id: "context",
      label: tr("widgets.usageplugin.context"),
      value: gauge.known ? `${gauge.percent}%` : tr("railsurfaces.unknown"),
      ...(gauge.known
        ? { detail: `${fmtTokens(gauge.inputTokens)} / ${fmtTokens(gauge.contextTokens)}` }
        : {}),
    });
  }
  if (usageMetricVisible(config, "showInput")) {
    rows.push({ id: "input", label: tr("widgets.usageplugin.input"), value: fmtTokens(model.totals.input) });
  }
  if (usageMetricVisible(config, "showOutput")) {
    rows.push({ id: "output", label: tr("widgets.usageplugin.output"), value: fmtTokens(model.totals.output) });
  }
  if (usageMetricVisible(config, "showTotal")) {
    rows.push({ id: "total", label: tr("widgets.usageplugin.total"), value: fmtTokens(total) });
  }
  if (usageMetricVisible(config, "showCost")) {
    rows.push({
      id: "cost",
      label: tr("widgets.usageplugin.cost"),
      value: model.totals.cost > 0 ? fmtCost(model.totals.cost) : "—",
    });
  }
  return (
    <div className="usage-widget-stat-grid usage-session-stats">
      {rows.map((row) => (
        <div key={row.id} data-usage-metric={row.id}>
          <span>{row.label}</span>
          <strong>{row.value}</strong>
          {row.detail && <small>{row.detail}</small>}
        </div>
      ))}
      {rows.length === 0 && <div className="widget-empty">{tr("widgets.usageplugin.chooseMetricsInWidgetSettings")}</div>}
    </div>
  );
}

function SessionUsageWidget({ config }: WidgetRenderContext) {
  const model = useActiveModel();
  const models = useStore((state) => state.models);
  const session = useStore((state) =>
    state.sessions.find((item) => item.id === state.activeSessionId) ?? null);
  const activeModel = model.contextUsage?.model ?? model.turn?.model ?? session?.model;
  const descriptor = activeModel
    ? models.find((candidate) =>
        candidate.providerID === activeModel.providerID && candidate.modelID === activeModel.modelID)
    : undefined;
  return <SessionUsageStats model={model} contextTokens={descriptor?.context} config={config} />;
}

function ProjectUsageWidget({ projectId }: { projectId: string | null }) {
  const sessions = useStore((state) => state.sessions);
  const mine = sessions.filter((session) => session.projectId === projectId);
  const totals = projectUsageStats(mine);
  if (!projectId) return <div className="widget-empty">{tr("widgets.usageplugin.chooseAProjectToSeeUsage")}</div>;
  if (mine.length === 0) return <div className="widget-empty">{tr("widgets.usageplugin.usageAppearsOnceSessionsRunInThis")}</div>;
  return (
    <div className="usage-widget-panel">
      <div className="usage-widget-stat-grid">
        <div><span>{tr("widgets.usageplugin.cost")}</span><strong>{totals.cost > 0 ? fmtCost(totals.cost) : "—"}</strong></div>
        <div><span>{tr("widgets.usageplugin.tokens")}</span><strong>{fmtTokens(totals.tokens)}</strong></div>
        <div><span>{tr("widgets.usageplugin.sessions")}</span><strong>{totals.sessions}</strong></div>
      </div>
      <ProviderUsageDonut sessions={mine} />
    </div>
  );
}

function SessionsTableWidget({ projectId }: { projectId: string | null }) {
  const sessions = useStore((state) => state.sessions);
  const [sort, setSort] = useState<SessionUsageSort>("cost");
  const mine = sessions.filter((session) => session.projectId === projectId);
  const top = topProjectSessions(mine, sort, 12);
  if (!projectId) return <div className="widget-empty">{tr("widgets.usageplugin.chooseAProjectToRankSessions")}</div>;
  if (mine.length === 0) return <div className="widget-empty">{tr("widgets.usageplugin.noProjectSessionsToRankYet")}</div>;
  return (
    <div className="usage-sessions-table">
      <table>
        <thead>
          <tr>
            <th>{tr("widgets.usageplugin.session")}</th>
            <th>
              <Button size="sm" variant="ghost" className={sort === "tokens" ? "active" : ""} onClick={() => setSort("tokens")}>
                {tr("widgets.usageplugin.tokens")}{" "}{sort === "tokens" ? "↓" : ""}
              </Button>
            </th>
            <th>
              <Button size="sm" variant="ghost" className={sort === "cost" ? "active" : ""} onClick={() => setSort("cost")}>
                {tr("widgets.usageplugin.cost")}{" "}{sort === "cost" ? "↓" : ""}
              </Button>
            </th>
          </tr>
        </thead>
        <tbody>
          {top.map((session) => (
            <tr key={session.id}>
              <td title={session.title || session.id}>{session.title || session.id}</td>
              <td className="mono">{fmtTokens(sessionTokens(session))}</td>
              <td className="mono">{session.costTotal ? fmtCost(session.costTotal) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const resetLabel = (resetsAt: number | undefined, now = Date.now()): string => {
  if (resetsAt === undefined) return "";
  const ms = Math.max(0, resetsAt - now);
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const remaining = hours % 24;
  return remaining > 0 ? `${days}d ${remaining}h` : `${days}d`;
};

function QuotaSummaryWidget() {
  const { snapshots, loading, error } = useQuotaSnapshots();
  const prefs = useUsagePrefs();
  const visible = snapshots.filter((snapshot) => !prefs.hiddenProviders.includes(snapshot.providerId));
  const providers = visible.map((snapshot) => {
    const highest = [...snapshot.windows]
      .filter((window) => window.limit > 0)
      .sort((left, right) => right.used / right.limit - left.used / left.limit)[0];
    return highest ? {
      id: snapshot.providerId,
      ratio: Math.max(0, highest.used / highest.limit),
      reset: resetLabel(highest.resetsAt),
    } : null;
  }).filter((item): item is { id: string; ratio: number; reset: string } => item !== null)
    .sort((left, right) => right.ratio - left.ratio);

  if (loading && snapshots.length === 0) return <div className="widget-empty" role="status">{tr("widgets.usageplugin.loadingQuotaSummary")}</div>;
  if (error && snapshots.length === 0) return <div className="widget-empty" role="alert">{tr("widgets.usageplugin.quotaSummaryIsUnavailable")} {error}</div>;
  if (providers.length === 0) return <div className="widget-empty">{tr("widgets.usageplugin.noProvidersDiscoveredFromOpencodeOrClaude")}</div>;

  return (
    <div className="usage-quota-mini-list">
      {providers.slice(0, 2).map((provider) => (
        <div key={provider.id}>
          <ProviderLogo providerID={provider.id} className="quota-provider-logo" />
          <span>{provider.id}</span>
          <strong className={provider.ratio >= .8 ? "warn" : undefined}>{Math.round(provider.ratio * 100)}%</strong>
          {provider.reset && <small>· {provider.reset}</small>}
        </div>
      ))}
      <span className="usage-quota-mini-narrow">
        Quota {providers.filter((provider) => provider.ratio >= .8).length > 0
          ? `⚠ ${providers.filter((provider) => provider.ratio >= .8).length}`
          : "✓"}
      </span>
    </div>
  );
}

const ANALYTICS_KIND: Readonly<Record<string, UsageAnalyticsWidgetKind>> = {
  "usage.summary": "summary",
  "usage.quotas": "quotas",
  "usage.throughput": "throughput",
  "usage.ttft": "ttft",
  "usage.spend-trend": "spend-trend",
  "usage.performance": "performance",
  "usage.what-changed": "what-changed",
  "usage.subscription-value": "subscription-value",
  "usage.model-efficiency": "model-efficiency",
  "usage.breakdown": "breakdown",
  "usage.reliability": "reliability",
  "usage.cache-efficiency": "cache-efficiency",
};

const DEFAULT_ANALYTICS_CONFIG: Readonly<Record<string, JsonObject>> = {
  "usage.summary": { range: "7d", projectScope: "all" },
  "usage.quotas": {},
  "usage.throughput": { range: "24h", groupBy: "provider", aggregation: "p50", projectScope: "all" },
  "usage.ttft": { range: "24h", groupBy: "provider", aggregation: "p50", projectScope: "all" },
  "usage.spend-trend": { range: "30d", groupBy: "provider", projectScope: "all" },
  "usage.performance": { range: "24h", projectScope: "all" },
  "usage.what-changed": { range: "7d", projectScope: "all" },
  "usage.subscription-value": { projectScope: "all" },
  "usage.model-efficiency": { range: "7d", projectScope: "all" },
  "usage.breakdown": { range: "7d", groupBy: "provider", metric: "cost", projectScope: "all" },
  "usage.reliability": { range: "24h", projectScope: "all" },
  "usage.cache-efficiency": { range: "7d", projectScope: "all" },
};

function AnalyticsWidget(context: WidgetRenderContext) {
  const kind = ANALYTICS_KIND[context.instanceId.split("#")[0] ?? ""];
  if (!kind) return <div className="widget-empty">Unknown Usage widget.</div>;
  const defaults = DEFAULT_ANALYTICS_CONFIG[context.instanceId.split("#")[0] ?? ""] ?? {};
  const config = useMemo(
    () => ({ ...defaults, ...context.config }),
    [context.config, defaults],
  );
  const scope = useMemo(
    () => scopeFromWidget(config, context.projectId),
    [config, context.projectId],
  );
  return (
    <div className="usage-analytics-widget">
      <UsageAnalyticsWidgetView kind={kind} scope={scope} config={config} />
    </div>
  );
}

function ProviderQuotasWidget(context: WidgetRenderContext) {
  return (
    <div className="usage-analytics-widget">
      <UsageQuotasBlock showAllWindows={context.config.showAllWindows === true} />
    </div>
  );
}

const RANGE_OPTIONS = [
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

const GROUP_OPTIONS = [
  { value: "provider", label: "Provider" },
  { value: "model", label: "Model" },
  { value: "harness", label: "Harness" },
  { value: "project", label: "Project" },
];

const STAT_OPTIONS = [
  { value: "p50", label: "p50" },
  { value: "average", label: "Average" },
  { value: "p95", label: "p95" },
];

const SUMMARY_METRICS = [
  ["cost", "Spend / cost"],
  ["tokens", "Tokens"],
  ["sessions", "Sessions"],
  ["ttft", "TTFT"],
  ["tps", "Speed"],
  ["cache", "Cache"],
  ["errors", "Error rate"],
  ["success", "Success rate"],
] as const;

function AnalyticsWidgetSettings(context: WidgetSettingsContext) {
  const id = context.widgetId;
  const defaults = DEFAULT_ANALYTICS_CONFIG[id] ?? {};
  const config = { ...defaults, ...context.config };
  const set = (patch: JsonObject) => context.updateConfig({ ...context.config, ...patch });

  if (id === "usage.quotas") {
    return (
      <div className="widget-schema-settings">
        <Checkbox
          checked={config.showAllWindows === true}
          onChange={(checked) => set({ showAllWindows: checked })}
          label="Show all quota windows"
        />
      </div>
    );
  }

  const prefs = useUsagePrefs();
  const providerOptions = [
    { value: "", label: "Automatic" },
    ...Object.keys(prefs.providerCosts).sort().map((providerId) => ({ value: providerId, label: providerId })),
  ];

  const metrics = Array.isArray(config.metrics)
    ? config.metrics.filter((metric): metric is string => typeof metric === "string")
    : ["cost", "tokens", "sessions", "ttft", "tps", "cache"];

  return (
    <div className="widget-schema-settings usage-analytics-settings">
      {id !== "usage.subscription-value" && id !== "usage.summary" && (
        <Select
          label="Range"
          ariaLabel="Usage range"
          value={typeof config.range === "string" ? config.range : "7d"}
          options={RANGE_OPTIONS}
          onChange={(range) => set({ range })}
        />
      )}
      {id === "usage.summary" && (
        <Select
          label="Range"
          ariaLabel="Usage summary range"
          value={typeof config.range === "string" ? config.range : "7d"}
          options={RANGE_OPTIONS}
          onChange={(range) => set({ range })}
        />
      )}
      {id !== "usage.subscription-value" && id !== "usage.summary" && id !== "usage.performance"
        && id !== "usage.what-changed" && id !== "usage.model-efficiency"
        && id !== "usage.reliability" && id !== "usage.cache-efficiency" && (
        <Select
          label="Group by"
          ariaLabel="Usage grouping"
          value={typeof config.groupBy === "string" ? config.groupBy : "provider"}
          options={GROUP_OPTIONS}
          onChange={(groupBy) => set({ groupBy })}
        />
      )}
      {(id === "usage.throughput" || id === "usage.ttft") && (
        <Select
          label="Statistic"
          ariaLabel="Usage statistic"
          value={typeof config.aggregation === "string" ? config.aggregation : "p50"}
          options={STAT_OPTIONS}
          onChange={(aggregation) => set({ aggregation })}
        />
      )}
      {id === "usage.breakdown" && (
        <Select
          label="Metric"
          ariaLabel="Breakdown metric"
          value={typeof config.metric === "string" ? config.metric : "cost"}
          options={[
            { value: "cost", label: "Cost" },
            { value: "tokens", label: "Tokens" },
            { value: "output", label: "Output tokens" },
            { value: "sessions", label: "Sessions" },
            { value: "requests", label: "Requests" },
          ]}
          onChange={(metric) => set({ metric })}
        />
      )}
      {id === "usage.subscription-value" && (
        <Select
          label="Provider"
          ariaLabel="Subscription provider"
          value={typeof config.providerId === "string" ? config.providerId : ""}
          options={providerOptions}
          onChange={(providerId) => set({ providerId })}
        />
      )}
      {id === "usage.summary" && (
        <div className="usage-summary-metric-settings">
          <span>Metrics · choose up to 6</span>
          {SUMMARY_METRICS.map(([metric, label]) => (
            <Checkbox
              key={metric}
              checked={metrics.includes(metric)}
              onChange={(checked) => {
                const next = checked
                  ? metrics.includes(metric) || metrics.length >= 6 ? metrics : [...metrics, metric]
                  : metrics.filter((value) => value !== metric);
                if (next.length > 0) set({ metrics: next });
              }}
              label={label}
            />
          ))}
        </div>
      )}
      {id !== "usage.quotas" && (
        <Select
          label="Project scope"
          ariaLabel="Project scope"
          value={config.projectScope === "current" ? "current" : "all"}
          options={[
            { value: "all", label: "All projects" },
            { value: "current", label: "Current project" },
          ]}
          onChange={(projectScope) => set({ projectScope })}
        />
      )}
    </div>
  );
}

function UsageWidgetSettings() {
  return (
    <div className="builtin-widget-settings">
      <span>{tr("widgets.usageplugin.usesUsageDataFromTheActiveWorkspace")}</span>
      <small>{tr("widgets.usageplugin.providerVisibilityAndCollapsedQuotaGroupsFollow")}</small>
    </div>
  );
}

function SessionUsageWidgetSettings({ config, updateConfig }: WidgetSettingsContext) {
  return (
    <div className="widget-schema-settings" aria-label={tr("widgets.usageplugin.sessionUsageMetrics")}>
      {SESSION_USAGE_METRICS.map((metric) => (
        <Checkbox
          key={metric.id}
          checked={usageMetricVisible(config, metric.id)}
          onChange={(checked) => updateConfig({ ...config, [metric.id]: checked })}
          label={metric.label}
        />
      ))}
    </div>
  );
}

const RENDERERS: Readonly<Record<string, (context: WidgetRenderContext) => ReactNode>> = {
  "usage.session": (context) => <SessionUsageWidget {...context} />,
  "usage.summary": (context) => <AnalyticsWidget {...context} />,
  "usage.quotas": (context) => <ProviderQuotasWidget {...context} />,
  "usage.quota-summary": () => <QuotaSummaryWidget />,
  "usage.throughput": (context) => <AnalyticsWidget {...context} />,
  "usage.ttft": (context) => <AnalyticsWidget {...context} />,
  "usage.spend-trend": (context) => <AnalyticsWidget {...context} />,
  "usage.performance": (context) => <AnalyticsWidget {...context} />,
  "usage.what-changed": (context) => <AnalyticsWidget {...context} />,
  "usage.subscription-value": (context) => <AnalyticsWidget {...context} />,
  "usage.model-efficiency": (context) => <AnalyticsWidget {...context} />,
  "usage.breakdown": (context) => <AnalyticsWidget {...context} />,
  "usage.reliability": (context) => <AnalyticsWidget {...context} />,
  "usage.cache-efficiency": (context) => <AnalyticsWidget {...context} />,
  "usage.project": (context) => <ProjectUsageWidget projectId={context.projectId} />,
  "usage.sessions-table": (context) => <SessionsTableWidget projectId={context.projectId} />,
  "usage.turn": (context) => turnStatsWidgetRender(context),
};

const translatedMetadata = (id: string): Partial<PluginWidgetDef> => {
  switch (id) {
    case "usage.session":
      return {
        title: tr("widgets.usageplugin.sessionUsage"),
        description: tr("widgets.usageplugin.contextWindowTokenAndCostTotalsFor"),
        settingsSchema: SESSION_USAGE_SETTINGS,
      };
    case "usage.quotas":
      return {
        title: tr("widgets.usageplugin.providerQuotas"),
      };
    case "usage.project":
      return {
        title: tr("widgets.usageplugin.projectUsage"),
        description: tr("widgets.usageplugin.projectSessionTokenAndCostTotalsWith"),
      };
    case "usage.sessions-table":
      return {
        title: tr("widgets.usageplugin.topSessions"),
        description: tr("widgets.usageplugin.rankActiveProjectSessionsByCostOr"),
      };
    case "usage.quota-summary":
      return {
        title: tr("widgets.usageplugin.quotaSummary"),
      };
    case "usage.turn":
      return {
        title: tr("widgets.usageplugin.turnStats"),
        description: tr("widgets.usageplugin.turnStatsDescription"),
        settingsSchema: TURN_STATS_SETTINGS_SCHEMA,
      };
    default:
      return {};
  }
};

const settingsRenderer = (id: string): ((context: WidgetSettingsContext) => ReactNode) => {
  if (id === "usage.session") return (context) => <SessionUsageWidgetSettings {...context} />;
  if (id === "usage.turn") return (context) => turnStatsWidgetSettingsRender(context);
  if (id in ANALYTICS_KIND) return (context) => <AnalyticsWidgetSettings {...context} />;
  return () => <UsageWidgetSettings />;
};

export const USAGE_WIDGET_PLUGIN = defineWidgetPlugin({
  id: "usage",
  name: tr("packages.usage.usage"),
  widgets: USAGE_WIDGETS.map(({ module: _module, ...widget }) => ({
    ...widget,
    ...translatedMetadata(widget.id),
    render: RENDERERS[widget.id]!,
    settingsRender: settingsRenderer(widget.id),
  })) satisfies readonly PluginWidgetDef[],
});

let uninstall: (() => void) | null = null;

export function installUsagePlugin(): () => void {
  if (uninstall) return uninstall;
  const unregister = registerWidgetPlugin(USAGE_WIDGET_PLUGIN);
  const current = () => {
    unregister();
    if (uninstall === current) uninstall = null;
  };
  uninstall = current;
  return current;
}
