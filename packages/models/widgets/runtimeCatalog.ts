import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AgentDescriptor, HarnessRosterItem, HarnessSnapshot, ModelDescriptor, ModelDiscoveryEmptyCode, ModelDiscoveryState, SessionProjection } from "@polyth/contracts";
import { createApiTransport } from "@polyth/web-sdk";
import { isNetworkFailure } from "@polyth/contracts/transport-retry";
import { accountStorageKey, activeBrowserAccountId } from "@polyth/web/account-storage";
import { createCatalogCache, type CatalogCacheStorage } from "./catalogCache.ts";
import { harnessColor } from "./harnessColor.ts";
import { pickerCatalogModels } from "./modelPickerState.ts";
const api = createApiTransport();
/** Structured cause for an unavailable catalog. The English reason is copy, not
 *  an API: `no-engine` means the project route resolved no ready engine at all,
 *  so there is nothing to reconnect to and the composer sends the user to the
 *  Harnesses settings instead. Every other unavailable cause (transport or
 *  runtime failure) stays a Reconnect retry. */
export type RuntimeCatalogDiscoveryCode = "no-engine" | ModelDiscoveryEmptyCode;
export type RuntimeCatalogDiscovery = ModelDiscoveryState & { code?: RuntimeCatalogDiscoveryCode };
type Catalog = {
  models: ModelDescriptor[];
  agents: AgentDescriptor[];
  nativeDefault: boolean;
  ready: boolean;
  harnessId?: string;
  harnessName?: string;
  /** Why the model list looks the way it does, for honest composer copy. */
  discovery: RuntimeCatalogDiscovery;
};
/** The reason the composer shows when a route has no ready engine. Paired with
 *  `code: "no-engine"`; callers branch on the code, never on this string. */
export const NO_ENGINE_REASON = "No engine is ready for this project";
const unavailable: Catalog = { models: [], agents: [], nativeDefault: false, ready: false, discovery: { state: "empty" } };
const emptyModels: ModelDescriptor[] = [];
const DAILY_CACHE_MS = 24 * 60 * 60_000;
const persistentStorage = (name: string): CatalogCacheStorage => {
  // Account changes reload the shell. Pinning the backing key prevents a late
  // request from ever writing one account's metadata into another account.
  const key = accountStorageKey(name, activeBrowserAccountId());
  return {
    read: () => { try { return localStorage.getItem(key); } catch { return null; } },
    write: (value) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
    clear: () => { try { localStorage.removeItem(key); } catch { /* private mode */ } },
  };
};
// Live reads stay page-local; successful discovery is also persisted for one
// day so a page reload is not itself a reason to start native harness probes.
const catalogCache = createCatalogCache<Catalog>(Infinity);
const harnessCache = createCatalogCache<HarnessSnapshot[]>(Infinity);
/** When the server last answered a request key directly (forced or fresh). */
const answeredAt = new Map<string, number>();
const rosterCache = createCatalogCache<HarnessRosterItem[]>(Infinity);
const persistedCatalogs = createCatalogCache<Catalog>(DAILY_CACHE_MS, 64, Date.now, persistentStorage("polyth.runtimeCatalogs.v1"));
const persistedHarnesses = createCatalogCache<HarnessSnapshot[]>(DAILY_CACHE_MS, 64, Date.now, persistentStorage("polyth.runtimeHarnesses.v1"));
const persistedRosters = createCatalogCache<HarnessRosterItem[]>(DAILY_CACHE_MS, 64, Date.now, persistentStorage("polyth.runtimeRosters.v1"));
const persistedGlobalModels = createCatalogCache<ModelDescriptor[]>(DAILY_CACHE_MS, 64, Date.now, persistentStorage("polyth.runtimeGlobalModels.v1"));
const persistedGlobalAgents = createCatalogCache<AgentDescriptor[]>(DAILY_CACHE_MS, 64, Date.now, persistentStorage("polyth.runtimeGlobalAgents.v1"));
const persistedWarmScopes = createCatalogCache<true>(DAILY_CACHE_MS, 64, Date.now, persistentStorage("polyth.runtimeWarmScopes.v1"));
const persistedHarnessTopology = persistentStorage("polyth.runtimeHarnessTopology.v1");
// Stored metadata that predates the topology recorded beside it has unproven
// provenance: a harness package may have been added while this client was away.
// Drop it here, at load, because the shell paints from these caches before the
// package registry has finished syncing the real harness topology.
if (persistedHarnessTopology.read() === null) clearPersistedCatalogs();
let revision = 0;
const listeners = new Set<() => void>();
const invalidationListeners = new Set<() => void>();
export function subscribeRuntimeCatalogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
// A route whose catalog request failed shows "unavailable" until it is asked
// again. Reconnects and the composer's Reconnect action ask through here.
const retryListeners = new Set<() => void>();
/** Re-request every mounted route catalog whose last request failed. */
export function retryUnavailableRuntimeCatalogs(): void {
  for (const listener of [...retryListeners]) listener();
}
// After a lost connection the page retries on its own instead of keeping a
// raw "Load failed" until a reload.
const NETWORK_RETRY_MS = 10_000;
const NETWORK_FAILURE_REASON = "Can't reach Polyth. Retrying…";
/** A live route whose runtime reported no models can recover moments later
 *  (a re-materialized leg, a provider still loading). Ask again a few times
 *  without waiting for the user to reconnect; after that the last known
 *  catalog stays on screen and the regular retry signals remain armed. */
