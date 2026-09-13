import type { SessionProjection } from "@polyth/contracts";
import { resolveSessionUsageProviderId } from "./providerIdentity.ts";

export { providerUsageLabel } from "./providerIdentity.ts";

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

const finiteNonNegative = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

const sessionTokens = (session: SessionProjection): number =>
  finiteNonNegative(session.tokenTotals?.input) + finiteNonNegative(session.tokenTotals?.output);

/** Project usage grouped by the provider that actually served each session. */
export function providerUsageDistribution(
  sessions: readonly SessionProjection[],
): ProviderUsageDistribution {
  const grouped = new Map<string, Omit<ProviderUsageShare, "share">>();
  let attributedSessions = 0;
  for (const session of sessions) {
    const providerId = resolveSessionUsageProviderId(session);
    if (!providerId) continue;
    attributedSessions += 1;
    const current = grouped.get(providerId) ?? {
      providerId,
      sessions: 0,
      tokens: 0,
      cost: 0,
    };
    current.sessions += 1;
    current.tokens += sessionTokens(session);
    current.cost += finiteNonNegative(session.costTotal);
    grouped.set(providerId, current);
  }

  const totalTokens = [...grouped.values()].reduce((sum, provider) => sum + provider.tokens, 0);
  const metric = totalTokens > 0 ? "tokens" : "sessions";
  const total = metric === "tokens" ? totalTokens : attributedSessions;
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
