// The person's usage-alert ledger as the server keeps it (see
// src/alertLedgerStore.ts). The response names the server and Space it answers
// for, so a per-Space ledger is only ever combined with that Space's sources.
import { sessionFetch } from "@polyth/session/web-api";
import { parseAlertLedger, type UsageAlertLedger } from "../../src/alertLedger.ts";
import type { UsageLimitsIdentity } from "./limitsIdentity.ts";

export interface RemoteAlertLedgers {
  serverInstanceId?: string;
  spaceId?: string;
  host: UsageAlertLedger | null;
  space: UsageAlertLedger | null;
  /** On a write's answer only: the stored copy that write found, before its
   * merge. An older server leaves it out. */
  previous?: { host: UsageAlertLedger | null; space: UsageAlertLedger | null };
}

export interface RemoteAlertLedgersUpdate {
  host?: UsageAlertLedger;
  /** Sent only with the identity it was judged for. */
  space?: { ledger: UsageAlertLedger; identity: UsageLimitsIdentity };
}

const ENDPOINT = "/api/usage/alerts/ledger";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const parse = (value: unknown): RemoteAlertLedgers => {
  const raw = record(value);
  const previous = raw.previous && typeof raw.previous === "object" ? record(raw.previous) : null;
  return {
    ...(typeof raw.serverInstanceId === "string" ? { serverInstanceId: raw.serverInstanceId } : {}),
    ...(typeof raw.spaceId === "string" ? { spaceId: raw.spaceId } : {}),
    host: raw.host ? parseAlertLedger(raw.host) : null,
    space: raw.space ? parseAlertLedger(raw.space) : null,
    ...(previous ? {
      previous: {
        host: previous.host ? parseAlertLedger(previous.host) : null,
        space: previous.space ? parseAlertLedger(previous.space) : null,
      },
    } : {}),
  };
};

/** A server without the route (an older one): the ledger stays on this device. */
const unsupported = (error: unknown): boolean => {
  const status = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
  return status === 404 || status === 405;
};

/** The stored ledgers, or null when this server keeps none. Other failures reject. */
export async function loadAlertLedgers(): Promise<RemoteAlertLedgers | null> {
  try {
    return parse(await sessionFetch<unknown>(ENDPOINT));
  } catch (error) {
    if (unsupported(error)) return null;
    throw error;
  }
}

export async function saveAlertLedgers(update: RemoteAlertLedgersUpdate): Promise<RemoteAlertLedgers> {
  return parse(await sessionFetch<unknown>(ENDPOINT, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(update.host ? { host: update.host } : {}),
      ...(update.space ? { ...update.space.identity, space: update.space.ledger } : {}),
    }),
  }));
}
