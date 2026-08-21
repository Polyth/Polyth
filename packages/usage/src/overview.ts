import type { QuotaSnapshot, QuotaWindow } from "@polyth/contracts";

export interface ProviderUsageOverview {
  providerId: string;
  accountLabel?: string;
  stale: boolean;
  windows: Array<QuotaWindow & { usedFraction: number; remainingFraction: number }>;
  highestUsedFraction: number;
}

export function buildProviderUsageOverview(
  snapshots: readonly QuotaSnapshot[],
): ProviderUsageOverview[] {
  return snapshots.map((snapshot) => {
    const windows = snapshot.windows.map((window) => {
      const usedFraction = window.limit > 0
        ? Math.min(1, Math.max(0, window.used / window.limit))
        : 0;
      return { ...window, usedFraction, remainingFraction: 1 - usedFraction };
    });
    return {
      providerId: snapshot.providerId,
      ...(snapshot.accountLabel ? { accountLabel: snapshot.accountLabel } : {}),
      stale: snapshot.stale,
      windows,
      highestUsedFraction: windows.reduce((highest, window) => Math.max(highest, window.usedFraction), 0),
    };
  });
}
