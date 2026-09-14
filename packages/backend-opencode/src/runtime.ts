import { posix } from "node:path";
import type {
  BorrowedRuntimeEndpointLease,
  JsonObject,
  ModelMessage,
  ModelRef,
  MutationOutcome,
  OpenCodeTransport,
  OwnedRuntimeEndpointLease,
  ProtocolAdapter,
  RuntimeEndpoint,
  RuntimeEndpointLease,
  RuntimeReconciliationBinding,
  RuntimeSessionBinding,
  RuntimeSnapshot,
  RuntimeTurnBinding,
} from "@polyth/contracts";
import { isOwnedEndpointLease } from "./endpoint.ts";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const bindingError = (message: string): Error =>
  Object.assign(new Error(message), { code: "binding-mismatch" });

const unavailable = (message: string, cause?: unknown): Error =>
  Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: "unavailable",
  });

const runtimeIsUnresponsive = (error: unknown): boolean => {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    const message = current instanceof Error ? current.message : String(current);
    if (/fetch failed|terminated|ECONNRESET|ECONNREFUSED|not ready|readiness probe|timed? ?out|exceeded .*ms/i.test(message)) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
};

const normalizeDirectory = (directory: string): string => {
  const trimmed = directory.trim();
  if (!trimmed) throw bindingError("runtime directory is required");
  return posix.normalize(trimmed);
};

const sameLocation = (
  left: RuntimeEndpoint["location"],
  right: RuntimeEndpoint["location"],
): boolean =>
  normalizeDirectory(left.directory) === normalizeDirectory(right.directory)
  && (left.workspace ?? "") === (right.workspace ?? "");

export interface RuntimeTransportFactory {
  (
    endpoint: RuntimeEndpoint,
    headers: Readonly<Record<string, string>>,
  ): OpenCodeTransport | Promise<OpenCodeTransport>;
}

export interface RuntimeProtocolFactory {
  (
    transport: OpenCodeTransport,
    endpoint: RuntimeEndpoint,
  ): ProtocolAdapter | Promise<ProtocolAdapter>;
}

export interface RuntimeLifecycleOptions {
  lease: RuntimeEndpointLease;
  createTransport: RuntimeTransportFactory;
  createProtocol: RuntimeProtocolFactory;
}

export type RuntimeSessionBindingWithProtocol = RuntimeSessionBinding & {
  protocol: ProtocolAdapter["protocol"];
};

export type RuntimeReconciliationBindingWithProtocol = RuntimeReconciliationBinding & {
  protocol: ProtocolAdapter["protocol"];
};

export type RuntimeTurnBindingWithProtocol = Omit<RuntimeTurnBinding, "session"> & {
  session: RuntimeSessionBindingWithProtocol;
};

export interface RuntimeBranchBindingWithProtocol {
  source: RuntimeSessionBindingWithProtocol;
  target: RuntimeSessionBindingWithProtocol;
  title?: string;
  history: ModelMessage[];
}

export interface RuntimeStreamObservation {
  authorityId: string;
  generation: number;
  location: RuntimeEndpoint["location"];
  value: unknown;
}

interface RuntimeGeneration {
  endpoint: RuntimeEndpoint;
  transport: OpenCodeTransport;
  protocol: ProtocolAdapter;
}

interface StoredBinding extends RuntimeSessionBindingWithProtocol {
  backendSessionId: string;
}

