// Read-only session debug facts. Never include prompts, tokens, credentials,
// or recoveryContext text. Callers must not attach or wake a runtime.

import type {
  DurableOperation,
  PersistedRuntimeBinding,
  RuntimeControl,
  RuntimeEndpoint,
  SessionDebugDto,
  SessionDebugEndpointDto,
  SessionDebugEpochReplacedDto,
  SessionDebugRecoveryPlanDto,
  SessionDebugRuntimeBindingDto,
  SessionEvent,
} from "@polyth/contracts";

export interface SessionDebugRecoveryStatsInput {
  epoch: number;
  markerSeq: number;
  omittedMessages: number;
  omittedPins?: number;
  omittedKnowledge?: number;
  omittedSummaries?: number;
  sectionsCapped: readonly string[];
  sectionChars: SessionDebugRecoveryPlanDto["sectionChars"];
  goalRestored?: boolean;
}

export interface SessionDebugObservabilityInput {
  binding?: PersistedRuntimeBinding;
  events: readonly SessionEvent[];
  operations?: readonly DurableOperation[];
  heldForReview?: number;
  endpoint?: SessionDebugEndpointDto | Pick<RuntimeEndpoint, "authorityId" | "generation" | "control">;
  recoveryPlan?: SessionDebugRecoveryStatsInput | null;
  recoveryRestored?: boolean;
}

export function snapshotDebugRuntimeBinding(
  binding: PersistedRuntimeBinding,
): SessionDebugRuntimeBindingDto {
  return {
    authorityId: binding.authorityId,
    generation: binding.generation,
    epoch: binding.epoch ?? 0,
    continuity: binding.continuity,
    protocol: binding.protocol,
    location: { ...binding.location },
    ...(binding.historyBaseline ? { historyBaseline: binding.historyBaseline } : {}),
  };
}

export function snapshotDebugEndpoint(
  endpoint: SessionDebugEndpointDto | Pick<RuntimeEndpoint, "authorityId" | "generation" | "control">,
): SessionDebugEndpointDto {
  return {
    authorityId: endpoint.authorityId,
    generation: endpoint.generation,
    control: debugControl(endpoint.control),
  };
}

export function lastRuntimeEpochReplaced(
  events: readonly SessionEvent[],
): SessionDebugEpochReplacedDto | undefined {
  const marker = events.findLast((event) => event.type === "runtime/epoch-replaced");
  if (!marker) return undefined;
  const data = marker.data as {
    reason?: unknown;
    old?: { authorityId?: unknown; generation?: unknown; epoch?: unknown };
    new?: { authorityId?: unknown; generation?: unknown; epoch?: unknown };
  };
  if (typeof data.reason !== "string") return undefined;
  const oldId = epochIdentity(data.old);
  const newId = epochIdentity(data.new);
  if (!oldId || !newId) return undefined;
  return { reason: data.reason, old: oldId, new: newId, seq: marker.seq };
}

function debugOperationCounts(
  operations: readonly DurableOperation[] | undefined,
  events: readonly SessionEvent[],
  heldForReview: number,
): SessionDebugDto["counts"] {
  if (operations) {
    return {
      fencedOperations: operations.filter((operation) => operation.state === "fenced").length,
      unknownOperations: operations.filter((operation) => operation.state === "unknown").length,
      heldForReview,
    };
  }
  let fencedOperations = 0;
  let unknownOperations = 0;
  for (const event of events) {
    if (event.type === "mutation/fenced") fencedOperations += 1;
    else if (event.type === "mutation/uncertainty-recorded") unknownOperations += 1;
  }
  return { fencedOperations, unknownOperations, heldForReview };
}

function debugRecoveryPlanStats(
  plan: SessionDebugRecoveryStatsInput | null | undefined,
  restored: boolean,
): SessionDebugRecoveryPlanDto | undefined {
  if (!plan) return undefined;
  return {
    epoch: plan.epoch,
    markerSeq: plan.markerSeq,
    omittedMessages: plan.omittedMessages,
    omittedPins: plan.omittedPins ?? 0,
    omittedKnowledge: plan.omittedKnowledge ?? 0,
    omittedSummaries: plan.omittedSummaries ?? 0,
    sectionsCapped: [...plan.sectionsCapped],
    sectionChars: { ...plan.sectionChars },
    goalRestored: plan.goalRestored ?? false,
    restored,
  };
}

export function sessionDebugObservability(
  input: SessionDebugObservabilityInput,
): Pick<
  SessionDebugDto,
  "runtimeBinding" | "endpoint" | "counts" | "lastEpochReplaced" | "recoveryPlan"
> {
  const lastEpochReplaced = lastRuntimeEpochReplaced(input.events);
  const recoveryPlan = debugRecoveryPlanStats(
    input.recoveryPlan,
    input.recoveryRestored ?? false,
  );
  return {
    ...(input.binding ? { runtimeBinding: snapshotDebugRuntimeBinding(input.binding) } : {}),
    ...(input.endpoint ? { endpoint: snapshotDebugEndpoint(input.endpoint) } : {}),
    counts: debugOperationCounts(input.operations, input.events, input.heldForReview ?? 0),
    ...(lastEpochReplaced ? { lastEpochReplaced } : {}),
    ...(recoveryPlan ? { recoveryPlan } : {}),
  };
}

function debugControl(
  control: RuntimeControl | SessionDebugEndpointDto["control"],
): SessionDebugEndpointDto["control"] {
  if (control.kind === "owned") return { kind: "owned" };
  return { kind: "borrowed", ...(control.source ? { source: control.source } : {}) };
}

function epochIdentity(value: {
  authorityId?: unknown;
  generation?: unknown;
  epoch?: unknown;
} | undefined): SessionDebugEpochReplacedDto["old"] | undefined {
  if (!value || typeof value.authorityId !== "string") return undefined;
  if (!Number.isSafeInteger(value.generation) || !Number.isSafeInteger(value.epoch)) {
    return undefined;
  }
  return {
    authorityId: value.authorityId,
    generation: value.generation as number,
    epoch: value.epoch as number,
  };
}
