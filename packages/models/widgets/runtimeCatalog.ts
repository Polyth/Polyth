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
export function subscribeRuntimeCatalogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function invalidateRuntimeCatalogs(notify = true): void {
  catalogCache.clear();
  harnessCache.clear();
  rosterCache.clear();
  revision++;
  if (notify) for (const listener of listeners) listener();
}
type SnapshotRequest = { projectId?: string | null; spaceId?: string; cwd?: string; harnessId?: string; force?: boolean; detail?: boolean };
const snapshotRequestKey = (options: SnapshotRequest) => JSON.stringify([
  activeBrowserAccountId(), options.spaceId ?? "page", options.projectId ?? "", options.cwd ?? "project-root",
  options.harnessId ?? "all", options.detail === true, revision,
]);
const previewCatalogKey = (projectId: string | undefined, harnessId: string | undefined, spaceId?: string, cwd?: string) => JSON.stringify([
  activeBrowserAccountId(), spaceId ?? "page", projectId ?? "default", cwd ?? "project-root",
  `preview:${projectId ?? "default"}:${harnessId ?? "auto"}`, revision,
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
  // cwd fences browser reuse only. The server derives and validates the path
  // from project/session identity; never accept an authority path from UI.
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

/** Selected-route metadata may use a bounded native catalog probe, but it does
 * not bind the canonical session, create an execution leg, or send a turn. */
const readPreviewCatalog = (projectId?: string, harnessId?: string, spaceId?: string, cwd?: string): Promise<Catalog> => {
  const requestRevision = revision;
  const requestKey = previewCatalogKey(projectId, harnessId, spaceId, cwd);
  return catalogCache.read(requestKey, async () => {
    const snapshots = harnessId
      ? await readHarnessSnapshots({ projectId, harnessId, spaceId, cwd, detail: true })
      : await api.get<HarnessSnapshot[]>(`/api/harnesses/snapshots?${new URLSearchParams({
          ...(projectId ? { projectId } : {}), auto: "1", detail: "1",
        })}`);
    const snapshot = snapshots[0];
    if (cwd && snapshot && snapshot.context.cwd !== cwd) {
      throw new Error("Project context changed while discovering models");
    }
    const resolvedHarnessId = snapshot?.identity.id ?? harnessId;
    const catalog = catalogFromSnapshot(snapshot, resolvedHarnessId);
    // A transient discovery failure is not page-lifetime truth. Reject it so
    // createCatalogCache evicts the flight and a later restored-project mount
    // or harness switch can retry instead of preserving "No models found"
    // until the whole shell reloads. Successful empty catalogs remain cached.
    if (catalog.discovery.state === "unavailable") {
      throw Object.assign(new Error(catalog.discovery.reason), { code: "unavailable" });
    }
    // A context-free bootstrap request is scoped by the server. Alias its
    // result under the returned identity so later project/Space consumers hit
    // the same value without treating default-context data as global truth.
    if (snapshot && resolvedHarnessId && revision === requestRevision) {
      const aliases = new Set<string>();
      for (const aliasHarnessId of harnessId ? [resolvedHarnessId] : [undefined, resolvedHarnessId]) {
        aliases.add(previewCatalogKey(snapshot.context.projectId, aliasHarnessId));
        aliases.add(previewCatalogKey(snapshot.context.projectId, aliasHarnessId, snapshot.context.spaceId));
        aliases.add(previewCatalogKey(snapshot.context.projectId, aliasHarnessId, undefined, snapshot.context.cwd));
        aliases.add(previewCatalogKey(snapshot.context.projectId, aliasHarnessId, snapshot.context.spaceId, snapshot.context.cwd));
      }
      for (const alias of aliases) {
        if (alias !== requestKey) await catalogCache.read(alias, async () => catalog);
      }
    }
    return catalog;
  });
};

/** Warm every enabled harness catalog during shell package bootstrap, even
 * before project restoration. Each target gets its own cache entry, and the
 * server-returned context aliases it into the Space/project scope that owns it. */
export const preloadRuntimeCatalogs = async (
  options: { projectId?: string; spaceId?: string } = {},
): Promise<void> => {
  const preloadRevision = revision;
  const roster = await readHarnessRoster(options);
  if (revision !== preloadRevision) return;
  await Promise.allSettled([
    // Warm Auto as its own route too; the server chooses among the detailed
    // snapshots without committing that choice to any canonical session.
    readPreviewCatalog(options.projectId, undefined, options.spaceId),
    ...roster
      .filter((row) => row.policy.enabled)
      .map((row) => readPreviewCatalog(options.projectId, row.identity.id, options.spaceId)),
  ]);
};

export function useCatalogRevision(): number {
  return useSyncExternalStore(subscribeRuntimeCatalogs, () => revision);
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
  prospective?: { projectId?: string; harnessId?: string; spaceId?: string; cwd?: string },
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
  const key = routeKey ? JSON.stringify([activeBrowserAccountId(), prospective?.spaceId ?? "page", prospective?.projectId, prospective?.cwd,
    routeKey, catalogRevision]) : "";
  const requestedHarness = previewRoute ? prospective?.harnessId : session?.resolvedHarnessId ?? prospective?.harnessId;
  const fallbackModels = pickerCatalogModels(models, requestedHarness);
  const fallbackAgents = requestedHarness
    ? agents.filter((agent) => agent.harnessId === requestedHarness
        || (!agent.harnessId && requestedHarness === "opencode"))
    : agents;
  // Keep the visual route synchronous, but do not claim that an unanswered
  // metadata request is an authoritative empty catalog.
  const fallback: Catalog = {
    models: fallbackModels,
    agents: fallbackAgents,
    nativeDefault: false,
    ready: fallbackModels.length > 0,
    ...(requestedHarness ? { harnessId: requestedHarness } : {}),
    discovery: fallbackModels.length > 0
      ? { state: "available" }
      : { state: "pending" },
  };
  const preloaded = requestedHarness && (prospective?.projectId ?? session?.projectId)
    ? catalogCache.peek(previewCatalogKey(
        prospective?.projectId ?? session!.projectId,
        requestedHarness,
        prospective?.spaceId,
        prospective?.cwd,
      ))
    : undefined;
  const [result, setResult] = useState<{ key: string; catalog: Catalog }>();
  useEffect(() => {
    if (session?.harnessTransition) return;
    if (!session?.id && !prospective?.projectId) return;
    const controller = new AbortController();
    // A consumer leaving does not abort a shared metadata read; late results
    // can warm their own key but can never publish into the newly chosen one.
    const load = (): Promise<Catalog> => session?.id && !previewRoute
      ? api.get<Catalog>(`/api/runtime-catalog?sessionId=${encodeURIComponent(session.id)}`)
      : readPreviewCatalog(prospective!.projectId!, prospective?.harnessId, prospective?.spaceId, prospective?.cwd);
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
