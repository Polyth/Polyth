import { useEffect, useState } from "react";
import type { JsonObject } from "@polyth/contracts";
import { api, type CurrentPrSummaryDto, type GhListResult } from "../api.ts";
import {
  defineWidgetPlugin,
  registerWidgetPlugin,
  type PluginWidgetDef,
  type WidgetRenderContext,
  type WidgetSettingsContext,
} from "./catalog.ts";

type GithubSummaryMetric = "showFiles" | "showAdditions" | "showDeletions";

const SUMMARY_METRICS: ReadonlyArray<{ id: GithubSummaryMetric; label: string }> = [
  { id: "showFiles", label: "Changed files" },
  { id: "showAdditions", label: "Added lines" },
  { id: "showDeletions", label: "Removed lines" },
];

const PR_SUMMARY_SETTINGS = {
  type: "object",
  properties: {
    showFiles: { type: "boolean", title: "Changed files", default: true },
    showAdditions: { type: "boolean", title: "Added lines", default: true },
    showDeletions: { type: "boolean", title: "Removed lines", default: true },
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
    metrics.push({ id: "files", label: "Files", value: summary.changedFiles, className: "" });
  }
  if (metricVisible(config, "showAdditions")) {
    metrics.push({ id: "additions", label: "Added", value: `+${summary.additions}`, className: "positive" });
  }
  if (metricVisible(config, "showDeletions")) {
    metrics.push({ id: "deletions", label: "Removed", value: `−${summary.deletions}`, className: "negative" });
  }
  return (
    <div className="github-pr-summary">
      <a href={summary.url} target="_blank" rel="noreferrer">
        <span>PR #{summary.number}</span>
        <strong>{summary.title}</strong>
      </a>
      <div className="github-pr-summary-metrics">
        {metrics.map((metric) => (
          <div key={metric.id} data-github-metric={metric.id}>
            <span>{metric.label}</span>
            <strong className={metric.className}>{metric.value}</strong>
          </div>
        ))}
        {metrics.length === 0 && <small>Choose metrics in widget settings.</small>}
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

  if (!projectId) return <div className="widget-empty">Choose a project to inspect its pull request.</div>;
  if (!result) return <div className="widget-empty" role="status">Loading current pull request…</div>;
  if (!result.ok) return <div className="widget-empty">{result.reason}</div>;
  return <GithubPrSummary summary={result.data} config={config} />;
}

function GithubPrSummarySettings({ config, updateConfig }: WidgetSettingsContext) {
  return (
    <div className="widget-schema-settings" aria-label="GitHub pull request metrics">
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
      title: "Current pull request",
      description: "Changed files and added/removed lines for the current branch pull request.",
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
