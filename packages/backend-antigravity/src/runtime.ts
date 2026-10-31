import { createHash, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import type {
  AgentRuntime, HarnessContext, JsonObject, ModelDescriptor, ModelRef, MutationOutcome, RuntimeCommandDescriptor,
  RuntimeEvent, RuntimeObservation, RuntimeSnapshot, TokenUsage,
} from "@polyth/contracts";
import {
  AGENT_BETA_READ_ONLY_MESSAGE,
  acknowledgeCapabilityApplication,
  agentBetaEnabled,
  captureCapabilityLaunch,
  deltaTokenUsage,
  provisioningTarget,
  releaseCapabilityLaunch,
  resolveModelSelection,
  isFilesystemMutationPermission,
} from "@polyth/harness-runtime";
import type { HarnessProcessAuthority } from "@polyth/harness-runtime/process-authority";
import { stageAgyAttachments, type AgyInjectedStep, type AgyStagedAttachments } from "./attachments.ts";
import {
  classifyAgyPermission, isNativeDelegationTool, parseAgyHookRequest, NATIVE_DELEGATION_DENY_REASON,
  type AgyHookDecision, type AgyHookHandler, type AgyHookRequest, type AgyInvocationResult, type AgyStopResult,
  type AntigravityPermissionBridge,
} from "./permissions.ts";
import { antigravityOverlays } from "./provisioner.ts";
import { agyQuestionItems, agyQuestionReply, parseAgyQuestions, type AgyQuestion } from "./questions.ts";
import type { AntigravityTitleReader } from "./title.ts";
import { ANTIGRAVITY_CAPABILITIES, agyError, agyLaunchArgs, agyUsage, createAgyDecoder, createAgyTurn, record, sameAgyModel, text } from "./protocol.ts";

type Admission = MutationOutcome<{ admissionId?: string }>;
export interface AntigravityRuntimeOptions {
  context: HarnessContext;
  authority: HarnessProcessAuthority;
  command: string;
  workerPath: string;
  env?: NodeJS.ProcessEnv;
  models(): Promise<ModelDescriptor[]>;
  /** Launch the native CLI with its headless permission bypass. This is a
   * launch mode, not an approval: it never answers a tool. Every gated tool
   * still crosses the PreToolUse bridge into Polyth's canonical permission
   * policy (rules, Auto-Approve and its risk hold, or a person). */
  nativePermissionBypass(): Promise<boolean>;
  /** Optional reader for the CLI's generated per-conversation title. */
  titleReader?: AntigravityTitleReader;
  /** Native skill catalog (the CLI's local `/skills` report); absent means none. */
  commands?(): Promise<RuntimeCommandDescriptor[]>;
  permissionBridge(handle: AgyHookHandler): Promise<AntigravityPermissionBridge>;
  /** The CLI's MCP tool-schema cache under the private home; reads inside it need no approval. */
  mcpSchemaRoot?: string;
  timeoutMs?: number;
  /** `antigravity` or one of its account harnesses (`antigravity-<account>`). */
  harnessId?: string;
}

/** Steering text accepted for the running turn but not yet injected. */
type PendingSteer = { operationId: string; text: string };
const MAX_STEER_BYTES = 256 * 1024;
const MAX_CARRIED_STEERS = 16;

/** One native process per canonical runtime. No agent loop, provider fallback or hidden replay. */
export function createAntigravityRuntime(options: AntigravityRuntimeOptions): AgentRuntime {
  const { context, authority } = options;
  const harnessId = options.harnessId ?? "antigravity";
  const mcpSchemaOptions = options.mcpSchemaRoot ? { mcpSchemaRoot: options.mcpSchemaRoot } : {};
  let child: ChildProcess | undefined;
  let nativeId = "";
  let sessionTitle = "";
  let createId = "";
  let selectedModel: ModelRef | undefined;
  let selectedAgent: string | undefined;
  let started = false;
  let connected = true;
  /** The native CLI leg, not the worker. A stopped or exited leg is relaunched
   * on the recorded conversation by the next turn; only a lost worker is fatal. */
  let nativeLive = false;
  let nativeStopExpected = false;
  let nativeReleased: ((released: boolean) => void) | undefined;
  let stopping = false;
  let released = false;
  let closing: Promise<void> | undefined;
  let permissionBridge: AntigravityPermissionBridge | undefined;
  let permissionBridgeClosing: Promise<void> | undefined;
  let launchBypass = false;
  let expectedReinitBypass: boolean | undefined;
  let initialization: Promise<void> | undefined;
  let initResolve: (() => void) | undefined;
  let initReject: ((error: Error) => void) | undefined;
  let initTimer: ReturnType<typeof setTimeout> | undefined;
  let active: {
    id: string;
    turn: ReturnType<typeof createAgyTurn>;
    admit?: (outcome: Admission) => void;
    timer?: ReturnType<typeof setTimeout>;
    promptProjection?: {
      target: ReturnType<typeof provisioningTarget>;
      desiredRevision: string;
      capabilityIds: string[];
    };
    /** Tool calls that open this turn's attachments before its first model call. */
    injections: AgyInjectedStep[];
    stagedPaths: Set<string>;
    stagedUrls: Set<string>;
    /** Accepted steering, injected in order as native user messages. */
    steers: PendingSteer[];
    /** Injected user messages, which the CLI may count as turns. */
    injectedMessages: number;
    /** PreInvocation hooks seen in this turn: proof the injection seam is live. */
    invocations: number;
    /** One Stop re-entry per pending steer batch, so a lost injection cannot loop. */
    stopContinued: boolean;
  } | undefined;
  /** Steering the CLI never received before its turn ended; the next prompt carries it. */
  let carriedSteers: string[] = [];
  let nativeCommands: RuntimeCommandDescriptor[] = [];
  let commandDiscovery: Promise<void> | undefined;
  /** A fresh catalog, or a failed report's backoff, suppresses a new report. */
  let commandsQuietUntil = 0;
  let selectionPending = false;
  let stagedLaunchTarget: ReturnType<typeof provisioningTarget> | undefined;
  let stagedRevision: string | undefined;
  let stagedLaunchCapabilityIds: string[] | undefined;
  let previousUsage: TokenUsage | undefined;
  let usageBaselineKnown = true;
  let completedTurns: number | undefined;
  let completedStep = -1;
  let currentMaxStep = -1;
  let pendingNativeError: Record<string, unknown> | undefined;
  let serial = 0;
  let order = 0;
  let reconciliationOrdinal = 0;
  // A workspace runtime starts unbound; the first canonical session named by
  // an operation claims it so utility callers can observe their own turn.
  let activeSessionId = context.sessionId ?? "";
  const events = new Map<string, RuntimeSnapshot["events"][number]>();
  const accepted: NonNullable<RuntimeSnapshot["acceptedOperations"]> = [];
  const permissions = new Map<string, {
    permission: string;
    patterns: string[];
    tool: string;
    resolvers: Set<(decision: AgyHookDecision) => void>;
  }>();
  const questions = new Map<string, {
    questions: AgyQuestion[];
    items: JsonObject[];
    resolvers: Set<(decision: AgyHookDecision) => void>;
  }>();
  const listeners = new Set<Parameters<AgentRuntime["onEvent"]>[0]>();
  const observations = new Set<Parameters<NonNullable<AgentRuntime["onObservation"]>>[0]>();
  const lifecycle = new Set<Parameters<NonNullable<AgentRuntime["onLifecycle"]>>[0]>();
  const endpoint = {
    authorityId: authority.authorityId, generation: authority.generation, continuity: "generation-only" as const,
    url: "stdio:antigravity", location: { directory: context.cwd },
    control: { kind: "owned" as const, instanceToken: authority.authorityId },
    config: { kind: "read-only" as const }, authentication: { kind: "none" as const },
  };
  const belongs = (sessionId: string) => !!activeSessionId && sessionId === activeSessionId;
  // A workspace runtime starts unbound; the first canonical session named by
  // an operation claims it. Bound session runtimes keep the strict check.
  const claim = (sessionId: string | undefined) => {
    if (sessionId && !context.sessionId) activeSessionId = sessionId;
  };
  const knownNative = (id: string) => Object.entries(authority.receipts).some(([key, value]) => key.startsWith("create:") && value === id);
  const rejected = (code: string, message: string) => ({ kind: "rejected" as const, code, message });
  const unknown = (operationId: string, message: string) => ({ kind: "unknown" as const, operationId, message });
  const announce = () => {
    for (const callback of lifecycle) callback({ type: connected ? "stream-connected" : "stream-disconnected", authorityId: authority.authorityId, generation: authority.generation });
  };
  const emit = (event: RuntimeEvent) => {
    if (!activeSessionId) return;
    const entityKey = `${active?.id || createId || nativeId}:${++serial}`;
    const revision = createHash("sha256").update(JSON.stringify(event)).digest("hex");
    const artifactKind = event.type.startsWith("tool/") ? "tool"
      : event.type.startsWith("turn/") ? "turn"
        : event.type === "permission/requested" ? "permission"
          : event.type === "question/asked" ? "question"
            : event.type === "context/updated" || event.type === "runtime/commands-changed" || event.type === "session/compacted" ? "status"
              : "message";
    events.set(entityKey, { entityKey, revision, artifactKind, events: [event] });
    // Canonical storage is authoritative; this is a bounded partial replay cache.
    if (events.size > 4096) events.delete(events.keys().next().value!);
    if (observations.size) {
      const observation: RuntimeObservation = { channel: "sse", entityKey, reconciliationOrdinal,
        identity: { ...endpoint, backendSessionId: nativeId, artifactKind, entityId: entityKey, revision }, events: [event] };
      for (const callback of observations) callback(activeSessionId, observation);
    } else for (const callback of listeners) callback(activeSessionId, event);
  };
  // Antigravity generates a conversation title into its own annotation store.
  // Read only that metadata and publish it as a native title; never import the
  // native transcript. Absence is normal until the CLI finishes naming a
  // conversation, so a miss is silent.
  const adoptNativeTitle = async (conversationId: string): Promise<void> => {
    if (!options.titleReader || !conversationId || conversationId !== nativeId) return;
    const title = await options.titleReader.read(conversationId);
    if (!title || title === sessionTitle) return;
    sessionTitle = title;
    emit({ type: "session/title-generated", title });
  };
  const settleAdmission = (outcome: Admission) => {
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    const resolve = active.admit;
    active.admit = undefined;
    resolve?.(outcome);
  };
  const closeAuthority = () => {
    if (released) return Promise.resolve();
    if (!closing) closing = authority.close().then(() => { released = true; }).finally(() => { closing = undefined; });
    return closing;
  };
  const closePermissionBridge = () => {
    if (!permissionBridge) return Promise.resolve();
    if (!permissionBridgeClosing) permissionBridgeClosing = permissionBridge.close().finally(() => {
      permissionBridge = undefined;
      permissionBridgeClosing = undefined;
    });
    return permissionBridgeClosing;
  };
  /** Settle every pending native approval and question with one decision. */
  const resolveAllPermissions = (decision: AgyHookDecision) => {
    for (const pending of permissions.values()) for (const resolve of pending.resolvers) resolve(decision);
    permissions.clear();
    for (const pending of questions.values()) for (const resolve of pending.resolvers) resolve(decision);
    questions.clear();
  };
  /** Keep undelivered steering for the next prompt (bounded, oldest first). */
  const carrySteers = (steers: readonly PendingSteer[]) => {
    carriedSteers = [...carriedSteers, ...steers.map((steer) => steer.text)].slice(-MAX_CARRIED_STEERS);
  };
  const currentBypass = async () => {
    try { return await options.nativePermissionBypass(); } catch { return false; }
  };
  /** The active turn a loop hook belongs to; any other conversation gets the native default. */
  const hookTurn = (payload: unknown) => {
    const conversationId = text(record(payload)?.conversationId);
    return nativeId && conversationId === nativeId && active && !active.turn.terminal ? active : undefined;
  };
  // Headless Antigravity cannot show `ask_question`; Polyth asks instead and
  // the answer returns to the model as this hook's decision reason.
  const askUser = (request: AgyHookRequest, turnId: string): Promise<AgyHookDecision> => {
    const parsed = parseAgyQuestions(request.args);
    if (!parsed) {
      return Promise.resolve({ decision: "deny", reason: "Polyth could not display this question; ask the user in plain text instead" });
    }
    const requestId = `agyq_${createHash("sha256")
      .update(JSON.stringify([turnId, request.conversationId, request.stepIdx, request.args]))
      .digest("hex")}`;
    return new Promise<AgyHookDecision>((resolveQuestion) => {
      const existing = questions.get(requestId);
      if (existing) {
        existing.resolvers.add(resolveQuestion);
        return;
      }
      const items = agyQuestionItems(parsed);
      questions.set(requestId, { questions: parsed, items, resolvers: new Set([resolveQuestion]) });
      emit({ type: "question/asked", requestId, questions: items });
    });
  };
  // Before each model call: open this turn's attachments first, then deliver
  // steering as native user messages, all ahead of the model's next step.
  const handleInvocation = async (payload: unknown): Promise<AgyInvocationResult> => {
    const current = hookTurn(payload);
    if (!current) return {};
    current.invocations++;
    const injectSteps = current.injections.splice(0);
    if (current.steers.length) {
      injectSteps.push(...current.steers.map((steer) => ({ userMessage: steer.text })));
      current.injectedMessages += current.steers.length;
      current.steers = [];
      current.stopContinued = false;
    }
    return injectSteps.length ? { injectSteps } : {};
  };
  // Steering that arrived while the model was finishing re-enters the native
  // loop once; the next PreInvocation injects it. An error or step-limit stop
  // is final, and its steering is carried to the next prompt instead.
  const handleStop = async (payload: unknown): Promise<AgyStopResult> => {
    const current = hookTurn(payload);
    const reason = text(record(payload)?.terminationReason);
    if (!current || !current.steers.length || current.stopContinued || (reason && reason !== "model_stop")) return {};
    current.stopContinued = true;
    return {
      decision: "continue",
      reason: "The user sent another message while you were finishing. It follows; address it before you end the turn.",
    };
  };
  const handleHook: AgyHookHandler = async (payload, event = "PreToolUse") => {
    if (event === "PreInvocation") return handleInvocation(payload);
    if (event === "Stop") return handleStop(payload);
    return handleToolHook(payload);
  };
  const handleToolHook = async (payload: unknown): Promise<AgyHookDecision> => {
    const request = parseAgyHookRequest(payload);
    if (!request) return { decision: "deny", reason: "Antigravity supplied an invalid tool approval request" };
    if (!nativeId || request.conversationId !== nativeId || !active || active.turn.terminal) {
      return { decision: "deny", reason: "Tool request does not belong to the active Polyth turn" };
    }
    const turnId = active.id;
    // This deny is evaluated before any approval and covers every native spawn
    // surface the CLI advertises, not just `invoke_subagent`. Delegated work
    // must be a canonical Polyth child session created through agent.spawn.
    if (isNativeDelegationTool(request.tool)) {
      return { decision: "deny", reason: NATIVE_DELEGATION_DENY_REASON };
    }
    if (request.tool === "ask_question") return askUser(request, turnId);
    // The native CLI runs headless, so this hook is the hard workspace mutation
    // boundary in beta mode rather than a UI prompt the model could bypass.
    const betaClassification = agentBetaEnabled()
      ? await classifyAgyPermission(request, context.cwd, mcpSchemaOptions)
      : undefined;
    if (betaClassification?.kind === "deny") {
      return { decision: "deny", reason: betaClassification.reason };
    }
    if (betaClassification
      && isFilesystemMutationPermission(betaClassification.permission)) {
      return { decision: "deny", reason: AGENT_BETA_READ_ONLY_MESSAGE };
    }
    // The launch bypass only stops the headless CLI from auto-denying; it is
    // never an answer. Gated tools reach Polyth's canonical policy below, which
    // applies rules, Auto-Approve (and its high-risk hold) or asks a person.
    if (!active || active.id !== turnId || active.turn.terminal)
      return { decision: "deny", reason: "The Polyth turn ended before approval" };
    // Opening what the user attached to this turn needs no second approval.
    const openedPath = request.tool === "view_file" && typeof request.args.AbsolutePath === "string"
      ? resolvePath(request.args.AbsolutePath) : undefined;
    if (openedPath && active.stagedPaths.has(openedPath)) return { decision: "allow" };
    if (request.tool === "read_url_content" && typeof request.args.Url === "string") {
      let href: string | undefined;
      try { href = new URL(request.args.Url).href; } catch { href = undefined; }
      if (href && active.stagedUrls.has(href)) return { decision: "allow" };
    }
    const classification = betaClassification ?? await classifyAgyPermission(request, context.cwd, mcpSchemaOptions);
    if (!active || active.id !== turnId || active.turn.terminal)
      return { decision: "deny", reason: "The Polyth turn ended before approval" };
    if (classification.kind === "deny") return { decision: "deny", reason: classification.reason };
    if (classification.kind === "allow") return { decision: "allow" };
    const requestId = `agy_${createHash("sha256")
      .update(JSON.stringify([turnId, request.conversationId, request.stepIdx, request.tool, request.args]))
      .digest("hex")}`;
    return new Promise<AgyHookDecision>((resolvePermission) => {
      const existing = permissions.get(requestId);
      if (existing) {
        existing.resolvers.add(resolvePermission);
        return;
      }
      permissions.set(requestId, {
        permission: classification.permission,
        patterns: classification.patterns,
        tool: classification.tool,
        resolvers: new Set([resolvePermission]),
      });
      emit({
        type: "permission/requested",
        requestId,
        permission: classification.permission,
        patterns: classification.patterns,
        tool: classification.tool,
      });
    });
  };
  // The owned worker outlives its native leg, so a stopped or exited
  // conversation leaves this runtime usable: the next turn relaunches the
  // recorded conversation. Counters restart exactly like a resume, because the
  // replacement leg reports the native store's own step/turn numbering.
  const loseNativeLeg = (message: string) => {
    const aborted = nativeStopExpected;
    nativeStopExpected = false;
    nativeLive = false;
    expectedReinitBypass = undefined;
    completedTurns = undefined;
    completedStep = -1;
    currentMaxStep = -1;
    previousUsage = undefined;
    usageBaselineKnown = false;
    pendingNativeError = undefined;
    resolveAllPermissions({ decision: "deny", reason: message });
    if (active) {
      // A user stop discards steering for the stopped turn; an exited leg
      // hands it to the next prompt, since the CLI never received it.
      if (!aborted) carrySteers(active.steers);
      settleAdmission(unknown(active.id, message));
      emit(aborted
        ? { type: "turn/stopped", turnId: active.id, reason: "aborted" }
        : { type: "turn/stopped", turnId: active.id, reason: "error", code: "unknown", error: message });
      active = undefined;
    }
    order++;
    const release = nativeReleased;
    nativeReleased = undefined;
    release?.(true);
  };
  const fail = (error: Error) => {
    if (!connected || stopping) return;
    connected = false;
    nativeLive = false;
    nativeReleased?.(false);
    nativeReleased = undefined;
    if (initTimer) clearTimeout(initTimer);
    if (stagedLaunchTarget && stagedRevision && !nativeId) {
      releaseCapabilityLaunch({
        target: stagedLaunchTarget,
        desiredRevision: stagedRevision,
      });
      stagedLaunchTarget = undefined;
      stagedRevision = undefined;
      stagedLaunchCapabilityIds = undefined;
    }
    initReject?.(error);
    initReject = undefined;
    if (active) settleAdmission(unknown(active.id, error.message));
    resolveAllPermissions({ decision: "deny", reason: "Antigravity runtime disconnected" });
    // A closed pipe is not release proof. Only the shared authority can fence
    // descendants. Keep the turn uncertain when containment cannot be proved.
    void Promise.all([closeAuthority(), closePermissionBridge()]).then(() => {
      if (active) {
        emit({ type: "turn/stopped", turnId: active.id, reason: "error", code: "unknown", error: error.message });
        active = undefined;
      }
      order++;
      announce();
    }, () => announce());
  };
  const validateModel = async (model?: ModelRef): Promise<ModelRef | undefined> => {
    if (!model) return undefined;
    const selection = resolveModelSelection(await options.models(), model, harnessId);
    if (!selection.ok) throw agyError(selection.code, selection.message);
    const resolved: ModelRef = {
      ...model,
      ...(selection.variant
        ? { variant: selection.variant }
        : (selection.descriptor?.defaultVariant ? { variant: selection.descriptor.defaultVariant } : {})),
    };
    agyLaunchArgs(resolved);
    return resolved;
  };
  const admitted = async () => {
    const current = active;
    if (!current?.admit) return;
    await authority.receipt(`turn:${current.id}`, nativeId);
    if (stopping || !connected || active !== current) return;
    accepted.push({ operationId: current.id, mutationKind: "turn-submit", receipt: current.id, backendSessionId: nativeId });
    if (current.promptProjection?.capabilityIds.length) {
      acknowledgeCapabilityApplication({
        target: current.promptProjection.target,
        desiredRevision: current.promptProjection.desiredRevision,
        capabilityIds: current.promptProjection.capabilityIds,
        outcome: "unverifiable",
        reason: "Antigravity admitted the prompt text projection; native model consumption is not observable",
        evidence: { stage: "staged", source: "Antigravity user prompt projection" },
      });
    }
    emit({ type: "turn/started", turnId: current.id, ...(selectedModel ? { model: selectedModel } : {}) });
    settleAdmission({ kind: "confirmed", value: { admissionId: current.id }, receipt: current.id });
  };
  let frameQueue = Promise.resolve();
  let queuedBytes = 0;
  const acceptInitialization = async (
    frame: Record<string, unknown>,
    expectedId: string | undefined,
    bypass: boolean,
    replacement: boolean,
  ) => {
    const id = text(frame.conversation_id);
    const init = record(frame.init);
    if (!id || !init || (expectedId && id !== expectedId))
      throw agyError("protocol-error", "Antigravity did not initialize the requested conversation");
    agyLaunchArgs(undefined, undefined, id);
    if (typeof init.cwd === "string" && init.cwd !== context.cwd)
      throw agyError("protocol-error", "Antigravity initialized a different workspace");
    const expectedPermissionMode = bypass ? "always-proceed" : "request-review";
    if (init.permission_mode !== expectedPermissionMode) {
      throw agyError(
        "protocol-error",
        `Antigravity did not confirm the requested ${bypass ? "headless bypass" : "approval-required"} permission mode`,
      );
    }
    if (selectedModel && init.model !== selectedModel.modelID)
      throw agyError("protocol-error", "Antigravity did not confirm the selected model");
    if (selectedAgent && init.agent !== selectedAgent)
      throw agyError("protocol-error", "Antigravity did not confirm the selected agent");
    if (!selectedModel && text(init.model)) selectedModel = { providerID: "antigravity", modelID: text(init.model)! };
    if (replacement) {
      if (!nativeId || id !== nativeId)
        throw agyError("protocol-error", "Antigravity replacement changed the native conversation");
      launchBypass = bypass;
      expectedReinitBypass = undefined;
      nativeLive = true;
      order++;
      return;
    }
    if (nativeId) throw agyError("protocol-error", "Antigravity sent a duplicate initialization");
    nativeId = id;
    nativeLive = true;
    void adoptNativeTitle(nativeId);
    if (stagedLaunchTarget && stagedRevision) {
      if (stagedLaunchCapabilityIds?.length) {
        acknowledgeCapabilityApplication({
          target: stagedLaunchTarget,
          desiredRevision: stagedRevision,
          capabilityIds: stagedLaunchCapabilityIds,
          outcome: "unverifiable",
          reason: "Antigravity CLI initialized with the staged launch capabilities",
          evidence: { stage: "staged", source: "init" },
        });
      }
      const currentOverlay = antigravityOverlays.peek(context, harnessId);
      if (currentOverlay?.desiredRevision === stagedRevision) {
        const prompt = currentOverlay.value.prompt;
        if (prompt?.capabilityIds.length) {
          antigravityOverlays.set(context, {
            prompt,
            launchCapabilityIds: [],
          }, harnessId, {
            desiredRevision: currentOverlay.desiredRevision,
            capabilityIds: prompt.capabilityIds,
          });
        } else {
          antigravityOverlays.consumeIfRevision(context, harnessId, stagedRevision);
        }
      }
      stagedLaunchTarget = undefined;
      stagedRevision = undefined;
      stagedLaunchCapabilityIds = undefined;
    }
    launchBypass = bypass;
    for (const [key, value] of Object.entries(authority.receipts)) {
      if (key.startsWith("turn:") && value === id)
        accepted.push({ operationId: key.slice(5), mutationKind: "turn-submit", receipt: key.slice(5), backendSessionId: id });
      if (key.startsWith("steer:") && value === id)
        accepted.push({ operationId: key.slice(6), mutationKind: "turn-steer", receipt: key.slice(6), backendSessionId: id });
    }
    if (createId) await authority.receipt(`create:${createId}`, id);
    if (stopping || !connected) return;
    if (initTimer) clearTimeout(initTimer);
    initResolve?.();
    initResolve = undefined; initReject = undefined;
    order++;
    announce();
    void discoverCommands();
  };
  const onFrame = async (frame: Record<string, unknown>, expectedId?: string) => {
    if (!connected || stopping) return;
    if (frame.event === "init") {
      await acceptInitialization(frame, expectedId, launchBypass, false);
      return;
    }
    if (frame.event === "polyth_reinit") {
      const nested = record(frame.polyth_reinit);
      if (nested?.event !== "init")
        throw agyError("protocol-error", "Antigravity worker sent an unexpected replacement initialization");
      // The worker owns the containment boundary and relaunches the recorded
      // conversation whenever its native leg is gone, including the disposable
      // initialization probe leg. That can race a turn Polyth submits while it
      // still believes the probe leg is live, so a same-conversation
      // replacement is accepted. An unrequested one must still confirm the
      // current launch mode, so a replacement can never widen permissions.
      await acceptInitialization(nested, nativeId, expectedReinitBypass ?? launchBypass, true);
      return;
    }
    if (frame.event === "polyth_error") {
      const error = record(frame.polyth_error);
      throw agyError("runtime-unavailable", text(error?.message) ?? "Antigravity worker failed");
    }
    if (frame.event === "polyth_released" || frame.event === "polyth_native_closed") {
      // The worker proved the native tree released (stop) or observed it exit.
      // Either way the worker still owns the containment boundary.
      if (!nativeId) throw agyError("runtime-unavailable", "Antigravity CLI ended before it initialized");
      loseNativeLeg(frame.event === "polyth_released"
        ? "Antigravity stopped the native conversation leg"
        : "Antigravity ended the native conversation leg");
      return;
    }
    if (frame.event === "polyth_native_error") {
      const error = record(frame.polyth_native_error);
      if (error) pendingNativeError = error;
      return;
    }
    if (frame.event !== "step_update" && frame.event !== "result") return;
    const payload = record(frame[frame.event]);
    if (!payload || !nativeId || payload.conversation_id !== nativeId)
      throw agyError("protocol-error", "Antigravity event belongs to a different conversation");
    if (frame.event === "result") {
      const turns = payload.num_turns;
      if (typeof turns !== "number" || !Number.isSafeInteger(turns) || turns < 0)
        throw agyError("protocol-error", "Antigravity result has no valid turn counter");
      if (completedTurns !== undefined && turns < completedTurns) return;
      // A steering message injected into this turn may count as a native turn.
      if (completedTurns !== undefined && turns > completedTurns + 1 + (active?.injectedMessages ?? 0))
        throw agyError("protocol-error", "Antigravity turn counter skipped an unobserved turn");
      // API/model failures can end before AGY increments its cumulative turn
      // count (including zero on the first prompt). A same-count SUCCESS is an
      // old terminal snapshot; a distinct error is the current refused turn.
      if (completedTurns !== undefined && turns === completedTurns && payload.status === "SUCCESS") return;
    }
    if (!active) return; // No prompt is outstanding; never attach ambient output.
    const current = active;
    if (frame.event === "step_update") {
      const index = payload.step_index;
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0)
        throw agyError("protocol-error", "Antigravity step has no valid index");
      if (index <= completedStep) return;
      currentMaxStep = Math.max(currentMaxStep, index);
      await admitted();
      if (active !== current || !connected || stopping) return;
      for (const event of current.turn.step(payload)) emit(event);
      return;
    }
    // An error result proves the input reached the native CLI too, even when
    // it rejected the model/policy before producing a user_input step.
    await admitted();
    if (active !== current || !connected || stopping) return;
    const cumulative = agyUsage(payload.usage);
    const monotonic = cumulative && (!previousUsage || Object.keys(cumulative).every((key) =>
      (cumulative[key as keyof TokenUsage] ?? 0) >= (previousUsage![key as keyof TokenUsage] ?? 0)));
    const usage = cumulative && usageBaselineKnown && monotonic ? deltaTokenUsage(previousUsage, cumulative) : undefined;
    const resultEvents = current.turn.finish(
      pendingNativeError ? { ...payload, agy_error: pendingNativeError } : payload,
      usage,
    );
    pendingNativeError = undefined;
    completedTurns = payload.num_turns as number;
    completedStep = currentMaxStep;
    previousUsage = cumulative;
    usageBaselineKnown = !!cumulative;
    resolveAllPermissions({ decision: "deny", reason: "Antigravity ended the turn before approval completed" });
    // Steering that neither a PreInvocation nor the Stop re-entry delivered
    // (an error or step-limit end) was never seen by the CLI.
    carrySteers(current.steers);
    active = undefined;
    order++;
    for (const event of resultEvents) emit(event);
    void adoptNativeTitle(nativeId);
    void discoverCommands();
  };
  // The CLI answers `/skills` locally. A catalog stays fresh for five minutes
  // (a turn may have added a workspace skill), a failed report backs off for
  // one, and only a changed catalog is published.
  const discoverCommands = (): Promise<void> => {
    if (!options.commands) return Promise.resolve();
    if (commandDiscovery) return commandDiscovery;
    if (Date.now() < commandsQuietUntil) return Promise.resolve();
    commandDiscovery = options.commands().then((found) => {
      commandsQuietUntil = Date.now() + 5 * 60_000;
      const changed = JSON.stringify(found) !== JSON.stringify(nativeCommands);
      nativeCommands = found;
      if (changed && connected && !stopping) emit({ type: "runtime/commands-changed", commands: [...found] });
    }, () => { commandsQuietUntil = Date.now() + 60_000; }).finally(() => { commandDiscovery = undefined; });
    return commandDiscovery;
  };
  const initialize = async (model?: ModelRef, agent?: string, resumeId?: string) => {
    if (initialization) {
      await initialization;
      if (resumeId && nativeId !== resumeId) throw agyError("conflict", "This runtime already owns another conversation");
      if ((model && !sameAgyModel(model, selectedModel)) || (agent && agent !== selectedAgent))
        throw agyError("unsupported", "Antigravity launch settings cannot change while resuming a live runtime");
      return;
    }
    if (!connected || stopping) throw agyError("runtime-unavailable", "Antigravity's owned runtime is fenced; this session needs a fresh runtime");
    selectedModel = model; selectedAgent = agent; usageBaselineKnown = !resumeId;
    const staged = antigravityOverlays.peek(context, harnessId);
    const overlay = staged?.value;
    if (staged && overlay?.launchCapabilityIds.length) {
      stagedLaunchTarget = provisioningTarget(context, harnessId);
      stagedRevision = staged.desiredRevision;
      stagedLaunchCapabilityIds = overlay.launchCapabilityIds;
      captureCapabilityLaunch({
        target: stagedLaunchTarget,
        desiredRevision: stagedRevision,
      });
    }
    initialization = new Promise<void>((resolve, reject) => { initResolve = resolve; initReject = reject; });
    // Install a handler immediately; child callbacks can fail before the caller awaits.
    void initialization.catch(() => {});
    initTimer = setTimeout(() => fail(agyError("outcome-unknown", "Antigravity did not initialize in time; no prompt was replayed")), options.timeoutMs ?? 15_000);
    const decoder = createAgyDecoder((frame) => {
      const size = Buffer.byteLength(JSON.stringify(frame));
      queuedBytes += size;
      if (queuedBytes > 8 * 1024 * 1024) throw agyError("protocol-error", "Antigravity output exceeded the pending event limit");
      frameQueue = frameQueue.then(() => onFrame(frame, resumeId)).catch((error) => fail(error instanceof Error ? error : agyError("protocol-error", "Antigravity event processing failed"))).finally(() => { queuedBytes -= size; });
    });
    try {
      permissionBridge = await options.permissionBridge(handleHook);
      await permissionBridge.prepare(overlay?.mcpServers ?? {}, overlay?.disabledMcpNames ?? []);
      launchBypass = await currentBypass();
      const args = agyLaunchArgs(model, agent, resumeId, {
        bypass: launchBypass,
        hookRoot: permissionBridge.root,
      });
      child = authority.spawn(process.execPath, [options.workerPath], { cwd: context.cwd, env: options.env });
      started = true;
      child.stdin?.on("error", () => fail(agyError("outcome-unknown", "Antigravity worker input pipe closed; the prompt was not replayed")));
      child.stdout?.on("data", (chunk: Buffer) => {
        try { decoder.write(chunk); } catch (error) { fail(error as Error); }
      });
      // Drain diagnostics, but never persist raw stderr (credentials/auth URLs,
      // native prompts and paths can appear there).
      child.stderr?.resume();
      child.once("error", () => fail(agyError("runtime-unavailable", "Antigravity worker could not start")));
      child.once("close", () => {
        try { decoder.end(); } catch (error) { fail(error as Error); }
        void frameQueue.then(() => {
          if (!stopping) fail(agyError("outcome-unknown", "Antigravity disconnected; verify the native session before retrying"));
        });
      });
      child.stdin?.write(JSON.stringify({
        event: "polyth_launch",
        command: options.command,
        args,
        mode: launchBypass ? "auto" : "review",
      }) + "\n", (error) => {
        if (error) fail(agyError("runtime-unavailable", "Antigravity worker did not accept its native launch"));
      });
    } catch (error) {
      if (stagedLaunchTarget && stagedRevision) {
        releaseCapabilityLaunch({
          target: stagedLaunchTarget,
          desiredRevision: stagedRevision,
        });
        stagedLaunchTarget = undefined;
        stagedRevision = undefined;
        stagedLaunchCapabilityIds = undefined;
      }
      fail(error instanceof Error ? error : agyError("runtime-unavailable", "Antigravity could not start"));
    }
    return initialization;
  };
  const create: NonNullable<AgentRuntime["createSessionOperation"]> = async (request, operationId) => {
    claim(request.sessionId);
    if (!belongs(request.sessionId) || request.cwd !== context.cwd || request.projectId !== context.projectId)
      return rejected("invalid-session", "Antigravity runtime belongs to another session or workspace");
    if (createId && createId !== operationId) return rejected("unsupported", "Create a new Polyth session to start a fresh Antigravity conversation");
    // Claim synchronously before catalog I/O so competing create operations
    // cannot overwrite the receipt owner while discovery is pending.
    createId = operationId;
    let effectiveModel: ModelRef | undefined;
    try { effectiveModel = await validateModel(request.model ?? context.model); } catch (error) {
      if (!initialization) createId = "";
      return rejected((error as { code?: string }).code ?? "discovery-unavailable", "Antigravity could not validate the selected model or effort");
    }
    try {
      await initialize(effectiveModel, request.agent, authority.receipts[`create:${operationId}`]);
      // `initialize` verified the CLI confirmed the requested model/agent, and
      // recorded the CLI's own choice when Polyth did not state one. Publish
      // that effective selection so the canonical session names what this
      // leg is actually locked to instead of guessing.
      return {
        kind: "confirmed",
        value: {
          backendSessionId: nativeId,
          ...(selectedModel
            ? { launch: { model: selectedModel, ...(selectedAgent ? { agent: selectedAgent } : {}) } }
            : {}),
        },
        receipt: nativeId,
      };
    } catch {
      return started ? unknown(operationId, "Antigravity session creation was not confirmed; no automatic retry was made")
        : rejected("runtime-unavailable", "Antigravity CLI could not be launched");
    }
  };
  const runtime: AgentRuntime = {
    harnessId,
    capabilities: async () => ANTIGRAVITY_CAPABILITIES,
    models: options.models,
    agents: async () => [],
    createSessionOperation: create,
    resetSessionOperation: async () => rejected("unsupported", "Antigravity cannot replace exact native history; start a new session"),
    async ensureSession(input) {
      claim(input.sessionId);
      if (!belongs(input.sessionId) || input.cwd !== context.cwd || input.projectId !== context.projectId || !input.backendSessionId || !knownNative(input.backendSessionId))
        throw agyError("unknown-session", "Only this Space's recorded Antigravity conversation can be resumed");
      const effectiveModel = await validateModel(input.model ?? context.model);
      await initialize(effectiveModel, input.agent, input.backendSessionId);
      void adoptNativeTitle(nativeId);
      return nativeId;
    },
    sessions: async () => {
      const entries = Object.entries(authority.receipts).filter(([key]) => key.startsWith("create:"));
      const titles = await Promise.all(entries.map(([, id]) => options.titleReader?.read(id) ?? Promise.resolve(undefined)));
      return entries.map(([key, id], index) => ({ id, operationId: key.slice(7), title: titles[index] ?? "", createdAt: 0, updatedAt: 0 }));
    },
    history: async () => [],
    async startTurnOperation(request, operationId) {
      claim(request.sessionId);
      if (!belongs(request.sessionId)) return rejected("invalid-session", "Antigravity runtime belongs to another session");
      if (authority.receipts[`turn:${operationId}`] === nativeId && nativeId)
        return { kind: "confirmed", value: { admissionId: operationId }, receipt: operationId };
      if (authority.receipts[`sent:${operationId}`]) return unknown(operationId, "This prompt may already have reached Antigravity; it was not replayed");
      if (!connected || !nativeId || !child?.stdin?.writable || stopping) return rejected("runtime-unavailable", "Antigravity's owned runtime is fenced after an unrecoverable failure; this session needs a fresh runtime");
      if (active || selectionPending) return rejected("busy", "Antigravity accepts one turn at a time");
      const modelCompatible = !request.model || sameAgyModel(request.model, selectedModel)
        || (!request.model.variant && sameAgyModel({ ...request.model, variant: selectedModel?.variant }, selectedModel));
      if (!modelCompatible || (request.agent && request.agent !== selectedAgent))
        return rejected("unsupported", "Antigravity model, effort and agent are launch-time settings; start a new session to change them");
      // The CLI expands only a leading slash command, so a native command is
      // the whole message: nothing is prepended or appended to it.
      const command = request.command;
      if (command && request.attachments?.length)
        return rejected("unsupported", "Send attachments in a separate message; an Antigravity command must be the whole message");
      const bridge = permissionBridge;
      if (!bridge) return rejected("runtime-unavailable", "Antigravity approval bridge is unavailable");
      selectionPending = true;
      try {
        const staged = command ? undefined : antigravityOverlays.peek(context, harnessId);
        const projection = staged?.value.prompt;
        const carried = command ? [] : [...carriedSteers];
        let promptContent = request.text;
        let attached: AgyStagedAttachments | undefined;
        if (!command) {
          let prepared: Awaited<ReturnType<typeof stageAgyAttachments>>;
          try {
            prepared = await stageAgyAttachments({
              root: bridge.root, turnId: operationId, cwd: context.cwd, text: request.text,
              ...(request.attachments ? { attachments: request.attachments } : {}),
              ...(request.workspace ? { workspace: request.workspace } : {}),
            });
          } catch {
            return rejected("invalid-attachment", "Antigravity could not stage the attachments for this message");
          }
          if (!prepared.ok) return rejected(prepared.code, prepared.message);
          attached = prepared.staged;
          promptContent = prepared.text;
          if (carried.length) {
            const earlier = `Messages the user sent while you were finishing the previous turn:\n${carried.map((body) => `- ${body}`).join("\n")}`;
            promptContent = promptContent.trim() ? `${earlier}\n\n${promptContent}` : earlier;
          }
          if (projection?.text) {
            promptContent = promptContent.trim()
              ? `${promptContent}\n\n${projection.text}`
              : projection.text;
          }
        }
        const input = { event: "user", message: { content: promptContent } };
        if (Buffer.byteLength(JSON.stringify(input)) > 4 * 1024 * 1024) return rejected("invalid-input", "Antigravity prompt exceeds the size limit");
        await bridge.prepare();
        const bypass = await currentBypass();
        const args = agyLaunchArgs(selectedModel, selectedAgent, nativeId, {
          bypass,
          hookRoot: bridge.root,
        });
        // Persist intent BEFORE touching stdin: a lost acknowledgement is not
        // permission to submit a duplicated prompt after a server restart.
        await authority.receipt(`sent:${operationId}`, nativeId);
        if (!connected || stopping) return unknown(operationId, "Antigravity disconnected while recording the prompt intent");
        if (carried.length) carriedSteers = [];
        return await new Promise<Admission>((resolve) => {
          pendingNativeError = undefined;
          active = {
            id: operationId,
            turn: createAgyTurn(operationId, selectedModel),
            admit: resolve,
            injections: attached?.steps ?? [],
            stagedPaths: new Set(attached?.paths ?? []),
            stagedUrls: new Set(attached?.urls ?? []),
            steers: [],
            injectedMessages: 0,
            invocations: 0,
            stopContinued: false,
            ...(staged && projection?.capabilityIds.length
              ? {
                promptProjection: {
                  target: provisioningTarget(context, harnessId),
                  desiredRevision: staged.desiredRevision,
                  capabilityIds: projection.capabilityIds,
                },
              }
              : {}),
          };
          // A relaunch pays for the CLI's own start-up before it can acknowledge.
          active.timer = setTimeout(() => fail(agyError("outcome-unknown", "Antigravity did not acknowledge the prompt; it was not replayed")), (options.timeoutMs ?? 15_000) * (nativeLive ? 1 : 2));
          // The native permission mode is a launch flag, so a changed bypass
          // setting replaces the idle native leg first. A stopped or exited leg
          // is relaunched on the recorded conversation, and that replacement
          // `init` is expected too.
          if (!nativeLive || bypass !== launchBypass) expectedReinitBypass = bypass;
          order++;
          child!.stdin!.write(JSON.stringify({
            event: "polyth_user",
            args,
            mode: bypass ? "auto" : "review",
            input,
          }) + "\n", (error) => { if (error) fail(agyError("outcome-unknown", "Antigravity did not confirm prompt delivery")); });
        });
      } catch {
        fail(agyError("outcome-unknown", "Antigravity prompt delivery was not confirmed"));
        return unknown(operationId, "Antigravity prompt intent could not be confirmed");
      }
      finally { selectionPending = false; }
    },
    startTurn: async () => { throw agyError("unsupported", "Operation-aware admission is required"); },
    async steer(sessionId, steerText, model, agent) {
      const outcome = await runtime.steerOperation!(sessionId, steerText, `compat-steer:${randomUUID()}`, model, agent);
      if (outcome.kind === "confirmed") return true;
      if (outcome.kind === "rejected") return false;
      throw agyError("outcome-unknown", outcome.message);
    },
    // Accepted steering is injected by the next PreInvocation hook as a native
    // user message; a rejection makes Polyth queue it as the next turn.
    async steerOperation(sessionId, steerText, operationId, model, agent) {
      if (!belongs(sessionId)) return rejected("invalid-session", "Antigravity runtime belongs to another session");
      if (nativeId && authority.receipts[`steer:${operationId}`] === nativeId) return { kind: "confirmed", value: {} };
      const current = active;
      if (!connected || stopping || !current || current.turn.terminal || current.admit)
        return rejected("runtime-rejected", "Antigravity has no running turn to steer");
      if ((model && !sameAgyModel(model, selectedModel)) || (agent && agent !== selectedAgent))
        return rejected("unsupported", "Antigravity model, effort and agent are fixed for the running turn");
      // No PreInvocation hook in this turn means the injection seam is unproven.
      if (!current.invocations) return rejected("runtime-rejected", "Antigravity has not reached a step that can take a new message yet");
      const body = steerText.trim();
      if (!body) return rejected("invalid-input", "Steering text is empty");
      if (Buffer.byteLength(body) > MAX_STEER_BYTES) return rejected("invalid-input", "Steering text exceeds the size limit");
      try { await authority.receipt(`steer:${operationId}`, nativeId); } catch {
        return unknown(operationId, "Antigravity could not record the steering intent");
      }
      accepted.push({ operationId, mutationKind: "turn-steer", receipt: operationId, backendSessionId: nativeId });
      // The turn may have ended while the intent was recorded; the next prompt
      // then carries it, exactly like steering the CLI never received.
      if (active !== current || current.turn.terminal) carrySteers([{ operationId, text: body }]);
      else current.steers.push({ operationId, text: body });
      return { kind: "confirmed", value: {} };
    },
    async abort(sessionId) {
      if (!belongs(sessionId)) throw agyError("invalid-session", "Antigravity runtime belongs to another session");
      // Stopping a turn must not destroy the authority-owned worker: that is
      // this session's only way back to its native conversation, and nothing
      // rebuilds it, so every later prompt would fail as "disconnected". The
      // worker terminates the native process group, proves it released and
      // relaunches the recorded conversation on the next turn.
      if (!stopping && connected && nativeId && child?.stdin?.writable) {
        if (active) settleAdmission(unknown(active.id, "Antigravity was stopped during prompt admission"));
        resolveAllPermissions({ decision: "deny", reason: "Antigravity turn was stopped" });
        nativeStopExpected = true;
        const released = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), options.timeoutMs ?? 15_000);
          nativeReleased = (value) => { clearTimeout(timer); resolve(value); };
          child!.stdin!.write(JSON.stringify({ event: "polyth_stop" }) + "\n", (error) => {
            if (error) { clearTimeout(timer); resolve(false); }
          });
        });
        nativeReleased = undefined;
        nativeStopExpected = false;
        if (released) return;
      }
      stopping = true;
      if (initTimer) clearTimeout(initTimer);
      if (stagedLaunchTarget && stagedRevision && !nativeId) {
        releaseCapabilityLaunch({
          target: stagedLaunchTarget,
          desiredRevision: stagedRevision,
        });
        stagedLaunchTarget = undefined;
        stagedRevision = undefined;
        stagedLaunchCapabilityIds = undefined;
      }
      initReject?.(agyError("runtime-unavailable", "Antigravity was stopped"));
      if (active) settleAdmission(unknown(active.id, "Antigravity was stopped during prompt admission"));
      resolveAllPermissions({ decision: "deny", reason: "Antigravity turn was stopped" });
      // SIGINT/control messages alone are not proof of release. Terminate the
      // entire owned process tree and wait for the shared authority receipt.
      await Promise.all([closeAuthority(), closePermissionBridge()]);
      if (active) {
        settleAdmission(unknown(active.id, "Antigravity was stopped during prompt admission"));
        emit({ type: "turn/stopped", turnId: active.id, reason: "aborted" });
        active = undefined;
      }
      connected = false; order++; announce();
    },
    async abortOperation(sessionId, operationId) {
      try { await runtime.abort(sessionId); return { kind: "confirmed", value: {} }; }
      catch { return unknown(operationId, "Antigravity process-tree release is not confirmed"); }
    },
    async replyPermission(sessionId, requestId, reply) {
      if (!belongs(sessionId)) throw agyError("invalid-session", "Antigravity runtime belongs to another session");
      const pending = permissions.get(requestId);
      if (!pending) throw agyError("not-found", "Permission is no longer pending");
      permissions.delete(requestId);
      const decision: AgyHookDecision = reply === "reject"
        ? { decision: "deny", reason: "User declined this Antigravity tool" }
        : { decision: "allow" };
      for (const resolve of pending.resolvers) resolve(decision);
    },
    async replyPermissionOperation(sessionId, requestId, reply, operationId) {
      try {
        await runtime.replyPermission(sessionId, requestId, reply);
        return { kind: "confirmed", value: {} };
      } catch (error) {
        if ((error as { code?: unknown }).code === "not-found")
          return rejected("not-found", "Permission is no longer pending");
        return unknown(operationId, "Antigravity did not confirm the permission response");
      }
    },
    async replyQuestion(sessionId, requestId, answers) {
      if (!belongs(sessionId)) throw agyError("invalid-session", "Antigravity runtime belongs to another session");
      const pending = questions.get(requestId);
      if (!pending) throw agyError("not-found", "Question is no longer pending");
      questions.delete(requestId);
      // Denying the native call carries the answer: the reason is what the
      // model reads, and headless Antigravity has no answer channel of its own.
      const decision: AgyHookDecision = { decision: "deny", reason: agyQuestionReply(pending.questions, answers) };
      for (const resolve of pending.resolvers) resolve(decision);
    },
    async replyQuestionOperation(sessionId, requestId, answers, operationId) {
      try {
        await runtime.replyQuestion(sessionId, requestId, answers);
        return { kind: "confirmed", value: {} };
      } catch (error) {
        if ((error as { code?: unknown }).code === "not-found")
          return rejected("not-found", "Question is no longer pending");
        return unknown(operationId, "Antigravity did not confirm the question answer");
      }
    },
    // Never wait on the CLI's slow report here: the runtime-features request
    // calls this, and a finished discovery publishes runtime/commands-changed.
    async commands(sessionId) {
      if (!belongs(sessionId)) return [];
      void discoverCommands();
      return [...nativeCommands];
    },
    endpoint: async () => endpoint,
    protocol: async () => "legacy",
    async reconcile(binding) {
      claim(binding.canonicalSessionId);
      reconciliationOrdinal = binding.reconciliationOrdinal ?? 0;
      const matches = belongs(binding.canonicalSessionId) && binding.backendSessionId === nativeId && binding.location.directory === context.cwd
        && binding.authorityId === authority.authorityId && binding.generation === authority.generation;
      return { ...endpoint, backendSessionId: binding.backendSessionId ?? nativeId, reconciliationOrdinal,
        state: { value: !matches || !connected || stopping ? "unknown" : active ? "running" : "idle", comparison: { domain: authority.authorityId, order: ++order }, ...(createId && !accepted.length ? { causalOperationId: createId } : {}) },
        completeness: {
          events: "partial",
          permissions: connected ? "complete" : "unverifiable",
          questions: connected ? "complete" : "unverifiable",
        },
        events: matches ? [...events.values()] : [],
        permissions: matches ? [...permissions].map(([requestId, pending]) => ({
          requestId,
          permission: pending.permission,
          patterns: pending.patterns,
        })) : [],
        questions: matches ? [...questions].map(([requestId, pending]) => ({ requestId, questions: pending.items })) : [],
        acceptedOperations: matches ? accepted : [],
      };
    },
    async releaseExecution(binding, operationId) {
      const proof = (binding.authorityId === authority.authorityId && binding.generation === authority.generation)
        || authority.releasedAuthorities.some((item) => item.authorityId === binding.authorityId && item.generation === binding.generation);
      if (!proof || !belongs(binding.canonicalSessionId) || binding.backendSessionId !== nativeId || binding.location.directory !== context.cwd)
        return rejected("invalid-session", "Antigravity execution binding does not match this runtime");
      try { await runtime.dispose(); return { kind: "confirmed", value: { authorityId: binding.authorityId, generation: binding.generation, backendSessionId: nativeId } }; }
      catch { return unknown(operationId, "Antigravity execution release has not been proved"); }
    },
    onEvent(callback) { listeners.add(callback); return { dispose: () => { listeners.delete(callback); } }; },
    onObservation(callback) { observations.add(callback); return { dispose: () => { observations.delete(callback); } }; },
    onLifecycle(callback) { lifecycle.add(callback); return { dispose: () => { lifecycle.delete(callback); } }; },
    async dispose() {
      stopping = true;
      if (initTimer) clearTimeout(initTimer);
      if (stagedLaunchTarget && stagedRevision && !nativeId) {
        releaseCapabilityLaunch({
          target: stagedLaunchTarget,
          desiredRevision: stagedRevision,
        });
        stagedLaunchTarget = undefined;
        stagedRevision = undefined;
        stagedLaunchCapabilityIds = undefined;
      }
      initReject?.(agyError("runtime-unavailable", "Antigravity runtime was disposed"));
      if (active) settleAdmission(unknown(active.id, "Antigravity runtime was disposed during admission"));
      resolveAllPermissions({ decision: "deny", reason: "Antigravity runtime was disposed" });
      await Promise.all([closeAuthority(), closePermissionBridge()]);
      connected = false;
    },
  };
  return runtime;
}
