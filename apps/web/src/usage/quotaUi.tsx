import { useCallback, useEffect, useState } from "react";
import {
  api,
  type QuotaPaceDto,
  type QuotaSnapshotDto,
  type QuotaWindowDto,
} from "../api.ts";
import { fmtTokens } from "../format.ts";
import {
  groupQuotaWindows,
  setGroupCollapsed,
  useUsagePrefs,
} from "../usagePrefs.ts";
import ProviderLogo from "../components/ProviderLogo.tsx";

export function fmtQuota(n: number, unit: QuotaWindowDto["unit"]): string {
  if (unit === "currency") return `$${n.toFixed(2)}`;
  if (unit === "percent") return `${Math.round(n)}%`;
  if (unit === "tokens") return fmtTokens(n);
  return String(Math.round(n));
}

export function paceText(pace: QuotaPaceDto | null, win: QuotaWindowDto): string {
  if (!pace) return "";
  const bits: string[] = [
    `${Math.round(pace.usageFraction * 100)}% used, ${Math.round(pace.timeFraction * 100)}% of window elapsed (${pace.pace})`,
  ];
  if (pace.predictedAtReset !== undefined) {
    bits.push(`At current pace: ~${fmtQuota(pace.predictedAtReset, win.unit)} of ${fmtQuota(win.limit, win.unit)} by reset`);
  }
  if (pace.exhaustsAt !== undefined) {
    bits.push(`may run out around ${new Date(pace.exhaustsAt).toLocaleTimeString()}`);
  }
  return bits.join(" · ");
}

export function QuotaWindowRow({
  w,
  pace,
}: {
  w: QuotaWindowDto;
  pace: QuotaPaceDto | null;
}) {
  const frac = w.limit > 0 ? Math.min(1, w.used / w.limit) : 0;
  return (
    <div className="quota-window">
      <div className="quota-window-head">
        <span>{w.label}</span>
        <span className="mono">{fmtQuota(w.used, w.unit)} / {fmtQuota(w.limit, w.unit)}</span>
      </div>
      <div
        className="quota-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(frac * 100)}
        aria-label={w.label}
      >
        <div className={`quota-progress-fill ${pace?.pace ?? ""}`} style={{ width: `${frac * 100}%` }} />
      </div>
      {pace && <div className="quota-pace">{paceText(pace, w)}</div>}
      {w.resetsAt !== undefined && (
        <div className="muted" style={{ fontSize: 11 }}>resets {new Date(w.resetsAt).toLocaleString()}</div>
      )}
    </div>
  );
}

export function ProviderQuotaChart({ snap }: { snap: QuotaSnapshotDto }) {
  const windows = snap.overview?.windows ?? snap.windows.map((window) => ({
    ...window,
    usedFraction: window.limit > 0 ? Math.min(1, Math.max(0, window.used / window.limit)) : 0,
    remainingFraction: window.limit > 0 ? Math.max(0, 1 - window.used / window.limit) : 1,
  }));
  const width = 240;
  const height = 72;
  const gap = 8;
  const barWidth = windows.length > 0
    ? Math.max(8, (width - gap * (windows.length - 1)) / windows.length)
    : width;
  return (
    <div className="provider-quota-chart" role="img" aria-label={`${snap.providerId} quota utilization chart`}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" x2={width} y1={height * .2} y2={height * .2} />
        <line x1="0" x2={width} y1={height * .5} y2={height * .5} />
        <line x1="0" x2={width} y1={height * .8} y2={height * .8} />
        {windows.map((window, index) => {
          const usedHeight = window.usedFraction * height;
          return (
            <rect
              key={window.id}
              x={index * (barWidth + gap)}
              y={height - usedHeight}
              width={barWidth}
              height={usedHeight}
              rx="3"
              className={window.usedFraction >= .8 ? "warn" : ""}
            />
          );
        })}
      </svg>
      <div className="provider-quota-chart-labels">
        {windows.map((window) => (
          <span key={window.id} title={window.label}>{Math.round(window.usedFraction * 100)}%</span>
        ))}
      </div>
    </div>
  );
}