export interface BaseRuntimeLifecycle {
  readonly control: RuntimeEndpointLease["control"];
  endpoint(): Promise<RuntimeEndpoint>;
  refresh(reason: "connect" | "disconnect" | "unauthorized"): Promise<RuntimeEndpoint>;
  protocol(): Promise<ProtocolAdapter["protocol"]>;
  /** Execute against one atomic transport/protocol generation. Results from a
   * generation replaced while the operation is in flight are rejected. */
  usingProtocol<T>(
    operation: (protocol: ProtocolAdapter, endpoint: RuntimeEndpoint) => Promise<T>,
  ): Promise<T>;
  ensureSession(
    binding: RuntimeSessionBindingWithProtocol,
    operationId: string,
    title?: string,
  ): Promise<MutationOutcome<{ backendSessionId: string }>>;
  resetSession(
    binding: RuntimeSessionBindingWithProtocol,
    title: string | undefined,
    operationId: string,
  ): Promise<MutationOutcome<{ backendSessionId: string }>>;
  branchSession(
    binding: RuntimeBranchBindingWithProtocol,
    operationId: string,
  ): Promise<MutationOutcome<{ backendSessionId: string }>>;
  submit(
    binding: RuntimeTurnBindingWithProtocol,
    operationId: string,
  ): Promise<MutationOutcome<{ admissionId?: string }>>;
  steer(
    binding: RuntimeTurnBindingWithProtocol,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  abort(
    binding: RuntimeSessionBindingWithProtocol,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  compact(
    binding: RuntimeSessionBindingWithProtocol,
    operationId: string,
    model?: ModelRef,
  ): Promise<MutationOutcome<Record<string, never>>>;
  deleteSession(
    binding: RuntimeSessionBindingWithProtocol,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  replyPermission(
    binding: RuntimeSessionBindingWithProtocol,
    requestId: string,
    reply: "once" | "always" | "reject",
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  replyQuestion(
    binding: RuntimeSessionBindingWithProtocol,
    requestId: string,
    answers: JsonObject,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  reconcile(
    binding: RuntimeReconciliationBindingWithProtocol,
    after?: string,
  ): Promise<RuntimeSnapshot>;
  stream(
    path: string,
    options: {
      after?: string;
      signal: AbortSignal;
      onEvent(observation: RuntimeStreamObservation): void;
    },
  ): Promise<void>;
  streamEvents(options: {
    after?: string;
    signal: AbortSignal;
    onEvent(observation: RuntimeStreamObservation): void;
  }): Promise<void>;
  /** A generation fence for protocol callbacks that originate outside
   * `stream`, such as protocol-owned liveness hooks. */
  acceptGeneration(
    authorityId: string,
    generation: number,
    callback: () => void,
  ): boolean;
  dispose(): Promise<void>;
}

export interface OwnedRuntimeLifecycle extends BaseRuntimeLifecycle {
  readonly control: { kind: "owned"; instanceToken: string };
  restart(reason: "crash" | "config" | "manual"): Promise<RuntimeEndpoint>;
  /** Hold the generation-install lock across config safety reconciliation and
   * writes. Natural refreshes queue behind the action; its restart capability
   * is the only replacement allowed while the lock is held. */
  withConfigRestart<T>(
    action: (restart: () => Promise<RuntimeEndpoint>) => Promise<T>,
  ): Promise<T>;
}

export interface BorrowedRuntimeLifecycle extends BaseRuntimeLifecycle {
  readonly control: { kind: "borrowed"; source: "shared" | "external" };
}

export type RuntimeLifecycle = OwnedRuntimeLifecycle | BorrowedRuntimeLifecycle;

export const resolveRuntimeEndpointHeaders = async (
  endpoint: RuntimeEndpoint,
): Promise<Readonly<Record<string, string>>> => {
  const authentication = endpoint.authentication;
  if (authentication.kind === "none") return {};
  if (authentication.kind === "endpoint-headers") {
    return Object.freeze({ ...await authentication.resolve() });
  }
  const password = process.env[authentication.passwordEnv];
  if (!password) return {};
  const username = process.env[authentication.usernameEnv]
    ?? (authentication.usernameEnv === "OPENCODE_SERVER_USERNAME" ? "opencode" : undefined);
  if (!username) {
    throw unavailable(
      `OpenCode authentication requires the username environment variable ${authentication.usernameEnv}`,
    );
  }
  return Object.freeze({
    authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  });
};

const assertSnapshot = (
  snapshot: RuntimeSnapshot,
  generation: RuntimeGeneration,
  binding: RuntimeSessionBindingWithProtocol,
): void => {
  if (snapshot.authorityId !== generation.endpoint.authorityId) {
    throw bindingError("reconciliation authority does not match the current endpoint");
  }
  if (snapshot.generation !== generation.endpoint.generation) {
    throw bindingError("reconciliation generation is stale");
  }
  if (!sameLocation(snapshot.location, generation.endpoint.location)) {
    throw bindingError("reconciliation location does not match the current endpoint");
  }
  if (
    binding.backendSessionId
    && snapshot.backendSessionId !== binding.backendSessionId
  ) {
    throw bindingError("reconciliation backend session does not match its binding");
  }
};

/** Compose endpoint ownership, one transport, and one negotiated protocol as
 * an atomic generation. Refresh/restart never mixes the old HTTP/SSE transport
 * with the new endpoint or credentials. */
export const createRuntimeLifecycle = async (
  options: RuntimeLifecycleOptions,
): Promise<RuntimeLifecycle> => {
  let current: RuntimeGeneration | undefined;
  let replacement: Promise<RuntimeGeneration> | undefined;
  let queuedReplacement: Promise<RuntimeGeneration> | undefined;
  let replacementTail = Promise.resolve();
  let disposal: Promise<void> | undefined;
  let disposed = false;
  const bindings = new Map<string, StoredBinding>();
  const streamControllers = new Set<AbortController>();

  const abortStreams = (): void => {
    for (const controller of streamControllers) controller.abort();
    streamControllers.clear();
  };

  const build = async (endpoint: RuntimeEndpoint): Promise<RuntimeGeneration> => {
    const headers = await resolveRuntimeEndpointHeaders(endpoint);
    const transport = await options.createTransport(endpoint, headers);
    let protocol: ProtocolAdapter;
    try {
      protocol = await options.createProtocol(transport, endpoint);
    } catch (error) {
      throw unavailable(
        "OpenCode protocol negotiation failed; private daemon fallback is disabled",
        error,
      );
    }
    return { endpoint, transport, protocol };
  };

  const install = async (
    endpointPromise: Promise<RuntimeEndpoint>,
  ): Promise<RuntimeGeneration> => {
    const endpoint = await endpointPromise;
    if (disposed) throw unavailable("runtime lifecycle is disposed");
    if (
      current
      && current.endpoint.authorityId === endpoint.authorityId
      && current.endpoint.generation === endpoint.generation
      && current.endpoint.url === endpoint.url
    ) {
      return current;
    }
    const next = await build(endpoint);
    if (disposed) throw unavailable("runtime lifecycle was disposed during replacement");
    current = next;
    return next;
  };

  const replaceUnlocked = (
    endpointFactory: () => Promise<RuntimeEndpoint>,
  ): Promise<RuntimeGeneration> => {
    if (replacement) return replacement;
    // Fence and detach the complete old stream generation before endpoint
    // refresh/restart begins.
    abortStreams();
    // Once replacement starts, the old generation is no longer eligible for
    // query or mutation work. In particular, a failed owned restart has
    // already stopped its child; retaining `current` here would let the next
    // call reuse a dead URL instead of asking the lease to recover.
    current = undefined;
    replacement = install(endpointFactory()).finally(() => {
      replacement = undefined;
    });
    return replacement;
  };

  const withReplacementLock = async <T,>(action: () => Promise<T>): Promise<T> => {
    const previous = replacementTail;
    let release!: () => void;
    replacementTail = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  };

  const replaceSingleFlight = (
    endpointFactory: () => Promise<RuntimeEndpoint>,
  ): Promise<RuntimeGeneration> => {
    if (queuedReplacement) return queuedReplacement;
    queuedReplacement = withReplacementLock(
      () => replaceUnlocked(endpointFactory),
    ).finally(() => {
      queuedReplacement = undefined;
    });
    return queuedReplacement;
  };

  await replaceSingleFlight(() => options.lease.endpoint());

  const generation = async (): Promise<RuntimeGeneration> => {
    if (disposed) throw unavailable("runtime lifecycle is disposed");
    if (replacement) return replacement;
    if (!current) return replaceSingleFlight(() => options.lease.endpoint());
    const endpoint = await options.lease.endpoint();
    if (
      current.endpoint.authorityId === endpoint.authorityId
      && current.endpoint.generation === endpoint.generation
      && current.endpoint.url === endpoint.url
    ) {
      return current;
    }
    return replaceSingleFlight(async () => endpoint);
  };

  const bindingForCurrent = (
    input: RuntimeSessionBindingWithProtocol,
    active: RuntimeGeneration,
  ): RuntimeSessionBindingWithProtocol => {
    const endpoint = active.endpoint;
    if (input.authorityId !== endpoint.authorityId) {
      throw bindingError("session authority does not match the current endpoint");
    }
    if (!sameLocation(input.location, endpoint.location)) {
      throw bindingError("session location does not match the current endpoint");
    }
    if (input.protocol !== active.protocol.protocol) {
      throw bindingError("session protocol does not match the negotiated endpoint protocol");
    }
    if (input.continuity !== endpoint.continuity) {
      throw bindingError("session continuity does not match the current endpoint");
    }

    let next: RuntimeSessionBindingWithProtocol = {
      ...input,
      location: { ...endpoint.location },
    };
    if (input.generation !== endpoint.generation) {
      if (
        input.continuity !== "verified"
        || endpoint.continuity !== "verified"
      ) {
        throw bindingError("session generation is stale and endpoint continuity is unverified");
      }
      next = { ...next, generation: endpoint.generation };
    }

    const stored = bindings.get(input.canonicalSessionId);
    if (stored) {
      if (
        stored.authorityId !== next.authorityId
        || stored.protocol !== next.protocol
        || stored.continuity !== next.continuity
        || !sameLocation(stored.location, next.location)
      ) {
        throw bindingError("session binding conflicts with its existing backend binding");
      }
      if (
        next.backendSessionId
        && next.backendSessionId !== stored.backendSessionId
      ) {
        throw bindingError("backend session ID conflicts with its existing binding");
      }
      if (stored.generation !== endpoint.generation) {
        if (
          stored.continuity !== "verified"
          || endpoint.continuity !== "verified"
        ) {
          throw bindingError("existing backend binding cannot cross an unverified generation");
        }
        stored.generation = endpoint.generation;
      }
      return {
        ...next,
        backendSessionId: stored.backendSessionId,
        generation: stored.generation,
      };
    }
    return next;
  };

  const assertCurrentGeneration = (
    active: RuntimeGeneration,
    generation: number,
    label: string,
  ): void => {
    if (
      replacement
      || current !== active
      || current.endpoint.generation !== generation
    ) {
      throw bindingError(`${label} result belongs to an old endpoint generation`);
    }
  };

  const ensureSession = async (
    binding: RuntimeSessionBindingWithProtocol,
    operationId: string,
    title?: string,
  ): Promise<MutationOutcome<{ backendSessionId: string }>> => {
    const active = await generation();
    const checked = bindingForCurrent(binding, active);
    const outcome = await active.protocol.ensureSession(checked, operationId, title);
    // A replacement may complete while the old request is in flight. Its
    // result is fenced before it can update the binding table.
    assertCurrentGeneration(active, checked.generation, "session");
    if (outcome.kind === "confirmed") {
      bindings.set(checked.canonicalSessionId, {
        ...checked,
        backendSessionId: outcome.value.backendSessionId,
      });
    }
    return outcome;
  };

  const resetSession = async (
    binding: RuntimeSessionBindingWithProtocol,
    title: string | undefined,
    operationId: string,
  ): Promise<MutationOutcome<{ backendSessionId: string }>> => {
    const active = await generation();
    const checked = bindingForCurrent(binding, active);
    const outcome = await active.protocol.resetSession(checked, title, operationId);
    assertCurrentGeneration(active, checked.generation, "session reset");
    if (outcome.kind === "confirmed") {
      bindings.set(checked.canonicalSessionId, {
        ...checked,
        backendSessionId: outcome.value.backendSessionId,
      });
    }
    return outcome;
  };

  const branchSession = async (
    input: RuntimeBranchBindingWithProtocol,
    operationId: string,
  ): Promise<MutationOutcome<{ backendSessionId: string }>> => {
    const active = await generation();
    const source = bindingForCurrent(input.source, active);
    const target = bindingForCurrent(input.target, active);
    const outcome = await active.protocol.branchSession({
      source,
      target,
      ...(input.title ? { title: input.title } : {}),
      history: input.history,
    }, operationId);
    assertCurrentGeneration(active, source.generation, "session branch");
    if (outcome.kind === "confirmed") {
      bindings.set(target.canonicalSessionId, {
        ...target,
        backendSessionId: outcome.value.backendSessionId,
      });
    }
    return outcome;
  };

  const submit = async (
    turn: RuntimeTurnBindingWithProtocol,
    operationId: string,
  ): Promise<MutationOutcome<{ admissionId?: string }>> => {
    const active = await generation();
    const session = bindingForCurrent(turn.session, active);
    if (!session.backendSessionId) {
      throw bindingError("turn submission requires a bound backend session ID");
    }
    const outcome = await active.protocol.submit({ ...turn, session }, operationId);
    assertCurrentGeneration(active, session.generation, "turn");
    return outcome;
  };

  const sessionMutation = async (
    binding: RuntimeSessionBindingWithProtocol,
    operation: (
      protocol: ProtocolAdapter,
      checked: RuntimeSessionBindingWithProtocol,
    ) => Promise<MutationOutcome<Record<string, never>>>,
    label: string,
  ): Promise<MutationOutcome<Record<string, never>>> => {
    const active = await generation();
    const checked = bindingForCurrent(binding, active);
    if (!checked.backendSessionId) {
      throw bindingError(`${label} requires a bound backend session ID`);
    }
    const outcome = await operation(active.protocol, checked);
    assertCurrentGeneration(active, checked.generation, label);
    return outcome;
  };

  const steer = async (
    turn: RuntimeTurnBindingWithProtocol,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>> => {
    const active = await generation();
    const session = bindingForCurrent(turn.session, active);
    if (!session.backendSessionId) {
      throw bindingError("turn steering requires a bound backend session ID");
    }
    const outcome = await active.protocol.steer({ ...turn, session }, operationId);
    assertCurrentGeneration(active, session.generation, "turn steering");
    return outcome;
  };

  const abort = (
    binding: RuntimeSessionBindingWithProtocol,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>> =>
    sessionMutation(
      binding,
      (protocol, checked) => protocol.abort(checked, operationId),
      "turn abort",
    );

  const compact = (
    binding: RuntimeSessionBindingWithProtocol,
    operationId: string,
    model?: ModelRef,
  ): Promise<MutationOutcome<Record<string, never>>> =>
    sessionMutation(
      binding,
      (protocol, checked) => protocol.compact
        ? protocol.compact(checked, operationId, model)
        : Promise.resolve({
            kind: "rejected",
            code: "capability-unsupported",
            message: `${protocol.protocol} protocol does not support manual compaction`,
          }),
      "session compaction",
    );

  const deleteSession = async (
    binding: RuntimeSessionBindingWithProtocol,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>> => {
    const outcome = await sessionMutation(
      binding,
      (protocol, checked) => protocol.deleteSession(checked, operationId),
      "session delete",
    );
    if (outcome.kind === "confirmed") bindings.delete(binding.canonicalSessionId);
    return outcome;
  };

  const replyPermission = (
    binding: RuntimeSessionBindingWithProtocol,
    requestId: string,
    reply: "once" | "always" | "reject",
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>> =>
    sessionMutation(
      binding,
      (protocol, checked) =>
        protocol.replyPermission(checked, requestId, reply, operationId),
      "permission reply",
    );

  const replyQuestion = (
    binding: RuntimeSessionBindingWithProtocol,
    requestId: string,
    answers: JsonObject,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>> =>
    sessionMutation(
      binding,
      (protocol, checked) =>
        protocol.replyQuestion(checked, requestId, answers, operationId),
      "question reply",
    );

  const reconcile = async (
    input: RuntimeSessionBindingWithProtocol,
    after?: string,
  ): Promise<RuntimeSnapshot> => {
    const active = await generation();
    const binding = bindingForCurrent(input, active);
    if (!binding.backendSessionId) {
      throw bindingError("reconciliation requires a bound backend session ID");
    }
    const snapshot = await active.protocol.reconcile(binding, after);
    if (replacement || current !== active) {
      throw bindingError("reconciliation result belongs to an old endpoint generation");
    }
    assertSnapshot(snapshot, active, binding);
    return snapshot;
  };

  const usingProtocol = async <T,>(
    operation: (protocol: ProtocolAdapter, endpoint: RuntimeEndpoint) => Promise<T>,
  ): Promise<T> => {
    const active = await generation();
    const result = await operation(active.protocol, active.endpoint);
    if (replacement || current !== active) {
      throw bindingError("operation result belongs to an old endpoint generation");
    }
    return result;
  };

  const stream = async (
    path: string,
    streamOptions: {
      after?: string;
      signal: AbortSignal;
      onEvent(observation: RuntimeStreamObservation): void;
    },
    selected?: RuntimeGeneration,
  ): Promise<void> => {
    const active = selected ?? await generation();
    if (replacement || current !== active) {
      throw bindingError("stream belongs to an old endpoint generation");
    }
    const capturedAuthority = active.endpoint.authorityId;
    const capturedGeneration = active.endpoint.generation;
    const controller = new AbortController();
    streamControllers.add(controller);
    const abort = () => controller.abort(streamOptions.signal.reason);
    if (streamOptions.signal.aborted) abort();
    else streamOptions.signal.addEventListener("abort", abort, { once: true });
    try {
      await active.transport.stream({
        path,
        ...(streamOptions.after === undefined ? {} : { after: streamOptions.after }),
        signal: controller.signal,
        onEvent(value) {
          // This fence runs before the protocol callback receives raw data.
          if (
            replacement
            || current !== active
            || current.endpoint.authorityId !== capturedAuthority
            || current.endpoint.generation !== capturedGeneration
          ) {
            return;
          }
          streamOptions.onEvent({
            authorityId: capturedAuthority,
            generation: capturedGeneration,
            location: { ...active.endpoint.location },
            value,
          });
        },
      });
    } finally {
      streamControllers.delete(controller);
      streamOptions.signal.removeEventListener("abort", abort);
    }
  };

  const base: BaseRuntimeLifecycle = {
    get control() {
      return options.lease.control;
    },
    async endpoint() {
      return (await generation()).endpoint;
    },
    async refresh(reason) {
      try {
        const next = await replaceSingleFlight(() => options.lease.refresh(reason));
        return next.endpoint;
      } catch (error) {
        // Refresh first gives a healthy owned runtime a chance to reconnect
        // without losing native state. A failed readiness check means the
        // process we own is no longer serving: terminate its complete owned
        // boundary, advance generation, and let canonical Polyth sessions
        // rehydrate through the endpoint-replaced lifecycle event. The failed
        // request itself is never replayed here.
        const lease = options.lease;
        if (
          reason !== "disconnect"
          || !isOwnedEndpointLease(lease)
          || !runtimeIsUnresponsive(error)
        ) {
          throw error;
        }
        const next = await replaceSingleFlight(() => lease.restart("crash"));
        return next.endpoint;
      }
    },
    async protocol() {
      return (await generation()).protocol.protocol;
    },
    usingProtocol,
    ensureSession,
    resetSession,
    branchSession,
    submit,
    steer,
    abort,
    compact,
    deleteSession,
    replyPermission,
    replyQuestion,
    reconcile,
    stream,
    async streamEvents(streamOptions) {
      const active = await generation();
      const path = active.protocol.eventStreamPath();
      if (!path) {
        throw Object.assign(
          new Error(`${active.protocol.protocol} event streaming is not contract-tested`),
          { code: "capability-unsupported" },
        );
      }
      return stream(path, streamOptions, active);
    },
    acceptGeneration(authorityId, endpointGeneration, callback) {
      if (
        disposed
        || replacement !== undefined
        || !current
        || current.endpoint.authorityId !== authorityId
        || current.endpoint.generation !== endpointGeneration
      ) {
        return false;
      }
      callback();
      return true;
    },
    async dispose() {
      if (disposal) return disposal;
      disposed = true;
      disposal = withReplacementLock(async () => {
        try {
          await replacement;
        } catch {
          // Failed replacement has no transport resource contract to release.
        }
        abortStreams();
        current = undefined;
        bindings.clear();
        await options.lease.dispose();
      });
      return disposal;
    },
  };

  if (isOwnedEndpointLease(options.lease)) {
    const ownedLease: OwnedRuntimeEndpointLease = options.lease;
    const owned: OwnedRuntimeLifecycle = {
      ...base,
      get control() {
        return ownedLease.control;
      },
      async restart(reason) {
        const next = await replaceSingleFlight(() => ownedLease.restart(reason));
        return next.endpoint;
      },
      async withConfigRestart<T>(
        action: (restart: () => Promise<RuntimeEndpoint>) => Promise<T>,
      ): Promise<T> {
        return withReplacementLock(async () => {
          if (disposed) throw unavailable("runtime lifecycle is disposed");
          if (!current) await replaceUnlocked(() => ownedLease.endpoint());
          let restarted = false;
          return action(async () => {
            if (restarted) {
              throw new Error("config restart capability has already been used");
            }
            restarted = true;
            const next = await replaceUnlocked(() => ownedLease.restart("config"));
            return next.endpoint;
          });
        });
      },
    };
    return owned;
  }

  const borrowedLease: BorrowedRuntimeEndpointLease = options.lease;
  return {
    ...base,
    get control() {
      return borrowedLease.control;
    },
  };
};

export interface RuntimeReadyOptions {
  startupDeadlineMs: number;
  probeDeadlineMs?: number;
  retryDelayMs?: number;
  paths?: readonly string[];
}

/** Cheap liveness only. `/provider` and `/agent` initialize catalogs and can
 * take hundreds of milliseconds plus megabytes; they are not readiness. */
export const DEFAULT_RUNTIME_READY_PATHS = ["/global/health", "/api/health"] as const;

const probePath = async (
  transport: OpenCodeTransport,
  path: string,
  deadlineMs: number,
): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    const response = await Promise.race([
      transport.query<unknown>({
        method: "GET",
        path,
        deadlineMs,
      }),
      new Promise<never>((_, rejectProbe) => {
        timer = setTimeout(
          () => rejectProbe(unavailable(`readiness probe ${path} exceeded ${deadlineMs}ms`)),
          deadlineMs,
        );
      }),
    ]);
    const status = response && typeof response === "object" && "status" in response
      ? (response as { status?: unknown }).status
      : undefined;
    if (typeof status === "number" && (status < 200 || status >= 300)) {
      throw unavailable(`HTTP ${status}`);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** Probe under one absolute startup deadline. Health paths run in parallel so a
 * hung sibling cannot stall a path that is already 200. */
export const waitForRuntimeReady = async (
  transport: OpenCodeTransport,
  options: RuntimeReadyOptions,
): Promise<void> => {
  if (!Number.isFinite(options.startupDeadlineMs) || options.startupDeadlineMs <= 0) {
    throw new RangeError("startupDeadlineMs must be a positive finite number");
  }
  const probeDeadlineMs = options.probeDeadlineMs ?? 250;
  if (!Number.isFinite(probeDeadlineMs) || probeDeadlineMs <= 0) {
    throw new RangeError("probeDeadlineMs must be a positive finite number");
  }
  const paths = options.paths ?? DEFAULT_RUNTIME_READY_PATHS;
  if (paths.length === 0) {
    throw new RangeError("readiness probe requires at least one path");
  }
  const deadlineAt = Date.now() + options.startupDeadlineMs;
  let lastError = "";

  while (Date.now() < deadlineAt) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) break;
    const deadlineMs = Math.max(1, Math.min(probeDeadlineMs, remaining));
    try {
      await Promise.any(paths.map((path) => probePath(transport, path, deadlineMs)));
      return;
    } catch (error) {
      if (error instanceof AggregateError) {
        lastError = error.errors
          .map((cause) => cause instanceof Error ? cause.message : String(cause))
          .join("; ");
      } else {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    const retryRemaining = deadlineAt - Date.now();
    if (retryRemaining <= 0) break;
    await sleep(Math.min(options.retryDelayMs ?? 20, retryRemaining));
  }
  throw unavailable(
    `OpenCode runtime was not ready within ${options.startupDeadlineMs}ms${lastError ? ` (${lastError})` : ""}`,
  );
};
