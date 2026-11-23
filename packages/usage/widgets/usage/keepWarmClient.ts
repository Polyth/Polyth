// Browser client of the server's keep-warm controller (`/api/usage/keep-warm`),
// shared by the composer's context card and the cache-expiry notice.
import { sessionFetch } from "@polyth/session/web-api";
import type { KeepWarmStatus } from "../../src/keepWarm.ts";

const ENDPOINT = "/api/usage/keep-warm";

export function loadKeepWarm(sessionId: string, signal?: AbortSignal): Promise<KeepWarmStatus> {
  return sessionFetch<KeepWarmStatus>(`${ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`, signal ? { signal } : undefined);
}

/** Keeps the chat warm for `minutes` from now; 0 stops it. */
export function setKeepWarm(sessionId: string, minutes: number): Promise<KeepWarmStatus> {
  return sessionFetch<KeepWarmStatus>(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, minutes }),
  });
}
