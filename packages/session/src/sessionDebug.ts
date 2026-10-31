// Read-only session debug facts. Never include prompts, tokens, credentials,
// or recoveryContext text. Callers must not attach or wake a runtime.

import type {
  DurableOperation,
  PersistedRuntimeBinding,
  RuntimeControl,
  RuntimeEndpoint,
  SessionDebugDto,
  SessionDebugErrorDto,
  SessionDebugEndpointDto,
  SessionDebugEpochReplacedDto,
  SessionDebugRecoveryPlanDto,
  SessionDebugRuntimeBindingDto,
  SessionEvent,
} from "@polyth/contracts";

const MCP_TOOL_ERROR_FALLBACK = "MCP tool call failed";

const diagnosticLabel = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  return label.length > 0
    && label.length <= 160
    && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(label)
    ? label
    : undefined;
};

export function formatDiagnosticErrorMessage(raw: string): string {
  const trimmed = raw.trim();
  const statusMatch = trimmed.match(/^(?:HTTP\s*)?(\d{3})[:—–]\s*(\{[\s\S]*\})$/);
  if (statusMatch && statusMatch[1] && statusMatch[2]) {
    const statusCode = statusMatch[1];
    const jsonStr = statusMatch[2];
    try {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      const err = (parsed?.error && typeof parsed.error === "object" ? parsed.error : undefined) as Record<string, unknown> | undefined;
      const inner = parsed?.message ?? err?.message ?? parsed?.error;
      if (typeof inner === "string" && inner.trim()) {
        return `${inner.trim()} (HTTP ${statusCode})`;
      }
    } catch {}
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const err = (parsed?.error && typeof parsed.error === "object" ? parsed.error : undefined) as Record<string, unknown> | undefined;
      const inner = parsed?.message ?? err?.message ?? parsed?.error;
      if (typeof inner === "string" && inner.trim()) {
        return inner.trim();
      }
    } catch {}
  }
  return trimmed;
}

/** Project failures without their tool arguments. Pair terminal tool events
 * with their start event so debug consumers can identify the slow boundary. */
export function sessionDebugRecentErrors(
  events: readonly SessionEvent[],
): SessionDebugErrorDto[] {
  const toolStarts = new Map<string, number>();
  const errors: SessionDebugErrorDto[] = [];
  for (const event of events) {
    const data = event.data as Record<string, unknown>;
    const callId = diagnosticLabel(data.callId);
    const isToolStart = event.type === "tool/started"
      || (event.type === "tool/call" && data.status === "running");
    if (event.type === "turn/started") toolStarts.clear();
    if (isToolStart && callId) {
      toolStarts.set(callId, event.time);
      continue;
    }

    const failedStop = event.type === "turn/stopped" && data.reason === "error";
    const failedType = event.type === "turn/failed"
      || event.type === "tool/error"
      || event.type.endsWith("/failed");
    if (failedStop || failedType) {
      const raw = data.error ?? data.message ?? data.reason ?? "unknown error";
      const message = formatDiagnosticErrorMessage(typeof raw === "string" ? raw : JSON.stringify(raw));
      const input = data.input && typeof data.input === "object" && !Array.isArray(data.input)
        ? data.input as Record<string, unknown>
        : undefined;
      const mcpServer = diagnosticLabel(data.mcpServer)
        ?? diagnosticLabel(data.server)
        ?? diagnosticLabel(input?.server);
      const tool = diagnosticLabel(data.tool);
      const operation = diagnosticLabel(data.operation);
      const code = diagnosticLabel(data.code);
      const startedAt = callId ? toolStarts.get(callId) : undefined;
      const durationMs = startedAt !== undefined && event.time >= startedAt
        ? event.time - startedAt
        : undefined;
      errors.push({
        seq: event.seq,
        time: event.time,
        type: event.type,
        message,
        ...(callId ? { callId } : {}),
        ...(tool ? { tool } : {}),
        ...(mcpServer ? { mcpServer } : {}),
        ...(operation ? { operation } : {}),
        ...(code ? { code } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(event.type === "tool/error" && message === MCP_TOOL_ERROR_FALLBACK
          ? { messageFallback: true as const }
          : {}),
      });
    }

    if ((event.type === "tool/result" || event.type === "tool/error") && callId) {
      toolStarts.delete(callId);
    }
    if (event.type === "turn/stopped") toolStarts.clear();
  }
  return errors.slice(-20);
}

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
