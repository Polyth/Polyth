// Client recovery hints, deliberately not a second mutation ledger. The
// durable server operation remains authoritative after an admitted request or
// any lost response; these records only identify a locally staged intent.
import { flushClientPersistence, hydrateClientRecord, readClientRecord, removeClientRecord, writeClientRecord, type PersistenceScope } from "./clientPersistence.ts";
import { clientPersistenceScope } from "./reliabilityContext.ts";
import { api } from "@polyth/session/web-api";
import { errorCodeOf, httpStatusOf } from "@polyth/session/web-api";
import type { AttachmentRef, JsonObject, SendResult } from "@polyth/contracts";

export type ClientMutationKind = "turn-submit" | "queue-admission" | "permission-reply" | "question-reply" | "abort";
export interface LocalMutationIntent {
  v: 1;
  operationId: string;
  kind: ClientMutationKind;
  state: "never-transmitted" | "unknown";
  updatedAt: number;
}

export type ClientMutationReconciliation = "none" | "applied" | "not-applied" | "unknown";

const KIND = "unsent-intent";
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

/** One-shot direct prompt admission. It never retries a transport failure:
 * after `fetch` throws, only the server's durable operation can establish
 * whether this UUID applied. The caller may later inspect/reconcile it. */
export async function submitDirectPrompt(
  sessionId: string,
  body: {
    text: string; command?: { id: string; args?: string }; autoTitle?: boolean;
    attachments?: AttachmentRef[]; model?: JsonObject; agent?: string;
    delivery?: "normal" | "queue";
    dismissPending?: boolean; agentProfileId?: string | null;
  },
  scopeOverride?: PersistenceScope,
): Promise<SendResult> {
  const capturedScope = intentScope(sessionId, scopeOverride);
  const intent = stageLocalMutationIntent(sessionId, body.delivery === "queue" ? "queue-admission" : "turn-submit", newLogicalOperationId(), capturedScope);
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
    const result = await api.sendMessage(sessionId, { ...body, clientOperationId: intent.operationId });
    clearLocalMutationIntent(sessionId, capturedScope);
    return result;
  } catch (error) {
    if (retainLocalMutationIntentAfterError(error)) markLocalMutationUnknown(sessionId, intent, capturedScope);
    else clearLocalMutationIntent(sessionId, capturedScope);
    throw error;
  }
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
