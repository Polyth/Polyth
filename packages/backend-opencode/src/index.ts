/*
OpenCode 1.18.18 serve API (empirically verified 2026-08-17 against
`opencode serve --port 4556 --hostname 127.0.0.1` + GET /doc + bundled SDK
~/.opencode/node_modules/@opencode-ai/sdk).

Auth: when OPENCODE_SERVER_PASSWORD is set, HTTP Basic uses
OPENCODE_SERVER_USERNAME (the direct legacy-client compatibility default is `opencode`).
Listening line: `opencode server listening on http://127.0.0.1:<port>`

The verified legacy wire shapes live exclusively in `protocolLegacy.ts`.
Protocol discovery is read-only and lives in `protocol.ts`; V2 remains
capability-gated.

SSE event names observed live (JSON `data:` objects, field `id` = evt_…; no SSE `id:` lines):
  server.connected
  session.created / session.updated / session.diff / session.status {type:busy|idle} / session.idle / session.error
  message.updated  properties.info  (role user|assistant; assistant has cost, tokens, time.completed?)
  message.part.updated  properties.{sessionID, part:{id,type,text|state,...}, delta?, time}
  message.part.delta    properties.{sessionID,messageID,partID,field:"text"|"reasoning",delta}
  permission.updated (SDK) / permission.asked (OpenAPI) / permission.replied
  question.asked / question.replied / question.rejected
  plugin.added, catalog.updated, … (ignored)
*/

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  AgentRuntime,
  CanonicalTurnRequest,
  Disposable,
  JsonObject,
  ModelRef,
  MutationOutcome,
  RuntimeBranchRequest,
  RuntimeEndpoint,
  RuntimeCapabilities,
  RuntimeEndpointLease,
  RuntimeEvent,
  RuntimeObservation,
} from "@polyth/contracts";
import {
  admitTranslateTurn,
  asOcEvent,
  backendSessionId,
  claimTerminalStateEvidence,
  createTranslateState,
  errorMessageOf,
  providerLimitOf,
  finishTranslateTurn,
  flushAssistantOnIdle,
  markTranslateTurnAborting,
  normalizeOcObservation,
  splitNormalizedObservation,
  translateOcEvent,
  type TranslateState,
} from "./events.ts";
import { classifyProviderLimitNotice } from "./providerLimit.ts";
import {
  createOwnedLocalEndpointLease,
} from "./endpoint.ts";
import {
  createRuntimeLifecycle,
  waitForRuntimeReady,
  type RuntimeLifecycle,
  type RuntimeSessionBindingWithProtocol,
} from "./runtime.ts";
import {
  createOpenCodeTransport,
  type OpenCodeTransportOptions,
} from "./transport.ts";
import {
  createProtocolAdapter,
  type ProtocolSelection,
} from "./protocol.ts";
import { completeSmallModelDirect } from "./smallModel.ts";

export interface OpenCodeAdapterOptions {
  projectId?: string;
  spaceId?: string;
  cwd: string;
  port?: number;
  hostname?: string;
  bin?: string;
  binarySource?: "bundled" | "configured";
  configDir?: string;
  /** @deprecated Use configDir. */
  dataDir?: string;
  runtimeDir?: string;
  stateFile?: string;
  protocol?: ProtocolSelection;
  configTargetId?: string;
  startupDeadlineMs?: number;
  probeDeadlineMs?: number;
}