const EMPTY_RETRY_DELAYS_MS = [1_200, 3_000, 7_000, 15_000] as const;
export function subscribeRuntimeCatalogInvalidations(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => { invalidationListeners.delete(listener); };
}
export function resetRuntimeCatalogMemory(notify = true): void {
  catalogCache.clear();
  harnessCache.clear();
  rosterCache.clear();
  answeredAt.clear();
  revision++;
  if (notify) for (const listener of listeners) listener();
}
function clearPersistedCatalogs(): void {
  persistedCatalogs.clear();
  persistedHarnesses.clear();
  persistedRosters.clear();
  persistedGlobalModels.clear();
  persistedGlobalAgents.clear();
  persistedWarmScopes.clear();
}
export function invalidateRuntimeCatalogs(notify = true): void {
  clearPersistedCatalogs();
  for (const listener of invalidationListeners) listener();
  resetRuntimeCatalogMemory(notify);
}
/** Record the set of harness-owning packages the day-long metadata was stored
 * under, and drop that metadata when the set has changed. The package registry's
 * in-memory baseline only sees transitions within one page, so a harness
 * installed while this client was away stayed invisible until the stored copies
 * aged out. An absent record is handled at load, not here. */
export function reconcileHarnessTopology(fingerprint: string): void {
  const previous = persistedHarnessTopology.read();
  if (previous === fingerprint) return;
  persistedHarnessTopology.write(fingerprint);
  if (previous !== null) invalidateRuntimeCatalogs();
}
/** `fresh` asks the server even when this page or a stored copy holds rows
 * (Settings revalidates instead of painting day-old readiness as current).
 * `verify` is a detail read that waits for the harness's native readiness
 * check instead of a last-known catalog. */
type SnapshotRequest = { projectId?: string | null; spaceId?: string; cwd?: string; harnessId?: string; force?: boolean; detail?: boolean; verify?: boolean; fresh?: boolean };
const snapshotRequestKey = (options: SnapshotRequest) => JSON.stringify([
  activeBrowserAccountId(), options.spaceId ?? "page", options.projectId ?? "", options.cwd ?? "project-root",
  options.harnessId ?? "all", options.detail === true || options.verify === true, revision,
]);
const previewCatalogKey = (projectId: string | undefined, harnessId: string | undefined, spaceId?: string, cwd?: string) => JSON.stringify([
  activeBrowserAccountId(), spaceId ?? "page", projectId ?? "default", cwd ?? "project-root",
  `preview:${projectId ?? "default"}:${harnessId ?? "auto"}`, revision,
]);
const rosterKey = (options: Pick<SnapshotRequest, "projectId" | "spaceId">) => JSON.stringify([
  activeBrowserAccountId(), options.spaceId ?? "page", options.projectId ?? "", revision,
]);
const rosterPresentationKey = (options: Pick<SnapshotRequest, "projectId" | "spaceId">) => JSON.stringify([
  activeBrowserAccountId(), options.spaceId ?? "page", options.projectId ?? "",
]);
const globalCatalogPresentationKey = (projectId: string) => JSON.stringify([
  activeBrowserAccountId(), projectId,
]);

/** The legacy aggregate /api/models + /api/agents store is still consumed by
 * non-picker surfaces. Keep it on the same daily invalidation boundary instead
 * of making every page reload fan out through all runtimes again. Project id is
 * a tenant-safe Space discriminator because projects never cross Spaces. */