export function QuotaCard({
  snap,
  onRefresh,
}: {
  snap: QuotaSnapshotDto;
  onRefresh: (id: string) => void;
}) {
  const prefs = useUsagePrefs();
  const groups = groupQuotaWindows(snap.windows);
  const grouped = groups.some((group) => group.family !== null);
  return (
    <div className={`quota-card ${snap.stale ? "quota-stale" : ""}`}>
      <div className="quota-card-head">
        <ProviderLogo providerID={snap.providerId} className="quota-provider-logo" />
        <strong>{snap.providerId}</strong>
        {snap.accountLabel && <span className="muted">{snap.accountLabel}</span>}
        {snap.stale && <span className="tag" title={snap.error?.message}>stale</span>}
        <span className="header-spacer" />
        {snap.fetchedAt > 0 && (
          <span className="muted" style={{ fontSize: 11 }}>{new Date(snap.fetchedAt).toLocaleTimeString()}</span>
        )}
        <button type="button" className="small-btn" onClick={() => onRefresh(snap.providerId)}>Refresh</button>
      </div>
      {snap.stale && snap.error && <div className="quota-error">{snap.error.message}</div>}
      {snap.windows.length > 0 && <ProviderQuotaChart snap={snap} />}
      {groups.map((group) => {
        const key = `${snap.providerId}/${group.family ?? "general"}`;
        const collapsed = grouped && prefs.collapsedGroups.includes(key);
        return (
          <div key={key} className="quota-group">
            {grouped && (
              <button
                type="button"
                className="quota-group-head"
                aria-expanded={!collapsed}
                onClick={() => setGroupCollapsed(key, !collapsed)}
              >
                <span className="quota-group-arrow">{collapsed ? "▸" : "▾"}</span>
                <span>{group.label}</span>
                <span className="muted">{group.windows.length}</span>
              </button>
            )}
            {!collapsed && group.windows.map((window) => (
              <QuotaWindowRow key={window.id} w={window} pace={snap.pace[window.id] ?? null} />
            ))}
          </div>
        );
      })}
      {snap.windows.length === 0 && (
        <div className="muted" style={{ fontSize: 12 }}>No quota data yet.</div>
      )}
    </div>
  );
}

export interface QuotaSnapshotStats {
  providerCount: number;
  windowCount: number;
  attentionCount: number;
  staleCount: number;
}

export function quotaSnapshotStats(snapshots: readonly QuotaSnapshotDto[]): QuotaSnapshotStats {
  return {
    providerCount: snapshots.length,
    windowCount: snapshots.reduce((count, snapshot) => count + snapshot.windows.length, 0),
    attentionCount: snapshots.reduce(
      (count, snapshot) => count + snapshot.windows.filter(
        (window) => window.limit > 0 && window.used / window.limit >= .8,
      ).length,
      0,
    ),
    staleCount: snapshots.filter((snapshot) => snapshot.stale).length,
  };
}

export function QuotaOverviewGrid({ snapshots }: { snapshots: readonly QuotaSnapshotDto[] }) {
  const stats = quotaSnapshotStats(snapshots);
  return (
    <div className="usage-overview-grid">
      <div><span>Providers</span><strong>{stats.providerCount}</strong></div>
      <div><span>Quota windows</span><strong>{stats.windowCount}</strong></div>
      <div><span>At 80%+</span><strong className={stats.attentionCount > 0 ? "warn" : ""}>{stats.attentionCount}</strong></div>
      <div><span>Stale feeds</span><strong>{stats.staleCount}</strong></div>
    </div>
  );
}

export function useQuotaSnapshots(): {
  snapshots: QuotaSnapshotDto[];
  reload: () => void;
  refresh: (providerId: string) => void;
} {
  const [snapshots, setSnapshots] = useState<QuotaSnapshotDto[]>([]);
  const reload = useCallback(() => {
    void api.usageQuotas().then(setSnapshots);
  }, []);
  useEffect(() => {
    reload();
    const timer = window.setInterval(reload, 60_000);
    return () => window.clearInterval(timer);
  }, [reload]);
  const refresh = useCallback((providerId: string) => {
    void api.usageQuotasRefresh(providerId).then(
      () => reload(),
      () => reload(),
    );
  }, [reload]);
  return { snapshots, reload, refresh };
}
