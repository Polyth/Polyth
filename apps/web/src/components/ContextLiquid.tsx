import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { resolveModelContextLimit } from "@polyth/contracts/model-context";
import {
  contextGaugeForTelemetry,
  contextTelemetryStatus,
  formatContextPercent,
  type ContextGauge,
  type RenderModel,
} from "../reduce.ts";
import { usePendingSends, useStore } from "../store.ts";
import { tr } from "../i18n/index.ts";

/** The gauge the composer renders. `pending` marks the last known value of the
 *  same context identity while its current telemetry is briefly absent, so the
 *  liquid is dimmed rather than unmounted. Identity/reset changes clear it. */
export type ContextGaugeDisplay = ContextGauge & { pending?: boolean };

/** Context usage of the active session, derived exactly like the session-title
 *  indicator so the composer and the header never disagree. A route change can
 *  clear the current value for a moment; only the same model, harness, capacity
 *  and canonical reset boundary may retain the last value as visually pending. */
export function useActiveContextGauge(model: RenderModel): ContextGaugeDisplay {
  const activeSessionId = useStore((s) => s.activeSessionId);
  const session = useStore((s) => s.sessions.find((item) => item.id === s.activeSessionId) ?? null);
  const runtimeFeatures = useStore((s) => s.activeSessionId ? s.runtimeFeatures[s.activeSessionId] : undefined);
  const models = useStore((s) => s.models);
  const pendingSends = usePendingSends(activeSessionId);
  const pendingModel = pendingSends[pendingSends.length - 1]?.model;
  const activeModel = pendingModel ?? model.contextUsage?.model ?? model.turn?.model ?? session?.model;
  const contextTokens = resolveModelContextLimit(
    activeModel,
    models,
    session?.resolvedHarnessId,
  );
  const occupancy = session?.contextWindow;
  const resolved = contextGaugeForTelemetry(
    model,
    contextTokens,
    // A pending send changes the selected denominator before the runtime has
    // changed models. Qualify occupancy from the current canonical turn.
    occupancy && pendingModel ? { ...occupancy, model: model.turn?.model ?? session?.model } : occupancy ?? null,
    contextTelemetryStatus(runtimeFeatures?.telemetry),
    { model: activeModel, harnessId: session?.resolvedHarnessId },
  );
  const identityKey = JSON.stringify([
    activeSessionId, activeModel?.providerID, activeModel?.modelID, activeModel?.variant,
    session?.resolvedHarnessId, contextTokens, model.contextResetAt, model.contextEstimateAfterSeq,
  ]);
  const lastKnown = useRef<{ identityKey: string; gauge: ContextGauge } | null>(null);
  useEffect(() => {
    if (resolved.percent !== null) lastKnown.current = { identityKey, gauge: resolved };
    else if (lastKnown.current?.identityKey !== identityKey) lastKnown.current = null;
  });
  const pending = resolved.percent === null
    && lastKnown.current !== null
    && lastKnown.current.identityKey === identityKey;
  return pending ? { ...lastKnown.current!.gauge, pending: true } : resolved;
}

/** Tooltip suffix for an action that shows the context fill ("Context ~42%"). */
export function contextLiquidLabel(gauge: ContextGauge): string | null {
  const percent = formatContextPercent(gauge);
  return percent ? `${tr("railsurfaces.context")} ${percent}` : null;
}

/** The liquid that fills a running composer action with the session's
 *  context usage. The host button stays an outline while the context is empty
 *  and ends solid when it is full. `children` repeats the host's glyph: the
 *  copy lives inside the liquid, so the part of the glyph below the waterline
 *  switches to the ink color along the same wave. Unknown usage renders
 *  nothing and leaves the plain outline. */
export default function ContextLiquid({ gauge, children }: { gauge: ContextGaugeDisplay; children: ReactNode }) {
  if (gauge.percent === null) return null;
  return (
    <span
      className="context-liquid"
      data-pending={gauge.pending ? "true" : undefined}
      style={{ "--context-fill": `${gauge.percent}%` } as CSSProperties}
      aria-hidden="true"
    >
      <span className="context-liquid-wave context-liquid-back" />
      <span className="context-liquid-wave context-liquid-front">{children}</span>
    </span>
  );
}
