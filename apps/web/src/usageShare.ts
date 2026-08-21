import type { SessionProjection } from "@polyth/contracts";

export interface ProviderUsageShare {
  providerId: string;
  sessions: number;
  tokens: number;
  cost: number;
  share: number;
}

export interface ProviderUsageDistribution {
  metric: "tokens" | "sessions";
  total: number;
  providers: ProviderUsageShare[];
}

const sessionTokens = (session: SessionProjection): number =>
  (session.tokenTotals?.input ?? 0) + (session.tokenTotals?.output ?? 0);

/** Project usage grouped by the provider recorded on each session. Sessions
 * without an explicit model stay visible as the human-facing Default group. */
export function providerUsageDistribution(
  sessions: readonly SessionProjection[],
): ProviderUsageDistribution {
  const grouped = new Map<string, Omit<ProviderUsageShare, "share">>();
  for (const session of sessions) {
    const providerId = session.model?.providerID || "Default";
    const current = grouped.get(providerId) ?? {
      providerId,
      sessions: 0,
      tokens: 0,
      cost: 0,
    };
    current.sessions += 1;
    current.tokens += sessionTokens(session);
    current.cost += session.costTotal ?? 0;
    grouped.set(providerId, current);
  }

  const totalTokens = [...grouped.values()].reduce((sum, provider) => sum + provider.tokens, 0);
  const metric = totalTokens > 0 ? "tokens" : "sessions";
  const total = metric === "tokens" ? totalTokens : sessions.length;
  const providers = [...grouped.values()]
    .map((provider): ProviderUsageShare => ({
      ...provider,
      share: total > 0
        ? (metric === "tokens" ? provider.tokens : provider.sessions) / total
        : 0,
    }))
    .sort((a, b) => b.share - a.share || a.providerId.localeCompare(b.providerId));

  return { metric, total, providers };
}
