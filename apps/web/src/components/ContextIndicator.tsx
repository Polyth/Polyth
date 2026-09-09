import type { CSSProperties } from "react";
import ProviderLogo from "../../../../packages/models/widgets/ProviderLogo.tsx";
import {
  contextTelemetryNotice,
  formatContextPercent,
  type ContextGauge,
  type ContextTelemetryStatus,
} from "../reduce.ts";
import type { ContextIndicatorMode } from "../uiPrefs.ts";

export default function ContextIndicator({
  gauge,
  mode,
  providerID,
  providerName,
  harnessId,
  active,
  telemetryStatus = "unknown",
}: {
  gauge: ContextGauge;
  mode: ContextIndicatorMode;
  providerID?: string;
  providerName?: string;
  harnessId?: string;
  active: boolean;
  telemetryStatus?: ContextTelemetryStatus;
}) {
  const notice = contextTelemetryNotice(telemetryStatus, gauge);
  const percentLabel = notice ? null : formatContextPercent(gauge);
  const label = notice ?? (percentLabel ? `Context ${percentLabel}` : "Context usage unavailable");
  return (
    <span
      className={`context-indicator ${mode} ${gauge.level}${active ? " active" : ""}`}
      style={{ "--context-fill": `${gauge.percent ?? 0}%` } as CSSProperties}
      role="img"
      aria-label={label}
      title={label}
    >
      {mode === "logo" && <ProviderLogo providerID={providerID} providerName={providerName} harnessId={harnessId} size="compact" />}
    </span>
  );
}
