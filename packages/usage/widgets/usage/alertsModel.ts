// Usage notifications: pure rules over the Limits snapshot, the per-turn usage
// and a session's cache health. Nothing here talks to the network, the store
// or the notification stack; `alertsController.ts` feeds it and shows what it
// returns. The ledger is what makes every alert fire once per limit period.
import type { QuotaPace, QuotaWindow, TokenUsage } from "@polyth/contracts";
import { fmtCost, fmtTokens } from "../../../../apps/web/src/format.ts";
import { getLocale, tr } from "../../../../apps/web/src/i18n/index.ts";
import { cacheCountdown } from "../../src/analytics/cacheHealth.ts";
import type { UsageCacheHealth } from "../../src/analytics/contracts.ts";
import type { UsageLimitSnapshotDto } from "./limitsClient.ts";
import {
  classifyLimitPace,
  formatLimitReset,
  limitSourceName,
  relativeTime,
  remainingFraction,
  splitWindowLabel,
  windowAppliesToModel,
} from "./limitsModel.ts";
import { currentLimitSources, type LimitsSession } from "../../src/limitSources.ts";
import {
  LEDGER_RETENTION_MS,
  startsNewPeriod,
  type AlertWindowMemo,
  type UsageAlertLedger,
} from "../../src/alertLedger.ts";
import { isLimitSourceVisible, type UsageLimitsPrefs } from "./limitsPrefs.ts";
import { alertsPaused, isAlertSourceMuted, type UsageAlertPrefs } from "./alertsPrefs.ts";
import { cacheDuration } from "./cacheWarmth.ts";

export { emptyAlertLedger, parseAlertLedger, type UsageAlertLedger } from "../../src/alertLedger.ts";

export type UsageAlertRule = "pace" | "low" | "exhausted" | "restored" | "source" | "summary";
export type UsageAlertKind = "warning" | "error" | "success" | "info" | "hint";

export interface UsageAlert {
  /** Stable notification id: a newer alert for the same limit replaces it. */
  id: string;
  rule: UsageAlertRule;
  kind: UsageAlertKind;
  title: string;
  body: string;
  providerId?: string;
  /** Higher is more urgent; orders a burst. */
  severity: number;
}

type WindowMemo = AlertWindowMemo;

/** One burst never shows more than this many separate limit alerts. */
export const MAX_ALERTS_PER_BURST = 3;

const PACE_RANK = { elevated: 1, likely: 2 } as const;

const AUTH_CODES = new Set(["unauthorized", "forbidden", "invalid_api_key"]);

/** A rejected key is a fixable problem, but not a signed-out account. Only a
 * message that names a key counts: an expired sign-in token is not one. */
const KEY_REJECTED = /invalid api key|api_key_expired|\b(?:expired|revoked|rejected)\b.*\bkey\b|\bkey\b.*\b(?:expired|revoked|rejected)\b/i;

/** Codes that are not a problem for the person: no reading yet, or a harness
 * login whose short-lived token the harness renews on its next run. */
const NOT_A_PROBLEM = new Set(["never-fetched", "not-refreshed", "login-renewing"]);

/** The problem a source reports that a person can fix, or null. */
export function sourceProblem(provider: Pick<UsageLimitSnapshotDto, "error">): "sign-in" | "key" | null {
  const error = provider.error;
  if (!error || NOT_A_PROBLEM.has(error.code)) return null;
  if (KEY_REJECTED.test(error.message)) return "key";
  return AUTH_CODES.has(error.code) || /auth|sign.?in|credential|token/i.test(error.message) ? "sign-in" : null;
}

/** `Claude 5-hour`, or the source alone when the window label repeats it. */
export function limitName(provider: UsageLimitSnapshotDto, window: Pick<QuotaWindow, "label">): string {
  const source = limitSourceName(provider);
  const label = splitWindowLabel(window.label).label;
  return label.toLowerCase().startsWith(source.toLowerCase()) ? label : `${source} ${label}`;
}

const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

const sentence = (...parts: Array<string | null | undefined>): string => {
  // Chinese runs sentences together with a full-width stop and no space.
  const zh = getLocale().startsWith("zh");
  return parts.filter(Boolean).map((part) => /[.!?。！？]$/.test(part!) ? part : `${part}${zh ? "。" : "."}`).join(zh ? "" : " ");
};

const resetText = (window: QuotaWindow, limits: UsageLimitsPrefs, now: number): string | null => {
  const reset = formatLimitReset(window.resetsAt, limits.resetFormat, now);
  return reset ? tr(limits.resetFormat === "exact" ? "usage.notiResetsOn" : "usage.limitResetsWhen", { when: reset }) : null;
};

