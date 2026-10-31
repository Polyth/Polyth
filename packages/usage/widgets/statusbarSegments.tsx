// Usage's status-bar segments: the active session's context and spend, its
// prompt cache, and the tightest limit of the route it runs on. Each one is a
// mini-widget in the bar's two widget areas, so it can be hidden, reordered or
// moved to the other end like the shell's own segments. They read the same
// sources as the Usage cards (loaded event tail, limits snapshot), never a
// probe of their own, and render nothing when there is nothing to say.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import { fmtTokens } from "../../../apps/web/src/format.ts";
import { formatNumber, tr } from "../../../apps/web/src/i18n/index.ts";
import { useStore } from "../../../apps/web/src/store.ts";
import { DatabaseIcon, GaugeIcon, Icon, LayersIcon, TimerIcon } from "../../../apps/web/src/components/ui/index.ts";
import {
  defineWidgetPlugin,
  type PluginWidgetDef,
  type WidgetPlugin,
  type WidgetRenderContext,
} from "../../../apps/web/src/widgets/catalog.ts";
import { collectSessionObservations } from "../src/analytics/collect.ts";
import { useSessionCache } from "./cacheUsage.ts";
import { activeTurnStart, lastTurnStats, turnTail } from "./turnStats.ts";
import { contextGaugeDisplay, useSessionContextGauge } from "./contextUsage.ts";
import { useUsageLimits } from "./usage/limitsClient.ts";
import { useUsageLimitsPrefs } from "./usage/limitsPrefs.ts";
import { limitGroups, limitProviders, limitsWidgetPreferences, type LimitGroupView, type LimitRowView } from "./usage/limitsModel.ts";
import type { RequestedUsageView } from "./usage/viewRequest.ts";

type Translate = (key: string, values?: Record<string, string | number>) => string;
type OpenUsage = (view: RequestedUsageView) => void;

const STATUSBAR_AREAS = ["app.statusbar.leading", "app.statusbar.trailing"] as const;
const CURRENT_SOURCE = limitsWidgetPreferences({});

/** Spend at a glance: whole cents (`$1.19`), and `<$0.01` rather than a zero
 *  for a session that has cost something. The Usage card keeps four places. */
