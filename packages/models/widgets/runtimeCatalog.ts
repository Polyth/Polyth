import { useEffect, useState, useSyncExternalStore } from "react";
import type { AgentDescriptor, HarnessRosterItem, HarnessSnapshot, ModelDescriptor, ModelDiscoveryState, SessionProjection } from "@polyth/contracts";
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
const rosterCache = createCatalogCache<HarnessRosterItem[]>(Infinity);
let revision = 0;
const listeners = new Set<() => void>();
export function invalidateRuntimeCatalogs(notify = true): void {
  catalogCache.clear();
  harnessCache.clear();
  rosterCache.clear();
  revision++;
  if (notify) for (const listener of listeners) listener();
}
type SnapshotRequest = { projectId?: string | null; spaceId?: string; harnessId?: string; force?: boolean; detail?: boolean };
const snapshotRequestKey = (options: SnapshotRequest) => JSON.stringify([
  activeBrowserAccountId(), options.spaceId ?? "page", options.projectId ?? "", options.harnessId ?? "all", options.detail === true, revision,
]);
const previewCatalogKey = (projectId: string, harnessId: string | undefined, spaceId?: string) => JSON.stringify([
  activeBrowserAccountId(), spaceId ?? "page", projectId, `preview:${projectId}:${harnessId ?? "auto"}`, revision,
]);
const rosterKey = (options: Pick<SnapshotRequest, "projectId" | "spaceId">) => JSON.stringify([
  activeBrowserAccountId(), options.spaceId ?? "page", options.projectId ?? "", revision,
]);
export function peekHarnessRoster(options: Pick<SnapshotRequest, "projectId" | "spaceId">): HarnessRosterItem[] | undefined {
  return rosterCache.peek(rosterKey(options));
}
export function readHarnessRoster(options: Pick<SnapshotRequest, "projectId" | "spaceId">): Promise<HarnessRosterItem[]> {
  const query = options.projectId ? `?projectId=${encodeURIComponent(options.projectId)}` : "";
  return rosterCache.read(rosterKey(options), () => api.get<HarnessRosterItem[]>(`/api/harnesses/roster${query}`));
}
export function peekHarnessSnapshots(options: SnapshotRequest): HarnessSnapshot[] | undefined {
  return harnessCache.peek(snapshotRequestKey(options));
}
export function readHarnessSnapshots(options: SnapshotRequest): Promise<HarnessSnapshot[]> {
  const query = new URLSearchParams();
  if (options.projectId) query.set("projectId", options.projectId);
  if (options.harnessId) query.set("harnessId", options.harnessId);
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

const readPreviewCatalog = (projectId: string, harnessId?: string, spaceId?: string): Promise<Catalog> =>
  catalogCache.read(previewCatalogKey(projectId, harnessId, spaceId), async () => {
    const snapshots = harnessId
      ? await readHarnessSnapshots({ projectId, harnessId, spaceId })
      : await api.get<HarnessSnapshot[]>(`/api/harnesses/snapshots?${new URLSearchParams({ projectId, auto: "1" })}`);
    const resolvedHarnessId = snapshots[0]?.identity.id ?? harnessId;
    return catalogFromSnapshot(snapshots[0], resolvedHarnessId);
  });
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
  const previewRoute = Boolean(prospective?.projectId
    && (!session?.id || (prospective.harnessId && prospective.harnessId !== session.resolvedHarnessId)));
  const routeKey = session?.id && !previewRoute
    ? `session:${session.id}:${session.resolvedHarnessId ?? ""}:${session.runtimeLeg?.id ?? ""}:${session.harnessTransition?.id ?? ""}`
    : prospective?.projectId
      ? `draft:${prospective.projectId}:${prospective.harnessId ?? "auto"}`
      : "";
  // Space/account switching reloads the shell, so this memory cache also has
  // a page-lifetime fence. Explicit identity protects mounted route changes.
  const key = routeKey ? JSON.stringify([activeBrowserAccountId(), prospective?.spaceId ?? "page", prospective?.projectId,
    routeKey, catalogRevision]) : "";
  const requestedHarness = previewRoute ? prospective?.harnessId : session?.resolvedHarnessId ?? prospective?.harnessId;
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
    nativeDefault: previewRoute && fallbackModels.length === 0,
    ready: previewRoute || fallbackModels.length > 0,
    ...(requestedHarness ? { harnessId: requestedHarness } : {}),
    discovery: fallbackModels.length > 0
      ? { state: "available" }
      : previewRoute ? { state: "empty" } : { state: "pending" },
  };
  const preloaded = requestedHarness && (prospective?.projectId ?? session?.projectId)
    ? catalogCache.peek(previewCatalogKey(prospective?.projectId ?? session!.projectId, requestedHarness, prospective?.spaceId))
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
    // Picker chrome has its own process-free roster. Start it with the
    // composer so the first open never waits for native version/auth probes.
    void readHarnessRoster({ projectId, spaceId }).catch(() => {});
    void readHarnessSnapshots({ projectId, spaceId }).catch(() => {});
    // A consumer leaving does not abort a shared metadata read; late results
    // can warm their own key but can never publish into the newly chosen one.
    const load = (): Promise<Catalog> => session?.id && !previewRoute
      ? api.get<Catalog>(`/api/runtime-catalog?sessionId=${encodeURIComponent(session.id)}`)
      : readPreviewCatalog(prospective!.projectId!, prospective?.harnessId, prospective?.spaceId);
    const request = session?.id && !previewRoute ? catalogCache.read(key, load) : load();
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
  }, [key, previewRoute, session?.id, session?.harnessTransition, prospective?.projectId, prospective?.harnessId]);
  return !key
    ? { models, agents, nativeDefault: false, ready: true, discovery: models.length > 0 ? { state: "available" } : { state: "empty" } }
    : result?.key === key ? result.catalog : catalogCache.peek(key) ?? preloaded ?? fallback;
}
