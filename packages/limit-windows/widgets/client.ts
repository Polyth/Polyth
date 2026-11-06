import { sessionFetch } from "@polyth/session/web-api";
import type { LimitWindowsState, PingRecord, SourceView, WindowPlan } from "../src/types.ts";

export const deviceTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export const readState = (signal?: AbortSignal): Promise<LimitWindowsState> =>
  sessionFetch<LimitWindowsState>(`/api/limit-windows/state?timeZone=${encodeURIComponent(deviceTimeZone())}`, signal ? { signal } : undefined);

const sourcePath = (sourceId: string): string => `/api/limit-windows/plans/${encodeURIComponent(sourceId)}`;

export const savePlan = (sourceId: string, plan: WindowPlan): Promise<SourceView> =>
  sessionFetch<SourceView>(sourcePath(sourceId), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(plan),
  });

export const startWindow = (sourceId: string, meterId: string): Promise<{ record: PingRecord }> =>
  sessionFetch<{ record: PingRecord }>(`${sourcePath(sourceId)}/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ meterId }),
  });
