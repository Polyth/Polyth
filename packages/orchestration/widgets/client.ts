// Browser side of the Orchestration routes. No polling: callers refetch on
// mount, on Refresh, after a save and when the window regains focus.
import { ApiError, createApiTransport } from "@polyth/web-sdk";
import {
  ORCHESTRATION_API,
  type ModelOptionsResponse,
  type OrchestrationState,
  type RoutingPolicy,
} from "../src/contracts.ts";

const api = createApiTransport();
const BEHAVIOR_SUBAGENTS = "/api/settings/behavior/subagents";

export const getState = (): Promise<OrchestrationState> => api.get<OrchestrationState>(ORCHESTRATION_API);

export const previewPolicy = (policy: RoutingPolicy): Promise<OrchestrationState> =>
  api.post<OrchestrationState>(`${ORCHESTRATION_API}/preview`, { policy });

export const savePolicy = (policy: RoutingPolicy, expectedRevision: string): Promise<OrchestrationState> =>
  api.put<OrchestrationState>(`${ORCHESTRATION_API}/policy`, { policy, expectedRevision });

export const resetPolicy = (): Promise<OrchestrationState> =>
  api.delete<OrchestrationState>(`${ORCHESTRATION_API}/policy`);

export const recommendPolicy = async (): Promise<RoutingPolicy> =>
  (await api.post<{ policy: RoutingPolicy }>(`${ORCHESTRATION_API}/recommend`)).policy;

/** Whether the server-wide "choose a subagent model" rule is on; `true` when unreadable. */
export async function subagentRuleEnabled(): Promise<boolean> {
  try {
    return (await api.get<{ enabled: boolean }>(BEHAVIOR_SUBAGENTS)).enabled !== false;
  } catch {
    return true;
  }
}

export const isConflict = (error: unknown): boolean => error instanceof ApiError && error.status === 409;

let modelsCache: Promise<ModelOptionsResponse> | null = null;

/** The catalog is cached for the page visit; `force` (Refresh) refetches it. */
export function loadModels(force = false): Promise<ModelOptionsResponse> {
  if (!modelsCache || force) {
    const pending = api.get<ModelOptionsResponse>(`${ORCHESTRATION_API}/models`);
    modelsCache = pending;
    // A failed fetch must not stay cached.
    pending.catch(() => { if (modelsCache === pending) modelsCache = null; });
  }
  return modelsCache;
}

export const forgetModels = (): void => { modelsCache = null; };
