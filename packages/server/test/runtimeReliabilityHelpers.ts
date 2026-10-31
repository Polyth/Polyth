/**
 * Test-only session reliability harness. Composes owned/borrowed stub
 * runtimes with the session service so matrix cells can inject identity
 * breaks without copying setup. Do not import from production packages.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRuntime,
  Project,
  ProjectService,
  RuntimeEndpoint,
  RuntimeEvent,
  RuntimeSessionBinding,
  RuntimeSnapshot,
  SessionEvent,
  SessionProjection,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { canRebindPersistedSession, createSessionService, type Broadcaster } from "../src/sessions.ts";

export const assertCanRebindUnchanged = (): void => {
  assert.doesNotMatch(canRebindPersistedSession.toString(), /\.epoch\b/);
};

export const persistBoundSession = async (
  store: ReturnType<typeof createStore>,
  project: Project,
  endpoint: RuntimeEndpoint,
  sessionId: string,
  backendSessionId: string,
  authorityId = endpoint.authorityId,
  status: SessionProjection["status"] = "idle",
): Promise<SessionProjection> => {
  const projection: SessionProjection = {
    id: sessionId,
    projectId: project.id,
    title: "Reliability matrix",
    status,
    backendSessionId,
    runtimeControl: endpoint.control.kind === "owned" ? "owned" : "borrowed",
    runtimeBinding: {
      backendSessionId,
      authorityId,
      generation: endpoint.generation,
      epoch: 0,
      continuity: endpoint.continuity,
      protocol: "legacy",
      location: endpoint.location,
    },
    createdAt: 1,
    updatedAt: 1,
  };
  await store.upsertProjection(projection);
  return projection;
};

export const admitUnknownTurn = async (
  store: ReturnType<typeof createStore>,
  sessionId: string,
  text: string,
): Promise<{ operationId: string }> => {
  const prepared = await store.prepareOperation({
    sessionId,
    mutationKind: "turn-submit",
    intentEvent: { type: "user/message", data: { text } },
  });
  await store.claimOperation(prepared.operation.operationId);
  await store.settleOperation(prepared.operation.operationId, {
    kind: "unknown",
    message: "submission outcome was lost",
  });
  return { operationId: prepared.operation.operationId };
};

/** A turn that was mid-flight (prepared + claimed, never settled) when the
 *  Polyth process died. Reopening the store converts it to
 *  `unknown` / `process-restarted` exactly like a real restart. */
export const admitRestartStrandedTurn = async (
  store: ReturnType<typeof createStore>,
  sessionId: string,
  text: string,
): Promise<{ operationId: string }> => {
  const prepared = await store.prepareOperation({
    sessionId,
    mutationKind: "turn-submit",
    intentEvent: { type: "user/message", data: { text } },
  });
  await store.claimOperation(prepared.operation.operationId);
  return { operationId: prepared.operation.operationId };
};

export const prepareUnclaimedTurn = async (
  store: ReturnType<typeof createStore>,
  sessionId: string,
  text: string,
): Promise<{ operationId: string }> => {
  const prepared = await store.prepareOperation({
    sessionId,
    mutationKind: "turn-submit",
    intentEvent: { type: "user/message", data: { text } },
  });
  return { operationId: prepared.operation.operationId };
};

export const reopenStore = async (
  directory: string,
  store: ReturnType<typeof createStore>,
): Promise<ReturnType<typeof createStore>> => {
  await store.close();
  return createStore(join(directory, "sessions.db"));
};

export const latestRecoveryContext = (events: readonly SessionEvent[]): string => {
  const last = [...events].reverse().find((event) => event.type === "user/message");
  return String((last?.data as { recoveryContext?: unknown })?.recoveryContext ?? "");
};

export const createEpochRuntime = (
  endpoint: RuntimeEndpoint,
  submitted: string[] = [],
  backendSessionId = `backend-${endpoint.authorityId}`,
): AgentRuntime => {
  let resetOperationId: string | undefined;
  return {
    capabilities: async () => ({
      streaming: true,
      permissions: true,
      questions: true,
      compaction: false,
      subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (input) => input.backendSessionId ?? backendSessionId,
    resetSessionOperation: async (_input, operationId) => {
      resetOperationId = operationId;
      return {
        kind: "confirmed",
        value: { backendSessionId },
        receipt: backendSessionId,
      };
    },
    sessions: async () => [],
    history: async () => [],
    startTurnOperation: async (request) => {
      submitted.push(request.text);
      return { kind: "confirmed", value: {} };
    },
    startTurn: async () => undefined,
    abort: async () => undefined,
    replyPermission: async () => undefined,
    replyQuestion: async () => undefined,
    endpoint: async () => endpoint,
    protocol: async () => "legacy",
    reconcile: async (
      binding: RuntimeSessionBinding & { reconciliationOrdinal?: number },
    ): Promise<RuntimeSnapshot> => ({
      authorityId: binding.authorityId,
      generation: binding.generation,
      location: binding.location,
      backendSessionId: binding.backendSessionId!,
      reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
      state: resetOperationId
        ? { value: "idle", causalOperationId: resetOperationId }
        : {
            value: "idle",
            comparison: { domain: `stable-${endpoint.authorityId}`, order: 1 },
          },
      completeness: {
        events: "partial",
        permissions: "partial",
        questions: "partial",
      },
      permissions: [],
      questions: [],
      events: [],
    }),
    onEvent: (_callback: (sessionId: string, event: RuntimeEvent) => void) => ({
      dispose: () => undefined,
    }),
    dispose: async () => undefined,
  };
};

export const createSessionReliabilityHarness = (options: {
  runtime: AgentRuntime;
  prefix?: string;
  directory?: string;
  store?: ReturnType<typeof createStore>;
}) => {
  const directory = options.directory
    ?? mkdtempSync(join(tmpdir(), options.prefix ?? "polyth-reliability-"));
  const ownsDirectory = options.directory === undefined && options.store === undefined;
  const store = options.store ?? createStore(join(directory, "sessions.db"));
  const project: Project = {
    id: "project-1",
    name: "Reliability",
    path: directory,
    createdAt: 1,
  };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => id === project.id ? project : undefined,
    add: async () => project,
    create: async () => project,
    remove: async () => undefined,
  };
  const permissions = {
    evaluate: () => "allow",
    addRule: () => undefined,
    rules: () => [],
  } as unknown as PermissionService;
  const broadcast: Broadcaster = {
    event: () => undefined,
    projection: () => undefined,
  };
  return {
    directory,
    store,
    project,
    sessions: createSessionService({
      store,
      projects,
      permissions,
      broadcast,
      queue: store,
      runtimes: { forProject: async () => options.runtime },
    }),
    async dispose() {
      await store.close();
      if (ownsDirectory) rmSync(directory, { recursive: true, force: true });
    },
  };
};
