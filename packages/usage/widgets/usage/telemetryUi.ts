import { useCallback, useEffect, useMemo, useState } from "react";
import type { UsageTelemetryDto } from "../../src/telemetry.ts";
import type { UsageRangeInput } from "./dashboardData.ts";

interface UsageTelemetryState {
  telemetry: UsageTelemetryDto | null;
  loading: boolean;
  error: string | null;
}

const DAY_MS = 24 * 60 * 60_000;
const REFRESH_MS = 60_000;

const rangeNow = (range: UsageRangeInput): { start: number; end: number } => {
  if (typeof range === "number") {
    const end = Date.now();
    return { start: end - range * DAY_MS, end };
  }
  return {
    start: range.start,
    end: Math.min(Date.now(), range.end),
  };
};

const keyOf = (range: UsageRangeInput): string =>
  typeof range === "number" ? `preset:${range}` : `custom:${range.start}:${range.end}`;

export function useUsageTelemetry(range: UsageRangeInput): UsageTelemetryState & {
  reload: () => Promise<void>;
} {
  const rangeKey = keyOf(range);
  const stableRange = useMemo(() => range, [rangeKey]);
  const [state, setState] = useState<UsageTelemetryState>({
    telemetry: null,
    loading: true,
    error: null,
  });

  const reload = useCallback(async (): Promise<void> => {
    const resolved = rangeNow(stableRange);
    if (resolved.start >= resolved.end) {
      setState({ telemetry: null, loading: false, error: "Usage range does not include past time" });
      return;
    }
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const params = new URLSearchParams({
        start: String(Math.round(resolved.start)),
        end: String(Math.round(resolved.end)),
      });
      const response = await fetch(`/api/usage/telemetry?${params}`, {
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`Usage telemetry request failed: ${response.status}`);
      const telemetry = await response.json() as UsageTelemetryDto;
      setState({ telemetry, loading: false, error: null });
    } catch (cause) {
      setState((current) => ({
        ...current,
        loading: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }));
    }
  }, [stableRange]);

  useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      if (!active) return;
      await reload();
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [reload]);

  return { ...state, reload };
}
