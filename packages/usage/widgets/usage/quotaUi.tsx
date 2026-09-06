import { useSyncExternalStore } from "react";
import {
  api,
  type QuotaPaceDto,
  type QuotaSnapshotDto,
  type QuotaWindowDto,
} from "@polyth/session/web-api";
import { fmtTokens } from "../../../../apps/web/src/format.ts";
import {
  groupQuotaWindows,
  setGroupCollapsed,
  useUsagePrefs,
} from "../usagePrefs.ts";
import ProviderLogo from "../../../models/widgets/ProviderLogo.tsx";
import { formatNumber, getLocale, tr } from "../../../../apps/web/src/i18n/index.ts";
import { Button, RefreshIcon } from "../../../../apps/web/src/components/ui/index.ts";

export function fmtQuota(n: number, unit: QuotaWindowDto["unit"]): string {
  if (unit === "currency") {
    return formatNumber(n, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  }
  if (unit === "percent") return `${formatNumber(Math.round(n))}%`;
  if (unit === "tokens") return fmtTokens(n);
  return formatNumber(Math.round(n));
}

function quotaWindowLabel(window: QuotaWindowDto): string {
  if (window.id === "requests-day") return tr("usage.quotaui.requests24h");
  if (window.id === "spend-month") return tr("usage.quotaui.spendMonth");
  return window.label;
}

export function QuotaWindowRow({
  w,
  pace,
}: {
  w: QuotaWindowDto;
  pace: QuotaPaceDto | null;
}) {
  const frac = w.limit > 0 ? Math.min(1, w.used / w.limit) : 0;
  const label = quotaWindowLabel(w);
  return (
    <div className="quota-window">
      <div className="quota-window-head">
        <span>{label}</span>
        <span className="mono">{fmtQuota(w.used, w.unit)} / {fmtQuota(w.limit, w.unit)}</span>
      </div>
      <div
        className="quota-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(frac * 100)}
        aria-label={label}
      >
        <div className={`quota-progress-fill ${pace?.pace ?? ""}`} style={{ width: `${frac * 100}%` }} />
      </div>
      {w.resetsAt !== undefined && (
        <div className="muted quota-meta">{tr("usage.quotaui.resets")}{" "}{new Date(w.resetsAt).toLocaleString(getLocale())}</div>
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
    <div className="provider-quota-chart" role="img" aria-label={tr("usage.quotaui.valueQuotaUtilizationChart", { providerId: snap.providerId })}>
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
          <span key={window.id} title={quotaWindowLabel(window)}>
            {formatNumber(Math.round(window.usedFraction * 100))}%
          </span>
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
        {snap.stale && <span className="tag" title={snap.error?.message}>{tr("usage.quotaui.stale")}</span>}
        <span className="header-spacer" />
        {snap.fetchedAt > 0 && (
          <span className="muted quota-meta">{new Date(snap.fetchedAt).toLocaleTimeString(getLocale())}</span>
        )}
        <Button size="sm" iconStart={RefreshIcon} onClick={() => onRefresh(snap.providerId)}>{tr("common.refresh")}</Button>
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
        <div className="muted quota-meta">{tr("usage.quotaui.noQuotaDataYet")}</div>
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
      <div><span>{tr("usage.quotaui.providers")}</span><strong>{stats.providerCount}</strong></div>
      <div><span>{tr("usage.quotaui.quotaWindows")}</span><strong>{stats.windowCount}</strong></div>
      <div><span>{tr("usage.quotaui.at80")}</span><strong className={stats.attentionCount > 0 ? "warn" : ""}>{stats.attentionCount}</strong></div>
      <div><span>{tr("usage.quotaui.staleFeeds")}</span><strong>{stats.staleCount}</strong></div>
    </div>
  );
}

const quotaErrorMessage = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

interface QuotaSnapshotState {
  snapshots: QuotaSnapshotDto[];
  loading: boolean;
  error: string | null;
}

interface QuotaRequestResult {
  snapshots: QuotaSnapshotDto[];
  error?: unknown;
}

const quotaListeners = new Set<() => void>();
let quotaState: QuotaSnapshotState = {
  snapshots: [],
  loading: true,
  error: null,
};
let quotaRequest: Promise<void> | null = null;
let quotaPollTimer: number | null = null;

const publishQuotaState = (patch: Partial<QuotaSnapshotState>): void => {
  quotaState = { ...quotaState, ...patch };
  for (const listener of [...quotaListeners]) listener();
};

const runQuotaRequest = (
  operation: () => Promise<QuotaRequestResult>,
): Promise<void> => {
  if (quotaRequest) return quotaRequest;
  publishQuotaState({ loading: true, error: null });
  quotaRequest = (async () => {
    try {
      const result = await operation();
      publishQuotaState({
        snapshots: result.snapshots,
        error: result.error === undefined ? null : quotaErrorMessage(result.error),
      });
    } catch (cause) {
      publishQuotaState({ error: quotaErrorMessage(cause) });
    } finally {
      publishQuotaState({ loading: false });
      quotaRequest = null;
    }
  })();
  return quotaRequest;
};

const reloadQuotaSnapshots = (): Promise<void> =>
  runQuotaRequest(async () => ({ snapshots: await api.usageQuotas() }));

const refreshQuotaSnapshot = (providerId: string): Promise<void> =>
  runQuotaRequest(async () => {
    await api.usageQuotasRefresh(providerId);
    return { snapshots: await api.usageQuotas() };
  });

const refreshAllQuotaSnapshots = (): Promise<void> =>
  runQuotaRequest(async () => {
    const providerIds = quotaState.snapshots.map((snapshot) => snapshot.providerId);
    if (providerIds.length === 0) return { snapshots: await api.usageQuotas() };
    const outcomes = await Promise.allSettled(
      providerIds.map((providerId) => api.usageQuotasRefresh(providerId)),
    );
    const snapshots = await api.usageQuotas();
    const failed = outcomes.find((outcome) => outcome.status === "rejected");
    return {
      snapshots,
      ...(failed?.status === "rejected" ? { error: failed.reason } : {}),
    };
  });

const subscribeQuotaSnapshots = (listener: () => void): (() => void) => {
  quotaListeners.add(listener);
  if (quotaListeners.size === 1) {
    void reloadQuotaSnapshots();
    if (typeof window !== "undefined") {
      quotaPollTimer = window.setInterval(() => void reloadQuotaSnapshots(), 60_000);
    }
  }
  return () => {
    quotaListeners.delete(listener);
    if (quotaListeners.size === 0 && quotaPollTimer !== null && typeof window !== "undefined") {
      window.clearInterval(quotaPollTimer);
      quotaPollTimer = null;
    }
  };
};

export function useQuotaSnapshots(): {
  snapshots: QuotaSnapshotDto[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  refresh: (providerId: string) => Promise<void>;
  refreshAll: () => Promise<void>;
} {
  const state = useSyncExternalStore(
    subscribeQuotaSnapshots,
    () => quotaState,
    () => quotaState,
  );
  return {
    ...state,
    reload: reloadQuotaSnapshots,
    refresh: refreshQuotaSnapshot,
    refreshAll: refreshAllQuotaSnapshots,
  };
}
