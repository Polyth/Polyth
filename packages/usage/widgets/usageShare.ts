import type { SessionProjection } from "@polyth/contracts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

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

export function providerUsageLabel(providerId: string): string {
  return providerId === "Default" ? tr("composer.default") : providerId;
}

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
    current.cost += finiteNonNegative(session.costTotal);
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
