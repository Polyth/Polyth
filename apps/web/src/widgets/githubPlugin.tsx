import { useEffect, useState, type ReactNode } from "react";
import type { JsonObject } from "@polyth/contracts";
import { GITHUB_WIDGETS } from "@polyth/github";
import { api, type CurrentPrSummaryDto, type GhListResult } from "../api.ts";
import {
  defineWidgetPlugin,
  registerWidgetPlugin,
  type WidgetRenderContext,
  type WidgetSettingsContext,
} from "./catalog.ts";

type GithubSummaryMetric = "showFiles" | "showAdditions" | "showDeletions";

const SUMMARY_METRICS: ReadonlyArray<{ id: GithubSummaryMetric; label: string }> = [
  { id: "showFiles", label: "Changed files" },
  { id: "showAdditions", label: "Added lines" },
  { id: "showDeletions", label: "Removed lines" },
];

const metricVisible = (config: Readonly<JsonObject>, metric: GithubSummaryMetric): boolean =>
  config[metric] !== false;

export function GithubPrSummary({
  summary,
  config,
}: {
  summary: CurrentPrSummaryDto;
  config: Readonly<JsonObject>;
}) {
  const metrics = [
    metricVisible(config, "showFiles")
      ? { id: "files", label: "Files", value: summary.changedFiles, className: "" }
      : null,
    metricVisible(config, "showAdditions")
      ? { id: "additions", label: "Added", value: `+${summary.additions}`, className: "positive" }
      : null,
    metricVisible(config, "showDeletions")
      ? { id: "deletions", label: "Removed", value: `−${summary.deletions}`, className: "negative" }
      : null,
  ].filter((metric): metric is NonNullable<typeof metric> => metric !== null);
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

const RENDERERS: Record<string, (context: WidgetRenderContext) => ReactNode> = {
  "github.pr-summary": (context) => <GithubPrSummaryWidget {...context} />,
};

export const GITHUB_WIDGET_PLUGIN = defineWidgetPlugin({
  id: "github",
  name: "GitHub",
  widgets: GITHUB_WIDGETS.map(({ module, ...widget }) => ({
    ...widget,
    render: RENDERERS[module]!,
    settingsRender: (context: WidgetSettingsContext) => <GithubPrSummarySettings {...context} />,
  })),
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
