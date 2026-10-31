import type {
  JsonObject,
  ModelRef,
  SessionEvent,
  SessionProjection,
  TokenUsage,
} from "@polyth/contracts";
import {
  canonicalProviderId,
  isPlaceholderProviderId,
  resolveSessionUsageProviderId,
} from "../providerIdentity.ts";
import { deriveUsageTiming, type UsageInterval } from "./timing.ts";
import type {
  UsageObservation,
  UsageObservationStatus,
  UsageQuality,
  UsageTokenBreakdown,
} from "./contracts.ts";

interface TurnContext {
  id: string;
  startedAt: number;
  model?: ModelRef;
  harnessId?: string;
  tools: Map<string, UsageInterval>;
  assistantTimes: number[];
  observationIds: string[];
  retries?: number;
  status?: UsageObservationStatus;
  stoppedAt?: number;
}

interface AssistantCandidate {
  event: SessionEvent;
  turnId?: string;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const finiteNonNegative = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const modelRef = (value: unknown): ModelRef | undefined => {
  const row = record(value);
  const providerID = text(row?.providerID);
  const modelID = text(row?.modelID);
  // Adapters write "unknown" when the native event names no model; treat it as
  // absent so the observation inherits the turn's or session's model instead.
  if (!modelID || modelID === "unknown") return undefined;
  return {
    providerID: providerID && !isPlaceholderProviderId(providerID) ? providerID : "unknown",
    modelID,
    ...(text(row?.variant) ? { variant: text(row?.variant)! } : {}),
  };
};

const tokenBreakdown = (value: unknown): UsageTokenBreakdown => {
  const row = record(value);
  return {
    input: finiteNonNegative(row?.input),
    output: finiteNonNegative(row?.output),
    reasoning: finiteNonNegative(row?.reasoning),
    cacheRead: finiteNonNegative(row?.cacheRead),
    cacheWrite: finiteNonNegative(row?.cacheWrite),
  };
};

const validQuality = (value: unknown): UsageQuality | undefined =>
  value === "exact" || value === "derived" || value === "estimated" ? value : undefined;

const costQuality = (value: unknown): UsageQuality | undefined => {
  if (value === "native" || value === "exact") return "exact";
  if (value === "derived") return "derived";
  if (value === "estimated") return "estimated";
  return undefined;
};

const stopStatus = (value: unknown): UsageObservationStatus | undefined => {
  if (value === "completed") return "completed";
  if (value === "error" || value === "failed") return "failed";
  if (value === "aborted" || value === "cancelled") return "cancelled";
  return undefined;
};

const retryCount = (value: unknown): number | undefined => {
  const row = record(value);
  const attempt = typeof value === "number" ? value : row?.attempt ?? row?.count;
  return typeof attempt === "number" && Number.isFinite(attempt) && attempt >= 0
    ? Math.floor(attempt)
    : undefined;
};

const eventData = (event: SessionEvent): JsonObject => event.data;

const turnKey = (turnId: string | undefined): string => turnId ?? "\u0000unbound";

const agentKindFor = (
  value: unknown,
  projection: SessionProjection,
): "main" | "subagent" =>
  value === "main" || value === "subagent"
    ? value
    : projection.parentId ? "subagent" : "main";

const hasUsageValue = (tokens: UsageTokenBreakdown, cost: number | null): boolean =>
  cost !== null || Object.values(tokens).some((value) => value !== null);

/**
 * OpenCode can attach the same message-level token sample to several finalized
 * text parts. Keep one candidate per message root when falling back to legacy
 * assistant telemetry, while retaining distinct messages/turns as separate
 * observations. The `:text:<ordinal>`/`:reasoning:<ordinal>` suffix is the V2
 * part convention; other part ids are already stable message identities.
 */
const assistantMessageKey = (event: SessionEvent): string => {
  const data = eventData(event);
  const messageId = text(data.messageId) ?? text(data.messageID);
  if (messageId) return `message:${messageId}`;
  const partId = text(data.partId) ?? `event:${event.id}`;
  const root = /^(.*):(?:text|reasoning):\d+$/.exec(partId)?.[1];
  return `part:${root ?? partId}`;
};

const modelForObservation = (
  usageModel: ModelRef | undefined,
  turn: TurnContext | undefined,
  projection: SessionProjection,
): ModelRef | undefined => {
  if (usageModel) return usageModel;
  if (turn?.model) return turn.model;
  return projection.model;
};

const providerForObservation = (
  model: ModelRef | undefined,
  turn: TurnContext | undefined,
  projection: SessionProjection,
  harnessId = turn?.harnessId ?? projection.resolvedHarnessId,
): string | undefined => {
  const provider = model?.providerID && !isPlaceholderProviderId(model.providerID)
    ? canonicalProviderId(model.providerID)
    : "";
  if (provider) return provider;
  return harnessId
    ? resolveSessionUsageProviderId({ ...projection, model: undefined, resolvedHarnessId: harnessId })
    : undefined;
};

const finalizeTurn = (
  turn: TurnContext,
  observations: Map<string, UsageObservation>,
): void => {
  const timing = turn.stoppedAt === undefined
    ? null
    : deriveUsageTiming({
      start: turn.startedAt,
      end: turn.stoppedAt,
      toolIntervals: [...turn.tools.values()],
      assistantTimes: turn.assistantTimes,
    });
  for (const id of turn.observationIds) {
    const observation = observations.get(id);
    if (!observation) continue;
    if (turn.status) observation.status = turn.status;
    if (turn.retries !== undefined) observation.retries = turn.retries;
    if (timing) {
      observation.timing = {
        totalMs: timing.totalMs,
        modelMs: timing.modelMs,
        toolMs: timing.toolMs,
        ...(timing.ttftMs === null ? {} : { ttftMs: timing.ttftMs }),
      };
    }
    observation.steps = turn.tools.size;
  }
};

/**
 * Project one canonical session log into stable observations. `usage/recorded`
 * is the exact per-response/per-step source; cumulative projection totals are
 * used only when a legacy session has no recoverable usage events and are
 * explicitly marked derived.
 */
export function collectSessionObservations(
  projection: SessionProjection,
  events: readonly SessionEvent[],
): UsageObservation[] {
  const observations = new Map<string, UsageObservation>();
  const turns = new Map<string, TurnContext>();
  const usageTurnCounts = new Map<string, number>();
  const assistantCandidates: AssistantCandidate[] = [];
  let currentTurnId: string | undefined;
  let lastTurnId: string | undefined;

  const turnFor = (turnId: string | undefined, at: number): TurnContext => {
    const id = turnId ?? `event-turn:${at}`;
    let turn = turns.get(id);
    if (!turn) {
      turn = { id, startedAt: at, tools: new Map(), assistantTimes: [], observationIds: [] };
      turns.set(id, turn);
    }
    return turn;
  };

  for (const event of events) {
    const data = eventData(event);
    if (event.type === "turn/started") {
      const id = text(data.turnId) ?? `event-turn:${event.seq}`;
      const turn = turnFor(id, event.time);
      turn.startedAt = event.time;
      turn.model = modelRef(data.model) ?? turn.model;
      turn.harnessId = text(data.harnessId) ?? turn.harnessId ?? projection.resolvedHarnessId;
      turn.status = undefined;
      turn.retries = undefined;
      turn.stoppedAt = undefined;
      currentTurnId = turn.id;
      lastTurnId = turn.id;
      continue;
    }

    if (event.type === "turn/stopped") {
      const id = text(data.turnId) ?? currentTurnId ?? `event-turn:${event.time}`;
      const turn = turnFor(id, event.time);
      turn.stoppedAt = event.time;
      turn.status = stopStatus(data.reason);
      const retries = retryCount(data.retry) ?? retryCount(data.retries);
      if (retries !== undefined) turn.retries = retries;
      finalizeTurn(turn, observations);
      if (currentTurnId === turn.id) currentTurnId = undefined;
      continue;
    }

    const turnId = text(data.turnId) ?? currentTurnId ?? lastTurnId;
    const turn = turnId ? turnFor(turnId, event.time) : undefined;
    if (event.type === "tool/call" || event.type === "tool/started") {
      if (!turn) continue;
      const callId = text(data.callId) ?? `tool:${event.seq}`;
      if (!turn.tools.has(callId)) turn.tools.set(callId, { start: event.time, end: event.time });
      continue;
    }
    if (event.type === "tool/result" || event.type === "tool/error") {
      if (!turn) continue;
      const callId = text(data.callId);
      if (!callId) continue;
      const open = turn.tools.get(callId);
      if (open) open.end = event.time;
      continue;
    }
    if (event.type === "assistant/chunk" || event.type === "assistant/reasoning-chunk" || event.type === "assistant/message") {
      turn?.assistantTimes.push(event.time);
      if (event.type === "assistant/message") {
        const tokens = tokenBreakdown(data.tokens);
        const cost = finiteNonNegative(data.cost);
        if (hasUsageValue(tokens, cost)) {
          assistantCandidates.push({ event, turnId: turn?.id });
        }
      }
      continue;
    }
    if (event.type !== "usage/recorded") continue;

    const usageKey = turnKey(turn?.id);
    const tokens = tokenBreakdown(data.tokens);
    if (!hasUsageValue(tokens, finiteNonNegative(data.cost))) continue;
    usageTurnCounts.set(usageKey, (usageTurnCounts.get(usageKey) ?? 0) + 1);
    const usageModel = modelRef(data.model);
    const model = modelForObservation(usageModel, turn, projection);
    const harnessId = text(data.harnessId) ?? turn?.harnessId ?? projection.resolvedHarnessId;
    const providerId = providerForObservation(model, turn, projection, harnessId);
    const cost = finiteNonNegative(data.cost);
    const quality = validQuality(data.quality) ?? costQuality(data.costSource) ?? "exact";
    const costSource = cost === null ? undefined : costQuality(data.costSource) ?? quality;
    const observation: UsageObservation = {
      id: `usage:${event.id}`,
      timestamp: event.time,
      projectId: projection.projectId,
      sessionId: projection.id,
      ...(turn?.id ? { turnId: turn.id } : {}),
      ...(providerId ? { providerId } : {}),
      ...(model?.modelID ? { modelId: model.modelID } : {}),
      ...(model?.variant ? { modelVariant: model.variant } : {}),
      ...(harnessId ? { harnessId } : {}),
      agentKind: agentKindFor(data.agentKind, projection),
      tokens,
      ...(cost === null ? {} : { cost, costSource: costSource! }),
      quality,
    };
    if (turn) {
      turn.harnessId = harnessId ?? turn.harnessId;
      turn.model = usageModel ?? turn.model;
      turn.observationIds.push(observation.id);
    }
    observations.set(observation.id, observation);
  }

  // Older adapters persisted token/cost telemetry on finalized assistant
  // messages but did not emit a separate usage event. Keep one fallback
  // observation per message in a turn, and never add it when that turn already
  // has a canonical usage observation. This prevents the repeated assistant
  // snapshots emitted by OpenCode from multiplying a turn's totals.
  const candidatesByMessage = new Map<string, AssistantCandidate>();
  for (const candidate of assistantCandidates) {
    const key = `${turnKey(candidate.turnId)}\u0000${assistantMessageKey(candidate.event)}`;
    candidatesByMessage.set(key, candidate);
  }
  for (const candidate of candidatesByMessage.values()) {
    if ((usageTurnCounts.get(turnKey(candidate.turnId)) ?? 0) > 0) continue;
    const data = eventData(candidate.event);
    const tokens = tokenBreakdown(data.tokens);
    const cost = finiteNonNegative(data.cost);
    if (!hasUsageValue(tokens, cost)) continue;
    const turn = candidate.turnId ? turns.get(candidate.turnId) : undefined;
    const model = modelForObservation(modelRef(data.model), turn, projection);
    const harnessId = text(data.harnessId) ?? turn?.harnessId ?? projection.resolvedHarnessId;
    const providerId = providerForObservation(model, turn, projection, harnessId);
    const quality = validQuality(data.quality) ?? "derived";
    const costSource = cost === null ? undefined : costQuality(data.costSource) ?? quality;
    const observation: UsageObservation = {
      id: `assistant:${candidate.event.id}`,
      timestamp: candidate.event.time,
      projectId: projection.projectId,
      sessionId: projection.id,
      ...(candidate.turnId ? { turnId: candidate.turnId } : {}),
      ...(providerId ? { providerId } : {}),
      ...(model?.modelID ? { modelId: model.modelID } : {}),
      ...(model?.variant ? { modelVariant: model.variant } : {}),
      ...(harnessId ? { harnessId } : {}),
      agentKind: agentKindFor(data.agentKind, projection),
      tokens,
      ...(cost === null ? {} : { cost, costSource: costSource! }),
      quality,
    };
    if (turn) {
      if (harnessId) turn.harnessId = harnessId;
      if (model) turn.model = model;
      turn.observationIds.push(observation.id);
    }
    observations.set(observation.id, observation);
  }

  // A usage event can be emitted just after a terminal event. Finalize every
  // turn once more so late observations inherit the already-known boundary.
  for (const turn of turns.values()) {
    if (turn.stoppedAt !== undefined) finalizeTurn(turn, observations);
  }

  if (observations.size === 0) {
    const totals: TokenUsage | undefined = projection.tokenTotals;
    if (!totals) return [];
    const timestamp = typeof projection.lastTurnAt === "number" && Number.isFinite(projection.lastTurnAt) && projection.lastTurnAt > 0
      ? projection.lastTurnAt
      : typeof projection.updatedAt === "number" && Number.isFinite(projection.updatedAt) && projection.updatedAt > 0
        ? projection.updatedAt
        : projection.createdAt;
    const model = projection.model;
    const providerId = resolveSessionUsageProviderId(projection);
    const cost = finiteNonNegative(projection.costTotal);
    observations.set(`derived:${projection.id}:${timestamp}`, {
      id: `derived:${projection.id}:${timestamp}`,
      timestamp,
      projectId: projection.projectId,
      sessionId: projection.id,
      ...(providerId ? { providerId } : {}),
      ...(model?.modelID ? { modelId: model.modelID } : {}),
      ...(model?.variant ? { modelVariant: model.variant } : {}),
      ...(projection.resolvedHarnessId ? { harnessId: projection.resolvedHarnessId } : {}),
      ...(projection.parentId ? { agentKind: "subagent" as const } : { agentKind: "main" as const }),
      tokens: tokenBreakdown(totals),
      ...(cost === null ? {} : { cost, costSource: "derived" }),
      quality: "derived",
    });
  }
  return [...observations.values()];
}
