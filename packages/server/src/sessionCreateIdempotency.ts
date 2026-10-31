// Idempotent HTTP session creation. A phone on a flaky Polyth Link can lose the
// create response after the server already created the session; without a key
// the client cannot tell "never arrived" from "created", and a resend would
// duplicate the chat. The client sends a random `clientOperationId` per user
// intent; the server derives the canonical session id from it, so a retry with
// the same key resolves to the same session instead of a second one.
//
// The derived id is a one-way digest of (purpose, account, Space, key): the
// client chooses no session id and cannot alias or probe another account's or
// Space's sessions. Dedupe is by key, never a blind replay of an uncertain call.

import type { SessionProjection, SessionRef, SessionService } from "@polyth/contracts";
import { sessionIdForCreateOperation } from "@polyth/session/create-operation";

export { sessionIdForCreateOperation };

/** What a client learns about one create intent. `absent` means no session was
 *  created under the key yet (the request may still be in flight); resending
 *  the same key is safe either way. */
export interface SessionCreateOperationStatus {
  state: "absent" | "created" | "failed";
  sessionId?: string;
}

// Serialize every request for one derived id, so a retry that overtakes the
// still-running original waits for it and then observes its result.
const chains = new Map<string, Promise<void>>();
async function withCreateLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveCurrent) => { release = resolveCurrent; });
  chains.set(sessionId, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (chains.get(sessionId) === current) chains.delete(sessionId);
  }
}

async function existing(sessions: Pick<SessionService, "snapshot">, sessionId: string): Promise<SessionProjection | undefined> {
  try {
    return await sessions.snapshot(sessionId);
  } catch (error) {
    if ((error as { code?: unknown })?.code === "not-found") return undefined;
    throw error;
  }
}

function statusOf(projection: SessionProjection | undefined): SessionCreateOperationStatus {
  if (!projection) return { state: "absent" };
  return { state: projection.status === "failed" ? "failed" : "created", sessionId: projection.id };
}

export async function sessionCreateOperationStatus(
  sessions: Pick<SessionService, "snapshot">,
  sessionId: string,
): Promise<SessionCreateOperationStatus> {
  return statusOf(await existing(sessions, sessionId));
}

/** Create once per key. A repeat returns the session the first request made;
 *  a repeat of a create that failed reports that failure as settled. */
export async function createSessionOnce(
  sessions: Pick<SessionService, "snapshot">,
  sessionId: string,
  projectId: string,
  create: (sessionId: string) => Promise<SessionRef>,
): Promise<{ ref: SessionRef; created: boolean }> {
  return withCreateLock(sessionId, async () => {
    const prior = await existing(sessions, sessionId);
    if (!prior) return { ref: await create(sessionId), created: true };
    if (prior.projectId !== projectId) {
      throw Object.assign(new Error("clientOperationId was already used for another session"), { code: "conflict" });
    }
    if (prior.status === "failed") {
      throw Object.assign(new Error("session creation failed"), {
        code: "session-create-failed",
        status: 409,
        mutationOutcome: "rejected",
        sessionId,
      });
    }
    return { ref: { id: prior.id }, created: false };
  });
}
