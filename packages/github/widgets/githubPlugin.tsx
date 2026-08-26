import { useEffect, useState } from "react";
import type { JsonObject } from "@polyth/contracts";
import { api, type CurrentPrSummaryDto, type GhListResult } from "@polyth/session/web-api";
import {
  defineWidgetPlugin,
  registerWidgetPlugin,
  type PluginWidgetDef,
  type WidgetRenderContext,
  type WidgetSettingsContext,
} from "../../../apps/web/src/widgets/catalog.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

type GithubSummaryMetric = "showFiles" | "showAdditions" | "showDeletions";

const SUMMARY_METRICS: ReadonlyArray<{ id: GithubSummaryMetric; label: string }> = [
  { id: "showFiles", label: tr("widgets.githubplugin.changedFiles") },
  { id: "showAdditions", label: tr("widgets.githubplugin.addedLines") },
  { id: "showDeletions", label: tr("widgets.githubplugin.removedLines") },
];

const PR_SUMMARY_SETTINGS = {
  type: "object",
  properties: {
    showFiles: { type: "boolean", title: tr("widgets.githubplugin.changedFiles"), default: true },
    showAdditions: { type: "boolean", title: tr("widgets.githubplugin.addedLines"), default: true },
    showDeletions: { type: "boolean", title: tr("widgets.githubplugin.removedLines"), default: true },
  },
} as const;

const metricVisible = (config: Readonly<JsonObject>, metric: GithubSummaryMetric): boolean =>
  config[metric] !== false;

export function GithubPrSummary({
  summary,
  config,
}: {
  summary: CurrentPrSummaryDto;
  config: Readonly<JsonObject>;
}) {
  const metrics: Array<{ id: string; label: string; value: string | number; className: string }> = [];
  if (metricVisible(config, "showFiles")) {
    metrics.push({ id: "files", label: tr("widgets.githubplugin.files"), value: summary.changedFiles, className: "" });
  }
  if (metricVisible(config, "showAdditions")) {
    metrics.push({ id: "additions", label: tr("widgets.githubplugin.added"), value: `+${summary.additions}`, className: "positive" });
  }
  if (metricVisible(config, "showDeletions")) {
    metrics.push({ id: "deletions", label: tr("widgets.githubplugin.removed"), value: `−${summary.deletions}`, className: "negative" });
  }
  return (
    <div className="github-pr-summary">
      <a href={summary.url} target="_blank" rel="noreferrer">
        <span>{tr("widgets.githubplugin.pr")}{summary.number}</span>
        <strong>{summary.title}</strong>
      </a>
      <div className="github-pr-summary-metrics">
        {metrics.map((metric) => (
          <div key={metric.id} data-github-metric={metric.id}>
            <span>{metric.label}</span>
            <strong className={metric.className}>{metric.value}</strong>
          </div>
        ))}
        {metrics.length === 0 && <small>{tr("widgets.githubplugin.chooseMetricsInWidgetSettings")}</small>}
      </div>
    </div>
  );
}

function GithubPrSummaryWidget({ projectId, config }: WidgetRenderContext) {
  const [result, setResult] = useState<GhListResult<CurrentPrSummaryDto> | null>(null);
  useEffect(() => {
    let active = true;
    setResult(null);
    if (!projectId) return () => { active = false; };
    void api.githubCurrentPrSummary(projectId).then((next) => {
      if (active) setResult(next);
    });
    return () => { active = false; };
  }, [projectId]);

  if (!projectId) return <div className="widget-empty">{tr("widgets.githubplugin.chooseAProjectToInspectItsPull")}</div>;
  if (!result) return <div className="widget-empty" role="status">{tr("widgets.githubplugin.loadingCurrentPullRequest")}</div>;
  if (!result.ok) return <div className="widget-empty">{result.reason}</div>;
  return <GithubPrSummary summary={result.data} config={config} />;
}

function GithubPrSummarySettings({ config, updateConfig }: WidgetSettingsContext) {
  return (
    <div className="widget-schema-settings" aria-label={tr("widgets.githubplugin.githubPullRequestMetrics")}>
      {SUMMARY_METRICS.map((metric) => (
        <label key={metric.id}>
          <input
            type="checkbox"
            checked={metricVisible(config, metric.id)}
            onChange={(event) => updateConfig({ ...config, [metric.id]: event.target.checked })}
          />
          <span><strong>{metric.label}</strong></span>
        </label>
      ))}
    </div>
  );
}

export const GITHUB_WIDGET_PLUGIN = defineWidgetPlugin({
  id: "github",
  name: "GitHub",
  widgets: [
    {
      id: "github.pr-summary",
      title: tr("widgets.githubplugin.currentPullRequest"),
      description: tr("widgets.githubplugin.changedFilesAndAddedRemovedLinesFor"),
      kind: "widget",
      defaultSlot: "session.composer.before",
      supportedSlots: [
        "session.composer.before",
        "workspace.header",
        "workspace.left",
        "workspace.main",
        "workspace.right",
      ],
      category: "GitHub",
      capabilities: ["pull requests", "diff stats"],
      defaultSize: { w: 5, h: 3 },
      minSize: { w: 3, h: 2 },
      maxSize: { w: 8, h: 6 },
      audience: "standard",
      scope: "plugin",
      resizable: true,
      recommended: true,
      defaultVisible: false,
      settingsSchema: PR_SUMMARY_SETTINGS,
      render: (context) => <GithubPrSummaryWidget {...context} />,
      settingsRender: (context) => <GithubPrSummarySettings {...context} />,
    },
  ] satisfies readonly PluginWidgetDef[],
});

let uninstall: (() => void) | null = null;

export function installGithubPlugin(): () => void {
  if (uninstall) return uninstall;
  const unregister = registerWidgetPlugin(GITHUB_WIDGET_PLUGIN);
  const current = () => {
    unregister();
    if (uninstall === current) uninstall = null;
  };
  uninstall = current;
  return current;
}
