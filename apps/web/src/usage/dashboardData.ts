import type { SessionProjection } from "@polyth/contracts";
import type { QuotaSnapshotDto, QuotaWindowDto } from "../api.ts";

export type UsageRangeDays = 7 | 30 | 90;
export type UsageChartMetric = "tokens" | "cost" | "requests";

export interface UsageTrend {
  percent: number;
  direction: "up" | "down" | "flat";
}

export interface UsageProviderSummary {
  id: string;
  label: string;
  sessions: number;
  tokens: number;
  cost: number;
  trends: {
    sessions: UsageTrend | null;
    tokens: UsageTrend | null;
    cost: UsageTrend | null;
  };
  snapshot?: QuotaSnapshotDto;
  quotaWindow?: QuotaWindowDto;
  remainingPercent: number | null;
  stale: boolean;
}

export interface UsageChartSeries {
  providerId: string;
  label: string;
  values: number[];
}

export interface UsageDashboardData {
  rangeDays: UsageRangeDays;
  rangeStart: number;
  rangeEnd: number;
  totals: {
    sessions: number;
    tokens: number;
    cost: number;
    averageCostPerThousand: number;
  };
  trends: {
    sessions: UsageTrend | null;
    tokens: UsageTrend | null;
    cost: UsageTrend | null;
    averageCostPerThousand: UsageTrend | null;
  };
  providers: UsageProviderSummary[];
  chart: {
    labels: string[];
    tokens: UsageChartSeries[];
    cost: UsageChartSeries[];
    requests: UsageChartSeries[];
  };
}

const DAY_MS = 24 * 60 * 60_000;

const sessionTokens = (session: SessionProjection): number =>
  (session.tokenTotals?.input ?? 0) + (session.tokenTotals?.output ?? 0);

const canonicalProviderId = (providerId: string): string => {
  const normalized = providerId.trim().toLowerCase();
  if (normalized === "claude" || normalized === "claude-code") return "anthropic";
  if (normalized === "gemini") return "google";
  return providerId;
};

const sessionProviderId = (session: SessionProjection): string =>
  canonicalProviderId(session.model?.providerID || "Default");

const displayProvider = (providerId: string): string => {
  const normalized = providerId.trim().toLowerCase();
  const known: Record<string, string> = {
    anthropic: "Claude",
    claude: "Claude",
    "claude-code": "Claude",
    openai: "OpenAI",
    opencode: "OpenCode",
    "opencode-go": "OpenCode Go",
    "opencode-zen": "OpenCode Zen",
    openrouter: "OpenRouter",
    google: "Gemini",
    gemini: "Gemini",
    xai: "xAI",
    default: "Default",
  };
  return known[normalized] ?? providerId
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
};

const trendOf = (current: number, previous: number): UsageTrend | null => {
  if (previous <= 0) return null;
  const percent = ((current - previous) / previous) * 100;
  return {
    percent,
    direction: Math.abs(percent) < .5 ? "flat" : percent > 0 ? "up" : "down",
  };
};

const primaryQuotaWindow = (snapshot: QuotaSnapshotDto | undefined): QuotaWindowDto | undefined =>
  snapshot?.windows.reduce<QuotaWindowDto | undefined>((selected, window) => {
    if (!selected) return window;
    const selectedFraction = selected.limit > 0 ? selected.used / selected.limit : 0;
    const fraction = window.limit > 0 ? window.used / window.limit : 0;
    return fraction > selectedFraction ? window : selected;
  }, undefined);

const sumSessions = (sessions: readonly SessionProjection[]) => {
  const tokens = sessions.reduce((sum, session) => sum + sessionTokens(session), 0);
  const cost = sessions.reduce((sum, session) => sum + (session.costTotal ?? 0), 0);
  return {
    sessions: sessions.length,
    tokens,
    cost,
    averageCostPerThousand: tokens > 0 ? cost / tokens * 1_000 : 0,
  };
};

const metricValue = (session: SessionProjection, metric: UsageChartMetric): number => {
  if (metric === "tokens") return sessionTokens(session);
  if (metric === "cost") return session.costTotal ?? 0;
  return 1;
};