export function peekPersistedRuntimeModels(projectId: string): ModelDescriptor[] | undefined {
  return persistedGlobalModels.peek(globalCatalogPresentationKey(projectId));
}
export function rememberPersistedRuntimeModels(projectId: string, models: ModelDescriptor[]): void {
  // Never freeze a startup/unavailable empty answer for a day.
  if (models.length > 0) persistedGlobalModels.write(globalCatalogPresentationKey(projectId), models);
}
export function peekPersistedRuntimeAgents(projectId: string): AgentDescriptor[] | undefined {
  return persistedGlobalAgents.peek(globalCatalogPresentationKey(projectId));
}
export function rememberPersistedRuntimeAgents(projectId: string, agents: AgentDescriptor[]): void {
  persistedGlobalAgents.write(globalCatalogPresentationKey(projectId), agents);
}
export function runtimeCatalogRefreshDelay(projectId: string): number | undefined {
  return persistedWarmScopes.expiresIn(globalCatalogPresentationKey(projectId));
}
const snapshotPresentationKey = (options: SnapshotRequest) => JSON.stringify([
  activeBrowserAccountId(), options.spaceId ?? "page", options.projectId ?? "", options.cwd ?? "project-root",
  options.harnessId ?? "all", options.detail === true || options.verify === true,
]);
const previewPresentationKey = (projectId: string | undefined, harnessId: string | undefined, spaceId?: string, cwd?: string) => JSON.stringify([
  activeBrowserAccountId(), spaceId ?? "page", projectId ?? "default", cwd ?? "project-root",
  `preview:${projectId ?? "default"}:${harnessId ?? "auto"}`,
]);
export function peekHarnessRoster(options: Pick<SnapshotRequest, "projectId" | "spaceId">): HarnessRosterItem[] | undefined {
  return rosterCache.peek(rosterKey(options)) ?? persistedRosters.peekStale(rosterPresentationKey(options));
}
export function readHarnessRoster(options: Pick<SnapshotRequest, "projectId" | "spaceId">): Promise<HarnessRosterItem[]> {
  const key = rosterKey(options);
  const persistentKey = rosterPresentationKey(options);
  const requestRevision = revision;
  const query = options.projectId ? `?projectId=${encodeURIComponent(options.projectId)}` : "";
  return rosterCache.read(key, async () => {
    const persisted = persistedRosters.peek(persistentKey);
    if (persisted) return persisted;
    const rows = await api.get<HarnessRosterItem[]>(`/api/harnesses/roster${query}`);
    if (revision === requestRevision) persistedRosters.write(persistentKey, rows);
    return rows;
  });
}
/** This project's harness roster, or undefined until it is known. */
function useHarnessRoster(projectId: string | undefined, spaceId?: string): HarnessRosterItem[] | undefined {
  const catalogRevision = useCatalogRevision();
  const key = projectId ? rosterKey({ projectId, spaceId }) : "";
  const [result, setResult] = useState<{ key: string; rows: HarnessRosterItem[] }>();
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    void readHarnessRoster({ projectId, spaceId })
      .then((rows) => { if (live) setResult({ key, rows }); })
      .catch(() => { /* unknown: callers keep every remembered pick */ });
    return () => { live = false; };
  }, [key]);
  return !projectId
    ? undefined
    : result?.key === key ? result.rows : peekHarnessRoster({ projectId, spaceId });
}
/** The harness ids the caller may use in this project's Space, or undefined
 *  until the roster is known. The server already leaves out what account
 *  limits, shared-account allowlists and other people's private logins hide,
 *  so a remembered pick or a project default outside this set cannot run. */
export function useVisibleHarnessIds(projectId: string | undefined, spaceId?: string): ReadonlySet<string> | undefined {
  const rows = useHarnessRoster(projectId, spaceId);
  return useMemo(() => rows ? new Set(rows.map((row) => row.identity.id)) : undefined, [rows]);
}
const NO_HARNESS_COLORS: ReadonlyMap<string, string> = new Map();
/** Each harness profile's color by harness id (`harnessColor`), so a logo
 *  outside the picker tabs shows the same tint. Empty until the roster is
 *  known; a harness without a color is absent. */
