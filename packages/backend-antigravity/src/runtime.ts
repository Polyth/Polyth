import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { AgentRuntime, HarnessContext, ModelDescriptor, ModelRef, MutationOutcome, RuntimeEvent, RuntimeObservation, RuntimeSnapshot, TokenUsage } from "@polyth/contracts";
import {
  acknowledgeCapabilityApplication,
  captureCapabilityLaunch,
  composeTurnPrompt,
  deltaTokenUsage,
  provisioningTarget,
  releaseCapabilityLaunch,
  resolveModelSelection,
} from "@polyth/harness-runtime";
import type { HarnessProcessAuthority } from "@polyth/harness-runtime/process-authority";
import { classifyAgyPermission, parseAgyHookRequest, type AgyHookDecision, type AntigravityPermissionBridge } from "./permissions.ts";
import { antigravityOverlays } from "./provisioner.ts";
import { ANTIGRAVITY_CAPABILITIES, agyError, agyLaunchArgs, agyUsage, createAgyDecoder, createAgyTurn, record, sameAgyModel, text } from "./protocol.ts";

type Admission = MutationOutcome<{ admissionId?: string }>;
export interface AntigravityRuntimeOptions {
  context: HarnessContext;
  authority: HarnessProcessAuthority;
  command: string;
  workerPath: string;
  env?: NodeJS.ProcessEnv;
  models(): Promise<ModelDescriptor[]>;
  autoApprove(): Promise<boolean>;
  permissionBridge(handle: (payload: unknown) => Promise<AgyHookDecision>): Promise<AntigravityPermissionBridge>;
  timeoutMs?: number;
}

