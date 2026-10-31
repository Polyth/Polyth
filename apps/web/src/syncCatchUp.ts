// Catch-up presentation after the link to the server breaks (a phone back from
// the background, a Link stall). What the client holds stays on screen and
// interactive the whole time — nothing is blanked or blocked. The shell only
// stops presenting it as current: a quiet "Updating…" after a short delay, so a
// quick reconnect shows nothing at all, and transport errors raised while the
// system is still healing itself are held back instead of shouted.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { SyncFreshness, SyncStatus } from "./sync.ts";
import { getSyncFreshness, getSyncStatus, subscribeSyncFreshness, subscribeSyncStatus } from "./init.ts";
import { presentUiError } from "./errorPresentation.ts";
import { isMutationOutcomeUnknownMessage } from "./settings.ts";

/** A catch-up shorter than this is never announced: it would read as flicker. */
export const CATCH_UP_INDICATOR_DELAY_MS = 700;
/** How long the system gets to heal before a transport error is shown. */
export const CATCH_UP_ERROR_GRACE_MS = 20_000;

export type CatchUpIndicator = "hidden" | "updating" | "reconnecting";

export interface CatchUpView {
  /** Everything on screen is confirmed current by the server. */
  fresh: boolean;
  indicator: CatchUpIndicator;
  /** Transport errors are expected while healing; keep them out of sight. */
  holdNetworkErrors: boolean;
}

export function isFresh(freshness: SyncFreshness): boolean {
  return freshness.session && freshness.sessions;
}

/** Pure decision. `staleSince` counts from when the person could first see the
 *  stale state (foreground), never from when a backgrounded app went quiet. */
export function catchUpView(input: {
  freshness: SyncFreshness;
  status: SyncStatus;
  staleSince: number | null;
  now: number;
}): CatchUpView {
  const fresh = isFresh(input.freshness);
  if (fresh || input.staleSince === null || input.status === "suspended") {
    return { fresh, indicator: "hidden", holdNetworkErrors: !fresh && input.status === "suspended" };
  }
  const elapsed = input.now - input.staleSince;
  const indicator: CatchUpIndicator = elapsed < CATCH_UP_INDICATOR_DELAY_MS
    ? "hidden"
    : input.status === "connected" ? "updating" : "reconnecting";
  return { fresh, indicator, holdNetworkErrors: elapsed < CATCH_UP_ERROR_GRACE_MS };
}

/** Only connection-loss reads are held. A write whose outcome is unknown must
 *  always surface: hiding it could let someone believe it went through. */
export function isHoldableNetworkError(message: string): boolean {
  if (isMutationOutcomeUnknownMessage(message)) return false;
  return presentUiError(message).category === "network";
}

const foregroundNow = (): boolean => typeof document === "undefined" || document.visibilityState !== "hidden";

export function useSyncCatchUp(): CatchUpView {
  const freshness = useSyncExternalStore(subscribeSyncFreshness, getSyncFreshness, getSyncFreshness);
  const status = useSyncExternalStore(subscribeSyncStatus, getSyncStatus, (): SyncStatus => "disconnected");
  const fresh = isFresh(freshness);
  const [staleSince, setStaleSince] = useState<number | null>(() => (fresh ? null : Date.now()));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (fresh) {
      setStaleSince(null);
      return;
    }
    const start = () => { if (foregroundNow()) setStaleSince((value) => value ?? Date.now()); };
    // Going to the background resets the clock: the delay and the grace both
    // restart from the moment the person is looking again.
    const onVisibility = () => {
      if (foregroundNow()) setStaleSince(Date.now());
      else setStaleSince(null);
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [fresh]);

  // Re-render exactly at the two thresholds; no polling.
  useEffect(() => {
    if (staleSince === null) return;
    const timers = [CATCH_UP_INDICATOR_DELAY_MS, CATCH_UP_ERROR_GRACE_MS]
      .map((at) => staleSince + at - Date.now())
      .filter((wait) => wait > 0)
      .map((wait) => setTimeout(() => setNow(Date.now()), wait + 1));
    setNow(Date.now());
    return () => { for (const timer of timers) clearTimeout(timer); };
  }, [staleSince]);

  return catchUpView({ freshness, status, staleSince, now });
}
