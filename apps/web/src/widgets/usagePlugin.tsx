import { useState, type ReactNode } from "react";
import { fmtCost, fmtTokens } from "../format.ts";
import { useActiveModel, useStore } from "../store.ts";
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
  type PluginWidgetDef,
  type WidgetRenderContext,
} from "./catalog.ts";

function SessionUsageWidget() {
  const model = useActiveModel();
  const total = model.totals.input + model.totals.output;
  return (
    <div className="widget-stat-grid">
      <div><span>Input</span><strong>{fmtTokens(model.totals.input)}</strong></div>
      <div><span>Output</span><strong>{fmtTokens(model.totals.output)}</strong></div>
      <div><span>Total</span><strong>{fmtTokens(total)}</strong></div>
      <div><span>Cost</span><strong>{model.totals.cost > 0 ? fmtCost(model.totals.cost) : "—"}</strong></div>
    </div>
  );
}

function ProviderQuotasWidget() {
  const { snapshots, refresh } = useQuotaSnapshots();
  const prefs = useUsagePrefs();
  const visible = snapshots.filter((snapshot) => !prefs.hiddenProviders.includes(snapshot.providerId));
  return (
    <div className="usage-widget-panel">
      {snapshots.length === 0 && (
        <div className="widget-empty">No quota providers configured.</div>
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
  if (snapshots.length === 0) return <div className="widget-empty">No quota providers configured.</div>;
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

const RENDERERS: Record<string, (context: WidgetRenderContext) => ReactNode> = {
  "usage.session": () => <SessionUsageWidget />,
  "usage.quotas": () => <ProviderQuotasWidget />,
  "usage.project": (context) => <ProjectUsageWidget projectId={context.projectId} />,
  "usage.sessions-table": (context) => <SessionsTableWidget projectId={context.projectId} />,
  "usage.quota-summary": () => <QuotaSummaryWidget />,
};

export const USAGE_WIDGET_PLUGIN = defineWidgetPlugin({
  id: "usage",
  name: "Usage",
  widgets: [
    {
      id: "usage.session",
      title: "Session usage",
      description: "Token and cost totals for the active session.",
      kind: "widget",
      defaultSlot: "workspace.right",
      supportedSlots: ["workspace.header", "workspace.left", "workspace.main", "workspace.right"],
      category: "Usage",
      defaultSize: { w: 4, h: 3 },
      minSize: { w: 3, h: 2 },
      maxSize: { w: 8, h: 6 },
      audience: "standard",
      scope: "workspace",
      resizable: true,
      recommended: true,
      defaultVisible: false,
      render: RENDERERS["usage.session"]!,
      settingsRender: () => <UsageWidgetSettings />,
    },
    {
      id: "usage.quotas",
      title: "Provider quotas",
      description: "Provider quota windows, utilization charts, pace, and refresh controls.",
      kind: "widget",
      defaultSlot: "workspace.main",
      supportedSlots: ["workspace.main", "workspace.right", "workspace.bottom"],
      category: "Usage",
      defaultSize: { w: 12, h: 7 },
      minSize: { w: 6, h: 5 },
      maxSize: { w: 12, h: 12 },
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
      title: "Project usage",
      description: "Project session, token, and cost totals with provider distribution.",
      kind: "widget",
      defaultSlot: "workspace.main",
      supportedSlots: ["workspace.left", "workspace.main", "workspace.right"],
      category: "Usage",
      defaultSize: { w: 8, h: 6 },
      minSize: { w: 5, h: 4 },
      maxSize: { w: 12, h: 10 },
      audience: "standard",
      scope: "workspace",
      resizable: true,
      recommended: true,
      defaultVisible: false,
      render: RENDERERS["usage.project"]!,
      settingsRender: () => <UsageWidgetSettings />,
    },
    {
      id: "usage.sessions-table",
      title: "Top sessions",
      description: "Rank active-project sessions by cost or token usage.",
      kind: "widget",
      defaultSlot: "workspace.right",
      supportedSlots: ["workspace.main", "workspace.right", "workspace.bottom"],
      category: "Usage",
      defaultSize: { w: 6, h: 5 },
      minSize: { w: 4, h: 3 },
      maxSize: { w: 12, h: 10 },
      audience: "standard",
      scope: "workspace",
      resizable: true,
      defaultVisible: false,
      render: RENDERERS["usage.sessions-table"]!,
      settingsRender: () => <UsageWidgetSettings />,
    },
    {
      id: "usage.quota-summary",
      title: "Quota summary",
      description: "Compact provider, high-utilization, and stale-feed quota counts.",
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