/** One native process per canonical runtime. No agent loop, provider fallback or hidden replay. */
export function createAntigravityRuntime(options: AntigravityRuntimeOptions): AgentRuntime {
  const { context, authority } = options;
  let child: ChildProcess | undefined;
  let nativeId = "";
  let createId = "";
  let selectedModel: ModelRef | undefined;
  let selectedAgent: string | undefined;
  let started = false;
  let connected = true;
  let stopping = false;
  let released = false;
  let closing: Promise<void> | undefined;
  let permissionBridge: AntigravityPermissionBridge | undefined;
  let permissionBridgeClosing: Promise<void> | undefined;
  let launchAutoApprove = false;
  let expectedReinitAutoApprove: boolean | undefined;
  let initialization: Promise<void> | undefined;
  let initResolve: (() => void) | undefined;
  let initReject: ((error: Error) => void) | undefined;
  let initTimer: ReturnType<typeof setTimeout> | undefined;
  let active: { id: string; turn: ReturnType<typeof createAgyTurn>; admit?: (outcome: Admission) => void; timer?: ReturnType<typeof setTimeout> } | undefined;
  let selectionPending = false;
  let initialPromptAppended = false;
  let stagedLaunchTarget: ReturnType<typeof provisioningTarget> | undefined;
  let stagedRevision: string | undefined;
  let stagedCapabilityIds: string[] | undefined;
  let previousUsage: TokenUsage | undefined;
  let usageBaselineKnown = true;
  let completedTurns: number | undefined;
  let completedStep = -1;
  let currentMaxStep = -1;
  let serial = 0;
  let order = 0;
  let reconciliationOrdinal = 0;
  const events = new Map<string, RuntimeSnapshot["events"][number]>();
  const accepted: NonNullable<RuntimeSnapshot["acceptedOperations"]> = [];
  const permissions = new Map<string, {
    permission: string;
    patterns: string[];
    tool: string;
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
  const belongs = (sessionId: string) => !!context.sessionId && sessionId === context.sessionId;
  const knownNative = (id: string) => Object.entries(authority.receipts).some(([key, value]) => key.startsWith("create:") && value === id);
  const rejected = (code: string, message: string) => ({ kind: "rejected" as const, code, message });
  const unknown = (operationId: string, message: string) => ({ kind: "unknown" as const, operationId, message });
  const announce = () => {
    for (const callback of lifecycle) callback({ type: connected ? "stream-connected" : "stream-disconnected", authorityId: authority.authorityId, generation: authority.generation });
  };
  const emit = (event: RuntimeEvent) => {
    if (!context.sessionId) return;
    const entityKey = `${active?.id || createId || nativeId}:${++serial}`;
    const revision = createHash("sha256").update(JSON.stringify(event)).digest("hex");
    const artifactKind = event.type.startsWith("tool/") ? "tool"
      : event.type.startsWith("turn/") ? "turn"
        : event.type === "permission/requested" ? "permission"
          : "message";
    events.set(entityKey, { entityKey, revision, artifactKind, events: [event] });
    // Canonical storage is authoritative; this is a bounded partial replay cache.
    if (events.size > 4096) events.delete(events.keys().next().value!);
    if (observations.size) {
      const observation: RuntimeObservation = { channel: "sse", entityKey, reconciliationOrdinal,
        identity: { ...endpoint, backendSessionId: nativeId, artifactKind, entityId: entityKey, revision }, events: [event] };
      for (const callback of observations) callback(context.sessionId, observation);
    } else for (const callback of listeners) callback(context.sessionId, event);
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
  const resolveAllPermissions = (decision: AgyHookDecision) => {
    for (const pending of permissions.values()) for (const resolve of pending.resolvers) resolve(decision);
    permissions.clear();
  };
  const currentAutoApprove = async () => {
    try { return await options.autoApprove(); } catch { return false; }
  };
  const handleHook = async (payload: unknown): Promise<AgyHookDecision> => {
    const request = parseAgyHookRequest(payload);
    if (!request) return { decision: "deny", reason: "Antigravity supplied an invalid tool approval request" };
    if (!nativeId || request.conversationId !== nativeId || !active || active.turn.terminal) {
      return { decision: "deny", reason: "Tool request does not belong to the active Polyth turn" };
    }
    const turnId = active.id;
    const autoApprove = await currentAutoApprove();
    if (!active || active.id !== turnId || active.turn.terminal)
      return { decision: "deny", reason: "The Polyth turn ended before approval" };
    if (autoApprove) return { decision: "allow" };
    const classification = await classifyAgyPermission(request, context.cwd);
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
        metadata: { provider: "antigravity", stepIdx: classification.stepIdx },
      });
    });
  };
  const fail = (error: Error) => {
    if (!connected || stopping) return;
    connected = false;
    if (initTimer) clearTimeout(initTimer);
    if (stagedLaunchTarget && stagedRevision && !nativeId) {
      releaseCapabilityLaunch({
        target: stagedLaunchTarget,
        desiredRevision: stagedRevision,
      });
      stagedLaunchTarget = undefined;
      stagedRevision = undefined;
      stagedCapabilityIds = undefined;
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
  const validateModel = async (model?: ModelRef) => {
    if (!model) return;
    const selection = resolveModelSelection(await options.models(), model, "antigravity");
    if (!selection.ok) throw agyError(selection.code, selection.message);
    agyLaunchArgs(model);
  };
  const admitted = async () => {
    const current = active;
    if (!current?.admit) return;
    await authority.receipt(`turn:${current.id}`, nativeId);
    if (stopping || !connected || active !== current) return;
    accepted.push({ operationId: current.id, mutationKind: "turn-submit", receipt: current.id, backendSessionId: nativeId });
    emit({ type: "turn/started", turnId: current.id, ...(selectedModel ? { model: selectedModel } : {}) });
    settleAdmission({ kind: "confirmed", value: { admissionId: current.id }, receipt: current.id });
  };
  let frameQueue = Promise.resolve();
  let queuedBytes = 0;
  const acceptInitialization = async (
    frame: Record<string, unknown>,
    expectedId: string | undefined,
    autoApprove: boolean,
    replacement: boolean,
  ) => {
    const id = text(frame.conversation_id);
    const init = record(frame.init);
    if (!id || !init || (expectedId && id !== expectedId))
      throw agyError("protocol-error", "Antigravity did not initialize the requested conversation");
    agyLaunchArgs(undefined, undefined, id);
    if (typeof init.cwd === "string" && init.cwd !== context.cwd)
      throw agyError("protocol-error", "Antigravity initialized a different workspace");
    const expectedPermissionMode = autoApprove ? "always-proceed" : "request-review";
    if (init.permission_mode !== expectedPermissionMode) {
      throw agyError(
        "protocol-error",
        `Antigravity did not confirm Polyth's ${autoApprove ? "Auto-Approve" : "approval-required"} permission mode`,
      );
    }
    if (selectedModel && init.model !== selectedModel.modelID)
      throw agyError("protocol-error", "Antigravity did not confirm the selected model");
    if (selectedAgent && init.agent !== selectedAgent)
      throw agyError("protocol-error", "Antigravity did not confirm the selected agent");
    if (!selectedModel && text(init.model)) selectedModel = { providerID: "antigravity", modelID: text(init.model)! };
    if (replacement) {
      if (!nativeId || id !== nativeId)
        throw agyError("protocol-error", "Antigravity permission-mode replacement changed the native conversation");
      launchAutoApprove = autoApprove;
      expectedReinitAutoApprove = undefined;
      order++;
      return;
    }
    if (nativeId) throw agyError("protocol-error", "Antigravity sent a duplicate initialization");
    nativeId = id;
    if (stagedLaunchTarget && stagedRevision) {
      antigravityOverlays.consumeIfRevision(context, "antigravity", stagedRevision);
      if (stagedCapabilityIds?.length) {
        acknowledgeCapabilityApplication({
          target: stagedLaunchTarget,
          desiredRevision: stagedRevision,
          capabilityIds: stagedCapabilityIds,
          outcome: "unverifiable",
          reason: "Antigravity CLI initialized with the staged MCP plugin",
          evidence: { stage: "staged", source: "init" },
        });
      }
      stagedLaunchTarget = undefined;
      stagedRevision = undefined;
      stagedCapabilityIds = undefined;
    }
    launchAutoApprove = autoApprove;
    for (const [key, value] of Object.entries(authority.receipts)) {
      if (key.startsWith("turn:") && value === id)
        accepted.push({ operationId: key.slice(5), mutationKind: "turn-submit", receipt: key.slice(5), backendSessionId: id });
    }
    if (createId) await authority.receipt(`create:${createId}`, id);
    if (stopping || !connected) return;
    if (initTimer) clearTimeout(initTimer);
    initResolve?.();
    initResolve = undefined; initReject = undefined;
    order++;
    announce();
  };
  const onFrame = async (frame: Record<string, unknown>, expectedId?: string) => {
    if (!connected || stopping) return;
    if (frame.event === "init") {
      await acceptInitialization(frame, expectedId, launchAutoApprove, false);
      return;
    }
    if (frame.event === "polyth_reinit") {
      const nested = record(frame.polyth_reinit);
      if (expectedReinitAutoApprove === undefined || nested?.event !== "init")
        throw agyError("protocol-error", "Antigravity worker sent an unexpected replacement initialization");
      await acceptInitialization(nested, nativeId, expectedReinitAutoApprove, true);
      return;
    }
    if (frame.event === "polyth_error") {
      const error = record(frame.polyth_error);
      throw agyError("runtime-unavailable", text(error?.message) ?? "Antigravity worker failed");
    }
    if (frame.event !== "step_update" && frame.event !== "result") return;
    const payload = record(frame[frame.event]);
    if (!payload || !nativeId || payload.conversation_id !== nativeId)
      throw agyError("protocol-error", "Antigravity event belongs to a different conversation");
    if (frame.event === "result") {
      const turns = payload.num_turns;
      if (typeof turns !== "number" || !Number.isSafeInteger(turns) || turns < 1)
        throw agyError("protocol-error", "Antigravity result has no valid turn counter");
      if (completedTurns !== undefined && turns <= completedTurns) return;
      if (completedTurns !== undefined && turns !== completedTurns + 1)
        throw agyError("protocol-error", "Antigravity turn counter skipped an unobserved turn");
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
    const resultEvents = current.turn.finish(payload, usage);
    completedTurns = payload.num_turns as number;
    completedStep = currentMaxStep;
    previousUsage = cumulative;
    usageBaselineKnown = !!cumulative;
    resolveAllPermissions({ decision: "deny", reason: "Antigravity ended the turn before approval completed" });
    active = undefined;
    order++;
    for (const event of resultEvents) emit(event);
  };
  const initialize = async (model?: ModelRef, agent?: string, resumeId?: string) => {
    if (initialization) {
      await initialization;
      if (resumeId && nativeId !== resumeId) throw agyError("conflict", "This runtime already owns another conversation");
      if ((model && !sameAgyModel(model, selectedModel)) || (agent && agent !== selectedAgent))
        throw agyError("unsupported", "Antigravity launch settings cannot change while resuming a live runtime");
      return;
    }
    if (!connected || stopping) throw agyError("runtime-unavailable", "Antigravity runtime is closed; reconnect the session");
    selectedModel = model; selectedAgent = agent; usageBaselineKnown = !resumeId;
    const staged = antigravityOverlays.peek(context, "antigravity");
    const overlay = staged?.value;
    if (staged) {
      stagedLaunchTarget = provisioningTarget(context, "antigravity");
      stagedRevision = staged.desiredRevision;
      stagedCapabilityIds = overlay?.capabilityIds ?? staged.capabilityIds;
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
      await permissionBridge.prepare(overlay?.mcpServers);
      launchAutoApprove = await currentAutoApprove();
      const args = agyLaunchArgs(model, agent, resumeId, {
        autoApprove: launchAutoApprove,
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
        mode: launchAutoApprove ? "auto" : "review",
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
        stagedCapabilityIds = undefined;
      }
      fail(error instanceof Error ? error : agyError("runtime-unavailable", "Antigravity could not start"));
    }
    return initialization;
  };
  const create: NonNullable<AgentRuntime["createSessionOperation"]> = async (request, operationId) => {
    if (!belongs(request.sessionId) || request.cwd !== context.cwd || request.projectId !== context.projectId)
      return rejected("invalid-session", "Antigravity runtime belongs to another session or workspace");
    if (createId && createId !== operationId) return rejected("unsupported", "Create a new Polyth session to start a fresh Antigravity conversation");
    // Claim synchronously before catalog I/O so competing create operations
    // cannot overwrite the receipt owner while discovery is pending.
    createId = operationId;
    try { await validateModel(request.model ?? context.model); } catch (error) {
      if (!initialization) createId = "";
      return rejected((error as { code?: string }).code ?? "discovery-unavailable", "Antigravity could not validate the selected model or effort");
    }
    try {
      await initialize(request.model ?? context.model, request.agent, authority.receipts[`create:${operationId}`]);
      return { kind: "confirmed", value: { backendSessionId: nativeId }, receipt: nativeId };
    } catch {
      return started ? unknown(operationId, "Antigravity session creation was not confirmed; no automatic retry was made")
        : rejected("runtime-unavailable", "Antigravity CLI could not be launched");
    }
  };
  const runtime: AgentRuntime = {
    harnessId: "antigravity",
    capabilities: async () => ANTIGRAVITY_CAPABILITIES,
    models: options.models,
    agents: async () => [],
    createSessionOperation: create,
    resetSessionOperation: async () => rejected("unsupported", "Antigravity cannot replace exact native history; start a new session"),
    async ensureSession(input) {
      if (!belongs(input.sessionId) || input.cwd !== context.cwd || input.projectId !== context.projectId || !input.backendSessionId || !knownNative(input.backendSessionId))
        throw agyError("unknown-session", "Only this Space's recorded Antigravity conversation can be resumed");
      await validateModel(input.model ?? context.model);
      await initialize(input.model ?? context.model, input.agent, input.backendSessionId);
      return nativeId;
    },
    sessions: async () => Object.entries(authority.receipts).filter(([key]) => key.startsWith("create:")).map(([key, id]) => ({ id, operationId: key.slice(7), title: "Antigravity session", createdAt: 0, updatedAt: 0 })),
    history: async () => [],
    async startTurnOperation(request, operationId) {
      if (!belongs(request.sessionId)) return rejected("invalid-session", "Antigravity runtime belongs to another session");
      if (authority.receipts[`turn:${operationId}`] === nativeId && nativeId)
        return { kind: "confirmed", value: { admissionId: operationId }, receipt: operationId };
      if (authority.receipts[`sent:${operationId}`]) return unknown(operationId, "This prompt may already have reached Antigravity; it was not replayed");
      if (!connected || !nativeId || !child?.stdin?.writable || stopping) return rejected("runtime-unavailable", "Antigravity is disconnected; reconnect the session");
      if (active || selectionPending) return rejected("busy", "Antigravity accepts one turn at a time");
      if (request.command) return rejected("unsupported", "Native slash commands are unavailable in Antigravity stream mode");
      if ((request.model && !sameAgyModel(request.model, selectedModel)) || (request.agent && request.agent !== selectedAgent))
        return rejected("unsupported", "Antigravity model, effort and agent are launch-time settings; start a new session to change them");
      const prompt = composeTurnPrompt(request.text, request.attachments);
      if (prompt.images.length || request.attachments?.some((ref) => ref.kind !== "browser-context"))
        return rejected("unsupported", "Antigravity stream mode accepts text only; attach a text file through Polyth's text projection");
      let promptContent = prompt.text;
      const staged = antigravityOverlays.peek(context, "antigravity");
      if (!initialPromptAppended && staged?.value.promptText) {
        initialPromptAppended = true;
        promptContent = `${staged.value.promptText}\n\n${promptContent}`;
      }
      const input = { event: "user", message: { content: promptContent } };
      if (Buffer.byteLength(JSON.stringify(input)) > 4 * 1024 * 1024) return rejected("invalid-input", "Antigravity prompt exceeds the size limit");
      selectionPending = true;
      try {
        if (!permissionBridge) throw agyError("runtime-unavailable", "Antigravity approval bridge is unavailable");
        await permissionBridge.prepare();
        const autoApprove = await currentAutoApprove();
        const args = agyLaunchArgs(selectedModel, selectedAgent, nativeId, {
          autoApprove,
          hookRoot: permissionBridge.root,
        });
        // Persist intent BEFORE touching stdin: a lost acknowledgement is not
        // permission to submit a duplicated prompt after a server restart.
        await authority.receipt(`sent:${operationId}`, nativeId);
        if (!connected || stopping) return unknown(operationId, "Antigravity disconnected while recording the prompt intent");
        return await new Promise<Admission>((resolve) => {
          active = { id: operationId, turn: createAgyTurn(operationId, selectedModel), admit: resolve };
          active.timer = setTimeout(() => fail(agyError("outcome-unknown", "Antigravity did not acknowledge the prompt; it was not replayed")), options.timeoutMs ?? 15_000);
          if (autoApprove !== launchAutoApprove) expectedReinitAutoApprove = autoApprove;
          order++;
          child!.stdin!.write(JSON.stringify({
            event: "polyth_user",
            args,
            mode: autoApprove ? "auto" : "review",
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
    async abort(sessionId) {
      if (!belongs(sessionId)) throw agyError("invalid-session", "Antigravity runtime belongs to another session");
      stopping = true;
      if (initTimer) clearTimeout(initTimer);
      if (stagedLaunchTarget && stagedRevision && !nativeId) {
        releaseCapabilityLaunch({
          target: stagedLaunchTarget,
          desiredRevision: stagedRevision,
        });
        stagedLaunchTarget = undefined;
        stagedRevision = undefined;
        stagedCapabilityIds = undefined;
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
    replyQuestion: async () => { throw agyError("unsupported", "Antigravity stream mode has no interactive question channel"); },
    endpoint: async () => endpoint,
    protocol: async () => "legacy",
    async reconcile(binding) {
      reconciliationOrdinal = binding.reconciliationOrdinal ?? 0;
      const matches = belongs(binding.canonicalSessionId) && binding.backendSessionId === nativeId && binding.location.directory === context.cwd
        && binding.authorityId === authority.authorityId && binding.generation === authority.generation;
      return { ...endpoint, backendSessionId: binding.backendSessionId ?? nativeId, reconciliationOrdinal,
        state: { value: !matches || !connected || stopping ? "unknown" : active ? "running" : "idle", comparison: { domain: authority.authorityId, order: ++order }, ...(createId && !accepted.length ? { causalOperationId: createId } : {}) },
        completeness: { events: "partial", permissions: connected ? "complete" : "unverifiable", questions: "complete" },
        events: matches ? [...events.values()] : [],
        permissions: matches ? [...permissions].map(([requestId, pending]) => ({
          requestId,
          permission: pending.permission,
          patterns: pending.patterns,
        })) : [],
        questions: [], acceptedOperations: matches ? accepted : [],
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
        stagedCapabilityIds = undefined;
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
