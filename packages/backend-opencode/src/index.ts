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
  MutationOutcome,
  RuntimeBranchRequest,
  RuntimeEndpoint,
  RuntimeCapabilities,
  RuntimeEndpointLease,
  RuntimeEvent,
  RuntimeObservation,
} from "@polyth/contracts";
import type { OpenCodeBrowserToolConfig } from "./browserTool.ts";
import {
  asOcEvent,
  backendSessionId,
  claimTerminalStateEvidence,
  createTranslateState,
  errorMessageOf,
  flushAssistantOnIdle,
  normalizeOcObservation,
  splitNormalizedObservation,
  translateOcEvent,
  type TranslateState,
} from "./events.ts";
import {
  createOwnedLocalEndpointLease,
  LISTEN_RE,
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

export interface OpenCodeAdapterOptions {
  cwd: string;
  port?: number;
  hostname?: string;
  bin?: string;
  dataDir?: string;
  browserTool?: OpenCodeBrowserToolConfig;
  protocol?: ProtocolSelection;
  configTargetId?: string;
  startupDeadlineMs?: number;
  probeDeadlineMs?: number;
}

export { createConfigApplier, normalizePluginEntries } from "./config.ts";
export type {
  BackendConfigApplier,
  McpApplyEntry,
  ProviderVisibilityApply,
} from "./config.ts";
export {
  BROWSER_TOOL_PATH,
  createBrowserToolBridge,
  createBrowserToolPluginSource,
  prepareBrowserToolEnvironment,
} from "./browserTool.ts";
export type {
  BrowserToolBridge,
  BrowserToolRegistration,
  OpenCodeBrowserToolConfig,
} from "./browserTool.ts";

export {
  createRemoteOpenCodeRuntime,
  probeRemoteOpenCode,
} from "./remote.ts";
export type { RemoteOpenCodeOptions, RemoteOpenCodeProbe } from "./remote.ts";
export {
  createBorrowedExternalEndpointLease,
  createBorrowedServiceEndpointLease,
  createOwnedLocalEndpointLease,
  createOwnedSshEndpointLease,
  isOwnedEndpointLease,
  LISTEN_RE,
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
  ProcessIdentity,
  ProcessIdentityReader,
  ProcessSignaler,
} from "./endpoint.ts";
export {
  createRuntimeLifecycle,
  waitForRuntimeReady,
} from "./runtime.ts";
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

const CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  permissions: true,
  questions: true,
  compaction: true,
  subagents: true,
  // live steering: a prompt posted to a busy session joins the active turn;
  // steer() reports false on rejection so callers can fall back to queueing
  steering: true,
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
        probeDeadlineMs: options.probeDeadlineMs ?? 1_000,
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
  const reconciliationOrdinals = new Map<string, number>();
  const seenEventIds = new Set<string>();
  const log = extras.log ?? ((level, msg, data) => {
    if (level === "debug") console.debug(msg, data ?? "");
  });

  let sseAbort: AbortController | undefined;
  let disposed = false;

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
      const events = [...normalized.observation.events];
      const terminal = claimTerminalStateEvidence(ev, st);
      const err = errorMessageOf(ev);
      if (err && terminal?.state === "failed") {
        const turn = activeTurn.get(canonical);
        if (turn) {
          activeTurn.delete(canonical);
          events.push({ type: "turn/stopped", reason: "error", error: err });
        }
      } else if (terminal?.state === "idle") {
        events.push(...flushAssistantOnIdle(st));
        const turn = activeTurn.get(canonical);
        if (turn) {
          activeTurn.delete(canonical);
          events.push({
            type: "turn/stopped",
            reason: turn.aborting ? "aborted" : "completed",
          });
        }
      }
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
      return;
    }
    for (const runtimeEv of translateOcEvent(ev, st)) emit(canonical, runtimeEv);
    const terminal = claimTerminalStateEvidence(ev, st);
    const err = errorMessageOf(ev);
    if (err && terminal?.state === "failed") {
      const turn = activeTurn.get(canonical);
      if (turn) {
        activeTurn.delete(canonical);
        emit(canonical, { type: "turn/stopped", reason: "error", error: err });
      }
      return;
    }
    if (terminal?.state === "idle") {
      for (const runtimeEv of flushAssistantOnIdle(st)) emit(canonical, runtimeEv);
      const turn = activeTurn.get(canonical);
      if (turn) {
        activeTurn.delete(canonical);
        emit(canonical, {
          type: "turn/stopped",
          reason: turn.aborting ? "aborted" : "completed",
        });
      }
    }
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
    const backendSessionId = maps.forward.get(sessionId) ?? sessionId;
    for (const [canonical, backend] of maps.forward) {
      if (backend === backendSessionId) {
        maps.forward.delete(canonical);
        reconciliationOrdinals.delete(canonical);
      }
    }
    maps.reverse.delete(backendSessionId);
    reconciliationOrdinals.delete(sessionId);
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
      if (!activeTurn.has(req.sessionId)) {
        const turnId = `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        activeTurn.set(req.sessionId, { turnId, aborting: false });
        emit(req.sessionId, { type: "turn/started", turnId });
      }
    },
    async startTurnOperation(req, operationId) {
      const outcome = await lifecycle.submit({
        session: await lifecycleBinding(req.sessionId),
        text: req.text,
        ...(req.attachments ? { attachments: req.attachments } : {}),
        ...(req.model ? { model: req.model } : {}),
        ...(req.agent ? { agent: req.agent } : {}),
      }, operationId);
      if (outcome.kind === "confirmed" && !activeTurn.has(req.sessionId)) {
        const turnId = `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        activeTurn.set(req.sessionId, { turnId, aborting: false });
        emit(req.sessionId, { type: "turn/started", turnId });
      }
      return outcome;
    },
    async steer(sessionId: string, text: string): Promise<boolean> {
      // Only meaningful while a turn is active; posting to an idle session
      // would start a fresh turn instead of steering.
      if (!activeTurn.has(sessionId)) return false;
      const binding = await lifecycleBinding(sessionId);
      const outcome = await lifecycle.steer({ session: binding, text }, randomUUID());
      return outcome.kind === "confirmed";
    },
    async steerOperation(sessionId, text, operationId) {
      if (!activeTurn.has(sessionId)) {
        return {
          kind: "rejected",
          code: "steer-not-admitted",
          message: "session has no active turn to steer",
        };
      }
      const binding = await lifecycleBinding(sessionId);
      return lifecycle.steer({ session: binding, text }, operationId);
    },
    async abort(sessionId: string) {
      const turn = activeTurn.get(sessionId);
      const binding = await lifecycleBinding(sessionId);
      const outcome = await lifecycle.abort(binding, randomUUID());
      outcomeValue(outcome);
      if (turn) turn.aborting = true;
    },
    async abortOperation(sessionId, operationId) {
      const binding = await lifecycleBinding(sessionId);
      const outcome = await lifecycle.abort(binding, operationId);
      if (outcome.kind === "confirmed") {
        const turn = activeTurn.get(sessionId);
        if (turn) turn.aborting = true;
      }
      return outcome;
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
      return lifecycle.reconcile({ ...binding, protocol }, after);
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
      reconciliationOrdinals.clear();
    },
  };
};

export const createOpenCodeRuntime = async (
  opts: OpenCodeAdapterOptions & Omit<OpenCodeRuntimeExtras, "lifecycle">,
): Promise<AgentRuntime> => {
  const lease = await createOwnedLocalEndpointLease({
    cwd: opts.cwd,
    port: opts.port,
    hostname: opts.hostname,
    bin: opts.bin,
    dataDir: opts.dataDir,
    browserTool: opts.browserTool,
    configTargetId: opts.configTargetId
      ?? (opts.dataDir ? `opencode-config:${resolve(opts.dataDir)}` : undefined),
  });
  let lifecycle: RuntimeLifecycle;
  try {
    lifecycle = await createOpenCodeRuntimeLifecycle({
      lease,
      protocol: opts.protocol,
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