const shortDate = (timestamp: number): string =>
  new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(timestamp);

export function buildUsageDashboardData(
  sessions: readonly SessionProjection[],
  snapshots: readonly QuotaSnapshotDto[],
  rangeDays: UsageRangeDays,
  now = Date.now(),
): UsageDashboardData {
  const rangeEnd = now;
  const rangeStart = now - rangeDays * DAY_MS;
  const previousStart = rangeStart - rangeDays * DAY_MS;
  const current = sessions.filter((session) => session.updatedAt >= rangeStart && session.updatedAt <= rangeEnd);
  const previous = sessions.filter((session) => session.updatedAt >= previousStart && session.updatedAt < rangeStart);
  const totals = sumSessions(current);
  const previousTotals = sumSessions(previous);

  const providerIds = new Set<string>();
  for (const session of current) providerIds.add(sessionProviderId(session));
  for (const session of previous) providerIds.add(sessionProviderId(session));
  for (const snapshot of snapshots) providerIds.add(canonicalProviderId(snapshot.providerId));

  const providers = [...providerIds].map((id): UsageProviderSummary => {
    const providerCurrent = current.filter((session) => sessionProviderId(session) === id);
    const providerPrevious = previous.filter((session) => sessionProviderId(session) === id);
    const currentTotals = sumSessions(providerCurrent);
    const previousProviderTotals = sumSessions(providerPrevious);
    const snapshot = snapshots.find((item) => canonicalProviderId(item.providerId) === id);
    const quotaWindow = primaryQuotaWindow(snapshot);
    const remainingPercent = quotaWindow && quotaWindow.limit > 0
      ? Math.round(Math.max(0, 1 - Math.min(1, quotaWindow.used / quotaWindow.limit)) * 100)
      : null;
    return {
      id,
      label: displayProvider(id),
      sessions: currentTotals.sessions,
      tokens: currentTotals.tokens,
      cost: currentTotals.cost,
      trends: {
        sessions: trendOf(currentTotals.sessions, previousProviderTotals.sessions),
        tokens: trendOf(currentTotals.tokens, previousProviderTotals.tokens),
        cost: trendOf(currentTotals.cost, previousProviderTotals.cost),
      },
      ...(snapshot ? { snapshot } : {}),
      ...(quotaWindow ? { quotaWindow } : {}),
      remainingPercent,
      stale: snapshot?.stale ?? false,
    };
  }).sort((a, b) =>
    b.cost - a.cost ||
    b.tokens - a.tokens ||
    b.sessions - a.sessions ||
    a.label.localeCompare(b.label));

  const bucketCount = rangeDays === 7 ? 7 : rangeDays === 30 ? 10 : 12;
  const bucketMs = (rangeEnd - rangeStart) / bucketCount;
  const labels = Array.from({ length: bucketCount }, (_, index) =>
    shortDate(rangeStart + bucketMs * (index + 1)));

  const makeSeries = (metric: UsageChartMetric): UsageChartSeries[] =>
    providers
      .filter((provider) => current.some((session) => sessionProviderId(session) === provider.id))
      .map((provider) => {
        const values = Array.from({ length: bucketCount }, () => 0);
        for (const session of current) {
          if (sessionProviderId(session) !== provider.id) continue;
          const index = Math.min(
            bucketCount - 1,
            Math.max(0, Math.floor((session.updatedAt - rangeStart) / bucketMs)),
          );
          values[index] = (values[index] ?? 0) + metricValue(session, metric);
        }
        return { providerId: provider.id, label: provider.label, values };
      });

  return {
    rangeDays,
    rangeStart,
    rangeEnd,
    totals,
    trends: {
      sessions: trendOf(totals.sessions, previousTotals.sessions),
      tokens: trendOf(totals.tokens, previousTotals.tokens),
      cost: trendOf(totals.cost, previousTotals.cost),
      averageCostPerThousand: trendOf(
        totals.averageCostPerThousand,
        previousTotals.averageCostPerThousand,
      ),
    },
    providers,
    chart: {
      labels,
      tokens: makeSeries("tokens"),
      cost: makeSeries("cost"),
      requests: makeSeries("requests"),
    },
  };
}