export function barCost(value: number): string {
  const money = (amount: number) => formatNumber(amount, {
    style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  return value < 0.005 ? `<${money(0.01)}` : money(value);
}

function useSession(sessionId: string | null): SessionProjection | null {
  return useStore((state) => (sessionId ? state.sessions.find((item) => item.id === sessionId) ?? null : null));
}

/** Occupancy as `73.4k (7%)`, coloured by the gauge level, then the session's
 *  reported spend. Nothing until the session has a context sample. */
export function ContextSegment({ sessionId, open }: { sessionId: string | null; open: OpenUsage }) {
  const session = useSession(sessionId);
  const gauge = useSessionContextGauge(session);
  if (!session) return null;
  const display = contextGaugeDisplay(gauge);
  const cost = typeof session.costTotal === "number" && session.costTotal > 0 ? barCost(session.costTotal) : null;
  if (display.value === "—" && !cost) return null;
  const level = gauge.known ? gauge.level : undefined;
  const label = [
    `${tr("usage.context")}: ${display.value}${display.detail ? ` (${display.detail})` : ""}`,
    cost ? `${tr("usage.cost")}: ${cost}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      className="sb sb-action usage-sb usage-sb-context"
      title={label}
      aria-label={label}
      {...(level ? { "data-level": level } : {})}
      onClick={() => open("session")}
    >
      <Icon icon={LayersIcon} size="sm" />
      {gauge.known ? (
        <span className="sb-text">
          {fmtTokens(gauge.inputTokens)} <span className="usage-sb-level">({display.value})</span>
        </span>
      ) : display.value !== "—" ? <span className="sb-text">{display.value}</span> : null}
      {cost && <span className="usage-sb-cost">{display.value === "—" ? cost : `· ${cost}`}</span>}
    </button>
  );
}

/** The prompt cache's time left (or `In use`, `Idle …`, `Expired`), with the
 *  same tones as the Usage session card. */
export function CacheSegment({ sessionId, open }: { sessionId: string | null; open: OpenUsage }) {
  const session = useSession(sessionId);
  const warmth = useSessionCache(session, undefined)?.warmth;
  if (!warmth) return null;
  const label = `${tr("usage.cacheWarmth")}: ${warmth.value} · ${warmth.detail}`;
  return (
    <button
      type="button"
      className="sb sb-action usage-sb usage-sb-cache"
      title={label}
      aria-label={label}
      data-state={warmth.state}
      {...(warmth.tone ? { "data-tone": warmth.tone } : {})}
      onClick={() => open("session")}
    >
      <Icon icon={DatabaseIcon} size="sm" />
      <span className="sb-text">{warmth.value}</span>
    </button>
  );
}

/** The current route's measurable windows, tightest first: the least share
 *  left decides, so the bar names the limit that runs out first. */
export function tightestLimit(groups: readonly LimitGroupView[]): { group: LimitGroupView; row: LimitRowView } | null {
  let best: { group: LimitGroupView; row: LimitRowView } | null = null;
  for (const group of groups) {
    for (const row of group.rows) {
      if (row.remaining === null) continue;
      if (!best || row.remaining < best.row.remaining!) best = { group, row };
    }
  }
  return best;
}

/** `Monthly 20% left` for the limit that runs out first on the session's route, coloured
 *  by the Limits bar preference (remaining share, pace or static). */
export function LimitsSegment({ sessionId, open }: { sessionId: string | null; open: OpenUsage }) {
  const session = useSession(sessionId);
  const limits = useUsageLimits();
  const limitsPrefs = useUsageLimitsPrefs();
  if (!session) return null;
  const shown = limitProviders(limits.providers, CURRENT_SOURCE, limitsPrefs, session);
  const tightest = tightestLimit(limitGroups(shown, limitsPrefs, Date.now(), { id: session.model?.modelID }));
  if (!tightest) return null;
  const { group, row } = tightest;
  const label = [
    `${group.name} · ${row.label}: ${row.value}`,
    row.reset ? tr("usage.statusbarLimitResets", { time: row.reset }) : null,
  ].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      className="sb sb-action usage-sb usage-sb-limits"
      title={label}
      aria-label={label}
      data-tone={row.bar.pressure === null ? "none" : row.bar.tone}
      onClick={() => open("limits")}
    >
      <Icon icon={GaugeIcon} size="sm" />
      <span className="sb-text">{row.label}</span>
      <span className="usage-sb-level">{row.value}</span>
    </button>
  );
}

const NO_EVENTS: SessionEvent[] = [];

/** `0:42` / `12:05` / `1:02:05` for a running clock; it reads the same in every locale. */
export function clockDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** A finished turn: `36.0 s` under a minute, the clock form above it. */
export function turnDuration(ms: number): string {
  if (ms >= 60_000) return clockDuration(ms);
  return formatNumber(ms / 1000, { style: "unit", unit: "second", unitDisplay: "narrow", minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** A ticking timer while the session runs a turn; afterwards the last turn's
 *  wall time and response speed (output tokens over model-active time). */
export function TurnSegment({ sessionId, open }: { sessionId: string | null; open: OpenUsage }) {
  const session = useSession(sessionId);
  const events = useStore((state) => (sessionId ? state.events[sessionId] : undefined) ?? NO_EVENTS);
  const tail = turnTail(events);
  const startedAt = activeTurnStart(events);
  const running = session?.status === "working" && startedAt !== null;
  // Re-collect only when a turn boundary or usage lands, not on every chunk.
  const stats = useMemo(
    () => (session && tail ? lastTurnStats(collectSessionObservations(session, events)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.id, tail],
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);
  if (!session) return null;
  if (running) {
    const label = tr("usage.statusbarTurnRunning", { duration: clockDuration(now - startedAt!) });
    return (
      <button type="button" className="sb sb-action usage-sb usage-sb-turn" data-state="running" title={label} aria-label={label} onClick={() => open("session")}>
        <Icon icon={TimerIcon} size="sm" />
        <span className="sb-text">{clockDuration(now - startedAt!)}</span>
      </button>
    );
  }
  if (!stats) return null;
  const speed = stats.tokensPerSecond === null
    ? null
    : tr("usage.statusbarTokensPerSecond", { value: formatNumber(stats.tokensPerSecond, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
  const label = [tr("usage.statusbarTurnLast", { duration: turnDuration(stats.totalMs) }), speed].filter(Boolean).join(" · ");
  return (
    <button type="button" className="sb sb-action usage-sb usage-sb-turn" data-state="done" title={label} aria-label={label} onClick={() => open("session")}>
      <Icon icon={TimerIcon} size="sm" />
      <span className="sb-text">{turnDuration(stats.totalMs)}</span>
      {speed && <span className="usage-sb-cost">· {speed}</span>}
    </button>
  );
}

export function createUsageStatusbarPlugin(translate: Translate, open: OpenUsage): WidgetPlugin {
  const segment = (
    id: string,
    order: number,
    title: string,
    description: string,
    render: (context: WidgetRenderContext) => ReactNode,
  ): PluginWidgetDef => ({
    id,
    title,
    description,
    kind: "mini-widget",
    defaultSlot: "app.statusbar.trailing",
    supportedSlots: STATUSBAR_AREAS,
    // Each segment renders nothing without a session or data, so turning the
    // bar on shows them only where they have something to say.
    defaultVisible: true,
    recommended: true,
    defaultSize: { w: 1, h: 1 },
    resizable: false,
    audience: "simple",
    category: translate("usage.name"),
    order,
    render,
  });
  return defineWidgetPlugin<WidgetPlugin>({
    id: "usage-statusbar",
    name: translate("usage.name"),
    widgets: [
      segment("usage.statusbar.context", 54, translate("usage.statusbarContextTitle"), translate("usage.statusbarContextHint"),
        ({ sessionId }) => <ContextSegment sessionId={sessionId} open={open} />),
      segment("usage.statusbar.cache", 56, translate("usage.cacheWarmth"), translate("usage.statusbarCacheHint"),
        ({ sessionId }) => <CacheSegment sessionId={sessionId} open={open} />),
      segment("usage.statusbar.turn", 53, translate("usage.statusbarTurnTitle"), translate("usage.statusbarTurnHint"),
        ({ sessionId }) => <TurnSegment sessionId={sessionId} open={open} />),
      segment("usage.statusbar.limits", 58, translate("usage.limitsWidgetTitle"), translate("usage.statusbarLimitsHint"),
        ({ sessionId }) => <LimitsSegment sessionId={sessionId} open={open} />),
    ],
  });
}
