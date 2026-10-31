// Each person's usage-alert ledger, kept in their Space's usage directory. The
// browser decides the alerts; the server only remembers what was announced, so
// a reload, another device or the phone app (a fresh shell origin on every
// launch) does not show the same alert again in the same limit period.
//
// Writes merge into the stored copy instead of replacing it: two devices
// writing at once both keep what they announced (alertLedger.ts).
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";
import { mergeAlertLedgers, parseAlertLedger, type UsageAlertLedger } from "./alertLedger.ts";

const FILE = "alert-ledgers-v1.json";
/** People whose ledgers one Space keeps; the least recently written go first. */
const MAX_PEOPLE = 64;

/** `host` covers host-wide sources; `space` the sources computed for this Space. */
export type AlertLedgerSlot = "host" | "space";

export interface PersonAlertLedgers {
  host: UsageAlertLedger | null;
  space: UsageAlertLedger | null;
}

interface StoredPerson {
  host?: UsageAlertLedger;
  space?: UsageAlertLedger;
  updatedAt: number;
}

const readPeople = (dir: string): Record<string, StoredPerson> => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, FILE), "utf8"));
  } catch {
    return {};
  }
  const people = raw && typeof raw === "object" ? (raw as { version?: unknown; people?: unknown }) : null;
  if (people?.version !== 1 || !people.people || typeof people.people !== "object") return {};
  const result: Record<string, StoredPerson> = {};
  for (const [userId, value] of Object.entries(people.people as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as { host?: unknown; space?: unknown; updatedAt?: unknown };
    result[userId] = {
      ...(entry.host !== undefined ? { host: parseAlertLedger(entry.host) } : {}),
      ...(entry.space !== undefined ? { space: parseAlertLedger(entry.space) } : {}),
      updatedAt: typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
    };
  }
  return result;
};

const view = (person: StoredPerson | undefined): PersonAlertLedgers => ({
  host: person?.host ?? null,
  space: person?.space ?? null,
});

export function readPersonAlertLedgers(dir: string, userId: string): PersonAlertLedgers {
  return view(readPeople(dir)[userId]);
}

/** Merges `incoming` into the person's stored ledgers and returns the result. */
export function mergePersonAlertLedgers(
  dir: string,
  userId: string,
  incoming: Partial<Record<AlertLedgerSlot, UsageAlertLedger>>,
  now: number,
): PersonAlertLedgers {
  // Read and write without yielding, so two requests cannot interleave here.
  const people = readPeople(dir);
  const current = people[userId];
  const next: StoredPerson = { ...current, updatedAt: now };
  for (const slot of ["host", "space"] as const) {
    const ledger = incoming[slot];
    if (!ledger) continue;
    const stored = current?.[slot];
    next[slot] = stored ? mergeAlertLedgers(stored, ledger, now) : mergeAlertLedgers(ledger, ledger, now);
  }
  people[userId] = next;
  const kept = Object.entries(people)
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_PEOPLE);
  mkdirSync(dir, { recursive: true });
  atomicWriteSync(join(dir, FILE), JSON.stringify({ version: 1, people: Object.fromEntries(kept) }));
  return view(next);
}