export {
  createConfigApplier,
  normalizePluginEntries,
  projectManagedMcp,
  stripJsonc,
} from "./config.ts";
export {
  applyOpenCodeLaunchOverlay,
  createOpenCodeProvisioner,
  peekOpenCodeLaunchOverlay,
  polythSkillId,
} from "./provisioner.ts";
export { createOpenCodeHarness } from "./harness.ts";
export type { OpenCodeLaunchOverlay } from "./provisioner.ts";
export type {
  BackendConfigApplier,
  McpApplyBatch,
  McpApplyEntry,
  ProviderVisibilityApply,
} from "./config.ts";
export {
  adapterForProtocol,
  addManualModelIntoProvider,
  applyHeaderPatch,
  applyProviderOps,
  dropCustomProvider,
  inspectProviderEntry,
  isCustomProviderEntry,
  mergeCustomProvider,
  mergeDiscoveredIntoProvider,
  projectConfig,
  protocolFromNpm,
  reconcileDiscoveredModels,
} from "./customProvider.ts";
export type { StagedProviderOp } from "./customProvider.ts";
export { createProviderHttpClient } from "./providerHttp.ts";
export type { ProviderHttpClient, ProviderHttpTransport } from "./providerHttp.ts";
export {
  createRemoteOpenCodeRuntime,
  installRemoteOpenCode,
  probeRemoteOpenCode,
} from "./remote.ts";
export type { RemoteOpenCodeOptions, RemoteOpenCodeProbe } from "./remote.ts";
export {
  DEFAULT_REMOTE_RUNTIME_ROOT_EXPR,
  prepareRemoteOpenCodeRuntime,
  resolveRemoteRuntimeDir,
} from "./remoteStorage.ts";
export {
  createBorrowedExternalEndpointLease,
  createBorrowedServiceEndpointLease,
  createOwnedLocalEndpointLease,
  createOwnedSshEndpointLease,
  isOwnedEndpointLease,
  LISTEN_RE,
  ownedSshRuntimeIdentityKey,
  pickFreePort,
  pidFileForDirectory,
  readProcessIdentity,
} from "./endpoint.ts";
export type {
  BorrowedExternalEndpointOptions,
  BorrowedServiceDescriptor,
  BorrowedServiceEndpointOptions,
  OwnedLocalEndpointOptions,
  OwnedSshEndpointOptions,
  OwnedSshStorageIdentity,
  ProcessIdentity,
  ProcessIdentityReader,
  ProcessSignaler,
} from "./endpoint.ts";
export {
  createRuntimeLifecycle,
  DEFAULT_RUNTIME_READY_PATHS,
  waitForRuntimeReady,
} from "./runtime.ts";
export {
  inspectOpenCodeEngine,
  OPEN_CODE_QUARANTINE_TTL_MS,
  OPEN_CODE_RUNTIME_STALE_TTL_MS,
  OPENCODE_UPDATE_DISABLE_ENV,
  OPENCODE_PROTOCOL_GENERATION,
  POLYTH_OPENCODE_BIN_ENV,
  parseOpenCodeRuntimeMetadata,
  openCodeEnginesMatch,
  prepareOpenCodeRuntime,
  resolveOpenCodeBinary,
  sweepOpenCodeRuntimes,
} from "./runtimeStorage.ts";
export type {
  OpenCodeBinarySource,
  OpenCodeEngineIdentity,
  OpenCodeRuntimeMetadata,
  PreparedOpenCodeRuntime,
  ResolvedOpenCodeBinary,
} from "./runtimeStorage.ts";
export type {
  BaseRuntimeLifecycle,
  BorrowedRuntimeLifecycle,
  OwnedRuntimeLifecycle,
  RuntimeBranchBindingWithProtocol,
  RuntimeLifecycle,
  RuntimeLifecycleOptions,
  RuntimeSessionBindingWithProtocol,
  RuntimeStreamObservation,
  RuntimeTurnBindingWithProtocol,
} from "./runtime.ts";
export { createOpenCodeTransport } from "./transport.ts";
export type { OpenCodeTransportOptions } from "./transport.ts";
export {
  createProtocolAdapter,
  probeProtocol,
} from "./protocol.ts";
export { flattenLegacyModels as flattenModels } from "./protocolLegacy.ts";
export type {
  CreateProtocolAdapterOptions,
  ProtocolProbe,
  ProtocolSelection,
} from "./protocol.ts";

export const CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  permissions: true,
  questions: true,
  compaction: true,
  subagents: true,
  // Process can consume MCP at startup. Provisioning mutability is separate
  // (requires-restart) and lives on HarnessCapabilitySupport.
  mcp: true,
  // live steering: a prompt posted to a busy session joins the active turn;
  // steer() reports false on rejection so callers can fall back to queueing
  steering: true,
  resume: true,
  usage: true,
  cost: true,
  fork: true,
  title: "native",
  attachments: {
    modalities: {
      image: "native",
      file: "native",
      url: "emulated",
      pdf: "native",
      audio: "unsupported",
    },
  },
  commands: { discovery: "unsupported", invoke: "unsupported" },
  contextOccupancy: "unknown",
};

type Listener = (sessionId: string, ev: RuntimeEvent) => void;

interface SessionMaps {
  forward: Map<string, string>;
  reverse: Map<string, string>;
}

