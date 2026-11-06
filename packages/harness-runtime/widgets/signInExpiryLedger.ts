// What a person was already told about each harness sign-in end: the
// one-time notification per level and a dismissed in-chat notice. A new end
// date (the person signed in again) or a stronger level is news again. Local
// storage is the synchronous cache; the package registers this store with
// `host.preferences`, so the account's settings sync carries it and a phone
// app that starts with empty storage does not repeat an alert it showed.
import { useSyncExternalStore } from "react";
import type { HarnessSignInExpiryLevel } from "@polyth/contracts";

export type SignInAlertLevel = Exclude<HarnessSignInExpiryLevel, "none">;
export interface SignInExpiryMemo {
  expiresAt: number;
  notified?: SignInAlertLevel;
  dismissed?: SignInAlertLevel;
}
export interface SignInExpiryLedger {
  version: 1;
  harnesses: Record<string, SignInExpiryMemo>;
}
export type SignInExpiryMark = "notified" | "dismissed";

export const SIGN_IN_EXPIRY_LEDGER_KEY = "polyth.harnessSignInExpiry";
export const SIGN_IN_EXPIRY_PREFERENCE_ID = "package.harness-runtime.sign-in-expiry";
const RANK: Readonly<Record<SignInAlertLevel, number>> = { soon: 1, imminent: 2, ended: 3 };
const MAX_ENTRIES = 32;
/** Entries for an end this far in the past are dropped. */
const KEEP_ENDED_MS = 30 * 24 * 60 * 60 * 1000;
const HARNESS_ID = /^[a-z][a-z0-9-]{0,63}$/;

const level = (value: unknown): SignInAlertLevel | undefined =>
  value === "soon" || value === "imminent" || value === "ended" ? value : undefined;

export function sanitizeSignInExpiryLedger(value: unknown, now: number = Date.now()): SignInExpiryLedger {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = undefined;
    }
  }
  const harnesses = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { harnesses?: unknown }).harnesses
    : undefined;
  const entries = harnesses && typeof harnesses === "object" && !Array.isArray(harnesses)
    ? Object.entries(harnesses as Record<string, unknown>).flatMap(([id, memo]): Array<[string, SignInExpiryMemo]> => {
      const record = memo as Partial<Record<keyof SignInExpiryMemo, unknown>> | null;
      const expiresAt = record?.expiresAt;
      if (!HARNESS_ID.test(id) || typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt < now - KEEP_ENDED_MS) return [];
      const notified = level(record?.notified);
      const dismissed = level(record?.dismissed);
      return [[id, { expiresAt, ...(notified ? { notified } : {}), ...(dismissed ? { dismissed } : {}) }]];
    })
    : [];
  entries.sort((a, b) => b[1].expiresAt - a[1].expiresAt);
  return { version: 1, harnesses: Object.fromEntries(entries.slice(0, MAX_ENTRIES)) };
}

/** Whether `alert` for this end has not been marked yet. */
export const isSignInExpiryNews = (
  ledger: SignInExpiryLedger,
  harnessId: string,
  expiresAt: number,
  alert: SignInAlertLevel,
  mark: SignInExpiryMark,
): boolean => {
  const memo = ledger.harnesses[harnessId];
  const seen = memo?.expiresAt === expiresAt ? memo[mark] : undefined;
  return !seen || RANK[alert] > RANK[seen];
};

export const withSignInExpiryMark = (
  ledger: SignInExpiryLedger,
  harnessId: string,
  expiresAt: number,
  alert: SignInAlertLevel,
  mark: SignInExpiryMark,
  now: number = Date.now(),
): SignInExpiryLedger => {
  const memo = ledger.harnesses[harnessId];
  const kept = memo?.expiresAt === expiresAt ? memo : { expiresAt };
  return sanitizeSignInExpiryLedger({ ...ledger, harnesses: { ...ledger.harnesses, [harnessId]: { ...kept, [mark]: alert } } }, now);
};

const listeners = new Set<() => void>();
let cache: SignInExpiryLedger | undefined;

function readStorage(): SignInExpiryLedger {
  try {
    if (typeof localStorage !== "undefined") return sanitizeSignInExpiryLedger(localStorage.getItem(SIGN_IN_EXPIRY_LEDGER_KEY));
  } catch {
    // Storage can be denied (private mode, sandboxed frames): start empty.
  }
  return { version: 1, harnesses: {} };
}

export function getSignInExpiryLedger(): SignInExpiryLedger {
  cache ??= readStorage();
  return cache;
}

/** Replace the whole record (the account-sync adapter writes this way). */
export function replaceSignInExpiryLedger(value: unknown): void {
  const next = sanitizeSignInExpiryLedger(value);
  if (JSON.stringify(next) === JSON.stringify(getSignInExpiryLedger())) return;
  cache = next;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(SIGN_IN_EXPIRY_LEDGER_KEY, JSON.stringify(next));
  } catch {
    // The in-memory record still applies for this page.
  }
  for (const listener of [...listeners]) listener();
}

export function markSignInExpiry(harnessId: string, expiresAt: number, alert: SignInAlertLevel, mark: SignInExpiryMark): void {
  replaceSignInExpiryLedger(withSignInExpiryMark(getSignInExpiryLedger(), harnessId, expiresAt, alert, mark));
}

function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== SIGN_IN_EXPIRY_LEDGER_KEY) return;
  cache = readStorage();
  for (const listener of [...listeners]) listener();
}

export function subscribeSignInExpiryLedger(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function useSignInExpiryLedger(): SignInExpiryLedger {
  return useSyncExternalStore(subscribeSignInExpiryLedger, getSignInExpiryLedger, getSignInExpiryLedger);
}

/** Test seam: forget the cached record so the next read hits storage. */
export function resetSignInExpiryLedgerCache(): void {
  cache = undefined;
}
