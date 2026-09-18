// Client recovery hints, deliberately not a second mutation ledger. The
// durable server operation remains authoritative after an admitted request or
// any lost response; these records only identify a locally staged intent.
import { flushClientPersistence, hydrateClientRecord, readClientRecord, removeClientRecord, writeClientRecord, type PersistenceScope } from "./clientPersistence.ts";
import { clientPersistenceScope } from "./reliabilityContext.ts";
import { api } from "@polyth/session/web-api";
import { errorCodeOf, httpStatusOf } from "@polyth/session/web-api";
import type { AttachmentRef, JsonObject, SendResult } from "@polyth/contracts";
import { getState, endPendingSend } from "./store.ts";

export type ClientMutationKind = "turn-submit" | "queue-admission" | "permission-reply" | "question-reply" | "abort";
export interface LocalMutationIntent {
  v: 1;
  operationId: string;
  kind: ClientMutationKind;
  state: "never-transmitted" | "unknown";
  updatedAt: number;
}

export type ClientMutationReconciliation = "none" | "applied" | "not-applied" | "unknown";

export interface DirectPromptBody {
  text: string;
  command?: { id: string; args?: string };
  autoTitle?: boolean;
  hiddenUserMessage?: boolean;
  attachments?: AttachmentRef[];
  model?: JsonObject;
  agent?: string;
  delivery?: "normal" | "queue";
  dismissPending?: boolean;
  agentProfileId?: string | null;
}

export interface ExtensionCommandLaunchInput {
  commandId: string;
  query: string;
  arguments?: string;
  sessionId?: string;
  projectId?: string;
}

export interface DirectPromptDependencies {
  launchExtensionCommand(input: ExtensionCommandLaunchInput): Promise<void>;
  projectIdForSession(sessionId: string): string | undefined;
  retireExtensionCommandEcho(sessionId: string, text: string): void;
  sendMessage(sessionId: string, body: DirectPromptBody & { clientOperationId: string }): Promise<SendResult>;
}

const KIND = "unsent-intent";
// Process-local only: a durable `unknown` is written before POST for crash
// recovery, but while this renderer still owns that POST it is not a recovery
// failure. Never persist this set — after a renderer/process restart the
// durable marker must become eligible for reconciliation again.
const activeLocalMutationIds = new Set<string>();
const intentScope = (sessionId: string, captured?: PersistenceScope): PersistenceScope =>
  captured ?? clientPersistenceScope({ sessionId });
const scopeIsCurrent = (sessionId: string, captured: PersistenceScope): boolean =>
  JSON.stringify(clientPersistenceScope({ sessionId })) === JSON.stringify(captured);

export function newLogicalOperationId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function loadLocalMutationIntent(sessionId: string, capturedScope?: PersistenceScope): LocalMutationIntent | null {
  try {
    const value = JSON.parse(readClientRecord(KIND, intentScope(sessionId, capturedScope)) ?? "null") as Partial<LocalMutationIntent> | null;
    return value?.v === 1
      && typeof value.operationId === "string"
      && typeof value.kind === "string"
      && (value.state === "never-transmitted" || value.state === "unknown")
      && typeof value.updatedAt === "number"
      ? value as LocalMutationIntent
      : null;
  } catch {
    return null;
  }
}

/** A recovery warning is valid only for a durable intent no live POST owns. */
export function shouldSurfaceLocalMutationRecovery(sessionId: string): boolean {
  const intent = loadLocalMutationIntent(sessionId);
  return intent !== null && !activeLocalMutationIds.has(intent.operationId);
}

export async function hydrateLocalMutationIntent(sessionId: string): Promise<LocalMutationIntent | null> {
  const capturedScope = intentScope(sessionId);
  await hydrateClientRecord(KIND, capturedScope);
  return loadLocalMutationIntent(sessionId, capturedScope);
}

export function stageLocalMutationIntent(sessionId: string, kind: ClientMutationKind, operationId = newLogicalOperationId(), capturedScope?: PersistenceScope): LocalMutationIntent {
  const intent: LocalMutationIntent = { v: 1, operationId, kind, state: "never-transmitted", updatedAt: Date.now() };
  writeClientRecord(KIND, intentScope(sessionId, capturedScope), JSON.stringify(intent));
  return intent;
}

/** A request that may have left the device is never retried from this store. */
export function markLocalMutationUnknown(sessionId: string, intent: LocalMutationIntent, capturedScope?: PersistenceScope): void {
  writeClientRecord(KIND, intentScope(sessionId, capturedScope), JSON.stringify({ ...intent, state: "unknown", updatedAt: Date.now() }));
}

export function clearLocalMutationIntent(sessionId: string, capturedScope?: PersistenceScope): void {
  removeClientRecord(KIND, intentScope(sessionId, capturedScope));
}

/** Only a possible transmit/lost outcome keeps a local reconciliation hint.
 * A concrete 4xx rejection proves this client operation was not admitted;
 * `outcome-unknown` is the explicit exception even when transported as 4xx. */
export function retainLocalMutationIntentAfterError(error: unknown): boolean {
  if (errorCodeOf(error) === "outcome-unknown") return true;
  const status = httpStatusOf(error);
  return status === undefined || status < 400 || status >= 500;
}

function retireExtensionCommandEcho(sessionId: string, text: string): void {
  const pending = getState().pendingSends;
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const item = pending[index]!;
    if (item.sessionId === sessionId && item.text.trim() === text.trim() && item.attachments.length === 0) {
      endPendingSend(item.id);
      return;
    }
  }
}

