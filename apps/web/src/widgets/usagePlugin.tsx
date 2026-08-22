import { useState, type ReactNode } from "react";
import type { JsonObject } from "@polyth/contracts";
import { USAGE_WIDGETS } from "@polyth/usage";
import { fmtCost, fmtTokens } from "../format.ts";
import { useActiveModel, useStore } from "../store.ts";
import { contextGauge, type RenderModel } from "../reduce.ts";
import {
  ProviderUsageDonut,
  projectUsageStats,
  sessionTokens,
  topProjectSessions,
  type SessionUsageSort,
} from "../usage/projectUi.tsx";
import {
  QuotaCard,
  QuotaOverviewGrid,
  quotaSnapshotStats,
  useQuotaSnapshots,
} from "../usage/quotaUi.tsx";
import {
  setProviderHidden,
  useUsagePrefs,
} from "../usagePrefs.ts";
import {
  defineWidgetPlugin,
  registerWidgetPlugin,
  type WidgetRenderContext,
  type WidgetSettingsContext,
} from "./catalog.ts";

export type SessionUsageMetric =
  | "showContext"
  | "showCost"
  | "showInput"
  | "showOutput"
  | "showTotal";

const SESSION_USAGE_METRICS: ReadonlyArray<{ id: SessionUsageMetric; label: string }> = [
  { id: "showContext", label: "Context window" },
  { id: "showCost", label: "Session cost" },
  { id: "showInput", label: "Input tokens" },
  { id: "showOutput", label: "Output tokens" },
  { id: "showTotal", label: "Total tokens" },
];

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
  const rows: Array<{ id: string; label: string; value: string; detail?: string } | null> = [
    usageMetricVisible(config, "showContext")
      ? {
          id: "context",
          label: "Context",
          value: gauge.known
            ? `${gauge.percent}%`
            : "Unknown",
          detail: gauge.known
            ? `${fmtTokens(gauge.inputTokens)} / ${fmtTokens(gauge.contextTokens)}`
            : undefined,
        }
      : null,
    usageMetricVisible(config, "showInput")
      ? { id: "input", label: "Input", value: fmtTokens(model.totals.input) }
      : null,
    usageMetricVisible(config, "showOutput")
      ? { id: "output", label: "Output", value: fmtTokens(model.totals.output) }
      : null,
    usageMetricVisible(config, "showTotal")
      ? { id: "total", label: "Total", value: fmtTokens(total) }
      : null,
    usageMetricVisible(config, "showCost")
      ? { id: "cost", label: "Cost", value: model.totals.cost > 0 ? fmtCost(model.totals.cost) : "—" }
      : null,
  ].filter((row): row is NonNullable<typeof row> => row !== null);
  return (
    <div className="widget-stat-grid usage-session-stats">
      {rows.map((row) => (
        <div key={row.id} data-usage-metric={row.id}>
          <span>{row.label}</span>
          <strong>{row.value}</strong>
          {row.detail && <small>{row.detail}</small>}
        </div>
      ))}
      {rows.length === 0 && <div className="widget-empty">Choose metrics in widget settings.</div>}
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
  const { snapshots, refresh } = useQuotaSnapshots();
  const prefs = useUsagePrefs();
  const visible = snapshots.filter((snapshot) => !prefs.hiddenProviders.includes(snapshot.providerId));
  return (
    <div className="usage-widget-panel">
      {snapshots.length === 0 && (
        <div className="widget-empty">No providers discovered. Sign in through OpenCode or Claude Code; credentials stay on the server.</div>
      )}
      {visible.length > 0 && <QuotaOverviewGrid snapshots={visible} />}
      {snapshots.length > 0 && (
        <div className="quota-visibility" aria-label="Visible quota providers">
          {snapshots.map((snapshot) => (
            <label key={snapshot.providerId} className="plugin-toggle">
              <input
                type="checkbox"
                checked={!prefs.hiddenProviders.includes(snapshot.providerId)}
                onChange={(event) => setProviderHidden(snapshot.providerId, !event.target.checked)}
              />
              {snapshot.providerId}
            </label>
          ))}
        </div>
      )}
      {snapshots.length > 0 && visible.length === 0 && (
        <div className="widget-empty">All providers are hidden.</div>
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
  if (!projectId) return <div className="widget-empty">Choose a project to see usage.</div>;
  if (mine.length === 0) return <div className="widget-empty">Usage appears once sessions run in this project.</div>;
  return (
    <div className="usage-widget-panel">
      <div className="widget-stat-grid">
        <div><span>Sessions</span><strong>{totals.sessions}</strong></div>
        <div><span>Tokens</span><strong>{fmtTokens(totals.tokens)}</strong></div>
        <div><span>Cost</span><strong>{totals.cost > 0 ? fmtCost(totals.cost) : "—"}</strong></div>
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
  if (!projectId) return <div className="widget-empty">Choose a project to rank sessions.</div>;
  if (mine.length === 0) return <div className="widget-empty">No project sessions to rank yet.</div>;
  return (
    <div className="usage-sessions-table">
      <table>
        <thead>
          <tr>
            <th>Session</th>
            <th>
              <button type="button" className={sort === "tokens" ? "active" : ""} onClick={() => setSort("tokens")}>
                Tokens {sort === "tokens" ? "↓" : ""}
              </button>
            </th>
            <th>
              <button type="button" className={sort === "cost" ? "active" : ""} onClick={() => setSort("cost")}>
                Cost {sort === "cost" ? "↓" : ""}
              </button>
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
  const { snapshots } = useQuotaSnapshots();
  const prefs = useUsagePrefs();
  const visible = snapshots.filter((snapshot) => !prefs.hiddenProviders.includes(snapshot.providerId));
  const stats = quotaSnapshotStats(visible);
  if (snapshots.length === 0) return <div className="widget-empty">No providers discovered from OpenCode or Claude Code.</div>;
  return (
    <div className="usage-quota-summary">
      <div><strong>{stats.providerCount}</strong><span>providers</span></div>
      <div className={stats.attentionCount > 0 ? "warn" : ""}><strong>{stats.attentionCount}</strong><span>at 80%+</span></div>
      <div><strong>{stats.staleCount}</strong><span>stale</span></div>
    </div>
  );
}

function UsageWidgetSettings() {
  return (
    <div className="builtin-widget-settings">
      <span>Uses usage data from the active workspace context</span>
      <small>Provider visibility and collapsed quota groups follow Settings → Usage.</small>
    </div>
  );
}

function SessionUsageWidgetSettings({ config, updateConfig }: WidgetSettingsContext) {
  return (
    <div className="widget-schema-settings" aria-label="Session usage metrics">
      {SESSION_USAGE_METRICS.map((metric) => (
        <label key={metric.id}>
          <input
            type="checkbox"
            checked={usageMetricVisible(config, metric.id)}
            onChange={(event) => updateConfig({ ...config, [metric.id]: event.target.checked })}
          />
          <span><strong>{metric.label}</strong></span>
        </label>
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
  name: "Usage",
  widgets: USAGE_WIDGETS.map(({ module, ...widget }) => ({
    ...widget,
    render: RENDERERS[module]!,
    settingsRender: module === "usage.session"
      ? (context: WidgetSettingsContext) => <SessionUsageWidgetSettings {...context} />
      : () => <UsageWidgetSettings />,
  })),
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