export function useHarnessColors(projectId: string | undefined, spaceId?: string): ReadonlyMap<string, string> {
  const rows = useHarnessRoster(projectId, spaceId);
  return useMemo(() => {
    if (!rows) return NO_HARNESS_COLORS;
    const colors = new Map<string, string>();
    for (const row of rows) {
      const color = harnessColor(row.identity);
      if (color) colors.set(row.identity.id, color);
    }
    return colors;
  }, [rows]);
}
// One stale-cache recovery per harness and page, so a server that keeps
// listing a harness it then refuses cannot loop invalidations.
const refusedPreviewHarnesses = new Set<string>();
export function peekHarnessSnapshots(options: SnapshotRequest): HarnessSnapshot[] | undefined {
  return harnessCache.peek(snapshotRequestKey(options)) ?? persistedHarnesses.peekStale(snapshotPresentationKey(options));
}
const rememberHarnessSnapshots = (options: SnapshotRequest, rows: HarnessSnapshot[]) => {
  const cached = rows.map((row): HarnessSnapshot => ({
    identity: row.identity,
    availability: row.availability,
    policy: row.policy,
    context: row.context,
    stale: true,
    ...(row.message ? { message: row.message } : {}),
    ...((options.detail || options.verify) && row.catalog ? { catalog: row.catalog } : {}),
  }));
  const keys = new Set<string>();
  if (options.projectId && options.spaceId) keys.add(snapshotPresentationKey(options));
  const context = rows[0]?.context;
  if (context) {
    // projectId itself is Space-owned, so this project-only alias is safe for
    // settings surfaces that do not carry the active Space id explicitly.
    keys.add(snapshotPresentationKey({ ...options, projectId: context.projectId, spaceId: undefined }));
    keys.add(snapshotPresentationKey({ ...options, projectId: context.projectId, spaceId: context.spaceId }));
    keys.add(snapshotPresentationKey({ ...options, projectId: context.projectId, spaceId: context.spaceId, cwd: context.cwd }));
  }
  for (const key of keys) persistedHarnesses.write(key, cached);
};
const reusablePersistedSnapshots = (rows: HarnessSnapshot[]): boolean =>
  // Metadata is presentation, not execution authority. An `unknown` native
  // auth state (Antigravity is one example) is still useful to paint instantly;
  // the switch boundary re-verifies readiness before creating a runtime.
  rows.every((row) => !["starting", "degraded", "offline"].includes(row.availability.state));

export function readHarnessSnapshots(options: SnapshotRequest): Promise<HarnessSnapshot[]> {
  const requestRevision = revision;
  const query = new URLSearchParams();
  if (options.projectId) query.set("projectId", options.projectId);
  // cwd fences browser reuse only. The server derives and validates the path
  // from project/session identity; never accept an authority path from UI.
  if (options.harnessId) query.set("harnessId", options.harnessId);
  if (options.force) query.set("force", "1");
  if (options.detail || options.verify) query.set("detail", "1");
  if (options.verify) query.set("verify", "1");
  if (!options.force && (options.fresh || options.verify)) {
    const key = snapshotRequestKey(options);
    // A revalidation right behind a forced read (which re-keys every
    // consumer) reuses that answer instead of asking twice.
    const recent = harnessCache.peek(key);
    if (options.fresh && !options.verify && recent && Date.now() - (answeredAt.get(key) ?? 0) < 3_000) return Promise.resolve(recent);
    // Revalidate without invalidating every other catalog consumer: the
    // answer replaces only this request's cached rows.
    return api.get<HarnessSnapshot[]>(`/api/harnesses/snapshots?${query}`).then((rows) => {
      if (revision === requestRevision) {
        harnessCache.write(key, rows);
        answeredAt.set(key, Date.now());
        rememberHarnessSnapshots(options, rows);
      }
      return rows;
    });
  }
  if (!options.force) return harnessCache.read(snapshotRequestKey(options), async () => {
    const persisted = persistedHarnesses.peek(snapshotPresentationKey(options));
    if (persisted && reusablePersistedSnapshots(persisted)) return persisted;
    const rows = await api.get<HarnessSnapshot[]>(`/api/harnesses/snapshots?${query}`);
    if (revision === requestRevision) rememberHarnessSnapshots(options, rows);
    return rows;
  });
  // Fetch first: invalidating before the forced response arrives lets
  // subscribers immediately refill the old server-side snapshot. Seed the
  // new revision before notifying them so they reuse this authoritative read.
  return api.get<HarnessSnapshot[]>(`/api/harnesses/snapshots?${query}`).then(async (rows) => {
    invalidateRuntimeCatalogs(false);
    const seeded = await harnessCache.read(snapshotRequestKey(options), async () => rows);
    answeredAt.set(snapshotRequestKey(options), Date.now());
    rememberHarnessSnapshots(options, rows);
    for (const listener of listeners) listener();
    return seeded;
  });
}