const mapsFrom = (sessionIdMap?: Map<string, string>): SessionMaps => {
  const forward = sessionIdMap ?? new Map<string, string>();
  const reverse = new Map<string, string>();
  for (const [canonical, backend] of forward) reverse.set(backend, canonical);
  return { forward, reverse };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface OpenCodeRuntimeExtras {
  /** Generation-aware seam shared by production and socket-backed tests. */
  lifecycle: RuntimeLifecycle;
  sessionIdMap?: Map<string, string>;
  log?: (level: "debug" | "info" | "warn" | "error", msg: string, data?: JsonObject) => void;
  cwd?: string;
  /** Optional liveness policy for deployments whose endpoint promises
   * heartbeats. Disabled by default because an idle legacy SSE may be quiet. */
  sseStallMs?: number;
  /** Command Code can report a provider-window stop as reasoning and then
   * leave SSE live without a terminal event. After this quiet grace period,
   * synthesize the normal retryable terminal event. Test seam only. */
  rateLimitStallMs?: number;
}

export interface OpenCodeRuntimeLifecycleOptions {
  lease: RuntimeEndpointLease;
  protocol?: ProtocolSelection;
  protocolDeadlineMs?: number;
  startupDeadlineMs?: number;
  probeDeadlineMs?: number;
  transport?: Omit<OpenCodeTransportOptions, "baseUrl" | "headers" | "directory">;
}

/** Public wiring point: transport and protocol factories are generation-local
 * and rebuilt together whenever the endpoint lease changes. */
export const createOpenCodeRuntimeLifecycle = async (
  options: OpenCodeRuntimeLifecycleOptions,
): Promise<RuntimeLifecycle> =>
  await createRuntimeLifecycle({
    lease: options.lease,
    createTransport(endpoint, headers) {
      return createOpenCodeTransport({
        ...options.transport,
        baseUrl: endpoint.url,
        headers,
        directory: endpoint.location.directory,
      });
    },
    async createProtocol(transport, endpoint) {
      await waitForRuntimeReady(transport, {
        startupDeadlineMs: options.startupDeadlineMs ?? 20_000,
        probeDeadlineMs: options.probeDeadlineMs ?? 250,
      });
      return await createProtocolAdapter({
        protocol: options.protocol ?? "auto",
        transport,
        endpoint,
        deadlineMs: options.protocolDeadlineMs,
      });
    },
  });

export interface ManagedOpenCodeRuntime extends AgentRuntime {
  readonly lifecycle: RuntimeLifecycle;
}

export const attachRuntimeLifecycle = (
  facade: AgentRuntime,
  lifecycle: RuntimeLifecycle,
): ManagedOpenCodeRuntime => {
  const lifecycleListeners = new Set<
    Parameters<NonNullable<AgentRuntime["onLifecycle"]>>[0]
  >();
  const subscribeFacadeLifecycle = facade.onLifecycle?.bind(facade);
  facade.onLifecycle = (callback) => {
    lifecycleListeners.add(callback);
    const subscription = subscribeFacadeLifecycle?.(callback);
    return {
      dispose() {
        lifecycleListeners.delete(callback);
        subscription?.dispose();
      },
    };
  };
  const emitEndpointReplacement = (
    endpoint: RuntimeEndpoint,
    reason: Parameters<RuntimeLifecycle["refresh"]>[0] | "crash" | "config" | "manual",
  ): void => {
    for (const callback of lifecycleListeners) {
      callback({
        type: "endpoint-replaced",
        authorityId: endpoint.authorityId,
        generation: endpoint.generation,
        reason,
      });
    }
  };
  const refresh = lifecycle.refresh.bind(lifecycle);
  lifecycle.refresh = async (reason) => {
    const previous = await lifecycle.endpoint();
    const endpoint = await refresh(reason);
    if (
      endpoint.authorityId !== previous.authorityId
      || endpoint.generation !== previous.generation
    ) {
      emitEndpointReplacement(endpoint, reason);
    }
    return endpoint;
  };
  if (lifecycle.control.kind === "owned" && "restart" in lifecycle) {
    const restart = lifecycle.restart.bind(lifecycle);
    lifecycle.restart = async (reason) => {
      const previous = await lifecycle.endpoint();
      const endpoint = await restart(reason);
      if (
        endpoint.authorityId !== previous.authorityId
        || endpoint.generation !== previous.generation
      ) {
        emitEndpointReplacement(endpoint, reason);
      }
      return endpoint;
    };
    const withConfigRestart = lifecycle.withConfigRestart.bind(lifecycle);
    lifecycle.withConfigRestart = async (action) =>
      withConfigRestart(async (restartGeneration) => {
        let previous = await lifecycle.endpoint();
        return action(async () => {
          const endpoint = await restartGeneration();
          if (
            endpoint.authorityId !== previous.authorityId
            || endpoint.generation !== previous.generation
          ) {
            emitEndpointReplacement(endpoint, "config");
          }
          previous = endpoint;
          return endpoint;
        });
      });
  }
  facade.endpoint ??= () => lifecycle.endpoint();
  facade.protocol ??= () => lifecycle.protocol();
  facade.reconcile ??= async (binding, after) => {
    const protocol = await lifecycle.protocol();
    return lifecycle.reconcile({ ...binding, protocol }, after);
  };
  return Object.assign(facade, { lifecycle });
};

/** Provider-neutral facade over one lifecycle. It owns translation/listeners
 * only; every wire path is selected by the lifecycle's protocol adapter. */
export const createOpenCodeRuntimeFacade = (
  extras: OpenCodeRuntimeExtras,
): AgentRuntime => {
  const lifecycle = extras.lifecycle;
  const maps = mapsFrom(extras.sessionIdMap);
  const listeners = new Set<Listener>();
  const observationListeners = new Set<(sessionId: string, observation: RuntimeObservation) => void>();
  const lifecycleListeners = new Set<Parameters<NonNullable<AgentRuntime["onLifecycle"]>>[0]>();
  const translate = new Map<string, TranslateState>();
  const activeTurn = new Map<string, { turnId: string; aborting: boolean }>();
  const rateLimitStalls = new Map<string, {
    turnId: string;
    hint: NonNullable<ReturnType<typeof classifyProviderLimitNotice>>;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const suppressedAfterAbort = new Set<string>();
  const reconciliationOrdinals = new Map<string, number>();
  const seenEventIds = new Set<string>();
  const log = extras.log ?? ((level, msg, data) => {
    if (level === "debug") console.debug(msg, data ?? "");
  });

  let sseAbort: AbortController | undefined;
  let disposed = false;

  const clearRateLimitStall = (sessionId: string): void => {
    const stall = rateLimitStalls.get(sessionId);
    if (!stall) return;
    clearTimeout(stall.timer);
    rateLimitStalls.delete(sessionId);
  };

  const armRateLimitStall = (
    sessionId: string,
    turn: { turnId: string; aborting: boolean },
    hint: NonNullable<ReturnType<typeof classifyProviderLimitNotice>>,
  ): void => {
    clearRateLimitStall(sessionId);
    const timer = setTimeout(() => {
      const pending = rateLimitStalls.get(sessionId);
      if (!pending || pending.turnId !== turn.turnId || activeTurn.get(sessionId) !== turn) return;
      rateLimitStalls.delete(sessionId);
      activeTurn.delete(sessionId);
      finishTranslateTurn(stateFor(sessionId), turn.turnId);
      emit(sessionId, {
        type: "turn/stopped",
        reason: "error",
        error: "provider rate limit reached",
        retry: hint,
      });
    }, extras.rateLimitStallMs ?? 15_000);
    timer.unref?.();
    rateLimitStalls.set(sessionId, { turnId: turn.turnId, hint, timer });
  };

  const touchRateLimitStall = (sessionId: string): void => {
    const pending = rateLimitStalls.get(sessionId);
    const turn = activeTurn.get(sessionId);
    if (pending && turn && pending.turnId === turn.turnId) armRateLimitStall(sessionId, turn, pending.hint);
  };

  const emit = (canonical: string, ev: RuntimeEvent) => {
    for (const cb of listeners) cb(canonical, ev);
  };

  const emitLifecycle = (
    notification: Parameters<Parameters<NonNullable<AgentRuntime["onLifecycle"]>>[0]>[0],
  ): void => {
    for (const cb of lifecycleListeners) cb(notification);
  };

  const stateFor = (canonical: string): TranslateState => {
    let s = translate.get(canonical);
    if (!s) {
      s = createTranslateState();
      translate.set(canonical, s);
    }
    return s;
  };

  const admitTurn = (sessionId: string, model?: ModelRef): void => {
    clearRateLimitStall(sessionId);
    suppressedAfterAbort.delete(sessionId);
    if (activeTurn.has(sessionId)) return;
    const turnId = `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    activeTurn.set(sessionId, { turnId, aborting: false });
    admitTranslateTurn(stateFor(sessionId), turnId);
    emit(sessionId, { type: "turn/started", turnId, ...(model ? { model } : {}) });
  };

  const terminalEvents = (
    sessionId: string,
    event: NonNullable<ReturnType<typeof asOcEvent>>,
    state: TranslateState,
  ): RuntimeEvent[] => {
    const terminal = claimTerminalStateEvidence(event, state);
    const turn = activeTurn.get(sessionId);
    if (!terminal || !turn) return [];
    const assistant = terminal.state === "idle" ? flushAssistantOnIdle(state) : [];
    clearRateLimitStall(sessionId);
    activeTurn.delete(sessionId);
    finishTranslateTurn(state, turn.turnId);
    if (terminal.state === "idle") {
      return [
        ...assistant,
        {
          type: "turn/stopped",
          reason: turn.aborting ? "aborted" : "completed",
        },
      ];
    }
    if (terminal.state === "interrupted") {
      return [{ type: "turn/stopped", reason: "aborted" }];
    }
    const retry = providerLimitOf(event);
    return [{
      type: "turn/stopped",
      reason: "error",
      error: errorMessageOf(event) ?? "session failed",
      ...(retry ? { retry } : {}),
    }];
  };

  const finishAbortedTurn = (
    sessionId: string,
    turn: { turnId: string; aborting: boolean } | undefined,
  ): void => {
    if (!turn) return;
    clearRateLimitStall(sessionId);
    activeTurn.delete(sessionId);
    finishTranslateTurn(stateFor(sessionId), turn.turnId);
    suppressedAfterAbort.add(sessionId);
    emit(sessionId, { type: "turn/stopped", reason: "aborted" });
  };

  const clearAbortRequest = (
    sessionId: string,
    turn: { turnId: string; aborting: boolean } | undefined,
  ): void => {
    if (!turn || activeTurn.get(sessionId) !== turn) return;
    turn.aborting = false;
    const state = stateFor(sessionId);
    if (state.abortingTurnId === turn.turnId) state.abortingTurnId = undefined;
  };

  const handlePayload = (
    id: string | undefined,
    data: unknown,
    streamEndpoint?: Pick<RuntimeEndpoint, "authorityId" | "generation" | "location">,
  ) => {
    const ev = asOcEvent(data);
    if (!ev) return;
    const eid = id ?? ev.id;
    if (eid) {
      const eventIdentity = streamEndpoint
        ? `${streamEndpoint.authorityId}\0${streamEndpoint.generation}\0${eid}`
        : eid;
      if (seenEventIds.has(eventIdentity)) return;
      seenEventIds.add(eventIdentity);
      if (seenEventIds.size > 8000) {
        const first = seenEventIds.values().next().value;
        if (first) seenEventIds.delete(first);
      }
    }
    const backendId = backendSessionId(ev);
    if (!backendId) return;
    const canonical = maps.reverse.get(backendId);
    if (!canonical) {
      log("debug", "opencode event for unmapped session", { backendId, type: ev.type ?? "" });
      return;
    }
    const st = stateFor(canonical);
    touchRateLimitStall(canonical);
    if (suppressedAfterAbort.has(canonical)) return;
    const observationEndpoint = streamEndpoint;
    if (observationEndpoint && observationListeners.size > 0) {
      const reconciliationOrdinal = reconciliationOrdinals.get(canonical);
      if (reconciliationOrdinal === undefined) {
        log("debug", "opencode event arrived before the session reconciliation barrier", {
          canonical,
          backendId,
          type: ev.type ?? "",
        });
        return;
      }
      const observed = {
        authorityId: observationEndpoint.authorityId,
        generation: observationEndpoint.generation,
        location: observationEndpoint.location,
        backendSessionId: backendId,
        reconciliationOrdinal,
      };
      const normalized = normalizeOcObservation({
        data,
        channel: "sse",
        observed,
        current: observed,
        state: st,
        ...(id ? { cursorAfter: id } : {}),
      });
      if (normalized.kind !== "accepted") return;
      const translated = normalized.observation.events;
      const events = [
        ...translated,
        ...terminalEvents(canonical, ev, st),
      ];
      if (
        events.length === normalized.observation.events.length
        && normalized.observation.events.length > 1
      ) {
        for (const observation of splitNormalizedObservation(normalized.observation)) {
          for (const cb of observationListeners) cb(canonical, observation);
        }
      } else {
        const observation = { ...normalized.observation, events };
        for (const cb of observationListeners) cb(canonical, observation);
      }
      const notice = translated.find((event) => event.type === "assistant/message")?.reasoning;
      const hint = notice ? classifyProviderLimitNotice(notice) : null;
      const turn = activeTurn.get(canonical);
      if (hint && turn) armRateLimitStall(canonical, turn, hint);
      return;
    }
    const translated = translateOcEvent(ev, st);
    for (const runtimeEv of translated) emit(canonical, runtimeEv);
    for (const runtimeEv of terminalEvents(canonical, ev, st)) emit(canonical, runtimeEv);
    const notice = translated.find((event) => event.type === "assistant/message")?.reasoning;
    const hint = notice ? classifyProviderLimitNotice(notice) : null;
    const turn = activeTurn.get(canonical);
    if (hint && turn) armRateLimitStall(canonical, turn, hint);
  };

  const connectSse = async () => {
    let delay = 500;
    while (!disposed) {
      sseAbort = new AbortController();
      let stalled = false;
      let stallTimer: NodeJS.Timeout | undefined;
      const armStall = (): void => {
        if (!extras.sseStallMs) return;
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          stalled = true;
          sseAbort?.abort();
        }, extras.sseStallMs);
      };
      let currentEndpoint: RuntimeEndpoint;
      try {
        currentEndpoint = await lifecycle.endpoint();
      } catch (error) {
        if (disposed) return;
        log("debug", "opencode endpoint unavailable for sse", { error: String(error) });
        await sleep(delay);
        delay = Math.min(delay * 2, 5000);
        continue;
      }
      const endpointFields = {
        authorityId: currentEndpoint.authorityId,
        generation: currentEndpoint.generation,
      };
      emitLifecycle({ type: "stream-connected", ...endpointFields });
      armStall();
      let reason = "stream ended";
      try {
        await lifecycle.streamEvents({
          signal: sseAbort.signal,
          onEvent(observation) {
            armStall();
            const envelope = observation.value && typeof observation.value === "object"
              ? observation.value as { id?: unknown; data?: unknown }
              : { data: observation.value };
            handlePayload(
              typeof envelope.id === "string" ? envelope.id : undefined,
              envelope.data,
              observation,
            );
          },
        });
      } catch (err) {
        if (disposed) return;
        if ((err as { code?: string }).code === "capability-unsupported") {
          log("debug", "opencode event stream is capability-gated", { error: String(err) });
          return;
        }
        if (
          (err as { name?: string }).name === "AbortError"
          && !stalled
          && sseAbort.signal.aborted
        ) return;
        reason = stalled ? "stream liveness deadline elapsed" : String(err);
        log("debug", "opencode sse disconnected", { error: String(err) });
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
      }
      if (disposed) return;
      emitLifecycle({ type: "stream-disconnected", ...endpointFields, reason });
      try {
        await lifecycle.refresh("disconnect");
      } catch (error) {
        log("debug", "opencode endpoint refresh failed", { error: String(error) });
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
    }
  };

  void connectSse();

  const setMapping = (canonicalSessionId: string, backendSessionId: string): void => {
    const previous = maps.forward.get(canonicalSessionId);
    if (previous && previous !== backendSessionId) maps.reverse.delete(previous);
    maps.forward.set(canonicalSessionId, backendSessionId);
    maps.reverse.set(backendSessionId, canonicalSessionId);
  };

  const removeMapping = (sessionId: string): string => {
    const canonicalSessionId = maps.forward.has(sessionId)
      ? sessionId
      : maps.reverse.get(sessionId) ?? sessionId;
    const backendSessionId = maps.forward.get(canonicalSessionId) ?? sessionId;
    maps.forward.delete(canonicalSessionId);
    if (maps.reverse.get(backendSessionId) === canonicalSessionId) {
      maps.reverse.delete(backendSessionId);
    }
    reconciliationOrdinals.delete(canonicalSessionId);
    return backendSessionId;
  };

  const lifecycleBinding = async (
    canonicalSessionId: string,
    backendSessionId = maps.forward.get(canonicalSessionId),
  ): Promise<RuntimeSessionBindingWithProtocol> => {
    const endpoint = await lifecycle.endpoint();
    return {
      canonicalSessionId,
      ...(backendSessionId ? { backendSessionId } : {}),
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
      continuity: endpoint.continuity,
      location: endpoint.location,
      protocol: await lifecycle.protocol(),
    };
  };

  const outcomeValue = <T,>(outcome: MutationOutcome<T>): T => {
    if (outcome.kind === "confirmed") return outcome.value;
    throw Object.assign(new Error(outcome.message), {
      code: outcome.kind === "rejected" ? outcome.code : "outcome-unknown",
      ...(outcome.kind === "unknown" ? { operationId: outcome.operationId } : {}),
    });
  };

  return {
    capabilities: async () => CAPABILITIES,
    models: () => lifecycle.usingProtocol((protocol) => protocol.models()),
    agents: () => lifecycle.usingProtocol((protocol) => protocol.agents()),
    sessions: () => lifecycle.usingProtocol((protocol) => protocol.sessions()),
    listAllProviders: () => lifecycle.usingProtocol((protocol) => {
      if (!protocol.listAllProviders) throw Object.assign(new Error("provider listing unavailable"), { code: "unsupported" });
      return protocol.listAllProviders();
    }),
    providerAuthMethods: () => lifecycle.usingProtocol((protocol) => {
      if (!protocol.providerAuthMethods) throw Object.assign(new Error("provider auth methods unavailable"), { code: "unsupported" });
      return protocol.providerAuthMethods();
    }),
    providerAuthorize: (providerID, method, inputs) => lifecycle.usingProtocol((protocol) => {
      if (!protocol.providerAuthorize) throw Object.assign(new Error("provider oauth unavailable"), { code: "unsupported" });
      return protocol.providerAuthorize(providerID, method, inputs);
    }),
    providerAuthCallback: (providerID, method, code) => lifecycle.usingProtocol((protocol) => {
      if (!protocol.providerAuthCallback) throw Object.assign(new Error("provider oauth unavailable"), { code: "unsupported" });
      return protocol.providerAuthCallback(providerID, method, code);
    }),
    setProviderApiKey: (providerID, key, metadata) => lifecycle.usingProtocol((protocol) => {
      if (!protocol.setProviderApiKey) throw Object.assign(new Error("provider auth unavailable"), { code: "unsupported" });
      return protocol.setProviderApiKey(providerID, key, metadata);
    }),
    setProviderAuth: (providerID, info) => lifecycle.usingProtocol((protocol) => {
      if (!protocol.setProviderAuth) throw Object.assign(new Error("provider auth unavailable"), { code: "unsupported" });
      return protocol.setProviderAuth(providerID, info);
    }),
    removeProviderAuth: (providerID) => lifecycle.usingProtocol((protocol) => {
      if (!protocol.removeProviderAuth) throw Object.assign(new Error("provider auth unavailable"), { code: "unsupported" });
      return protocol.removeProviderAuth(providerID);
    }),
    async history(sessionId) {
      const canonicalSessionId = maps.reverse.get(sessionId) ?? sessionId;
      const backendSessionId = maps.forward.get(canonicalSessionId) ?? sessionId;
      const binding = await lifecycleBinding(canonicalSessionId, backendSessionId);
      return lifecycle.usingProtocol((protocol) => protocol.history(binding));
    },
    async ensureSession(canonical) {
      const outcome = await lifecycle.ensureSession(
        await lifecycleBinding(
          canonical.sessionId,
          maps.forward.get(canonical.sessionId) ?? canonical.backendSessionId,
        ),
        randomUUID(),
        canonical.title,
      );
      const value = outcomeValue(outcome);
      setMapping(canonical.sessionId, value.backendSessionId);
      return value.backendSessionId;
    },
    async createSessionOperation(canonical, operationId) {
      const outcome = await lifecycle.ensureSession(
        await lifecycleBinding(
          canonical.sessionId,
          maps.forward.get(canonical.sessionId) ?? canonical.backendSessionId,
        ),
        operationId,
        canonical.title,
      );
      if (outcome.kind === "confirmed") {
        setMapping(canonical.sessionId, outcome.value.backendSessionId);
      }
      return outcome;
    },
    async resetSession(canonical) {
      const binding = await lifecycleBinding(canonical.sessionId);
      const outcome = await lifecycle.resetSession(binding, canonical.title, randomUUID());
      const value = outcomeValue(outcome);
      setMapping(canonical.sessionId, value.backendSessionId);
      translate.delete(canonical.sessionId);
      activeTurn.delete(canonical.sessionId);
      return value.backendSessionId;
    },
    async resetSessionOperation(canonical, operationId) {
      const binding = await lifecycleBinding(canonical.sessionId);
      const outcome = await lifecycle.resetSession(
        binding,
        canonical.title,
        operationId,
      );
      if (outcome.kind === "confirmed") {
        setMapping(canonical.sessionId, outcome.value.backendSessionId);
        translate.delete(canonical.sessionId);
        activeTurn.delete(canonical.sessionId);
      }
      return outcome;
    },
    // UX-MSG-ACTIONS: create a backend session holding EXACTLY the requested
    // canonical prefix via OpenCode's native /session/{id}/fork. The fork
    // boundary is resolved positionally (never by text search), the child is
    // read back and verified, and the canonical↔backend mapping swaps only
    // after verification — a mismatch or transport failure leaves every
    // existing mapping untouched.
    async branchSession(request: RuntimeBranchRequest): Promise<string> {
      const source = await lifecycleBinding(request.sourceSessionId);
      const target = await lifecycleBinding(request.target.sessionId, undefined);
      const outcome = await lifecycle.branchSession({
        source,
        target,
        ...(request.target.title ? { title: request.target.title } : {}),
        history: request.history,
      }, randomUUID());
      const value = outcomeValue(outcome);
      setMapping(request.target.sessionId, value.backendSessionId);
      if (request.target.sessionId === request.sourceSessionId) {
        translate.delete(request.sourceSessionId);
        activeTurn.delete(request.sourceSessionId);
      }
      return value.backendSessionId;
    },
    async branchSessionOperation(request, operationId) {
      const source = await lifecycleBinding(request.sourceSessionId);
      const target = await lifecycleBinding(request.target.sessionId, undefined);
      const outcome = await lifecycle.branchSession({
        source,
        target,
        ...(request.target.title ? { title: request.target.title } : {}),
        history: request.history,
      }, operationId);
      if (outcome.kind === "confirmed") {
        setMapping(request.target.sessionId, outcome.value.backendSessionId);
        if (request.target.sessionId === request.sourceSessionId) {
          translate.delete(request.sourceSessionId);
          activeTurn.delete(request.sourceSessionId);
        }
      }
      return outcome;
    },
    async discardSession(sessionId: string): Promise<void> {
      const backendId = maps.forward.get(sessionId) ?? sessionId;
      const canonicalId = maps.reverse.get(backendId) ?? sessionId;
      const binding = await lifecycleBinding(canonicalId, backendId);
      const outcome = await lifecycle.deleteSession(binding, randomUUID());
      outcomeValue(outcome);
      removeMapping(sessionId);
    },
    async discardSessionOperation(sessionId, operationId) {
      const backendId = maps.forward.get(sessionId) ?? sessionId;
      const canonicalId = maps.reverse.get(backendId) ?? sessionId;
      const binding = await lifecycleBinding(canonicalId, backendId);
      const outcome = await lifecycle.deleteSession(binding, operationId);
      if (outcome.kind === "confirmed") removeMapping(sessionId);
      return outcome;
    },
    async startTurn(req: CanonicalTurnRequest) {
      const outcome = await lifecycle.submit({
        session: await lifecycleBinding(req.sessionId),
        text: req.text,
        ...(req.attachments ? { attachments: req.attachments } : {}),
        ...(req.model ? { model: req.model } : {}),
        ...(req.agent ? { agent: req.agent } : {}),
      }, randomUUID());
      outcomeValue(outcome);
      admitTurn(req.sessionId, req.model);
    },
    async startTurnOperation(req, operationId) {
      const outcome = await lifecycle.submit({
        session: await lifecycleBinding(req.sessionId),
        text: req.text,
        ...(req.attachments ? { attachments: req.attachments } : {}),
        ...(req.model ? { model: req.model } : {}),
        ...(req.agent ? { agent: req.agent } : {}),
      }, operationId);
      if (outcome.kind === "confirmed") admitTurn(req.sessionId, req.model);
      return outcome;
    },
    completeSmallModel: (request) => completeSmallModelDirect(request),
    async steer(sessionId: string, text: string, model?: ModelRef, agent?: string): Promise<boolean> {
      // Only meaningful while a turn is active; posting to an idle session
      // would start a fresh turn instead of steering.
      if (!activeTurn.has(sessionId)) return false;
      const binding = await lifecycleBinding(sessionId);
      const outcome = await lifecycle.steer({
        session: binding,
        text,
        ...(model ? { model } : {}),
        ...(agent ? { agent } : {}),
      }, randomUUID());
      return outcome.kind === "confirmed";
    },
    async steerOperation(sessionId, text, operationId, model, agent) {
      if (!activeTurn.has(sessionId)) {
        return {
          kind: "rejected",
          code: "steer-not-admitted",
          message: "session has no active turn to steer",
        };
      }
      const binding = await lifecycleBinding(sessionId);
      return lifecycle.steer({
        session: binding,
        text,
        ...(model ? { model } : {}),
        ...(agent ? { agent } : {}),
      }, operationId);
    },
    async abort(sessionId: string) {
      const turn = activeTurn.get(sessionId);
      if (turn) {
        turn.aborting = true;
        markTranslateTurnAborting(stateFor(sessionId), turn.turnId);
      }
      const binding = await lifecycleBinding(sessionId);
      const outcome = await lifecycle.abort(binding, randomUUID());
      if (outcome.kind === "rejected") clearAbortRequest(sessionId, turn);
      outcomeValue(outcome);
      finishAbortedTurn(sessionId, turn);
    },
    async abortOperation(sessionId, operationId) {
      const turn = activeTurn.get(sessionId);
      if (turn) {
        turn.aborting = true;
        markTranslateTurnAborting(stateFor(sessionId), turn.turnId);
      }
      const binding = await lifecycleBinding(sessionId);
      const outcome = await lifecycle.abort(binding, operationId);
      if (outcome.kind === "confirmed") {
        finishAbortedTurn(sessionId, turn);
      } else if (outcome.kind === "rejected") {
        clearAbortRequest(sessionId, turn);
      }
      return outcome;
    },
    async releaseExecution(binding, operationId) {
      if (!binding.backendSessionId) {
        return {
          kind: "unknown",
          operationId,
          message: "release requires a backend session identity",
        };
      }
      let snapshot;
      try {
        snapshot = await lifecycle.reconcile({
          ...binding,
          protocol: await lifecycle.protocol(),
        });
      } catch {
        return {
          kind: "unknown",
          operationId,
          message: "Could not verify that the old execution has stopped",
        };
      }
      if (
        snapshot.backendSessionId !== binding.backendSessionId
        || snapshot.authorityId !== binding.authorityId
        || snapshot.generation !== binding.generation
      ) {
        return {
          kind: "unknown",
          operationId,
          message: "release proof does not name this execution incarnation",
        };
      }
      if (snapshot.state.value === "running" || snapshot.state.value === "unknown") {
        return {
          kind: "unknown",
          operationId,
          message: "Old execution has not been proven idle",
        };
      }
      return {
        kind: "confirmed",
        value: {
          authorityId: binding.authorityId,
          generation: binding.generation,
          backendSessionId: binding.backendSessionId,
        },
      };
    },
    async replyPermission(sessionId: string, requestId: string, reply: "once" | "always" | "reject") {
      const binding = await lifecycleBinding(sessionId);
      outcomeValue(await lifecycle.replyPermission(binding, requestId, reply, randomUUID()));
    },
    async replyPermissionOperation(sessionId, requestId, reply, operationId) {
      const binding = await lifecycleBinding(sessionId);
      return lifecycle.replyPermission(binding, requestId, reply, operationId);
    },
    async replyQuestion(sessionId: string, requestId: string, answers: JsonObject) {
      const binding = await lifecycleBinding(sessionId);
      outcomeValue(await lifecycle.replyQuestion(binding, requestId, answers, randomUUID()));
    },
    async replyQuestionOperation(sessionId, requestId, answers, operationId) {
      const binding = await lifecycleBinding(sessionId);
      return lifecycle.replyQuestion(binding, requestId, answers, operationId);
    },
    endpoint: () => lifecycle.endpoint(),
    protocol: () => lifecycle.protocol(),
    async reconcile(binding, after) {
      const ordinal = binding.reconciliationOrdinal;
      if (!Number.isSafeInteger(ordinal) || (ordinal ?? 0) <= 0) {
        throw Object.assign(
          new Error("runtime reconciliation requires a positive request ordinal"),
          { code: "invalid-input" },
        );
      }
      const prior = reconciliationOrdinals.get(binding.canonicalSessionId);
      if (prior !== undefined && ordinal! < prior) {
        throw Object.assign(
          new Error("runtime reconciliation request ordinal is stale"),
          { code: "stale-evidence" },
        );
      }
      reconciliationOrdinals.set(binding.canonicalSessionId, ordinal!);
      const protocol = await lifecycle.protocol();
      const snapshot = await lifecycle.reconcile({ ...binding, protocol }, after);
      if (!snapshot.events.some((entry) => entry.event.type === "task/snapshot")) {
        return snapshot;
      }

      // Pull adapters rebuild a fresh translation state, while SSE translation
      // is session-lived. Rebase pulled task snapshots onto that shared state
      // so every changed replacement remains monotonic across reconnects.
      const state = stateFor(binding.canonicalSessionId);
      let revision = state.taskRevision;
      let key = state.lastTaskKey;
      const events = snapshot.events.map((entry) => {
        if (entry.event.type !== "task/snapshot") return entry;
        const nextKey = JSON.stringify(entry.event.items);
        if (nextKey !== key) revision += 1;
        key = nextKey;
        return { ...entry, event: { ...entry.event, revision } };
      });
      state.taskRevision = revision;
      state.lastTaskKey = key;
      return { ...snapshot, events };
    },
    onObservation(cb) {
      observationListeners.add(cb);
      return { dispose: () => { observationListeners.delete(cb); } };
    },
    onLifecycle(cb) {
      lifecycleListeners.add(cb);
      return { dispose: () => { lifecycleListeners.delete(cb); } };
    },
    onEvent(cb: Listener): Disposable {
      listeners.add(cb);
      return { dispose: () => { listeners.delete(cb); } };
    },
    async dispose() {
      disposed = true;
      sseAbort?.abort();
      for (const sessionId of rateLimitStalls.keys()) clearRateLimitStall(sessionId);
      reconciliationOrdinals.clear();
    },
  };
};

export const createOpenCodeRuntime = async (
  opts: OpenCodeAdapterOptions & Omit<OpenCodeRuntimeExtras, "lifecycle">,
): Promise<AgentRuntime> => {
  const lease = await createOwnedLocalEndpointLease({
    projectId: opts.projectId,
    ...(opts.spaceId ? { spaceId: opts.spaceId } : {}),
    cwd: opts.cwd,
    port: opts.port,
    hostname: opts.hostname,
    bin: opts.bin,
    binarySource: opts.binarySource,
    configDir: opts.configDir ?? opts.dataDir,
    runtimeDir: opts.runtimeDir,
    stateFile: opts.stateFile,
    configTargetId: opts.configTargetId
      ?? (opts.configDir ?? opts.dataDir
        ? `opencode-config:${resolve((opts.configDir ?? opts.dataDir)!)}`
        : undefined),
  });
  let lifecycle: RuntimeLifecycle;
  try {
    lifecycle = await createOpenCodeRuntimeLifecycle({
      lease,
      // Owned local is the OpenCode we just spawned. Skip /doc auto-discovery
      // so models() can run as soon as health is 200.
      protocol: opts.protocol ?? "legacy",
      startupDeadlineMs: opts.startupDeadlineMs,
      probeDeadlineMs: opts.probeDeadlineMs,
    });
  } catch (err) {
    await lease.dispose();
    throw err;
  }
  const facade = createOpenCodeRuntimeFacade({
    ...opts,
    lifecycle,
  });
  const disposeFacade = facade.dispose.bind(facade);
  let disposed = false;
  facade.dispose = async () => {
    if (disposed) return;
    disposed = true;
    await disposeFacade();
    await lifecycle.dispose();
  };
  return attachRuntimeLifecycle(facade, lifecycle);
};
