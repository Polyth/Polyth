import type { CSSProperties } from "react";
import ProviderLogo from "../../../../packages/models/widgets/ProviderLogo.tsx";
import type { ContextGauge } from "../reduce.ts";
import type { ContextIndicatorMode } from "../uiPrefs.ts";

export default function ContextIndicator({
  gauge,
  mode,
  providerID,
  providerName,
  active,
}: {
  gauge: ContextGauge;
  mode: ContextIndicatorMode;
  providerID?: string;
  providerName?: string;
  active: boolean;
}) {
  const label = gauge.known ? `Context ${gauge.percent}%` : "Context usage unavailable";
  return (
    <span
      className={`context-indicator ${mode} ${gauge.level}${active ? " active" : ""}`}
      style={{ "--context-fill": `${gauge.percent ?? 0}%` } as CSSProperties}
      role="img"
      aria-label={label}
      title={label}
    >
      {mode === "logo" && <ProviderLogo providerID={providerID} providerName={providerName} size="compact" />}
    </span>
  );
}