const peekLastKnownCatalog = (
  projectId: string | undefined,
  harnessId: string | undefined,
  spaceId?: string,
  cwd?: string,
): Catalog | undefined => {
  if (!projectId) return undefined;
  for (const key of cwd
    ? [previewCatalogKey(projectId, harnessId, spaceId, cwd)]
    : [
      previewCatalogKey(projectId, harnessId, spaceId, cwd),
      previewCatalogKey(projectId, harnessId, spaceId),
    ]) {
    const hit = catalogCache.peek(key) ?? persistedCatalogs.peekStale(previewPresentationKey(projectId, harnessId, spaceId, cwd));
    if (hit?.models.length) return hit;
  }
  if (!harnessId) return undefined;
  const matchesScope = (snapshot: HarnessSnapshot) => snapshot.catalog?.models?.length
    && (!spaceId || snapshot.context?.spaceId === spaceId)
    && (!cwd || snapshot.context?.cwd === cwd);
  for (const detail of [true, false] as const) {
    const snapshot = peekHarnessSnapshots({ projectId, harnessId, spaceId, cwd, detail })?.[0];
    if (snapshot && matchesScope(snapshot)) return catalogFromSnapshot(snapshot, harnessId);
  }
  const listed = peekHarnessSnapshots({ projectId, spaceId })?.find((row) =>
    row.identity.id === harnessId && matchesScope(row));
  if (listed) return catalogFromSnapshot(listed, harnessId);
  return undefined;
};

const catalogFromSnapshot = (snapshot: HarnessSnapshot | undefined, harnessId?: string): Catalog => {
  if (!snapshot || !harnessId) return { ...unavailable, ready: true, discovery: { state: "unavailable", reason: NO_ENGINE_REASON, code: "no-engine" } };
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
  const persisted = persistedCatalogs.peek(previewPresentationKey(projectId, harnessId, spaceId, cwd));
  if (persisted) return catalogCache.read(requestKey, async () => persisted);
  return catalogCache.read(requestKey, async () => {
    const autoSnapshots = () => api.get<HarnessSnapshot[]>(`/api/harnesses/snapshots?${new URLSearchParams({
      ...(projectId ? { projectId } : {}), auto: "1", detail: "1",
    })}`);
    const snapshots = harnessId
      ? await readHarnessSnapshots({ projectId, harnessId, spaceId, cwd, detail: true }).catch((error: unknown) => {
          // The snapshot route's only other 404 is a missing project.
          const refused = error as { status?: unknown; message?: unknown };
          if (refused?.status !== 404 || refused.message !== "harness not found") throw error;
          // An account limit or allowlist hides this harness from the caller.
          // Quietly show the first available one instead, and drop the stored
          // roster once so the pickers stop offering it.
          if (!refusedPreviewHarnesses.has(harnessId)) {
            refusedPreviewHarnesses.add(harnessId);
            queueMicrotask(() => invalidateRuntimeCatalogs());
          }
          return autoSnapshots();
        })
      : await autoSnapshots();
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
      // The preview read rejects so a transient failure is not cached as
      // page-lifetime truth. Carry the structured cause across the rejection so
      // the composer can still tell "no engine" apart from "cannot reach it".
      throw Object.assign(new Error(catalog.discovery.reason), {
        code: "unavailable",
        discoveryCode: catalog.discovery.code,
      });
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
      const persistedAliases = new Set([
        previewPresentationKey(snapshot.context.projectId, resolvedHarnessId, snapshot.context.spaceId, snapshot.context.cwd),
        previewPresentationKey(snapshot.context.projectId, resolvedHarnessId, snapshot.context.spaceId),
        ...(!harnessId
          ? [
              previewPresentationKey(snapshot.context.projectId, undefined, snapshot.context.spaceId, snapshot.context.cwd),
              previewPresentationKey(snapshot.context.projectId, undefined, snapshot.context.spaceId),
            ]
          : []),
      ]);
      for (const alias of persistedAliases) persistedCatalogs.write(alias, catalog);
    }
    return catalog;
  });
};

const hasFreshPersistedCatalogs = (projectId?: string): boolean =>
  projectId
    ? persistedWarmScopes.peek(globalCatalogPresentationKey(projectId)) === true
    : persistedWarmScopes.someFresh();

/** Warm every enabled harness catalog once, then reuse that successful metadata
 * across page reloads for a day. A project-less bootstrap may skip when a fresh
 * persisted catalog exists; scoped consumers still enforce Space/cwd identity. */
