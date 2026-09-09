import { useEffect, useState, useSyncExternalStore } from "react";
import type { AgentDescriptor, HarnessSnapshot, ModelDescriptor, ModelDiscoveryState, SessionProjection } from "@polyth/contracts";
import { createApiTransport } from "@polyth/web-sdk";
import { activeBrowserAccountId } from "@polyth/web/account-storage";
import { createCatalogCache } from "./catalogCache.ts";
import { pickerCatalogModels } from "./modelPickerState.ts";
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
const catalogCache = createCatalogCache<Catalog>();
const harnessCache = createCatalogCache<HarnessSnapshot[]>();
let revision = 0;
const listeners = new Set<() => void>();
const sources = new WeakMap<object, number>();
let sourceId = 0;
const sourceKey = (source: object) => {
  if (!sources.has(source)) sources.set(source, ++sourceId);
  return sources.get(source)!;
};
export function invalidateRuntimeCatalogs(): void {
  catalogCache.clear();
  harnessCache.clear();
  revision++;
  for (const listener of listeners) listener();
}
type SnapshotRequest = { projectId?: string | null; spaceId?: string; force?: boolean; detail?: boolean };
const snapshotRequestKey = (options: SnapshotRequest) => JSON.stringify([
  activeBrowserAccountId(), options.spaceId ?? "page", options.projectId ?? "", options.detail === true, revision,
]);
export function peekHarnessSnapshots(options: SnapshotRequest): HarnessSnapshot[] | undefined {
  return harnessCache.peek(snapshotRequestKey(options));
}
export function readHarnessSnapshots(options: SnapshotRequest): Promise<HarnessSnapshot[]> {
  if (options.force) invalidateRuntimeCatalogs();
  const query = new URLSearchParams();
  if (options.projectId) query.set("projectId", options.projectId);
  if (options.force) query.set("force", "1");
  if (options.detail) query.set("detail", "1");
  return harnessCache.read(snapshotRequestKey(options), () => api.get<HarnessSnapshot[]>(`/api/harnesses/snapshots?${query}`));
}
export function useCatalogRevision(): number {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => revision);
}

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
  prospective?: { projectId?: string; harnessId?: string; spaceId?: string },
): Catalog {
  const catalogRevision = useCatalogRevision();
  const routeKey = session?.id
    ? `session:${session.id}:${session.resolvedHarnessId ?? ""}:${session.runtimeLeg?.id ?? ""}:${session.harnessTransition?.id ?? ""}`
    : prospective?.projectId
      ? `draft:${prospective.projectId}:${prospective.harnessId ?? "auto"}`
      : "";
  // Space/account switching reloads the shell, so this memory cache also has
  // a page-lifetime fence. Explicit identity protects mounted route changes.
  const key = routeKey ? JSON.stringify([activeBrowserAccountId(), prospective?.spaceId ?? "page", prospective?.projectId,
    routeKey, sourceKey(models), sourceKey(agents), catalogRevision]) : "";
  const requestedHarness = session?.resolvedHarnessId ?? prospective?.harnessId;
  const fallbackModels = pickerCatalogModels(models, requestedHarness);
  const fallbackAgents = requestedHarness
    ? agents.filter((agent) => agent.harnessId === requestedHarness
        || (!agent.harnessId && requestedHarness === "opencode"))
    : agents;
  // Snapshot discovery is an enhancement to the draft. A metadata outage
  // must not disable first send; the server remains the execution authority.
  const fallback: Catalog = {
    models: fallbackModels,
    agents: fallbackAgents,
    nativeDefault: fallbackModels.length === 0,
    ready: fallbackModels.length > 0,
    ...(requestedHarness ? { harnessId: requestedHarness } : {}),
    discovery: fallbackModels.length > 0 ? { state: "available" } : { state: "pending" },
  };
  const [result, setResult] = useState<{ key: string; catalog: Catalog }>();
  useEffect(() => {
    if (session?.harnessTransition) return;
    if (!session?.id && !prospective?.projectId) return;
    const controller = new AbortController();
    // Warm the cheap tab summaries alongside the selected model catalog, so
    // opening the picker does not begin a second discovery waterfall.
    void readHarnessSnapshots({ projectId: prospective?.projectId ?? session?.projectId, spaceId: prospective?.spaceId }).catch(() => {});
    // A consumer leaving does not abort a shared metadata read; late results
    // can warm their own key but can never publish into the newly chosen one.
    const request = catalogCache.read(key, () => (session?.id
      ? api.get<Catalog>(`/api/runtime-catalog?sessionId=${encodeURIComponent(session.id)}`)
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
          const snapshots = await api.get<HarnessSnapshot[]>(`/api/harnesses/snapshots?${query}`);
          const snapshot = snapshots[0];
          const harnessId = snapshot?.identity.id ?? prospective!.harnessId;
          if (!snapshot || !harnessId) {
            return { ...unavailable, ready: true, discovery: { state: "unavailable", reason: "No engine is ready for this project" } };
          }
          const catalog = snapshot.catalog;
          const reason = snapshotUnavailableReason(snapshot);
          const catalogModels = pickerCatalogModels(catalog?.models ?? [], harnessId);
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
        })()).then((catalog) => ({
          ...catalog,
          models: pickerCatalogModels(catalog.models, catalog.harnessId ?? requestedHarness),
          discovery: catalog.discovery ?? (catalog.models.length ? { state: "available" as const } : { state: "empty" as const }),
          ready: true,
        })));
    void request.then((catalog) => {
      if (controller.signal.aborted) return;
      setResult({ key, catalog });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setResult({
        key,
        catalog: {
          ...fallback,
          ready: true,
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
    : result?.key === key ? result.catalog : catalogCache.peek(key) ?? fallback;
}
