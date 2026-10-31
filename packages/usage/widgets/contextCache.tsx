import { useCallback, useEffect, useState } from "react";
import { sessionFetch } from "@polyth/session/web-api";
import { useStore } from "../../../apps/web/src/store.ts";
import { formatDate, tr } from "../../../apps/web/src/i18n/index.ts";
import { Button } from "../../../apps/web/src/components/ui/index.ts";
import { estimateKeepAlives, KEEP_WARM_PERIODS, type KeepWarmStatus } from "../src/keepWarm.ts";
import { useSessionCache } from "./cacheUsage.ts";
import { cacheDuration } from "./usage/cacheWarmth.ts";

const STATUS_POLL_MS = 15_000;

const stoppedLabel = (status: KeepWarmStatus): string | null => {
  const reason = status.stopped?.reason;
  if (!reason || reason === "cancelled") return null;
  if (reason === "period-ended") return tr("usage.keepWarmEnded");
  if (reason === "miss") return tr("usage.keepWarmMissed");
  if (reason === "no-cache" || reason === "unknown-ttl") return tr("usage.keepWarmUnavailable");
  return tr("usage.keepWarmFailed");
};

/** Keep-warm status of one chat, refreshed while the card is open. */
function useKeepWarm(sessionId: string | null) {
  const [status, setStatus] = useState<KeepWarmStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!sessionId) return;
    const next = await sessionFetch<KeepWarmStatus>(`/api/usage/keep-warm?sessionId=${encodeURIComponent(sessionId)}`, signal ? { signal } : undefined);
    if (!signal?.aborted) setStatus(next);
  }, [sessionId]);
  useEffect(() => {
    setStatus(null);
    setError(null);
    const controller = new AbortController();
    void load(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    if (!status?.active) return;
    const timer = setInterval(() => { void load().catch(() => {}); }, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [status?.active, load]);
  const set = async (minutes: number) => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await sessionFetch<KeepWarmStatus>("/api/usage/keep-warm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, minutes }),
      }));
    } catch {
      setError(tr("usage.keepWarmError"));
      void load().catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  return { status, busy, error, set };
}

/** Cache warmth inside the composer's context card: the same countdown and
 *  re-write warning as the Usage session card, from the loaded event tail,
 *  and a way to keep the cache warm for a chosen period. */
export function ContextCacheLine({ sessionId }: { sessionId: string | null }) {
  const session = useStore((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const cache = useSessionCache(session, undefined);
  const keepWarm = useKeepWarm(cache ? sessionId : null);
  if (!cache) return null;
  const { warmth, health } = cache;
  const status = keepWarm.status;
  const now = Date.now();
  const canKeepWarm = health.ttlMs !== null;
  const stopped = status && !status.active ? stoppedLabel(status) : null;
  return (
    <div className="usage-context-cache" data-tone={warmth.tone}>
      <span>{tr("usage.cacheWarmth")}</span>
      <strong>{warmth.value}</strong>
      <small>{warmth.detail}</small>
      <div className="usage-keep-warm" data-active={status?.active ? "true" : undefined}>
        <span className="usage-keep-warm-label" title={tr("usage.keepWarmHint")}>{tr("usage.keepWarm")}</span>
        {status?.active ? (
          <>
            <span className="usage-keep-warm-state">
              {status.cold
                ? tr("usage.keepWarmCold")
                : tr("usage.keepWarmActive", {
                  time: formatDate(status.until ?? now, { hour: "2-digit", minute: "2-digit" }),
                  count: status.sent ?? 0,
                })}
            </span>
            <Button type="button" size="sm" variant="ghost" busy={keepWarm.busy} onClick={() => { void keepWarm.set(0); }}>
              {tr("usage.keepWarmStop")}
            </Button>
          </>
        ) : canKeepWarm ? (
          <div className="usage-keep-warm-periods" role="group" aria-label={tr("usage.keepWarm")}>
            {KEEP_WARM_PERIODS.map((minutes) => {
              const estimate = estimateKeepAlives(health, now + minutes * 60_000, now);
              const label = cacheDuration(minutes * 60_000);
              const hint = estimate === null ? label : `${label} · ${tr("usage.keepWarmEstimate", { count: estimate })}`;
              return (
                <Button
                  key={minutes}
                  type="button"
                  size="sm"
                  variant="ghost"
                  title={hint}
                  aria-label={`${tr("usage.keepWarm")} ${hint}`}
                  disabled={keepWarm.busy}
                  onClick={() => { void keepWarm.set(minutes); }}
                >
                  {label}
                </Button>
              );
            })}
          </div>
        ) : (
          <span className="usage-keep-warm-state">{tr("usage.keepWarmUnavailable")}</span>
        )}
        {(keepWarm.error ?? stopped) && <small className="usage-keep-warm-note">{keepWarm.error ?? stopped}</small>}
      </div>
    </div>
  );
}
