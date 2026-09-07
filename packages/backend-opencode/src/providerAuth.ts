import { randomUUID } from "node:crypto";
import type {
  AgentRuntime,
  AuthAttemptDto,
  AuthErrorDto,
  AuthPhase,
  AvailableProviderDescriptor,
  ProviderAuthCapabilitiesDto,
  ProviderAuthMethod,
  ProviderAuthView,
  ProviderAuthorization,
  RuntimeEndpoint,
  SpaceContext,
  WellKnownPreviewDto,
} from "@polyth/contracts";
import { allowsInteractiveProviderAuth } from "@polyth/contracts";
import {
  assertInteractiveProviderAuth,
  interactiveProviderAuthUnavailable,
  localAuthTarget,
  openCodeProcessIsLocal,
} from "./providerAuthTarget.ts";
import {
  authError,
  redactSecrets,
  buildProviderAuthView,
  classifyAuthUrl,
  discoveryStatus,
  extractDeviceFlow,
  fingerprintAuthMethod,
  firstIncompleteField,
  hashCapabilityRevision,
  isTerminalPhase,
  isWaitingPhase,
  mapUpstreamAuthError,
  parseAuthorizationCode,
  pruneHiddenValues,
  throwAuthError,
  transitionPhase,
  urlHasLoopbackRedirect,
  withSelectDefaults,
} from "@polyth/models/auth";
import { createWellKnownFlow, runPinnedArgv } from "./providerAuthWellKnown.ts";

const TERMINAL_TTL_MS = 2 * 60 * 1000;
const CONNECTED_TTL_MS = 5 * 60 * 1000;
const ATTEMPT_MAX_AGE_MS = 20 * 60 * 1000;
const FAILURE_TTL_MS = 15_000;

type CallbackState = "idle" | "running" | "completed";

interface AuthAttemptInternal {
  id: string;
  providerId: string;
  methodId: string;
  upstreamIndex: number;
  fingerprint: string;
  revision: string;
  authorityId: string;
  generation: number;
  phase: AuthPhase;
  createdAt: number;
  expiresAt?: number;
  terminalAt?: number;
  instructions?: string;
  url?: string;
  urlKind?: AuthAttemptDto["urlKind"];
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  loopbackWarning?: boolean;
  error?: AuthErrorDto;
  secrets: string[];
  oauthMethod: "auto" | "code" | "api";
  abort: AbortController;
  callbackState: CallbackState;
  callbackPromise?: Promise<void>;
  spaceId: string;
}

interface Snapshot {
  revision: string;
  authorityId: string;
  generation: number;
  discoveredAt: number;
  rawMethods: Record<string, ProviderAuthMethod[]>;
  metadata: Record<string, AvailableProviderDescriptor>;
  status: ProviderAuthCapabilitiesDto["discovery"]["status"];
  provenance: ProviderAuthView["discovery"]["provenance"];
  error?: AuthErrorDto;
  failedAt?: number;
}

export interface ProviderAuthController {
  notifyRuntimeChange(endpoint?: RuntimeEndpoint): void;
  invalidate(): void;
  capabilities(connected: ReadonlySet<string>, space: SpaceContext): Promise<ProviderAuthCapabilitiesDto>;
  view(providerId: string, connected: boolean, space: SpaceContext): Promise<ProviderAuthView>;
  startAttempt(input: {
    providerId: string;
    methodId: string;
    inputs?: Record<string, string>;
    revision?: string;
    /** Proven only for a native desktop webview. Socket ingress is never this. */
    browserLocality?: "native-desktop" | "unknown";
    space: SpaceContext;
  }): Promise<AuthAttemptDto>;
  getAttempt(id: string, space: SpaceContext): AuthAttemptDto | undefined;
  completeAttempt(id: string, code: string | undefined, space: SpaceContext): Promise<AuthAttemptDto>;
  cancelAttempt(id: string, space: SpaceContext): AuthAttemptDto;
  saveCredential(providerId: string, key: string, metadata: Record<string, string> | undefined, space: SpaceContext): Promise<ProviderAuthView>;
  disconnect(providerId: string, space: SpaceContext): Promise<{ ok: true; remaining?: ProviderAuthView["credential"] }>;
  previewWellKnown(origin: string, space: SpaceContext): Promise<WellKnownPreviewDto>;
  executeWellKnown(origin: string, hash: string, space: SpaceContext): Promise<{ ok: true }>;
}