const paceForecast = (
  pace: QuotaPace | null | undefined,
  window: QuotaWindow,
  now: number,
): string | null => {
  if (!pace) return null;
  if (pace.exhaustsAt !== undefined && window.resetsAt !== undefined && pace.exhaustsAt < window.resetsAt) {
    return tr("usage.notiForecastRunsOut", { when: relativeTime(pace.exhaustsAt, now) });
  }
  if (pace.predictedAtReset !== undefined && window.limit > 0) {
    const left = Math.max(0, 1 - pace.predictedAtReset / window.limit);
    return tr("usage.notiForecastLeftAtReset", { percent: percent(left) });
  }
  return tr("usage.notiForecastUsedInPeriod", { used: percent(pace.usageFraction), elapsed: percent(pace.timeFraction) });
};

export interface EvaluateLimitAlertsInput {
  providers: readonly UsageLimitSnapshotDto[];
  prefs: UsageAlertPrefs;
  limits: UsageLimitsPrefs;
  ledger: UsageAlertLedger;
  now: number;
}

/**
 * Limit alerts due now, and the ledger that remembers them. A rule that is off
 * or paused does not mark its alert as shown, so turning it on later (or the
 * pause ending) still reports a limit that is low at that moment; the period
 * tracking itself always advances.
 */
export function evaluateLimitAlerts({ providers, prefs, limits, ledger, now }: EvaluateLimitAlertsInput): {
  alerts: UsageAlert[];
  ledger: UsageAlertLedger;
} {
  const active = prefs.enabled && !alertsPaused(prefs, now);
  const windows: Record<string, WindowMemo> = {};
  const sources: Record<string, string> = {};
  const alerts: UsageAlert[] = [];
  const lowLevels = [...prefs.lowLevels].sort((a, b) => a - b);

  for (const provider of providers) {
    const watched = isLimitSourceVisible(provider.providerId, limits) && !isAlertSourceMuted(provider.providerId, prefs);
    const problem = sourceProblem(provider);
    const announced = ledger.sources[provider.providerId];
    if (problem) {
      if (announced === problem || !(active && watched && prefs.sourceProblems)) {
        if (announced) sources[provider.providerId] = announced;
      } else {
        sources[provider.providerId] = problem;
        const name = limitSourceName(provider);
        alerts.push({
          id: `source:${provider.providerId}`,
          rule: "source",
          kind: "warning",
          title: tr(problem === "key" ? "usage.notiKeyTitle" : "usage.notiSignInTitle", { name }),
          body: tr(problem === "key" ? "usage.notiKeyBody" : "usage.notiSignInBody"),
          providerId: provider.providerId,
          severity: 1,
        });
      }
    }

    for (const window of provider.windows) {
      const remaining = remainingFraction(window);
      if (remaining === null) continue;
      const key = `${provider.providerId}/${window.id}`;
      const previous = ledger.windows[key];
      const newPeriod = previous !== undefined && startsNewPeriod(previous, { resetsAt: window.resetsAt, remaining }, now);
      const memo: WindowMemo = newPeriod || !previous
        ? { remaining, at: now, ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}) }
        : { ...previous, remaining, at: now, ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}) };
      windows[key] = memo;
      if (!active || !watched) continue;

      const name = limitName(provider, window);
      const reset = resetText(window, limits, now);
      const id = `limit:${key}`;

      if (newPeriod && previous?.exhausted && prefs.restored && remaining > 0) {
        alerts.push({
          id,
          rule: "restored",
          kind: "success",
          title: tr("usage.notiRestoredTitle", { name }),
          body: sentence(tr("usage.notiPercentLeft", { percent: percent(remaining) })),
          providerId: provider.providerId,
          severity: 2,
        });
        continue;
      }

      if (remaining <= 0) {
        if (prefs.exhausted && !memo.exhausted) {
          memo.exhausted = true;
          memo.low = lowLevels[0] ?? 0;
          memo.pace = PACE_RANK.likely;
          alerts.push({
            id,
            rule: "exhausted",
            kind: "error",
            title: tr(/\blimit$/i.test(name) ? "usage.notiReachedTitle" : "usage.notiLimitReachedTitle", { name }),
            body: sentence(reset ?? tr("usage.notiNoResetTime"), tr("usage.notiSessionsMayPause")),
            providerId: provider.providerId,
            severity: 5,
          });
          continue;
        }
      }

      const pace = provider.pace?.[window.id];
      const state = classifyLimitPace(pace, window, limits.paceSensitivity);
      const paceRank = state === "likely" ? PACE_RANK.likely : state === "elevated" && prefs.paceLevel === "elevated" ? PACE_RANK.elevated : 0;
      const remainingPercent = Math.round(remaining * 100);
      const level = lowLevels.find((candidate) => remainingPercent <= candidate);

      if (prefs.low && level !== undefined && (memo.low === undefined || level < memo.low)) {
        memo.low = level;
        // One alert per limit: the low warning carries the pace forecast too.
        if (prefs.pace && paceRank > (memo.pace ?? 0)) memo.pace = paceRank;
        alerts.push({
          id,
          rule: "low",
          kind: "warning",
          title: tr("usage.notiLowTitle", { name, percent: percent(remaining) }),
          body: sentence(reset, prefs.pace && state === "likely" ? paceForecast(pace, window, now) : null),
          providerId: provider.providerId,
          severity: 3 + (level <= 10 ? 1 : 0),
        });
        continue;
      }

      if (prefs.pace && paceRank > (memo.pace ?? 0) && remaining > 0) {
        memo.pace = paceRank;
        alerts.push({
          id,
          rule: "pace",
          kind: "warning",
          title: tr(paceRank === PACE_RANK.likely ? "usage.notiMayRunOutTitle" : "usage.notiRunningFastTitle", { name }),
          body: sentence(tr("usage.notiPercentLeft", { percent: percent(remaining) }), paceForecast(pace, window, now), reset),
          providerId: provider.providerId,
          severity: paceRank === PACE_RANK.likely ? 3 : 2,
        });
      }
    }
  }

  // Keep memos for limits not in this snapshot (a failed poll, a hidden source)
  // so they do not re-alert when they come back.
  for (const [key, memo] of Object.entries(ledger.windows)) {
    if (!(key in windows) && now - memo.at < LEDGER_RETENTION_MS) windows[key] = memo;
  }
  for (const [key, problem] of Object.entries(ledger.sources)) {
    if (!(key in sources) && !providers.some((provider) => provider.providerId === key)) sources[key] = problem;
  }
  return { alerts: alerts.sort((a, b) => b.severity - a.severity), ledger: { version: 1, windows, sources, at: now } };
}

