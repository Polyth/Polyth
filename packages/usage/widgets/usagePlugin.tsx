import { useState, type ReactNode } from "react";
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
import {
  QuotaCard,
  QuotaOverviewGrid,
  quotaSnapshotStats,
  useQuotaSnapshots,
} from "./usage/quotaUi.tsx";
import ProviderLogo from "../../models/widgets/ProviderLogo.tsx";
import {
  setProviderHidden,
  useUsagePrefs,
} from "./usagePrefs.ts";
import {
  defineWidgetPlugin,
  registerWidgetPlugin,
  type PluginWidgetDef,
  type WidgetRenderContext,
  type WidgetSettingsContext,
} from "../../../apps/web/src/widgets/catalog.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Checkbox, EmptyState } from "../../../apps/web/src/components/ui/index.ts";

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

function ProviderQuotasWidget() {
  const { snapshots, refresh, loading, error } = useQuotaSnapshots();
  const prefs = useUsagePrefs();
  const visible = snapshots.filter((snapshot) => !prefs.hiddenProviders.includes(snapshot.providerId));
  if (loading && snapshots.length === 0) {
    return <EmptyState variant="compact" title="Loading provider quotas…" />;
  }
  if (error && snapshots.length === 0) {
    return <EmptyState variant="compact" title="Provider quotas are unavailable" description={error} />;
  }
  return (
    <div className="usage-widget-panel">
      {snapshots.length === 0 && (
        <div className="widget-empty">{tr("widgets.usageplugin.noProvidersDiscoveredSignInThroughOpencode")}</div>
      )}
      {visible.length > 0 && <QuotaOverviewGrid snapshots={visible} />}
      {snapshots.length > 0 && (
        <div className="quota-visibility" aria-label={tr("widgets.usageplugin.visibleQuotaProviders")}>
          {snapshots.map((snapshot) => (
            <Checkbox
              key={snapshot.providerId}
              className="plugin-toggle"
              checked={!prefs.hiddenProviders.includes(snapshot.providerId)}
              onChange={(checked) => setProviderHidden(snapshot.providerId, !checked)}
              label={<><ProviderLogo providerID={snapshot.providerId} className="quota-provider-logo" />{snapshot.providerId}</>}
            />
          ))}
        </div>
      )}
      {snapshots.length > 0 && visible.length === 0 && (
        <div className="widget-empty">{tr("widgets.usageplugin.allProvidersAreHidden")}</div>
      )}
      {visible.length > 0 && (
        <div className="quota-grid">
          {visible.map((snapshot) => (
            <QuotaCard key={snapshot.providerId} snap={snapshot} onRefresh={refresh} />
          ))}
        </div>
      )}
    </div>
  );
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
        <div><span>{tr("widgets.usageplugin.sessions")}</span><strong>{totals.sessions}</strong></div>
        <div><span>{tr("widgets.usageplugin.tokens")}</span><strong>{fmtTokens(totals.tokens)}</strong></div>
        <div><span>{tr("widgets.usageplugin.cost")}</span><strong>{totals.cost > 0 ? fmtCost(totals.cost) : "—"}</strong></div>
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

function QuotaSummaryWidget() {
  const { snapshots, loading, error } = useQuotaSnapshots();
  const prefs = useUsagePrefs();
  const visible = snapshots.filter((snapshot) => !prefs.hiddenProviders.includes(snapshot.providerId));
  const stats = quotaSnapshotStats(visible);
  if (loading && snapshots.length === 0) return <div className="widget-empty" role="status">{tr("widgets.usageplugin.loadingQuotaSummary")}</div>;
  if (error && snapshots.length === 0) return <div className="widget-empty" role="alert">{tr("widgets.usageplugin.quotaSummaryIsUnavailable")} {error}</div>;
  if (snapshots.length === 0) return <div className="widget-empty">{tr("widgets.usageplugin.noProvidersDiscoveredFromOpencodeOrClaude")}</div>;
  return (
    <div className="usage-quota-summary">
      <div><strong>{stats.providerCount}</strong><span>{tr("widgets.usageplugin.providers")}</span></div>
      <div className={stats.attentionCount > 0 ? "warn" : ""}><strong>{stats.attentionCount}</strong><span>{tr("widgets.usageplugin.at80")}</span></div>
      <div><strong>{stats.staleCount}</strong><span>{tr("widgets.usageplugin.stale")}</span></div>
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

const RENDERERS: Record<string, (context: WidgetRenderContext) => ReactNode> = {
  "usage.session": (context) => <SessionUsageWidget {...context} />,
  "usage.quotas": () => <ProviderQuotasWidget />,
  "usage.project": (context) => <ProjectUsageWidget projectId={context.projectId} />,
  "usage.sessions-table": (context) => <SessionsTableWidget projectId={context.projectId} />,
  "usage.quota-summary": () => <QuotaSummaryWidget />,
};

export const USAGE_WIDGET_PLUGIN = defineWidgetPlugin({
  id: "usage",
  name: tr("packages.usage.usage"),
  widgets: [
    {
      id: "usage.session",
      title: tr("widgets.usageplugin.sessionUsage"),
      description: tr("widgets.usageplugin.contextWindowTokenAndCostTotalsFor"),
      kind: "widget",
      defaultSlot: "session.composer.before",
      supportedSlots: [
        "session.composer.before",
        "workspace.header",
        "workspace.left",
        "workspace.main",
        "workspace.right",
      ],
      category: "Usage",
      defaultSize: { w: 4, h: 3 },
      minSize: { w: 3, h: 2 },
      maxSize: { w: 12, h: 50 },
      audience: "standard",
      scope: "workspace",
      resizable: true,
      recommended: true,
      defaultVisible: false,
      settingsSchema: SESSION_USAGE_SETTINGS,
      render: RENDERERS["usage.session"]!,
      settingsRender: (context) => <SessionUsageWidgetSettings {...context} />,
    },
    {
      id: "usage.quotas",
      title: tr("widgets.usageplugin.providerQuotas"),
      description: tr("widgets.usageplugin.providerQuotaWindowsUtilizationChartsPaceAnd"),
      kind: "widget",
      defaultSlot: "workspace.main",
      supportedSlots: ["workspace.main", "workspace.right", "workspace.bottom"],
      category: "Usage",
      defaultSize: { w: 12, h: 7 },
      minSize: { w: 6, h: 5 },
      maxSize: { w: 12, h: 50 },
      audience: "standard",
      scope: "workspace",
      resizable: true,
      recommended: true,
      defaultVisible: false,
      render: RENDERERS["usage.quotas"]!,
      settingsRender: () => <UsageWidgetSettings />,
    },
    {
      id: "usage.project",
      title: tr("widgets.usageplugin.projectUsage"),
      description: tr("widgets.usageplugin.projectSessionTokenAndCostTotalsWith"),
      kind: "widget",
      defaultSlot: "workspace.main",
      supportedSlots: ["workspace.left", "workspace.main", "workspace.right"],
      category: "Usage",
      defaultSize: { w: 8, h: 6 },
      minSize: { w: 5, h: 4 },
      maxSize: { w: 12, h: 50 },
      audience: "standard",
      scope: "workspace",
      resizable: true,
      recommended: true,
      defaultVisible: false,
      panelSizes: ["wide", "large"],
      panelDefaultSize: "large",
      panelTitle: "Usage",
      render: RENDERERS["usage.project"]!,
      settingsRender: () => <UsageWidgetSettings />,
    },
    {
      id: "usage.sessions-table",
      title: tr("widgets.usageplugin.topSessions"),
      description: tr("widgets.usageplugin.rankActiveProjectSessionsByCostOr"),
      kind: "widget",
      defaultSlot: "workspace.right",
      supportedSlots: ["workspace.main", "workspace.right", "workspace.bottom"],
      category: "Usage",
      defaultSize: { w: 6, h: 5 },
      minSize: { w: 4, h: 3 },
      maxSize: { w: 12, h: 50 },
      audience: "standard",
      scope: "workspace",
      resizable: true,
      defaultVisible: false,
      render: RENDERERS["usage.sessions-table"]!,
      settingsRender: () => <UsageWidgetSettings />,
    },
    {
      id: "usage.quota-summary",
      title: tr("widgets.usageplugin.quotaSummary"),
      description: tr("widgets.usageplugin.compactProviderHighUtilizationAndStaleFeed"),
      kind: "mini-widget",
      defaultSlot: "workspace.header",
      supportedSlots: ["workspace.header", "workspace.left", "workspace.right"],
      category: "Usage",
      defaultSize: { w: 4, h: 2 },
      minSize: { w: 3, h: 2 },
      maxSize: { w: 6, h: 3 },
      audience: "simple",
      scope: "workspace",
      resizable: true,
      recommended: true,
      defaultVisible: false,
      order: 40,
      render: RENDERERS["usage.quota-summary"]!,
      settingsRender: () => <UsageWidgetSettings />,
    },
  ] satisfies readonly PluginWidgetDef[],
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
