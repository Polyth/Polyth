import type { SessionProjection } from "@polyth/contracts";
import { fmtTokens } from "../../../../apps/web/src/format.ts";
import { providerUsageDistribution, providerUsageLabel } from "../usageShare.ts";
import ProviderLogo from "../../../models/widgets/ProviderLogo.tsx";
import { formatNumber, tr } from "../../../../apps/web/src/i18n/index.ts";

const PROVIDER_SHARE_COLORS = [
  "var(--accent)",
  "var(--green)",
  "var(--amber)",
  "var(--purple)",
  "var(--blue)",
  "var(--accent-hi)",
] as const;

export function sessionTokens(session: SessionProjection): number {
  const safe = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  return safe(session.tokenTotals?.input) + safe(session.tokenTotals?.output);
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
    cost: sessions.reduce((total, session) =>
      total + (typeof session.costTotal === "number" && Number.isFinite(session.costTotal)
        ? Math.max(0, session.costTotal)
        : 0), 0),
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
  const arcs = distribution.providers.filter((provider) => provider.share > 0).map((provider, index) => {
    const start = offset;
    const length = Math.min(100, Math.max(0, provider.share * 100));
    offset = Math.min(100, offset + length);
    return {
      ...provider,
      color: PROVIDER_SHARE_COLORS[index % PROVIDER_SHARE_COLORS.length]!,
      length,
      offset: start,
    };
  });
  const totalLabel = distribution.metric === "tokens"
    ? fmtTokens(distribution.total)
    : distribution.total === 1
      ? tr("usage.projectui.oneSession")
      : tr("usage.projectui.valueSessions", { count: distribution.total });

  return (
    <section className="provider-share-card" aria-labelledby="provider-share-title">
      <div>
        <div className="stat-label" id="provider-share-title">{tr("usage.projectui.usageByProvider")}</div>
        <p>{tr("usage.projectui.shareOfProject")}{" "}{distribution.metric === "tokens" ? tr("usage.projectui.tokens") : tr("usage.projectui.sessions")}.</p>
      </div>
      <div
        className="provider-share-donut"
        role="img"
        aria-label={tr("usage.projectui.providerUsageShareByValue", { metric: distribution.metric })}
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
              strokeDasharray={`${provider.length} ${100 - provider.length}`}
              strokeDashoffset={-provider.offset}
            />
          ))}
        </svg>
        <div><strong>{totalLabel}</strong><span>{tr("usage.projectui.total")}</span></div>
      </div>
      <div className="provider-share-legend">
        {arcs.map((provider) => (
          <div key={provider.providerId}>
            <ProviderLogo providerID={provider.providerId} className="provider-share-logo" />
            <i style={{ background: provider.color }} />
            <span>{providerUsageLabel(provider.providerId)}</span>
            <strong>{formatNumber(provider.share, { style: "percent", maximumFractionDigits: 0 })}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}
