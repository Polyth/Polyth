import { useEffect, useState } from "react";
import type { AgentDescriptor, HarnessSnapshot, ModelDescriptor, SessionProjection } from "@polyth/contracts";
import { createApiTransport } from "@polyth/web-sdk";
const api = createApiTransport();
type Catalog = { models: ModelDescriptor[]; agents: AgentDescriptor[]; nativeDefault: boolean; ready: boolean; harnessId?: string };
const unavailable: Catalog = { models: [], agents: [], nativeDefault: false, ready: false };
const prospectiveCandidate = (snapshot: HarnessSnapshot): boolean => {
  const state = snapshot.availability.state;
  return snapshot.policy.enabled
    && snapshot.policy.autoSelect
    && snapshot.availability.installed
    && snapshot.availability.healthy
    && snapshot.availability.authenticated !== false
    && (state === "ready" || state === "unknown");
};
export function useRuntimeCatalog(
  session: SessionProjection | null,
  models: ModelDescriptor[],
  agents: AgentDescriptor[],
  prospective?: { projectId?: string; harnessId?: string },
): Catalog {
  const key = session?.id
    ? `session:${session.id}:${session.resolvedHarnessId ?? ""}:${session.harnessTransition?.id ?? ""}`
    : prospective?.projectId
      ? `draft:${prospective.projectId}:${prospective.harnessId ?? "auto"}`
      : "";
  const fallbackModels = prospective?.harnessId
    ? models.filter((model) => model.harnessId === prospective.harnessId
        || (!model.harnessId && prospective.harnessId === "opencode"))
    : models;
  const fallbackAgents = prospective?.harnessId
    ? agents.filter((agent) => agent.harnessId === prospective.harnessId
        || (!agent.harnessId && prospective.harnessId === "opencode"))
    : agents;
  // Snapshot discovery is an enhancement to the draft. A metadata outage
  // must not disable first send; the server remains the execution authority.
  const fallback: Catalog = {
    models: fallbackModels,
    agents: fallbackAgents,
    nativeDefault: fallbackModels.length === 0,
    ready: true,
    ...(prospective?.harnessId ? { harnessId: prospective.harnessId } : {}),
  };
  const [result, setResult] = useState<{ key: string; catalog: Catalog }>();
  useEffect(() => {
    if (session?.harnessTransition) return;
    if (!session?.id && !prospective?.projectId) return;
    let cancelled = false;
    const request = session?.id
      ? api.get<Catalog>(`/api/runtime-catalog?sessionId=${encodeURIComponent(session.id)}`)
      : (async (): Promise<Catalog> => {
          let harnessId = prospective!.harnessId;
          if (!harnessId) {
            const snapshots = await api.get<HarnessSnapshot[]>(`/api/harnesses/snapshots?projectId=${encodeURIComponent(prospective!.projectId!)}`);
            harnessId = snapshots
              .filter(prospectiveCandidate)
              .toSorted((left, right) => left.policy.priority - right.policy.priority || left.identity.id.localeCompare(right.identity.id))[0]
              ?.identity.id;
          }
          if (!harnessId) return { ...unavailable, ready: true };
          const snapshots = await api.get<HarnessSnapshot[]>(`/api/harnesses/snapshots?projectId=${encodeURIComponent(prospective!.projectId!)}&harnessId=${encodeURIComponent(harnessId)}&detail=1`);
          const catalog = snapshots[0]?.catalog;
          return {
            models: catalog?.models ?? [],
            agents: catalog?.agents ?? catalog?.roles ?? [],
            // A harness without an enumerable catalog can still own a native
            // default. Session creation remains the availability boundary.
            nativeDefault: catalog?.models === undefined || catalog.models.length === 0,
            ready: true,
            harnessId,
          };
        })();
    void request.then((catalog) => { if (!cancelled) setResult({ key, catalog: { ...catalog, ready: true } }); }).catch(() => { if (!cancelled) setResult({ key, catalog: fallback }); });
    return () => { cancelled = true; };
  }, [key, session?.id, session?.harnessTransition, prospective?.projectId, prospective?.harnessId]);
  return !key ? { models, agents, nativeDefault: false, ready: true } : result?.key === key ? result.catalog : fallback;
}
