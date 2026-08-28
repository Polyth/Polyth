import type {
  MutationOutcome,
  OpenCodeTransport,
  ProtocolAdapter,
  ProtocolCapabilities,
  RuntimeEndpoint,
  RuntimeReconciliationBinding,
  RuntimeSessionBinding,
  RuntimeSnapshot,
  RuntimeTurnBinding,
} from "@polyth/contracts";

export interface CreateV2ProtocolAdapterOptions {
  transport: OpenCodeTransport;
  endpoint: RuntimeEndpoint;
  deadlineMs?: number;
}

const capabilities: ProtocolCapabilities = {
  eventReplay: "none",
  pendingSnapshot: "none",
  idempotentMutations: new Set(),
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

/** Protocol discovery only. This does not enable any V2 behavior. */
export const hasV2ProtocolDocument = (document: unknown): boolean => {
  const body = asRecord(document);
  const nested = asRecord(body?.data);
  const paths = asRecord(body?.paths) ?? asRecord(nested?.paths);
  const names = paths ? Object.keys(paths) : [];
  return names.includes("/api/session")
    && names.some((path) => /\/api\/session\/\{[^}]+\}\/prompt$/.test(path));
};

const sameLocation = (
  left: RuntimeSessionBinding["location"],
  right: RuntimeSessionBinding["location"],
): boolean =>
  left.directory === right.directory
  && (left.workspace ?? "") === (right.workspace ?? "");

const bindingError = (
  binding: RuntimeSessionBinding,
  endpoint: RuntimeEndpoint,
): string | undefined => {
  if (binding.authorityId !== endpoint.authorityId) return "authority does not match endpoint";
  if (binding.generation !== endpoint.generation) return "endpoint generation is stale";
  if (!sameLocation(binding.location, endpoint.location)) return "location does not match endpoint";
  return undefined;
};

const rejected = <T>(operation: string): MutationOutcome<T> => ({
  kind: "rejected",
  code: "capability-unsupported",
  message: `OpenCode V2 ${operation} is disabled until its beta contract is pinned`,
});

/**
 * The installed V2 declarations are beta evidence, not an enabled behavior
 * contract. This adapter therefore negotiates as V2 but performs no generated
 * mutation, replay, cursor, pending-completeness, or status operation.
 */
export const createV2ProtocolAdapter = (
  options: CreateV2ProtocolAdapterOptions,
): ProtocolAdapter => {
  let reconciliationOrdinal = 0;
  // Keep the transport in the construction seam without allowing declarations
  // alone to trigger a request.
  void options.transport;
  void options.deadlineMs;

  return {
    protocol: "v2",
    async capabilities() {
      return capabilities;
    },
    async models() {
      return [];
    },
    async agents() {
      return [];
    },
    async sessions() {
      return [];
    },
    async history(input) {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) throw Object.assign(new Error(mismatch), { code: "binding-mismatch" });
      throw Object.assign(
        new Error("OpenCode V2 history is disabled until its beta contract is pinned"),
        { code: "capability-unsupported" },
      );
    },
    eventStreamPath() {
      return undefined;
    },
    async ensureSession(
      input: RuntimeSessionBinding,
      _operationId: string,
    ): Promise<MutationOutcome<{ backendSessionId: string }>> {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) {
        return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      }
      return rejected("session creation");
    },
    async resetSession(input, _title, _operationId) {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) {
        return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      }
      return rejected("session reset");
    },
    async branchSession(input, _operationId) {
      const mismatch = bindingError(input.source, options.endpoint)
        ?? bindingError(input.target, options.endpoint);
      if (mismatch) {
        return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      }
      return rejected("session branch");
    },
    async submit(
      input: RuntimeTurnBinding,
      _operationId: string,
    ): Promise<MutationOutcome<{ admissionId?: string }>> {
      const mismatch = bindingError(input.session, options.endpoint);
      if (mismatch) {
        return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      }
      return rejected("prompt admission");
    },
    async steer(input, _operationId) {
      const mismatch = bindingError(input.session, options.endpoint);
      if (mismatch) {
        return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      }
      return rejected("turn steering");
    },
    async abort(input, _operationId) {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) {
        return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      }
      return rejected("turn abort");
    },
    async deleteSession(input, _operationId) {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) {
        return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      }
      return rejected("session delete");
    },
    async replyPermission(input, _requestId, _reply, _operationId) {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) {
        return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      }
      return rejected("permission reply");
    },
    async replyQuestion(input, _requestId, _answers, _operationId) {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) {
        return { kind: "rejected", code: "binding-mismatch", message: mismatch };
      }
      return rejected("question reply");
    },
    async reconcile(input: RuntimeReconciliationBinding): Promise<RuntimeSnapshot> {
      const mismatch = bindingError(input, options.endpoint);
      if (mismatch) {
        throw Object.assign(new Error(mismatch), { code: "binding-mismatch" });
      }
      if (!input.backendSessionId) {
        throw Object.assign(
          new Error("V2 reconciliation requires a backend session binding"),
          { code: "binding-missing" },
        );
      }
      const requestedOrdinal = input.reconciliationOrdinal;
      const ordinal =
        Number.isSafeInteger(requestedOrdinal) && (requestedOrdinal ?? -1) >= 0
          ? requestedOrdinal!
          : ++reconciliationOrdinal;
      reconciliationOrdinal = Math.max(reconciliationOrdinal, ordinal);
      return {
        authorityId: input.authorityId,
        generation: input.generation,
        location: input.location,
        backendSessionId: input.backendSessionId,
        reconciliationOrdinal: ordinal,
        state: { value: "unknown" },
        completeness: {
          events: "unverifiable",
          permissions: "unverifiable",
          questions: "unverifiable",
        },
        permissions: [],
        questions: [],
        events: [],
      };
    },
  };
};
