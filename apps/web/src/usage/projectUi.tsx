import type { SessionProjection } from "@polyth/contracts";
import { fmtTokens } from "../format.ts";
import { providerUsageDistribution } from "../usageShare.ts";

const PROVIDER_SHARE_COLORS = [
  "var(--accent)",
  "var(--green)",
  "var(--amber)",
  "#c4a7ee",
  "#64b5f6",
  "#f49b5b",
] as const;

export function sessionTokens(session: SessionProjection): number {
  return (session.tokenTotals?.input ?? 0) + (session.tokenTotals?.output ?? 0);
}

export interface ProjectUsageStats {
  sessions: number;
  tokens: number;
  cost: number;
}

export function projectUsageStats(sessions: readonly SessionProjection[]): ProjectUsageStats {
  return {
    sessions: sessions.length,
    tokens: sessions.reduce((total, session) => total + sessionTokens(session), 0),
    cost: sessions.reduce((total, session) => total + (session.costTotal ?? 0), 0),
  };
}

export type SessionUsageSort = "cost" | "tokens";

export function topProjectSessions(
  sessions: readonly SessionProjection[],
  sort: SessionUsageSort = "cost",
  limit = 8,
): SessionProjection[] {
  return [...sessions]
    .sort((a, b) => sort === "tokens"
      ? sessionTokens(b) - sessionTokens(a) || (b.costTotal ?? 0) - (a.costTotal ?? 0)
      : (b.costTotal ?? 0) - (a.costTotal ?? 0) || sessionTokens(b) - sessionTokens(a))
    .slice(0, limit);
}

export function ProviderUsageDonut({ sessions }: { sessions: readonly SessionProjection[] }) {
  const distribution = providerUsageDistribution(sessions);
  let offset = 0;
  const arcs = distribution.providers.map((provider, index) => {
    const start = offset;
    offset += provider.share * 100;
    return {
      ...provider,
      color: PROVIDER_SHARE_COLORS[index % PROVIDER_SHARE_COLORS.length]!,
      offset: start,
    };
  });
  const totalLabel = distribution.metric === "tokens"
    ? fmtTokens(distribution.total)
    : `${distribution.total} session${distribution.total === 1 ? "" : "s"}`;

  return (
    <section className="provider-share-card" aria-labelledby="provider-share-title">
      <div>
        <div className="stat-label" id="provider-share-title">Usage by provider</div>
        <p>Share of project {distribution.metric === "tokens" ? "tokens" : "sessions"}.</p>
      </div>
      <div
        className="provider-share-donut"
        role="img"
        aria-label={`Provider usage share by ${distribution.metric}`}
      >
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle className="provider-share-track" cx="60" cy="60" r="44" pathLength="100" />
          {arcs.map((provider) => (
            <circle
              key={provider.providerId}
              className="provider-share-arc"
              cx="60"
              cy="60"
              r="44"
              pathLength="100"
              stroke={provider.color}
              strokeDasharray={`${provider.share * 100} ${100 - provider.share * 100}`}
              strokeDashoffset={-provider.offset}
            />
          ))}
        </svg>
        <div><strong>{totalLabel}</strong><span>total</span></div>
      </div>
      <div className="provider-share-legend">
        {arcs.map((provider) => (
          <div key={provider.providerId}>
            <i style={{ background: provider.color }} />
            <span>{provider.providerId}</span>
            <strong>{Math.round(provider.share * 100)}%</strong>
          </div>
        ))}
      </div>
    </section>
  );
}