const identityOf = async (runtime: AgentRuntime): Promise<{ authorityId: string; generation: number; endpoint?: RuntimeEndpoint }> => {
  const endpoint = await runtime.endpoint?.();
  return {
    authorityId: endpoint?.authorityId ?? "unmanaged",
    generation: endpoint?.generation ?? 0,
    ...(endpoint ? { endpoint } : {}),
  };
};

export const clearAttemptSecrets = (secrets: string[]): void => {
  for (let i = 0; i < secrets.length; i += 1) secrets[i] = "";
  secrets.length = 0;
};

const LOCAL_AUTH_ONLY = "Provider sign-in only targets this host's local OpenCode process.";

export function createProviderAuthController(deps: {
  runtime(space: SpaceContext): Promise<AgentRuntime>;
  invalidateModels(): void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  fetchImpl?: typeof fetch;
  resolve?: (hostname: string) => Promise<string[]>;
}): ProviderAuthController {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const wellKnown = createWellKnownFlow({
    now,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
  });
  let snapshot: Snapshot | undefined;
  let inflight: Promise<Snapshot> | undefined;
  const attempts = new Map<string, AuthAttemptInternal>();
  const activeByProvider = new Map<string, string>();

  const activeKey = (spaceId: string, authorityId: string, providerId: string) =>
    `${spaceId}:${authorityId}:${providerId}`;
  const runtimeOf = (space: SpaceContext) => deps.runtime(space);
  const attemptInSpace = (attempt: AuthAttemptInternal, space: SpaceContext): boolean =>
    attempt.spaceId === space.spaceId;
  const remoteAuthError = () => authError("AUTH_CAPABILITY_UNAVAILABLE", { details: LOCAL_AUTH_ONLY });
  const managedSnapshot = (): Snapshot => ({
    revision: "deployment-managed",
    authorityId: "deployment",
    generation: 0,
    discoveredAt: now(),
    rawMethods: {},
    metadata: {},
    status: "unavailable",
    provenance: [],
    error: interactiveProviderAuthUnavailable(),
  });
  const requireLocalIdentity = async (rt: AgentRuntime) => {
    const identity = await identityOf(rt);
    if (identity.endpoint && !openCodeProcessIsLocal(identity.endpoint)) {
      return throwAuthError(remoteAuthError());
    }
    return identity;
  };

  const markTerminal = (attempt: AuthAttemptInternal, phase: AuthPhase, error?: AuthErrorDto): void => {
    attempt.phase = phase;
    if (error) attempt.error = error;
    attempt.terminalAt = now();
    clearAttemptSecrets(attempt.secrets);
    if (activeByProvider.get(activeKey(attempt.spaceId, attempt.authorityId, attempt.providerId)) === attempt.id) {
      activeByProvider.delete(activeKey(attempt.spaceId, attempt.authorityId, attempt.providerId));
    }
  };

  const sweep = (): void => {
    wellKnown.sweep();
    const t = now();
    for (const [id, attempt] of attempts) {
      if (activeByProvider.get(activeKey(attempt.spaceId, attempt.authorityId, attempt.providerId)) === id && !isTerminalPhase(attempt.phase)) {
        if (t - attempt.createdAt > ATTEMPT_MAX_AGE_MS) {
          attempt.abort.abort();
          markTerminal(attempt, "expired", authError("AUTH_EXPIRED"));
        }
        continue;
      }
      const ttl = attempt.phase === "connected" || attempt.phase === "configured_unverified"
        ? CONNECTED_TTL_MS
        : TERMINAL_TTL_MS;
      if (attempt.terminalAt && t - attempt.terminalAt > ttl) attempts.delete(id);
    }
  };

  const notifyRuntimeChange = (endpoint?: RuntimeEndpoint): void => {
    if (!endpoint) {
      for (const attempt of attempts.values()) {
        if (attempt.authorityId !== "unmanaged" || isTerminalPhase(attempt.phase)) continue;
        attempt.abort.abort();
        markTerminal(attempt, "stale", authError("AUTH_RUNTIME_RESTARTED"));
      }
      if (snapshot?.authorityId === "unmanaged") {
        snapshot = undefined;
        inflight = undefined;
      }
      return;
    }
    for (const attempt of attempts.values()) {
      if (attempt.authorityId !== endpoint.authorityId) continue;
      if (attempt.generation === endpoint.generation) continue;
      if (isTerminalPhase(attempt.phase)) continue;
      attempt.abort.abort();
      markTerminal(attempt, "stale", authError("AUTH_RUNTIME_RESTARTED"));
    }
    if (snapshot && snapshot.authorityId === endpoint.authorityId && snapshot.generation !== endpoint.generation) {
      snapshot = undefined;
      inflight = undefined;
    }
  };

  const invalidate = (): void => {
    snapshot = undefined;
    inflight = undefined;
  };

  const loadSnapshot = (space: SpaceContext): Promise<Snapshot> => {
    sweep();
    if (!allowsInteractiveProviderAuth(space.deployment)) return Promise.resolve(managedSnapshot());
    if (snapshot && snapshot.status === "failed" && snapshot.failedAt && now() - snapshot.failedAt < FAILURE_TTL_MS) {
      return Promise.resolve(snapshot);
    }
    if (snapshot && snapshot.status !== "failed") return Promise.resolve(snapshot);
    if (inflight) return inflight;
    inflight = (async (): Promise<Snapshot> => {
      const rt = await runtimeOf(space);
      const identity = await identityOf(rt);
      let status: Snapshot["status"] = "loaded";
      let error: AuthErrorDto | undefined;
      let rawMethods: Record<string, ProviderAuthMethod[]> = {};
      const provenance: Snapshot["provenance"] = [];
      if (identity.endpoint && !openCodeProcessIsLocal(identity.endpoint)) {
        status = "unavailable";
        error = remoteAuthError();
      } else if (!rt.providerAuthMethods) {
        status = "unavailable";
        error = authError("AUTH_CAPABILITY_UNAVAILABLE");
      } else {
        try {
          rawMethods = await rt.providerAuthMethods();
          provenance.push("opencode-plugin");
          status = Object.values(rawMethods).some((methods) => methods.length > 0) ? "loaded" : "empty";
        } catch (caught) {
          const mapped = mapUpstreamAuthError(caught);
          error = mapped;
          status = mapped.code === "AUTH_CAPABILITY_UNAVAILABLE" ? "unavailable" : "failed";
        }
      }
      const metadata: Record<string, AvailableProviderDescriptor> = {};
      if (status !== "unavailable" && rt.listAllProviders) {
        try {
          for (const provider of await rt.listAllProviders()) metadata[provider.id] = provider;
          provenance.push("provider-metadata");
        } catch {
          /* enrichment only */
        }
      }
      const methodIdentity = Object.entries(rawMethods)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, methods]) => ({
          id,
          methods: methods.map((method) => ({
            upstreamIndex: method.upstreamIndex,
            type: method.type,
            fingerprint: fingerprintAuthMethod(method),
          })),
        }));
      const next: Snapshot = {
        revision: hashCapabilityRevision({
          authorityId: identity.authorityId,
          generation: identity.generation,
          methods: methodIdentity,
        }),
        authorityId: identity.authorityId,
        generation: identity.generation,
        discoveredAt: now(),
        rawMethods,
        metadata,
        status,
        provenance,
        ...(error ? { error } : {}),
        ...(status === "failed" ? { failedAt: now() } : {}),
      };
      snapshot = next;
      return next;
    })().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };

  const viewFromSnapshot = (snap: Snapshot, providerId: string, connected: boolean, justSaved = false): ProviderAuthView => {
    const listed = Object.prototype.hasOwnProperty.call(snap.rawMethods, providerId);
    const methods = listed ? snap.rawMethods[providerId] : undefined;
    const metadata = snap.metadata[providerId];
    const discoveryStatusValue = snap.status === "failed" || snap.status === "unavailable"
      ? snap.status
      : discoveryStatus(true, false, false, methods?.length ?? 0);
    return buildProviderAuthView({
      providerId,
      methods,
      ...(metadata ? { metadata } : {}),
      connected,
      env,
      ...(justSaved ? { justSaved: true } : {}),
      discovery: {
        status: listed ? (methods?.length ? "loaded" : "empty") : discoveryStatusValue,
        provenance: snap.provenance,
        revision: snap.revision,
        authorityId: snap.authorityId,
        generation: snap.generation,
        ...(snap.error && !listed ? { error: snap.error } : {}),
      },
    });
  };

  const publicAttempt = (attempt: AuthAttemptInternal): AuthAttemptDto => ({
    id: attempt.id,
    providerId: attempt.providerId,
    methodId: attempt.methodId,
    upstreamIndex: attempt.upstreamIndex,
    fingerprint: attempt.fingerprint,
    revision: attempt.revision,
    authorityId: attempt.authorityId,
    generation: attempt.generation,
    phase: attempt.phase,
    createdAt: attempt.createdAt,
    ...(attempt.expiresAt ? { expiresAt: attempt.expiresAt } : {}),
    ...(attempt.instructions ? { instructions: attempt.instructions } : {}),
    ...(attempt.url ? { url: attempt.url } : {}),
    ...(attempt.urlKind ? { urlKind: attempt.urlKind } : {}),
    ...(attempt.userCode ? { userCode: attempt.userCode } : {}),
    ...(attempt.verificationUri ? { verificationUri: attempt.verificationUri } : {}),
    ...(attempt.verificationUriComplete ? { verificationUriComplete: attempt.verificationUriComplete } : {}),
    ...(attempt.loopbackWarning ? { loopbackWarning: true } : {}),
    ...(attempt.error ? { error: attempt.error } : {}),
  });

  const currentMethod = (snap: Snapshot, attempt: AuthAttemptInternal): ProviderAuthMethod | undefined =>
    snap.rawMethods[attempt.providerId]?.find((method) => method.upstreamIndex === attempt.upstreamIndex);

  const methodStillMatches = (snap: Snapshot, attempt: AuthAttemptInternal): boolean => {
    if (snap.revision !== attempt.revision) return false;
    if (snap.authorityId !== attempt.authorityId || snap.generation !== attempt.generation) return false;
    const current = currentMethod(snap, attempt);
    return Boolean(current && fingerprintAuthMethod(current) === attempt.fingerprint);
  };

  const supersede = (spaceId: string, authorityId: string, providerId: string): void => {
    const existingId = activeByProvider.get(activeKey(spaceId, authorityId, providerId));
    if (!existingId) return;
    const existing = attempts.get(existingId);
    if (!existing || isTerminalPhase(existing.phase)) return;
    existing.abort.abort();
    markTerminal(existing, "stale", authError("AUTH_SESSION_STALE"));
  };

  const assignPhase = (attempt: AuthAttemptInternal, next: AuthPhase): boolean => {
    const resolved = transitionPhase(attempt.phase, next);
    if (resolved !== next) return false;
    attempt.phase = resolved;
    return true;
  };

  const admitCallback = (attempt: AuthAttemptInternal, run: () => Promise<void>): Promise<void> => {
    if (attempt.callbackState === "completed") return attempt.callbackPromise ?? Promise.resolve();
    if (attempt.callbackState === "running" && attempt.callbackPromise) return attempt.callbackPromise;
    attempt.callbackState = "running";
    attempt.callbackPromise = run().finally(() => {
      if (attempt.callbackState === "running") attempt.callbackState = "completed";
    });
    return attempt.callbackPromise;
  };

  const runCallback = async (attempt: AuthAttemptInternal, rt: AgentRuntime, code?: string): Promise<void> => {
    if (!rt.providerAuthCallback) {
      markTerminal(attempt, "failed", authError("AUTH_METHOD_UNAVAILABLE"));
      return;
    }
    try {
      if (code) assignPhase(attempt, "validating");
      else if (attempt.phase !== "device_action_required" && attempt.phase !== "browser_action_required") {
        assignPhase(attempt, "waiting");
      }
      // Cancellation is fencing-only: OpenCodeTransport.mutate has no AbortSignal.
      // The 15-minute adapter deadline bounds the upstream request.
      await rt.providerAuthCallback(attempt.providerId, attempt.upstreamIndex, code);
      if (attempt.abort.signal.aborted || isTerminalPhase(attempt.phase)) return;
      const live = await identityOf(rt);
      if (live.authorityId !== attempt.authorityId || live.generation !== attempt.generation) {
        markTerminal(attempt, "stale", authError("AUTH_RUNTIME_RESTARTED"));
        return;
      }
      markTerminal(attempt, "connected");
      invalidate();
      deps.invalidateModels();
    } catch (caught) {
      if (attempt.abort.signal.aborted || isTerminalPhase(attempt.phase)) return;
      const mapped = mapUpstreamAuthError(caught, attempt.secrets);
      const failed: AuthPhase = mapped.code === "AUTH_DENIED"
        ? "denied"
        : mapped.code === "AUTH_EXPIRED"
          ? "expired"
          : "failed";
      markTerminal(attempt, failed, mapped);
    }
  };

  const startAttempt = async (input: {
    providerId: string;
    methodId: string;
    inputs?: Record<string, string>;
    revision?: string;
    browserLocality?: "native-desktop" | "unknown";
    space: SpaceContext;
  }): Promise<AuthAttemptDto> => {
    sweep();
    assertInteractiveProviderAuth(input.space);
    const spaceId = input.space.spaceId;
    const snap = await loadSnapshot(input.space);
    const rt = await runtimeOf(input.space);
    const identity = await requireLocalIdentity(rt);
    if (snap.status === "unavailable") {
      return throwAuthError(snap.error ?? remoteAuthError());
    }
    if (identity.authorityId !== snap.authorityId || identity.generation !== snap.generation) {
      invalidate();
      return throwAuthError(authError("AUTH_RUNTIME_RESTARTED"));
    }
    if (input.revision && input.revision !== snap.revision) {
      return throwAuthError(authError("AUTH_PROVIDER_PROTOCOL_CHANGED"));
    }
    const view = viewFromSnapshot(snap, input.providerId, false);
    const method = view.methods.find((item) => item.id === input.methodId);
    if (!method) return throwAuthError(authError("AUTH_METHOD_UNAVAILABLE"));
    if (!method.usable) return throwAuthError(method.unavailability ?? authError("AUTH_METHOD_UNAVAILABLE"));
    const wire = snap.rawMethods[input.providerId]?.find((item) => item.upstreamIndex === method.upstreamIndex);
    if (!wire || fingerprintAuthMethod(wire) !== method.fingerprint) {
      return throwAuthError(authError("AUTH_PROVIDER_PROTOCOL_CHANGED"));
    }
    const inputs = pruneHiddenValues(method.fields, withSelectDefaults(method.fields, input.inputs ?? {}));
    const incomplete = firstIncompleteField(method.fields, inputs);
    if (incomplete) return throwAuthError(authError("AUTH_INPUT_INVALID", { field: incomplete }));
    if (method.kind === "api") {
      const key = (inputs.key ?? "").trim();
      if (!key) return throwAuthError(authError("AUTH_INPUT_INVALID", { field: "key" }));
      if (!rt.setProviderApiKey) return throwAuthError(authError("AUTH_CAPABILITY_UNAVAILABLE"));
      // Current OpenCode HTTP can only PUT /auth/:id {type:"api",key,metadata}.
      // Plugin API methods with authorize() are CLI-only; we do not invent that hook.
    } else {
      if (!rt.providerAuthorize || !rt.providerAuthCallback) {
        return throwAuthError(authError("AUTH_METHOD_UNAVAILABLE"));
      }
    }

    supersede(spaceId, snap.authorityId, input.providerId);
    const secrets = method.fields.filter((field) => field.secret).map((field) => inputs[field.key] ?? "").filter(Boolean);
    const attempt: AuthAttemptInternal = {
      id: randomUUID(),
      providerId: input.providerId,
      methodId: method.id,
      upstreamIndex: method.upstreamIndex,
      fingerprint: method.fingerprint,
      revision: snap.revision,
      authorityId: snap.authorityId,
      generation: snap.generation,
      phase: "starting",
      createdAt: now(),
      abort: new AbortController(),
      secrets,
      oauthMethod: method.kind === "api" ? "api" : "auto",
      callbackState: "idle",
      spaceId,
    };
    attempts.set(attempt.id, attempt);
    activeByProvider.set(activeKey(spaceId, snap.authorityId, input.providerId), attempt.id);

    if (method.kind === "api") {
      const key = (inputs.key ?? "").trim();
      const metadata = { ...inputs };
      delete metadata.key;
      try {
        assignPhase(attempt, "validating");
        await rt.setProviderApiKey!(input.providerId, key, Object.keys(metadata).length ? metadata : undefined);
        markTerminal(attempt, "configured_unverified");
        invalidate();
        deps.invalidateModels();
        return publicAttempt(attempt);
      } catch (caught) {
        markTerminal(attempt, "failed", mapUpstreamAuthError(caught, secrets));
        return throwAuthError(attempt.error!);
      }
    }

    let authorization: ProviderAuthorization;
    try {
      authorization = await rt.providerAuthorize!(
        input.providerId,
        method.upstreamIndex,
        Object.keys(inputs).length ? inputs : undefined,
      );
    } catch (caught) {
      markTerminal(attempt, "failed", mapUpstreamAuthError(caught, secrets));
      return throwAuthError(attempt.error!);
    }

    const device = extractDeviceFlow({
      instructions: authorization.instructions,
      url: authorization.url,
    });
    attempt.instructions = authorization.instructions;
    attempt.url = authorization.url;
    attempt.urlKind = classifyAuthUrl(authorization.url);
    if (device.userCode) attempt.userCode = device.userCode;
    if (device.verificationUri) attempt.verificationUri = device.verificationUri;
    if (device.verificationUriComplete) attempt.verificationUriComplete = device.verificationUriComplete;
    if (device.expiresIn) attempt.expiresAt = now() + device.expiresIn * 1000;
    attempt.oauthMethod = authorization.method;

    const loopback = urlHasLoopbackRedirect(authorization.url);
    const localProcess = identity.endpoint ? openCodeProcessIsLocal(identity.endpoint) : undefined;
    const browserOnHost = input.browserLocality === "native-desktop";
    // Socket ingress cannot prove where the browser is (SSH tunnels and reverse
    // proxies lie). Warn whenever loopback auto would need a co-located browser
    // we cannot prove. Fail closed only when the OpenCode runtime is known remote.
    if (loopback && (localProcess !== true || !browserOnHost)) {
      attempt.loopbackWarning = true;
    }
    const knownUnreachable = loopback
      && authorization.method !== "code"
      && !device.userCode
      && localProcess === false;
    if (knownUnreachable) {
      markTerminal(attempt, "failed", authError("AUTH_REMOTE_LOOPBACK_UNREACHABLE"));
      return publicAttempt(attempt);
    }

    if (device.userCode) attempt.phase = "device_action_required";
    else if (authorization.method === "code") attempt.phase = "awaiting_code";
    else attempt.phase = "browser_action_required";

    if (authorization.method === "auto") {
      void admitCallback(attempt, () => runCallback(attempt, rt));
    }
    return publicAttempt(attempt);
  };

  const getAttempt = (id: string, space: SpaceContext): AuthAttemptDto | undefined => {
    sweep();
    const attempt = attempts.get(id);
    if (!attempt || !attemptInSpace(attempt, space)) return undefined;
    if (attempt.expiresAt && now() > attempt.expiresAt && isWaitingPhase(attempt.phase)) {
      attempt.abort.abort();
      markTerminal(attempt, "expired", authError("AUTH_EXPIRED"));
    }
    return publicAttempt(attempt);
  };

  const failedResult = (attempt: AuthAttemptInternal): boolean =>
    Boolean(attempt.error && attempt.phase !== "connected" && attempt.phase !== "configured_unverified");

  const completeAttempt = async (id: string, code: string | undefined, space: SpaceContext): Promise<AuthAttemptDto> => {
    sweep();
    assertInteractiveProviderAuth(space);
    const attempt = attempts.get(id);
    if (!attempt || !attemptInSpace(attempt, space)) return throwAuthError(authError("AUTH_SESSION_STALE"));
    if (attempt.phase === "connected" || attempt.phase === "configured_unverified") return publicAttempt(attempt);
    if (isTerminalPhase(attempt.phase)) return throwAuthError(attempt.error ?? authError("AUTH_SESSION_STALE"));
    const snap = await loadSnapshot(space);
    if (!methodStillMatches(snap, attempt)) {
      markTerminal(attempt, "stale", authError("AUTH_PROVIDER_PROTOCOL_CHANGED"));
      return throwAuthError(attempt.error!);
    }
    if (attempt.oauthMethod === "auto" || attempt.callbackState !== "idle") {
      const rt = await runtimeOf(space);
      await admitCallback(attempt, () => runCallback(attempt, rt));
      if (failedResult(attempt)) return throwAuthError(attempt.error!);
      return publicAttempt(attempt);
    }
    if (attempt.phase !== "awaiting_code") {
      return throwAuthError(authError("AUTH_INPUT_INVALID", { details: "this attempt is not waiting for a code" }));
    }
    const parsed = code !== undefined ? parseAuthorizationCode(code) : undefined;
    if (!parsed || !parsed.ok) {
      return throwAuthError(parsed && !parsed.ok ? parsed.error : authError("AUTH_INPUT_INVALID", { field: "code" }));
    }
    attempt.secrets.push(parsed.code);
    const rt = await runtimeOf(space);
    await admitCallback(attempt, () => runCallback(attempt, rt, parsed.code));
    if (failedResult(attempt)) return throwAuthError(attempt.error!);
    return publicAttempt(attempt);
  };

  const cancelAttempt = (id: string, space: SpaceContext): AuthAttemptDto => {
    sweep();
    assertInteractiveProviderAuth(space);
    const attempt = attempts.get(id);
    if (!attempt || !attemptInSpace(attempt, space)) return throwAuthError(authError("AUTH_SESSION_STALE"));
    if (!isTerminalPhase(attempt.phase)) {
      attempt.abort.abort();
      markTerminal(attempt, "cancelled", authError("AUTH_CANCELLED"));
    }
    return publicAttempt(attempt);
  };

  const capabilities = async (connected: ReadonlySet<string>, space: SpaceContext): Promise<ProviderAuthCapabilitiesDto> => {
    const snap = await loadSnapshot(space);
    const ids = new Set([...Object.keys(snap.rawMethods), ...Object.keys(snap.metadata), ...connected]);
    const providers: Record<string, ProviderAuthView> = {};
    for (const id of ids) {
      const view = viewFromSnapshot(snap, id, connected.has(id));
      const activeId = activeByProvider.get(activeKey(space.spaceId, snap.authorityId, id));
      const active = activeId ? attempts.get(activeId) : undefined;
      if (
        active
        && attemptInSpace(active, space)
        && !isTerminalPhase(active.phase)
        && active.authorityId === snap.authorityId
        && active.generation === snap.generation
      ) {
        view.activeAttempt = publicAttempt(active);
      }
      providers[id] = view;
    }
    return {
      revision: snap.revision,
      authorityId: snap.authorityId,
      generation: snap.generation,
      discoveredAt: snap.discoveredAt,
      providers,
      discovery: {
        status: snap.status,
        provenance: snap.provenance,
        ...(snap.error ? { error: snap.error } : {}),
      },
    };
  };

  const view = async (providerId: string, connected: boolean, space: SpaceContext): Promise<ProviderAuthView> => {
    const snap = await loadSnapshot(space);
    const result = viewFromSnapshot(snap, providerId, connected);
    const activeId = activeByProvider.get(activeKey(space.spaceId, snap.authorityId, providerId));
    const active = activeId ? attempts.get(activeId) : undefined;
    if (
      active
      && attemptInSpace(active, space)
      && !isTerminalPhase(active.phase)
      && active.authorityId === snap.authorityId
      && active.generation === snap.generation
    ) {
      result.activeAttempt = publicAttempt(active);
    }
    return result;
  };

  const saveCredential = async (
    providerId: string,
    key: string,
    metadata: Record<string, string> | undefined,
    space: SpaceContext,
  ): Promise<ProviderAuthView> => {
    assertInteractiveProviderAuth(space);
    const rt = await runtimeOf(space);
    await requireLocalIdentity(rt);
    if (!rt.setProviderApiKey) return throwAuthError(authError("AUTH_CAPABILITY_UNAVAILABLE"));
    try {
      await rt.setProviderApiKey(providerId, key, metadata);
    } catch (caught) {
      return throwAuthError(mapUpstreamAuthError(caught, [key]));
    }
    invalidate();
    deps.invalidateModels();
    return viewFromSnapshot(await loadSnapshot(space), providerId, false, true);
  };

  const disconnect = async (
    providerId: string,
    space: SpaceContext,
  ): Promise<{ ok: true; remaining?: ProviderAuthView["credential"] }> => {
    assertInteractiveProviderAuth(space);
    const rt = await runtimeOf(space);
    await requireLocalIdentity(rt);
    if (!rt.removeProviderAuth) return throwAuthError(authError("AUTH_CAPABILITY_UNAVAILABLE"));
    try {
      await rt.removeProviderAuth(providerId);
    } catch (caught) {
      return throwAuthError(mapUpstreamAuthError(caught));
    }
    invalidate();
    deps.invalidateModels();
    const remaining = (await view(providerId, false, space)).credential;
    return remaining?.source === "environment" || remaining?.envVarNames?.length
      ? { ok: true, remaining }
      : { ok: true };
  };

  const previewWellKnown = async (origin: string, space: SpaceContext): Promise<WellKnownPreviewDto> => {
    assertInteractiveProviderAuth(space);
    const rt = await runtimeOf(space);
    const identity = await requireLocalIdentity(rt);
    if (!identity.endpoint || !openCodeProcessIsLocal(identity.endpoint)) {
      return throwAuthError(remoteAuthError());
    }
    return wellKnown.preview(origin, localAuthTarget(space, identity));
  };

  const executeWellKnown = async (originInput: string, hash: string, space: SpaceContext): Promise<{ ok: true }> => {
    assertInteractiveProviderAuth(space);
    const rt = await runtimeOf(space);
    const identity = await requireLocalIdentity(rt);
    if (!identity.endpoint || !openCodeProcessIsLocal(identity.endpoint)) {
      return throwAuthError(remoteAuthError());
    }
    const target = localAuthTarget(space, identity);
    const pin = wellKnown.takePin(originInput, hash, target);
    // Spawn is local-process only (pin.executionLocality). HTTP/UI has no
    // cancel route: closing the dialog does not abort this child. The command
    // runs until exit or the spawn timeout, then identity is re-checked
    // before persistence so a generation change during the command cannot
    // write credentials.
    let result: Awaited<ReturnType<typeof runPinnedArgv>>;
    try {
      result = await runPinnedArgv({ argv: pin.command });
    } catch (caught) {
      const code = (caught as { code?: string }).code;
      if (code === "AUTH_EXPIRED") return throwAuthError(authError("AUTH_EXPIRED", { details: "command timed out" }));
      if (code === "AUTH_CANCELLED") return throwAuthError(authError("AUTH_CANCELLED"));
      return throwAuthError(authError("AUTH_CALLBACK_FAILED", { details: "command failed to start" }));
    }
    if (result.stdoutOverflow) {
      return throwAuthError(authError("AUTH_WELLKNOWN_UNSAFE", { details: "command output exceeded the token size limit" }));
    }
    if (result.code !== 0) {
      const leaked = result.stdout.toString("utf8").trim();
      const details = redactSecrets(result.stderr.toString("utf8"), leaked ? [leaked] : []).slice(0, 500);
      return throwAuthError(authError("AUTH_CALLBACK_FAILED", { details: details || `command exited ${result.code ?? result.signal}` }));
    }
    const token = result.stdout.toString("utf8").trim();
    if (!token) return throwAuthError(authError("AUTH_CALLBACK_FAILED", { details: "command produced an empty token" }));
    const live = await identityOf(rt);
    if (live.authorityId !== pin.authorityId || live.generation !== pin.generation) {
      return throwAuthError(authError("AUTH_RUNTIME_RESTARTED"));
    }
    if (!rt.setProviderAuth) {
      return throwAuthError(authError("AUTH_CAPABILITY_UNAVAILABLE", { details: "runtime cannot persist organization credentials" }));
    }
    try {
      await rt.setProviderAuth(pin.origin, { type: "wellknown", key: pin.env, token });
    } catch (caught) {
      return throwAuthError(mapUpstreamAuthError(caught, [token]));
    }
    invalidate();
    deps.invalidateModels();
    return { ok: true };
  };

  return {
    notifyRuntimeChange,
    invalidate,
    capabilities,
    view,
    startAttempt,
    getAttempt,
    completeAttempt,
    cancelAttempt,
    saveCredential,
    disconnect,
    previewWellKnown,
    executeWellKnown,
  };
}