const defaultDependencies: DirectPromptDependencies = {
  launchExtensionCommand: async (input) => {
    // Keep the durable mutation module browser/Node-test safe. ReactDOM and
    // the extension overlay are loaded only after a host-only command wins.
    const module = await import("./packages/sandbox/extensionCommands.tsx");
    await module.launchExtensionCommand(input);
  },
  projectIdForSession: (sessionId) =>
    getState().sessions.find((candidate) => candidate.id === sessionId)?.projectId,
  retireExtensionCommandEcho,
  sendMessage: (sessionId, body) => api.sendMessage(sessionId, body),
};

/** Host-only slash commands are intercepted before the durable mutation ledger.
 * They may open RemoteUI and attach context, but they never create a fake
 * user/message, prompt-history row, model turn, or recoverable send intent. */
async function submitExtensionCommand(
  sessionId: string,
  body: DirectPromptBody,
  deps: DirectPromptDependencies,
): Promise<SendResult | null> {
  const command = body.command;
  if (!command?.id.startsWith("extension:")) return null;
  if (body.attachments?.length) {
    throw Object.assign(new Error("Remove attachments before running an extension command."), {
      code: "invalid-input",
      status: 409,
    });
  }
  const projectId = deps.projectIdForSession(sessionId);
  await deps.launchExtensionCommand({
    commandId: command.id,
    query: body.text,
    ...(command.args ? { arguments: command.args } : {}),
    sessionId,
    ...(projectId ? { projectId } : {}),
  });
  deps.retireExtensionCommandEcho(sessionId, body.text);
  // submitDirectPrompt callers only need an admitted/not-admitted distinction;
  // host commands intentionally have no canonical turn id.
  return { turnId: `extension:${crypto.randomUUID()}` } as SendResult;
}

/** Internal dependency seam used by admission tests. Production callers use
 * submitDirectPrompt so extension execution and normal sends cannot diverge. */
export async function submitDirectPromptWithDependencies(
  sessionId: string,
  body: DirectPromptBody,
  scopeOverride: PersistenceScope | undefined,
  deps: DirectPromptDependencies,
): Promise<SendResult> {
  const extensionResult = await submitExtensionCommand(sessionId, body, deps);
  if (extensionResult) return extensionResult;

  const capturedScope = intentScope(sessionId, scopeOverride);
  const intent = stageLocalMutationIntent(sessionId, body.delivery === "queue" ? "queue-admission" : "turn-submit", newLogicalOperationId(), capturedScope);
  activeLocalMutationIds.add(intent.operationId);
  try {
    try {
      // The recovery token and the draft share this flush boundary. Do not let
      // a request leave the device until process-restart recovery can name it.
      await flushClientPersistence();
    } catch (error) {
      throw Object.assign(
        new Error(error instanceof Error ? error.message : "client recovery metadata could not be persisted"),
        { code: "client-persistence-failed", status: 409 },
      );
    }
    if (!scopeIsCurrent(sessionId, capturedScope)) {
      throw Object.assign(new Error("session context changed before admission"), {
        code: "client-context-changed",
        status: 409,
      });
    }
    // Cross the network only after restart recovery durably knows this request
    // may have left the device. Otherwise a process kill during fetch can revive
    // a stale `never-transmitted` marker and make an absent status look like
    // proof that a still-arriving POST did not apply.
    markLocalMutationUnknown(sessionId, intent, capturedScope);
    try {
      await flushClientPersistence();
    } catch (error) {
      throw Object.assign(
        new Error(error instanceof Error ? error.message : "client recovery metadata could not be persisted"),
        { code: "client-persistence-failed", status: 409 },
      );
    }
    if (!scopeIsCurrent(sessionId, capturedScope)) {
      throw Object.assign(new Error("session context changed before admission"), {
        code: "client-context-changed",
        status: 409,
      });
    }
    try {
      const result = await deps.sendMessage(sessionId, { ...body, clientOperationId: intent.operationId });
      clearLocalMutationIntent(sessionId, capturedScope);
      return result;
    } catch (error) {
      if (retainLocalMutationIntentAfterError(error)) markLocalMutationUnknown(sessionId, intent, capturedScope);
      else clearLocalMutationIntent(sessionId, capturedScope);
      throw error;
    }
  } finally {
    activeLocalMutationIds.delete(intent.operationId);
  }
}

/** One-shot direct prompt admission. It never retries a transport failure:
 * after `fetch` throws, only the server's durable operation can establish
 * whether this UUID applied. The caller may later inspect/reconcile it. */
export function submitDirectPrompt(
  sessionId: string,
  body: DirectPromptBody,
  scopeOverride?: PersistenceScope,
): Promise<SendResult> {
  return submitDirectPromptWithDependencies(sessionId, body, scopeOverride, defaultDependencies);
}

/** Reconnect/process-restart recovery is a read, never a redispatch. The
 * server maps this client UUID into its existing durable operation or queue
 * row and is the sole authority for applied/non-applied. */
export async function reconcileLocalMutationIntent(sessionId: string): Promise<ClientMutationReconciliation> {
  const capturedScope = intentScope(sessionId);
  const intent = loadLocalMutationIntent(sessionId, capturedScope);
  if (!intent) return "none";
  if (!scopeIsCurrent(sessionId, capturedScope)) return "unknown";
  let status;
  try {
    status = await api.clientMutationStatus(sessionId, intent.operationId);
  } catch {
    return "unknown";
  }
  if (status.state === "confirmed" || status.state === "queued") {
    clearLocalMutationIntent(sessionId, capturedScope);
    return "applied";
  }
  if (status.state === "not-applied" || status.state === "rejected"
    || (status.state === "absent" && intent.state === "never-transmitted")) {
    clearLocalMutationIntent(sessionId, capturedScope);
    return "not-applied";
  }
  return "unknown";
}