/**
 * At most {@link MAX_ALERTS_PER_BURST} cards: past that, the most urgent ones
 * and a single summary of the rest, so a first load never floods the stack.
 */
export function collapseAlertBurst(alerts: readonly UsageAlert[]): UsageAlert[] {
  if (alerts.length <= MAX_ALERTS_PER_BURST) return [...alerts];
  const shown = alerts.slice(0, MAX_ALERTS_PER_BURST - 1);
  const rest = alerts.slice(MAX_ALERTS_PER_BURST - 1);
  return [
    ...shown,
    {
      id: "limit:burst",
      rule: rest[0]!.rule,
      kind: rest.some((alert) => alert.kind === "error") ? "error" : "warning",
      title: tr(new Intl.PluralRules(getLocale()).select(rest.length) === "one" ? "usage.notiBurstOne" : "usage.notiBurstOther", { count: rest.length }),
      body: rest.map((alert) => alert.title).join(" · "),
      severity: rest[0]!.severity,
    },
  ];
}

// ---- After each turn --------------------------------------------------------

export interface TurnUsage {
  tokens: number;
  cacheRead: number;
  cost: number | null;
  /** False when no usage was reported for the turn. */
  reported: boolean;
}

export const emptyTurnUsage = (): TurnUsage => ({ tokens: 0, cacheRead: 0, cost: null, reported: false });

/** Adds one `usage/recorded` payload; totals follow the dashboard (input + output + cache). */
export function addTurnUsage(total: TurnUsage, tokens: TokenUsage, cost: number | undefined): TurnUsage {
  const cacheRead = tokens.cacheRead ?? 0;
  const sum = tokens.input + tokens.output + cacheRead + (tokens.cacheWrite ?? 0);
  return {
    tokens: total.tokens + (Number.isFinite(sum) ? sum : 0),
    cacheRead: total.cacheRead + (Number.isFinite(cacheRead) ? cacheRead : 0),
    cost: typeof cost === "number" && Number.isFinite(cost) ? (total.cost ?? 0) + cost : total.cost,
    reported: true,
  };
}