export const preloadRuntimeCatalogs = async (
  options: { projectId?: string; spaceId?: string } = {},
): Promise<void> => {
  if (!options.spaceId && hasFreshPersistedCatalogs(options.projectId)) return;
  const preloadRevision = revision;
  const [roster, snapshots] = await Promise.all([
    readHarnessRoster(options),
    readHarnessSnapshots(options),
  ]);
  if (revision !== preloadRevision) return;
  // The process-free roster has no context of its own. Alias it under the
  // authoritative context returned by the matching snapshot so HarnessTabs can
  // survive a reload without a separate roster request.
  const context = snapshots[0]?.context;
  if (context) {
    persistedRosters.write(rosterPresentationKey({ projectId: context.projectId }), roster);
    persistedRosters.write(rosterPresentationKey({
      projectId: context.projectId,
      spaceId: context.spaceId,
    }), roster);
  }
  const results = await Promise.allSettled([
    // Warm Auto as its own route too; the server chooses among the detailed
    // snapshots without committing that choice to any canonical session.
    readPreviewCatalog(options.projectId, undefined, options.spaceId),
    ...roster
      .filter((row) => row.policy.enabled)
      .map((row) => readPreviewCatalog(options.projectId, row.identity.id, options.spaceId)),
  ]);
  if (revision !== preloadRevision || results.some((result) => result.status === "rejected")) return;
  const warmProjectId = context?.projectId ?? options.projectId;
  if (warmProjectId) persistedWarmScopes.write(globalCatalogPresentationKey(warmProjectId), true);
};

export function useCatalogRevision(): number {
  return useSyncExternalStore(subscribeRuntimeCatalogs, () => revision);
}

/** Read the structured cause `readPreviewCatalog` attached to a rejected
 *  preview read, without trusting an arbitrary error payload. */
const runtimeCatalogDiscoveryCode = (error: unknown): RuntimeCatalogDiscoveryCode | undefined =>
  (error as { discoveryCode?: unknown })?.discoveryCode === "no-engine" ? "no-engine" : undefined;

/** The recovery control the composer shows for a route that offers no model.
 *  `no-engine` has nothing to reconnect to; `models-hidden` is an
 *  authoritative account filter that Reconnect cannot change. Both open the
 *  Harnesses settings. Every other named failure (transport, runtime
 *  unavailable, a still-starting runtime) keeps Reconnect. */
