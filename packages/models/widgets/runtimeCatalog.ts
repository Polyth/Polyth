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
  harnessName?: string;
  /** Why the model list looks the way it does, for honest composer copy. */
  discovery: ModelDiscoveryState;
};
const unavailable: Catalog = { models: [], agents: [], nativeDefault: false, ready: false, discovery: { state: "empty" } };
// Model catalogs remain warm for the lifetime of this page. Explicit
// invalidation (auth/settings/runtime changes) is the freshness boundary.
const catalogCache = createCatalogCache<Catalog>(Infinity);
const harnessCache = createCatalogCache<HarnessSnapshot[]>();
let revision = 0;
const listeners = new Set<() => void>();
export function invalidateRuntimeCatalogs(notify = true): void {
  catalogCache.clear();
  harnessCache.clear();
  revision++;
  if (notify) for (const listener of listeners) listener();
}
type SnapshotRequest = { projectId?: string | null; spaceId?: string; force?: boolean; detail?: boolean };
const snapshotRequestKey = (options: SnapshotRequest) => JSON.stringify([
  activeBrowserAccountId(), options.spaceId ?? "page", options.projectId ?? "", options.detail === true, revision,
]);
const draftCatalogKey = (projectId: string, harnessId: string, spaceId?: string) => JSON.stringify([
  activeBrowserAccountId(), spaceId ?? "page", projectId, `draft:${projectId}:${harnessId}`, revision,
]);
export function peekHarnessSnapshots(options: SnapshotRequest): HarnessSnapshot[] | undefined {
  return harnessCache.peek(snapshotRequestKey(options));
}
export function readHarnessSnapshots(options: SnapshotRequest): Promise<HarnessSnapshot[]> {
  const query = new URLSearchParams();
  if (options.projectId) query.set("projectId", options.projectId);
  if (options.force) query.set("force", "1");
  if (options.detail) query.set("detail", "1");
  if (!options.force) return harnessCache.read(snapshotRequestKey(options), () => api.get<HarnessSnapshot[]>(`/api/harnesses/snapshots?${query}`));
  // Fetch first: invalidating before the forced response arrives lets
  // subscribers immediately refill the old server-side snapshot. Seed the
  // new revision before notifying them so they reuse this authoritative read.
  return api.get<HarnessSnapshot[]>(`/api/harnesses/snapshots?${query}`).then(async (rows) => {
    invalidateRuntimeCatalogs(false);
    const seeded = await harnessCache.read(snapshotRequestKey(options), async () => rows);
    for (const listener of listeners) listener();
    return seeded;
  });
}

const catalogFromSnapshot = (snapshot: HarnessSnapshot | undefined, harnessId?: string): Catalog => {
  if (!snapshot || !harnessId) return { ...unavailable, ready: true, discovery: { state: "unavailable", reason: "No engine is ready for this project" } };
  const catalog = snapshot.catalog;
  const reason = snapshotUnavailableReason(snapshot);
  const catalogModels = pickerCatalogModels(catalog?.models ?? [], harnessId);
  return {
    models: catalogModels,
    agents: catalog?.agents ?? catalog?.roles ?? [],
    nativeDefault: !reason && (catalog?.models === undefined || catalog.models.length === 0),
    ready: true,
    harnessId,
    harnessName: snapshot.identity.name,
    discovery: catalogModels.length > 0 ? { state: "available" } : reason ? { state: "unavailable", reason } : { state: "empty" },
  };
};

const readDraftCatalog = (projectId: string, harnessId: string, spaceId?: string): Promise<Catalog> =>
  catalogCache.read(draftCatalogKey(projectId, harnessId, spaceId), async () => {
    const query = new URLSearchParams({ projectId, detail: "1", harnessId });
    const snapshots = await api.get<HarnessSnapshot[]>(`/api/harnesses/snapshots?${query}`);
    return catalogFromSnapshot(snapshots[0], harnessId);
  });

/** Finish target metadata discovery before committing a harness selection. */
export async function prepareRuntimeCatalog(options: { projectId: string; harnessId: string; spaceId?: string }): Promise<void> {
  const catalog = await readDraftCatalog(options.projectId, options.harnessId, options.spaceId);
  if (catalog.discovery.state === "unavailable") throw new Error(catalog.discovery.reason);
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
    routeKey, catalogRevision]) : "";
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
  const preloaded = requestedHarness && (prospective?.projectId ?? session?.projectId)
    ? catalogCache.peek(draftCatalogKey(prospective?.projectId ?? session!.projectId, requestedHarness, prospective?.spaceId))
    : undefined;
  const [result, setResult] = useState<{ key: string; catalog: Catalog }>();
  useEffect(() => {
    if (session?.harnessTransition) return;
    if (!session?.id && !prospective?.projectId) return;
    const controller = new AbortController();
    // Warm the cheap tab summaries alongside the selected model catalog, so
    // opening the picker does not begin a second discovery waterfall.
    const projectId = prospective?.projectId ?? session?.projectId;
    const spaceId = prospective?.spaceId;
    const warmRevision = catalogRevision;
    void readHarnessSnapshots({ projectId, spaceId }).then((snapshots) => {
      // Cursor is the only currently expensive alternate catalog worth
      // warming. Its availability is cheap metadata; the selected harness
      // request continues independently and is never delayed by this read.
      const cursor = snapshots.find((snapshot) => snapshot.identity.id === "cursor");
      if (!controller.signal.aborted && revision === warmRevision && projectId && cursor?.policy.enabled && cursor.availability.installed) {
        void readDraftCatalog(projectId, "cursor", spaceId).catch(() => {});
      }
    }).catch(() => {});
    // A consumer leaving does not abort a shared metadata read; late results
    // can warm their own key but can never publish into the newly chosen one.
    const load = (): Promise<Catalog> => session?.id
      ? api.get<Catalog>(`/api/runtime-catalog?sessionId=${encodeURIComponent(session.id)}`)
      : (async (): Promise<Catalog> => {
          const query = new URLSearchParams({
            projectId: prospective!.projectId!, detail: "1",
            ...(prospective!.harnessId ? { harnessId: prospective!.harnessId } : { auto: "1" }),
          });
          const snapshots = await api.get<HarnessSnapshot[]>(`/api/harnesses/snapshots?${query}`);
          return catalogFromSnapshot(snapshots[0], snapshots[0]?.identity.id ?? prospective!.harnessId);
        })();
    // Cursor's draft key is owned by readDraftCatalog so the background
    // prefetch and selected route share one pending/value entry.
    const request = !session?.id && prospective?.harnessId === "cursor" && prospective.projectId
      ? readDraftCatalog(prospective.projectId, "cursor", prospective.spaceId)
      : catalogCache.read(key, load);
    const normalized = request.then((catalog) => ({
          ...catalog,
          models: pickerCatalogModels(catalog.models, catalog.harnessId ?? requestedHarness),
          discovery: catalog.discovery ?? (catalog.models.length ? { state: "available" as const } : { state: "empty" as const }),
          ready: true,
        }));
    void normalized.then((catalog) => {
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
    : result?.key === key ? result.catalog : catalogCache.peek(key) ?? preloaded ?? fallback;
}
