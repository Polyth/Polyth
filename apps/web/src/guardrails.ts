// Client mirror of the signed-in account's owner-set guardrails ("Protected
// mode"). The SERVER enforces every rule; this store only lets a guarded
// account skip controls that would be refused. Hiding is never security.
//
// `null` means unrestricted — also the answer while loading and for a server
// without the feature, so an unguarded owner never sees a flash of removal.
import { useEffect, useSyncExternalStore } from "react";
import type { AccountGuardrails, AccountLimits } from "@polyth/contracts";
import { currentAccountGuardrails, currentAccountLimits } from "./accounts.ts";

let current: AccountGuardrails | null = null;
// Owner-set limits (projects, assistants, daily counts) travel with the same
// account answer; the server enforces them, this only skips refused controls.
let currentLimits: AccountLimits | null = null;
let loaded = false;
let inflight: Promise<void> | null = null;
let epoch = 0;
const listeners = new Set<() => void>();
const emit = (): void => { for (const l of listeners) l(); };

export const getGuardrails = (): AccountGuardrails | null => current;
export const getAccountLimits = (): AccountLimits | null => currentLimits;

/** Load once; later calls are no-ops until `resetGuardrails`. */
export function loadGuardrails(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (inflight) return inflight;
  const mine = epoch;
  inflight = Promise.all([currentAccountGuardrails(), currentAccountLimits()]).then(([next, limits]) => {
    if (mine !== epoch) return; // account switched mid-flight
    current = next;
    currentLimits = limits;
    loaded = true;
    emit();
  }).finally(() => { if (mine === epoch) inflight = null; });
  return inflight;
}

/** Forget the previous account's guardrails (account switch/sign-in). */
export function resetGuardrails(): void {
  epoch += 1;
  inflight = null;
  loaded = false;
  const had = current !== null || currentLimits !== null;
  current = null;
  currentLimits = null;
  if (had) emit();
  if (listeners.size > 0) void loadGuardrails(); // mounted consumers must not stay on the old answer
}

export function useGuardrails(): AccountGuardrails | null {
  useEffect(() => { void loadGuardrails(); }, []);
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    getGuardrails,
    getGuardrails,
  );
}

export function useAccountLimits(): AccountLimits | null {
  useEffect(() => { void loadGuardrails(); }, []);
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    getAccountLimits,
    getAccountLimits,
  );
}

// ---------------------------------------------------------------- predicates

/** Composer `!` shell and Auto-Approve are refused for any guarded account. */
export const guardedShellAllowed = (g: AccountGuardrails | null): boolean => g === null;
export const guardedAutoApproveAllowed = (g: AccountGuardrails | null): boolean => g === null;
/** Adding projects and browsing server folders. */
export const guardedProjectAddAllowed = (g: AccountGuardrails | null): boolean => g === null;
/** An owner-set project list also rules out adding projects. */
export const limitedProjectAddAllowed = (limits: AccountLimits | null): boolean => !limits?.projects;
/** Permission card: whether she may answer "Allow" (once); never "always". */
export const guardedMayAllow = (g: AccountGuardrails | null): boolean => g === null || g.approvals === "once";
export const guardedMayAlways = (g: AccountGuardrails | null): boolean => g === null;
/** The model switcher only matters when there is a real choice. */
export const guardedModelSwitcherVisible = (g: AccountGuardrails | null): boolean =>
  g === null || g.models.length > 1;

/** Settings pages whose server routes a guarded account cannot reach. */
const GUARDED_HIDDEN_SETTINGS_PAGES: ReadonlySet<string> = new Set([
  "harnesses", "models", "providers", "packages", "plugins", "users", "tunnel",
  "mcp", "ssh", "secure-safe", "integrations", "desktop", "monitoring", "task-trackers",
  "home-assistant", "permissions",
]);
export const guardedSettingsPageVisible = (g: AccountGuardrails | null, pageId: string): boolean =>
  g === null || !GUARDED_HIDDEN_SETTINGS_PAGES.has(pageId);

/** Test seam. */
export function __setGuardrailsForTest(next: AccountGuardrails | null, isLoaded = true, limits: AccountLimits | null = null): void {
  epoch += 1; inflight = null; current = next; currentLimits = limits; loaded = isLoaded; emit();
}
