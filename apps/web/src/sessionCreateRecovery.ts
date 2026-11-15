// Session create over a flaky transport (a phone on Polyth Link). A create whose
// response was lost may or may not have made the session, so the request is
// keyed: one random clientOperationId per user intent, and the server derives
// the session id from it. After a transport loss the key is first resolved with
// the server's create-operation probe — which also proves the server dedupes —
// and only then resent; a resend returns the session the lost request made.
// A server that cannot resolve the key (older build, still unreachable) leaves
// the outcome unknown: never a blind replay, never a silent duplicate.

import type { StartSessionResult } from "@polyth/contracts";
import type { SessionCreateOperationStatusDto } from "@polyth/session/web-api";
import { isTransportFailure } from "./errorPresentation.ts";
import { newLogicalOperationId } from "./mutationIntent.ts";

export interface KeyedSessionCreate {
  create(clientOperationId: string): Promise<StartSessionResult>;
  status(clientOperationId: string): Promise<SessionCreateOperationStatusDto>;
  /** Defaults to a timer; tests inject an immediate one. */
  wait?(ms: number): Promise<void>;
  newOperationId?(): string;
  /** The create also started the chat (`start`): the probe's `created` holds
   *  only the id, so the keyed request is resent (the server returns the same
   *  chat and never queues its first turn twice) to learn whether the start
   *  was taken (`queueId`/`turnId`) or ignored by an older server. */
  resendWhenCreated?: boolean;
}

/** Backoff while the link reconnects (~24 s in total). */
export const SESSION_CREATE_RESOLVE_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000, 8_000];

const httpStatus = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
};

function outcomeUnknown(clientOperationId: string, cause: unknown): Error {
  return Object.assign(new Error("session creation was not confirmed"), {
    code: "outcome-unknown",
    mutationOutcome: "unknown",
    clientOperationId,
    cause,
  });
}

export async function createSessionWithRecovery(deps: KeyedSessionCreate): Promise<StartSessionResult> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const key = (deps.newOperationId ?? newLogicalOperationId)();
  let lastFailure: unknown;
  try {
    return await deps.create(key);
  } catch (error) {
    if (!isTransportFailure(error)) throw error;
    lastFailure = error;
  }
  for (const delay of SESSION_CREATE_RESOLVE_DELAYS_MS) {
    await wait(delay);
    let status: SessionCreateOperationStatusDto;
    try {
      status = await deps.status(key);
    } catch (error) {
      if (isTransportFailure(error)) { lastFailure = error; continue; }
      // 404 = a server without keyed create: resending could duplicate.
      throw outcomeUnknown(key, httpStatus(error) === 404 ? lastFailure : error);
    }
    if (status?.state === "created" && typeof status.sessionId === "string") {
      if (!deps.resendWhenCreated) return { id: status.sessionId };
      try {
        return await deps.create(key);
      } catch (error) {
        // The chat exists; only its start answer is missing. Never report
        // that as a plain failure the composer would offer to resend.
        if (!isTransportFailure(error)) throw outcomeUnknown(key, error);
        lastFailure = error;
        continue;
      }
    }
    if (status?.state !== "absent" && status?.state !== "failed") throw outcomeUnknown(key, lastFailure);
    // `absent`: never arrived (or still in flight — the server serializes the
    // key); `failed`: the resend reports that settled failure. Both are safe.
    try {
      return await deps.create(key);
    } catch (error) {
      if (!isTransportFailure(error)) throw error;
      lastFailure = error;
    }
  }
  throw outcomeUnknown(key, lastFailure);
}