export type ComposerRecoveryKind = "manage-harnesses" | "reconnect";
export function composerRecoveryKind(discovery: RuntimeCatalogDiscovery | undefined): ComposerRecoveryKind {
  return discovery?.code === "no-engine" || discovery?.code === "models-hidden"
    ? "manage-harnesses"
    : "reconnect";
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
/** Ask once more on an explicit retry, a return to the foreground or coming
 *  back online; a network failure also retries on a slow timer while visible.
 *  `delayMs` adds one bounded retry for a transient empty answer. */
function scheduleCatalogRetry(network: boolean, retry: () => void, delayMs?: number): () => void {
  let done = false;
  const doc = (globalThis as { document?: Document }).document;
  const win = (globalThis as { window?: Window }).window;
  const fire = () => {
    if (done) return;
    stop();
    retry();
  };
  const onVisible = () => {
    if (doc?.visibilityState !== "hidden") fire();
  };
  const timer = network && delayMs === undefined
    ? setInterval(() => {
        if (doc?.visibilityState !== "hidden") fire();
      }, NETWORK_RETRY_MS)
    : undefined;
  const timeout = delayMs === undefined
    ? undefined
    : setTimeout(() => {
        if (doc?.visibilityState !== "hidden") fire();
      }, delayMs);
  const stop = () => {
    done = true;
    retryListeners.delete(fire);
    doc?.removeEventListener("visibilitychange", onVisible);
    win?.removeEventListener("online", fire);
    if (timer !== undefined) clearInterval(timer);
    if (timeout !== undefined) clearTimeout(timeout);
  };
  retryListeners.add(fire);
  doc?.addEventListener("visibilitychange", onVisible);
  win?.addEventListener("online", fire);
  return stop;
}

export function useRuntimeCatalog(
  session: SessionProjection | null,
  models: ModelDescriptor[],
  agents: AgentDescriptor[],
  prospective?: { projectId?: string; harnessId?: string; spaceId?: string; cwd?: string },
): Catalog {
  const catalogRevision = useCatalogRevision();
  const requestedRouteHarnessId = prospective?.harnessId ?? session?.harnessTransition?.targetHarnessId;
  const previewRoute = Boolean(prospective?.projectId
    && (!session?.id || (requestedRouteHarnessId && requestedRouteHarnessId !== session.resolvedHarnessId)));
  const routeKey = session?.id && !previewRoute
    ? `session:${session.id}:${session.resolvedHarnessId ?? ""}:${session.runtimeLeg?.id ?? ""}:${session.harnessTransition?.id ?? ""}`
    : prospective?.projectId
      ? `draft:${prospective.projectId}:${requestedRouteHarnessId ?? "auto"}`
      : "";
  // Space/account switching reloads the shell, so this memory cache also has
  // a page-lifetime fence. Explicit identity protects mounted route changes.
  const key = routeKey ? JSON.stringify([activeBrowserAccountId(), prospective?.spaceId ?? "page", prospective?.projectId, prospective?.cwd,
    routeKey, catalogRevision]) : "";
  const requestedHarness = previewRoute ? requestedRouteHarnessId : session?.resolvedHarnessId ?? requestedRouteHarnessId;
  const projectId = prospective?.projectId ?? session?.projectId;
  const preloaded = useMemo(
    () => projectId
      ? peekLastKnownCatalog(projectId, requestedHarness, prospective?.spaceId, prospective?.cwd)
      : undefined,
    [catalogRevision, projectId, prospective?.cwd, prospective?.spaceId, requestedHarness],
  );
  const fallbackModels = useMemo(
    () => pickerCatalogModels(models, requestedHarness),
    [models, requestedHarness],
  );
  const fallbackAgents = useMemo(() => requestedHarness
    ? agents.filter((agent) => agent.harnessId === requestedHarness
        || (!agent.harnessId && requestedHarness === "opencode"))
    : agents, [agents, requestedHarness]);
  // Keep the visual route synchronous, but do not claim that an unanswered
  // metadata request is an authoritative empty catalog. Stable empty/fallback
  // identities keep the picker from rebuilding its whole list on unrelated
  // parent renders.
  const warmedModels = fallbackModels.length > 0 ? fallbackModels : preloaded?.models ?? emptyModels;
  const fallback = useMemo<Catalog>(() => ({
    models: warmedModels,
    agents: fallbackModels.length > 0 ? fallbackAgents : preloaded?.agents ?? fallbackAgents,
    nativeDefault: preloaded?.nativeDefault ?? false,
    ready: warmedModels.length > 0,
    ...(requestedHarness ? { harnessId: requestedHarness } : preloaded?.harnessId ? { harnessId: preloaded.harnessId } : {}),
    ...(preloaded?.harnessName ? { harnessName: preloaded.harnessName } : {}),
    discovery: warmedModels.length > 0
      ? { state: "available" as const }
      : { state: "pending" as const },
  }), [fallbackAgents, fallbackModels.length, preloaded, requestedHarness, warmedModels]);
  const [result, setResult] = useState<{ key: string; catalog: Catalog }>();
  const [retryNonce, setRetryNonce] = useState(0);
  // Attempts and the cache bypass belong to one route key. A retry answers
  // from the network instead of the cached empty answer that triggered it.
  const emptyRetry = useRef<{ key: string; attempts: number; bypass: boolean }>({
    key: "",
    attempts: 0,
    bypass: false,
  });
  useEffect(() => {
    // During a switch, the live session route is still the source harness.
    // A preview for the explicit transition target is safe to load and keeps
    // the model picker aligned with the target shown by the harness tabs.
    if (session?.harnessTransition && !previewRoute) return;
    if (!session?.id && !prospective?.projectId) return;
    const controller = new AbortController();
    let stopRetry = (): void => undefined;
    const liveRoute = Boolean(session?.id && !previewRoute);
    const retryState = emptyRetry.current;
    const bypassCache = liveRoute && retryState.key === key && retryState.bypass;
    if (retryState.key === key) retryState.bypass = false;
    // A consumer leaving does not abort a shared metadata read; late results
    // can warm their own key but can never publish into the newly chosen one.
    const load = (): Promise<Catalog> => liveRoute
      ? api.get<Catalog>(`/api/runtime-catalog?sessionId=${encodeURIComponent(session!.id)}`)
      : readPreviewCatalog(prospective!.projectId!, requestedRouteHarnessId, prospective?.spaceId, prospective?.cwd);
    // An empty live answer is a moment in time, not page-lifetime truth: never
    // let it hide a warm catalog from the next mount, and let the retry path
    // ask the server again instead of replaying it.
    const remember = (catalog: Catalog): Catalog => {
      if (liveRoute) {
        if (catalog.models.length > 0) catalogCache.write(key, catalog);
        else catalogCache.delete(key);
      }
      return catalog;
    };
    const request = liveRoute
      ? (bypassCache
          ? api.get<Catalog>(`/api/runtime-catalog?sessionId=${encodeURIComponent(session!.id)}`).then(remember)
          : catalogCache.read(key, load).then(remember))
      : load();
    const normalized = request.then((catalog) => ({
          ...catalog,
          models: pickerCatalogModels(catalog.models, catalog.harnessId ?? requestedHarness),
          discovery: catalog.discovery ?? (catalog.models.length ? { state: "available" as const } : { state: "empty" as const }),
          ready: true,
        }));
    void normalized.then((catalog) => {
      if (controller.signal.aborted) return;
      const liveEmpty = liveRoute && catalog.models.length === 0;
      // A runtime that reported nothing (nativeDefault) or listed rows the
      // picker filtered out may recover without a route change. An empty
      // catalog whose rows were authoritatively hidden for this account must
      // not be papered over with stale models or retried as a transport fault.
      const transientEmpty = liveEmpty
        && catalog.discovery.code !== "models-hidden"
        && (catalog.discovery.code === "runtime-empty"
          || catalog.nativeDefault
          || catalog.discovery.state !== "empty");
      const keepWarm = catalog.models.length === 0
        && fallback.models.length > 0
        && (catalog.discovery.state !== "empty" || transientEmpty);
      if (liveEmpty) {
        const attempts = retryState.key === key ? retryState.attempts : 0;
        retryState.key = key;
        retryState.attempts = attempts + 1;
        retryState.bypass = true;
        // The last empty answer keeps only the ordinary Reconnect/foreground
        // listeners armed, so a user action can still recover the route.
        const delay = transientEmpty ? EMPTY_RETRY_DELAYS_MS[attempts] : undefined;
        stopRetry = scheduleCatalogRetry(false, () => {
          if (!controller.signal.aborted) setRetryNonce((value) => value + 1);
        }, delay);
      } else if (retryState.key === key) {
        emptyRetry.current = { key, attempts: 0, bypass: false };
      }
      setResult({
        key,
        catalog: keepWarm
          ? { ...catalog, models: fallback.models, discovery: { state: "available" }, ready: true }
          : catalog,
      });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const network = isNetworkFailure(error);
      const discoveryCode = runtimeCatalogDiscoveryCode(error);
      setResult({
        key,
        catalog: {
          ...fallback,
          ready: true,
          discovery: fallback.models.length > 0
            ? { state: "available" }
            : {
                state: "unavailable",
                reason: network
                  ? NETWORK_FAILURE_REASON
                  : (error as { message?: string })?.message?.trim() || "The engine could not be reached",
                ...(discoveryCode ? { code: discoveryCode } : {}),
              },
        },
      });
      stopRetry = scheduleCatalogRetry(network, () => {
        if (!controller.signal.aborted) setRetryNonce((value) => value + 1);
      });
    });
    return () => {
      controller.abort();
      stopRetry();
    };
  }, [key, previewRoute, session?.id, session?.harnessTransition, prospective?.projectId, requestedRouteHarnessId, retryNonce]);
  return !key
    ? { models, agents, nativeDefault: false, ready: true, discovery: models.length > 0 ? { state: "available" } : { state: "empty" } }
    : result?.key === key ? result.catalog : catalogCache.peek(key) ?? preloaded ?? fallback;
}

export type HarnessModelGroup = { harnessId: string; name: string; models: ModelDescriptor[] };
const emptyGroups: HarnessModelGroup[] = [];
/** Every other enabled, runnable harness's last known catalog, for the model
 * picker's cross-harness search. Cache-only presentation: it never probes a
 * harness, so a catalog that was never warmed simply contributes nothing. */
export function useOtherHarnessModels(options: {
  projectId?: string;
  spaceId?: string;
  cwd?: string;
  excludeHarnessId?: string;
  enabled?: boolean;
}): HarnessModelGroup[] {
  const catalogRevision = useCatalogRevision();
  const { projectId, spaceId, cwd, excludeHarnessId, enabled = true } = options;
  return useMemo(() => {
    if (!enabled || !projectId) return emptyGroups;
    const snapshots = peekHarnessSnapshots({ projectId, spaceId }) ?? [];
    const groups: HarnessModelGroup[] = [];
    for (const row of peekHarnessRoster({ projectId, spaceId }) ?? []) {
      const harnessId = row.identity.id;
      if (!row.policy.enabled || harnessId === excludeHarnessId) continue;
      // Same rule as the harness tabs: once probed, an unusable harness is not offered.
      if (snapshotUnavailableReason(snapshots.find((snapshot) => snapshot.identity.id === harnessId))) continue;
      const catalog = peekLastKnownCatalog(projectId, harnessId, spaceId, cwd);
      if (catalog?.discovery.state !== "available") continue;
      groups.push({
        harnessId,
        name: row.identity.name,
        models: catalog.models.map((model) => model.harnessId ? model : { ...model, harnessId }),
      });
    }
    return groups.length ? groups : emptyGroups;
  }, [catalogRevision, cwd, enabled, excludeHarnessId, projectId, spaceId]);
}
