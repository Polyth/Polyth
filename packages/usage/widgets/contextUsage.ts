import type { ContextWindowState, ModelDescriptor, RuntimeFeaturesDto, SessionEvent, SessionProjection } from "@polyth/contracts";
import { resolveModelContextLimit } from "@polyth/contracts/model-context";
import { fmtTokens } from "../../../apps/web/src/format.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { useActiveModel, useStore } from "../../../apps/web/src/store.ts";
import {
  buildModel, contextGaugeForTelemetry, contextHasSample, contextTelemetryStatus,
  formatContextPercent, type ContextGauge, type RenderModel,
} from "../../../apps/web/src/reduce.ts";

const NO_EVENTS: SessionEvent[] = [];

const optionalFiniteNonNegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;

export function latestContextWindow(events: readonly SessionEvent[]): ContextWindowState | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "context/updated") continue;
    const candidate = event.data as unknown as Partial<ContextWindowState>;
    if (candidate.source !== "native"
      && candidate.source !== "derived"
      && candidate.source !== "estimated"
      && candidate.source !== "unknown") continue;
    const limitTokens = optionalFiniteNonNegative(candidate.limitTokens);
    const usedTokens = optionalFiniteNonNegative(candidate.usedTokens);
    const remainingTokens = optionalFiniteNonNegative(candidate.remainingTokens);
    const fraction = typeof candidate.fraction === "number" && Number.isFinite(candidate.fraction)
      ? candidate.fraction
      : undefined;
    const generation = typeof candidate.generation === "number" && Number.isFinite(candidate.generation)
      ? candidate.generation
      : undefined;
    return {
      source: candidate.source,
      updatedAt: typeof candidate.updatedAt === "number" && Number.isFinite(candidate.updatedAt)
        ? candidate.updatedAt
        : event.time,
      ...(limitTokens !== undefined ? { limitTokens } : {}),
      ...(usedTokens !== undefined ? { usedTokens } : {}),
      ...(remainingTokens !== undefined ? { remainingTokens } : {}),
      ...(fraction !== undefined ? { fraction } : {}),
      ...(candidate.compaction ? { compaction: candidate.compaction } : {}),
      ...(typeof candidate.harnessId === "string" ? { harnessId: candidate.harnessId } : {}),
      ...(generation !== undefined ? { generation } : {}),
    };
  }
  return null;
}

function newestContextWindow(
  first: ContextWindowState | null | undefined,
  second: ContextWindowState | null | undefined,
): ContextWindowState | null {
  if (!first) return second ?? null;
  if (!second) return first;
  return second.updatedAt >= first.updatedAt ? second : first;
}

export interface SessionContextDisplay {
  value: string;
  detail?: string;
  /** Occupied share of the window in `[0, 1]`, only when a percentage is shown. */
  fraction?: number;
  /** The shared context gauge's level, only for a known window. */
  level?: "green" | "yellow" | "red";
}

/** Context is current occupancy, independent of the analytics query's totals. */
function sessionContextGauge(
  model: RenderModel,
  catalog: readonly ModelDescriptor[],
  session: Pick<SessionProjection, "model" | "resolvedHarnessId" | "contextWindow"> | null,
  occupancy: ContextWindowState | null,
  telemetry?: RuntimeFeaturesDto["telemetry"],
): ContextGauge {
  const modelRef = model.turn?.model ?? session?.model ?? model.contextUsage?.model;
  return contextGaugeForTelemetry(
    model, resolveModelContextLimit(modelRef, catalog, session?.resolvedHarnessId),
    occupancy, contextTelemetryStatus(telemetry),
    { model: modelRef, harnessId: session?.resolvedHarnessId },
  );
}

export function sessionContextDisplay(
  model: RenderModel,
  catalog: readonly ModelDescriptor[],
  session: Pick<SessionProjection, "model" | "resolvedHarnessId" | "contextWindow"> | null,
  occupancy: ContextWindowState | null = session?.contextWindow ?? null,
  telemetry?: RuntimeFeaturesDto["telemetry"],
): SessionContextDisplay {
  return contextGaugeDisplay(sessionContextGauge(model, catalog, session, occupancy, telemetry));
}

export function contextGaugeDisplay(gauge: ContextGauge): SessionContextDisplay {
  const sample = contextHasSample(gauge)
    ? tr("context.tokens", { tokens: `${gauge.quality === "estimated" ? "~" : ""}${fmtTokens(gauge.inputTokens)}` })
    : "—";
  const percent = formatContextPercent(gauge);
  return {
    value: percent ?? sample,
    ...(gauge.known ? { detail: `${fmtTokens(gauge.inputTokens)} / ${fmtTokens(gauge.contextTokens)}` } : {}),
    ...(percent !== null && gauge.percent !== null ? { fraction: Math.max(0, Math.min(1, gauge.percent / 100)) } : {}),
    ...(gauge.known ? { level: gauge.level } : {}),
  };
}

/** The live gauge of one session: occupancy, limit and its green/yellow/red level. */
export function useSessionContextGauge(session: SessionProjection | null): ContextGauge {
  const activeSessionId = useStore((state) => state.activeSessionId);
  const activeModel = useActiveModel();
  const events = useStore((state) => (session ? state.events[session.id] : undefined) ?? NO_EVENTS);
  const catalog = useStore((state) => state.models);
  const features = useStore((state) => session ? state.runtimeFeatures[session.id] : undefined);
  const model = session && session.id === activeSessionId ? activeModel : buildModel(events);
  const occupancy = newestContextWindow(
    newestContextWindow(features?.contextWindow, latestContextWindow(events)),
    session?.contextWindow,
  );
  return sessionContextGauge(model, catalog, session, occupancy, features?.telemetry);
}

export function useSessionContext(session: SessionProjection | null): SessionContextDisplay {
  return contextGaugeDisplay(useSessionContextGauge(session));
}
