import { useMemo, useState, type DragEvent, type ReactNode } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import {
  moveUsageBlock,
  orderUsageBlocks,
  resetUsageOverview,
  setBlockHidden,
  setUsageDashboardPrefs,
  useUsagePrefs,
} from "../usagePrefs.ts";
import {
  UsageBreakdownBlock,
  UsageModelEfficiencyBlock,
  UsagePerformanceBlock,
  UsageQuotasBlock,
  UsageSpendTrendBlock,
  UsageSubscriptionValueBlock,
  UsageSummaryBlock,
  UsageThroughputBlock,
  UsageWhatChangedBlock,
  type UsageAnalyticsRange,
  type UsageAnalyticsScope,
} from "./analyticsPresentation.tsx";

interface OverviewBlockDefinition {
  id: string;
  title: string;
  span: "full" | "wide" | "narrow";
  render(scope: UsageAnalyticsScope): ReactNode;
  canvasConfig?: Readonly<Record<string, string | number | boolean>>;
  settingsItem?: string;
}

const BLOCKS: readonly OverviewBlockDefinition[] = [
  {
    id: "usage.summary",
    title: "Summary",
    span: "full",
    render: (scope) => <UsageSummaryBlock scope={scope} />,
    canvasConfig: { range: "24h", projectScope: "all" },
    settingsItem: "usage.statistics",
  },
  {
    id: "usage.quotas",
    title: "Provider quotas",
    span: "narrow",
    render: () => <UsageQuotasBlock />,
  },
  {
    id: "usage.throughput",
    title: "Token throughput",
    span: "wide",
    render: (scope) => <UsageThroughputBlock scope={scope} />,
    canvasConfig: { range: "24h", groupBy: "provider", aggregation: "p50", projectScope: "all" },
    settingsItem: "usage.charts",
  },
  {
    id: "usage.spend-trend",
    title: "Spend trend",
    span: "narrow",
    render: (scope) => <UsageSpendTrendBlock scope={scope} />,
    canvasConfig: { range: "30d", groupBy: "provider", projectScope: "all" },
    settingsItem: "usage.costs",
  },
  {
    id: "usage.performance",
    title: "Performance",
    span: "wide",
    render: (scope) => <UsagePerformanceBlock scope={scope} />,
    canvasConfig: { range: "24h", projectScope: "all" },
    settingsItem: "usage.statistics",
  },
  {
    id: "usage.what-changed",
    title: "What changed?",
    span: "narrow",
    render: (scope) => <UsageWhatChangedBlock scope={scope} />,
    canvasConfig: { range: "7d", projectScope: "all" },
  },
  {
    id: "usage.subscription-value",
    title: "Subscription value",
    span: "wide",
    render: () => <UsageSubscriptionValueBlock />,
    canvasConfig: { projectScope: "all" },
    settingsItem: "usage.costs",
  },
  {
    id: "usage.model-efficiency",
    title: "Model efficiency",
    span: "wide",
    render: (scope) => <UsageModelEfficiencyBlock scope={scope} />,
    canvasConfig: { range: "7d", projectScope: "all" },
  },
  {
    id: "usage.breakdown",
    title: "Usage breakdown",
    span: "narrow",
    render: (scope) => <UsageBreakdownBlock scope={scope} />,
    canvasConfig: { range: "7d", groupBy: "provider", metric: "cost", projectScope: "all" },
    settingsItem: "usage.charts",
  },
];

const defaultIds = (): string[] => BLOCKS.map((block) => block.id);

const presetForRange = (range: UsageAnalyticsRange): string => {
  const duration = range.to - range.from;
  if (duration <= 2 * 60 * 60_000) return "1h";
  if (duration <= 2 * 24 * 60 * 60_000) return "24h";
  if (duration <= 10 * 24 * 60 * 60_000) return "7d";
  if (duration <= 45 * 24 * 60 * 60_000) return "30d";
  return "90d";
};

