import { useEffect, useState, type ReactNode } from "react";
import type { SessionProjection } from "@polyth/contracts";
import type { RenderModel } from "../reduce.ts";
import { fmtCost, fmtTokens } from "../format.ts";
import { Icon } from "../icons.tsx";
import { useUiSettings, type HeaderMetricId } from "../uiPrefs.ts";
import { tr } from "../i18n/index.ts";

export function formatMetricDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

function sessionDuration(session: SessionProjection | null, model: RenderModel, now: number): number {
  if (!session || model.messages.length === 0) return 0;
  const first = model.messages[0]?.time ?? session.createdAt;
  const messageEnd = model.messages.reduce((latest, message) => {
    const completed = message.kind === "assistant" ? message.completedAt ?? message.time : message.time;
    return Math.max(latest, completed);
  }, first);
  const turnEnd = model.turn?.status === "working"
    ? now
    : model.turn?.stoppedAt ?? messageEnd;
  return Math.max(0, Math.max(messageEnd, turnEnd) - first);
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
  const messages = model.messages.filter((message) =>
    message.kind === "user" || message.kind === "assistant").length;
  const metrics: Record<HeaderMetricId, { label: string; value: string; icon: ReactNode }> = {
    tokens: { label: tr("chatmetrics.tokens"), value: fmtTokens(tokens).toUpperCase(), icon: <Icon.context /> },
    messages: { label: tr("chatmetrics.messages"), value: String(messages), icon: <Icon.events /> },
    duration: { label: tr("chatmetrics.duration"), value: formatMetricDuration(sessionDuration(session, model, now)), icon: <Icon.clock /> },
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
