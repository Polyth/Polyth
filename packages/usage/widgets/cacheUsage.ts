import { useEffect, useMemo, useState } from "react";
import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import { useStore } from "../../../apps/web/src/store.ts";
import { mergeCacheHealth, sessionCacheHealth } from "../src/analytics/cacheHealth.ts";
import { collectSessionObservations } from "../src/analytics/collect.ts";
import type { UsageCacheHealth } from "../src/analytics/contracts.ts";
import { cacheTickMs, cacheWarmthDisplay, type CacheWarmthDisplay } from "./usage/cacheWarmth.ts";

const NO_EVENTS: SessionEvent[] = [];

/** Identity of the newest usage-bearing event; streamed chunks do not change it. */
const usageTail = (events: readonly SessionEvent[]): string => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "usage/recorded" || event.type === "assistant/message") return event.id;
  }
  return "";
};

/**
 * Live cache state of one session. The loaded event tail answers the moment a
 * response lands; the analytics report contributes full-history burn and the
 * state of sessions whose events are not loaded.
 */
export function useSessionCache(
  session: SessionProjection | null,
  reported: UsageCacheHealth | undefined,
): { health: UsageCacheHealth; warmth: CacheWarmthDisplay } | null {
  const events = useStore((state) => (session ? state.events[session.id] : undefined) ?? NO_EVENTS);
  const tail = usageTail(events);
  // Re-collect only when a usage-bearing event lands, not on every chunk.
  const live = useMemo(
    () => session && tail ? sessionCacheHealth(collectSessionObservations(session, events)) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.id, session?.model?.providerID, session?.model?.modelID, session?.resolvedHarnessId, tail],
  );
  const health = mergeCacheHealth(live, reported);
  const active = session?.status === "working";
  const [now, setNow] = useState(() => Date.now());
  const tick = cacheTickMs(health, now, active);
  useEffect(() => {
    if (tick === null) return;
    const timer = setTimeout(() => setNow(Date.now()), tick);
    return () => clearTimeout(timer);
  }, [tick, now]);
  // A new response restarts the countdown from the current time.
  useEffect(() => setNow(Date.now()), [health?.lastActivityAt, active]);
  return health ? { health, warmth: cacheWarmthDisplay(health, now, active) } : null;
}