export function UsageOverview({
  range,
  host,
}: {
  range: UsageAnalyticsRange;
  host?: WebPackageHost;
}) {
  const prefs = useUsagePrefs();
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const scope = useMemo<UsageAnalyticsScope>(() => ({ range }), [range]);

  const ordered = orderUsageBlocks(BLOCKS, prefs.dashboard.overviewOrder, (block) => block.id);
  const visible = ordered.filter((block) => !prefs.hiddenBlocks.includes(block.id));
  const hidden = ordered.filter((block) => prefs.hiddenBlocks.includes(block.id));

  const persistMove = (source: string, target: string): void => {
    const ids = ordered.map((block) => block.id);
    setUsageDashboardPrefs({ overviewOrder: moveUsageBlock(ids, source, target) });
  };

  const dropOn = (event: DragEvent<HTMLElement>, target: string): void => {
    event.preventDefault();
    if (dragging && dragging !== target) persistMove(dragging, target);
    setDragging(null);
  };

  const addToCanvas = (block: OverviewBlockDefinition): void => {
    const add = host?.widgets.addToCanvas;
    if (!add) {
      setNotice("Canvas insertion is not available in this host.");
      return;
    }
    const result = add(block.id, {
      duplicate: true,
      config: {
        ...(block.canvasConfig ?? {}),
        range: block.canvasConfig?.range ?? presetForRange(range),
      },
    });
    setNotice(result
      ? `Added ${block.title} to Canvas${result.duplicated ? " as a new instance" : ""}.`
      : "Open a project before adding Usage widgets to Canvas.");
  };

  const configure = (block: OverviewBlockDefinition): void => {
    host?.navigation.openSettingsPage(
      "usage",
      block.settingsItem ? { itemId: block.settingsItem } : undefined,
    );
  };

  return (
    <div className={`usage-curated-overview ${editing ? "is-editing" : ""}`}>
      <div className="usage-overview-editbar">
        <div>
          {editing && <span>Drag blocks to reorder. Hidden blocks stay available here.</span>}
          {notice && <span role="status">{notice}</span>}
        </div>
        <div>
          {editing && (
            <button
              type="button"
              className="usage-overview-action"
              onClick={() => {
                resetUsageOverview();
                setNotice("Overview reset to the default layout.");
              }}
            >
              Reset
            </button>
          )}
          <button
            type="button"
            className="usage-overview-action"
            aria-pressed={editing}
            onClick={() => {
              setEditing((value) => !value);
              setDragging(null);
              setNotice(null);
            }}
          >
            {editing ? "Done" : "Edit overview"}
          </button>
        </div>
      </div>

      {editing && hidden.length > 0 && (
        <div className="usage-overview-hidden">
          <span>Hidden</span>
          {hidden.map((block) => (
            <button key={block.id} type="button" onClick={() => setBlockHidden(block.id, false)}>
              + {block.title}
            </button>
          ))}
        </div>
      )}

      <div className="usage-overview-grid">
        {visible.map((block) => (
          <article
            className={`usage-overview-cell span-${block.span} ${dragging === block.id ? "is-dragging" : ""}`}
            key={block.id}
            draggable={editing}
            onDragStart={() => setDragging(block.id)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => editing && event.preventDefault()}
            onDrop={(event) => editing && dropOn(event, block.id)}
          >
            {editing && (
              <div className="usage-overview-cell-actions">
                <span className="usage-overview-drag" aria-hidden="true">⠿</span>
                <strong>{block.title}</strong>
                {block.settingsItem && (
                  <button type="button" onClick={() => configure(block)}>Configure</button>
                )}
                <button type="button" onClick={() => addToCanvas(block)}>Add to Canvas</button>
                <button type="button" onClick={() => setBlockHidden(block.id, true)}>Hide</button>
              </div>
            )}
            {block.render(scope)}
          </article>
        ))}
      </div>

      {visible.length === 0 && (
        <div className="usage-analytics-state">
          Overview is empty.
          <button type="button" onClick={() => resetUsageOverview()}>Restore defaults</button>
        </div>
      )}
    </div>
  );
}

export const DEFAULT_USAGE_OVERVIEW_BLOCKS = defaultIds();
