import { useEffect, useState, type ReactNode } from "react";
import type { SessionProjection } from "@polyth/contracts";
import type { RenderModel } from "../reduce.ts";
import { fmtCost, fmtTokens } from "../format.ts";
import { Icon } from "../icons.tsx";
import { useUiSettings, type HeaderMetricId } from "../uiPrefs.ts";
import { tr } from "../i18n/index.ts";
import { sessionDurationMs, sessionMessageCounts } from "../sessionMetrics.ts";

export function formatMetricDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

export default function ChatMetrics({
  session,
  model,
}: {
  session: SessionProjection | null;
  model: RenderModel;
}) {
  const { headerMetrics } = useUiSettings();
  const working = model.turn?.status === "working";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [working]);

  const tokens = model.totals.input + model.totals.output + model.totals.reasoning;
  const messages = sessionMessageCounts(model).all;
  const metrics: Record<HeaderMetricId, { label: string; value: string; icon: ReactNode }> = {
    tokens: { label: tr("chatmetrics.tokens"), value: fmtTokens(tokens).toUpperCase(), icon: <Icon.context /> },
    messages: { label: tr("chatmetrics.messages"), value: String(messages), icon: <Icon.events /> },
    duration: { label: tr("chatmetrics.duration"), value: formatMetricDuration(sessionDurationMs(session, model, now) ?? 0), icon: <Icon.clock /> },
    cost: { label: tr("chatmetrics.cost"), value: fmtCost(model.totals.cost), icon: <Icon.usage /> },
  };

  return (
    <div className="chat-metrics" aria-label={tr("chatmetrics.sessionMetrics")}>
      {headerMetrics.map((id) => {
        const metric = metrics[id];
        return (
        <div
          className="chat-metric"
          key={id}
          title={`${metric.label}: ${metric.value}`}
          data-metric={id}
        >
          <span className="chat-metric-icon" aria-hidden="true">{metric.icon}</span>
          <span>
            <small>{metric.label}</small>
            <strong>{metric.value}</strong>
          </span>
        </div>
        );
      })}
    </div>
  );
}
