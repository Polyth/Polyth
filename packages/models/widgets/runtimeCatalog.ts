import { useEffect, useState } from "react";
import type { AgentDescriptor, HarnessSnapshot, ModelDescriptor, ModelDiscoveryState, SessionProjection } from "@polyth/contracts";
import { createApiTransport } from "@polyth/web-sdk";
const api = createApiTransport();
type Catalog = {
  models: ModelDescriptor[];
  agents: AgentDescriptor[];
  nativeDefault: boolean;
  ready: boolean;
  harnessId?: string;
  /** Why the model list looks the way it does, for honest composer copy. */
  discovery: ModelDiscoveryState;
};
const unavailable: Catalog = { models: [], agents: [], nativeDefault: false, ready: false, discovery: { state: "empty" } };

/** Availability states that mean "cannot answer", each with a real cause. */
const snapshotUnavailableReason = (snapshot: HarnessSnapshot | undefined): string | undefined => {
  if (!snapshot) return undefined;
  const state = snapshot.availability.state;
  if (state === "ready" || state === "unknown") return undefined;
  return snapshot.message
    ?? (state === "auth-required"
      ? `${snapshot.identity.name} is not signed in`
      : state === "not-installed"
        ? `${snapshot.identity.name} is not installed`
        : `${snapshot.identity.name} is ${state}`);
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
    discovery: fallbackModels.length > 0 ? { state: "available" } : { state: "pending" },
  };
  const [result, setResult] = useState<{ key: string; catalog: Catalog }>();
  useEffect(() => {
    if (session?.harnessTransition) return;
    if (!session?.id && !prospective?.projectId) return;
    const controller = new AbortController();
    const request = session?.id
      ? api.get<Catalog>(`/api/runtime-catalog?sessionId=${encodeURIComponent(session.id)}`, { signal: controller.signal })
      : (async (): Promise<Catalog> => {
          const query = new URLSearchParams({
            projectId: prospective!.projectId!,
            detail: "1",
            ...(prospective!.harnessId
              ? { harnessId: prospective!.harnessId }
              : { auto: "1" }),
          });
          // One request only. For Auto, the server selects from cheap cached
          // summaries and then details just that harness, reusing singleflight.
          const snapshots = await api.get<HarnessSnapshot[]>(`/api/harnesses/snapshots?${query}`, { signal: controller.signal });
          const snapshot = snapshots[0];
          const harnessId = snapshot?.identity.id ?? prospective!.harnessId;
          if (!snapshot || !harnessId) {
            return { ...unavailable, ready: true, discovery: { state: "unavailable", reason: "No engine is ready for this project" } };
          }
          const catalog = snapshot.catalog;
          const reason = snapshotUnavailableReason(snapshot);
          const catalogModels = catalog?.models ?? [];
          return {
            models: catalogModels,
            agents: catalog?.agents ?? catalog?.roles ?? [],
            // A harness without an enumerable catalog can still own a native
            // default — but only when discovery actually succeeded. An auth
            // failure is not a hidden model.
            nativeDefault: !reason && (catalog?.models === undefined || catalog.models.length === 0),
            ready: true,
            harnessId,
            discovery: catalogModels.length > 0
              ? { state: "available" }
              : reason
                ? { state: "unavailable", reason }
                : { state: "empty" },
          };
        })();
    void request.then((catalog) => {
      if (controller.signal.aborted) return;
      setResult({ key, catalog: { ...catalog, discovery: catalog.discovery ?? (catalog.models.length ? { state: "available" } : { state: "empty" }), ready: true } });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setResult({
        key,
        catalog: {
          ...fallback,
          discovery: fallback.models.length > 0
            ? { state: "available" }
            : { state: "unavailable", reason: (error as { message?: string })?.message?.trim() || "The engine could not be reached" },
        },
      });
    });
    return () => controller.abort();
  }, [key, session?.id, session?.harnessTransition, prospective?.projectId, prospective?.harnessId]);
  return !key
    ? { models, agents, nativeDefault: false, ready: true, discovery: models.length > 0 ? { state: "available" } : { state: "empty" } }
    : result?.key === key ? result.catalog : fallback;
}