/** Remaining fraction per `<source>/<window>` key, for before/after deltas. */
export function remainingByWindow(providers: readonly UsageLimitSnapshotDto[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const provider of providers) {
    for (const window of provider.windows) {
      const remaining = remainingFraction(window);
      if (remaining !== null) map.set(`${provider.providerId}/${window.id}`, remaining);
    }
  }
  return map;
}

export interface TurnSummaryInput {
  usage: TurnUsage;
  session: LimitsSession & { title?: string };
  /** Name the chat in the summary (it may not be the one on screen). */
  named: boolean;
  providers: readonly UsageLimitSnapshotDto[];
  before: ReadonlyMap<string, number>;
  prefs: UsageAlertPrefs;
}

/** Limit windows the turn ran against, most constrained first. */
function turnLimits(input: TurnSummaryInput): string[] {
  const ids = currentLimitSources(input.session, input.providers);
  const rows: Array<{ text: string; remaining: number }> = [];
  for (const provider of input.providers) {
    if (!ids.includes(provider.providerId)) continue;
    for (const window of provider.windows) {
      if (!windowAppliesToModel(window.id, input.session.model?.modelID)) continue;
      const remaining = remainingFraction(window);
      if (remaining === null) continue;
      const before = input.before.get(`${provider.providerId}/${window.id}`);
      const drop = before === undefined ? 0 : Math.round((before - remaining) * 100);
      rows.push({
        text: tr(drop >= 1 ? "usage.notiLimitLeftDrop" : "usage.notiLimitLeft", { name: limitName(provider, window), percent: percent(remaining), drop }),
        remaining,
      });
    }
  }
  return rows.sort((a, b) => a.remaining - b.remaining).slice(0, 2).map((row) => row.text);
}

/**
 * The passing notice after a turn, or null when the turn is under the size
 * threshold or there is nothing to say.
 */
export function turnSummary(input: TurnSummaryInput): { title: string; body: string } | null {
  const { usage, prefs } = input;
  if (prefs.turnMinTokens > 0 && (!usage.reported || usage.tokens < prefs.turnMinTokens)) return null;
  const show = new Set(prefs.turnParts);
  const head: string[] = [];
  if (show.has("tokens") && usage.reported) head.push(tr("usage.notiTokens", { tokens: fmtTokens(usage.tokens) }));
  if (show.has("cost") && usage.cost !== null) head.push(fmtCost(usage.cost));
  const detail: string[] = [];
  if (show.has("tokens") && usage.reported && usage.cacheRead > 0 && usage.tokens > 0) {
    detail.push(tr("usage.notiFromCache", { percent: Math.round(usage.cacheRead / usage.tokens * 100) }));
  }
  const limits = show.has("limits") ? turnLimits(input) : [];
  if (head.length === 0 && limits.length === 0) return null;
  const chat = input.named && input.session.title?.trim() ? input.session.title.trim() : null;
  const title = head.length > 0 ? tr("usage.notiTurnUsed", { usage: head.join(" · ") }) : tr("usage.notiTurnFinished");
  const body = [chat, ...detail, ...limits].filter(Boolean).join(" · ");
  return { title, body };
}

// ---- Prompt cache ------------------------------------------------------------

/** A prefix this small is cheap to re-write; its expiry is not worth a notice. */
export const MIN_CACHE_ALERT_TOKENS = 10_000;

/**
 * When to warn that a session's cache is about to lapse: `leadMs` before the
 * known lifetime ends, never for an unknown lifetime, a small prefix or one
 * already expired.
 */
export function cacheAlertAt(health: UsageCacheHealth | null, leadMs: number, now: number): number | null {
  if (!health || health.ttlMs === null || health.cachedTokens < MIN_CACHE_ALERT_TOKENS) return null;
  const countdown = cacheCountdown(health, now);
  if (countdown.state === "expired" || countdown.remainingMs === null) return null;
  if (health.ttlMs <= leadMs) return null;
  return health.lastActivityAt + health.ttlMs - leadMs;
}

export function cacheAlert(
  health: UsageCacheHealth,
  sessionTitle: string | undefined,
  now: number,
): { title: string; body: string } {
  const remaining = cacheCountdown(health, now).remainingMs ?? 0;
  const chat = sessionTitle?.trim();
  const tokens = fmtTokens(health.cachedTokens);
  return {
    title: tr("usage.notiCacheTitle", { duration: cacheDuration(remaining, true) }),
    body: chat ? tr("usage.notiCacheBodyChat", { chat, tokens }) : tr("usage.notiCacheBodyNoChat", { tokens }),
  };
}
