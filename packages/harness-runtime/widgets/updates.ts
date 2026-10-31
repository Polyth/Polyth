import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { HarnessUpdateStatus } from "@polyth/contracts";
import { createApiTransport } from "@polyth/web-sdk";
import { invalidateRuntimeCatalogs } from "@polyth/models/runtime-catalog";

const api = createApiTransport();

/** The server caches release lookups for hours; this page only needs to ask
 *  again when it opens later or someone presses Check again. */
const CLIENT_TTL_MS = 10 * 60_000;

export type HarnessUpdateRun =
  | { state: "running"; startedAt: number }
  | { state: "done"; at: number; output: string; from?: string; to?: string }
  | { state: "failed"; at: number; output: string; exitCode: number | null; message?: string };

type ProjectEntry = { statuses: ReadonlyMap<string, HarnessUpdateStatus>; loadedAt?: number; loading?: Promise<void> };
type Snapshot = { projects: ReadonlyMap<string, ProjectEntry>; runs: ReadonlyMap<string, HarnessUpdateRun> };

let snapshot: Snapshot = { projects: new Map(), runs: new Map() };
const listeners = new Set<() => void>();
const publish = (next: Snapshot) => {
  snapshot = next;
  for (const listener of [...listeners]) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const projectKey = (projectId?: string | null) => projectId ?? "";
const emptyStatuses: ReadonlyMap<string, HarnessUpdateStatus> = new Map();

/** Ask whether newer releases are published. A server without the route, or
 *  one that cannot reach a registry, simply reports nothing new. */
export function loadHarnessUpdates(projectId?: string | null, options: { force?: boolean } = {}): Promise<void> {
  const key = projectKey(projectId);
  const current = snapshot.projects.get(key);
  if (!options.force && current?.loading) return current.loading;
  if (!options.force && current?.loadedAt !== undefined && Date.now() - current.loadedAt < CLIENT_TTL_MS) return Promise.resolve();
  const query = new URLSearchParams();
  if (projectId) query.set("projectId", projectId);
  if (options.force) query.set("force", "1");
  const search = query.toString();
  const loading = api.get<HarnessUpdateStatus[]>(`/api/harnesses/updates${search ? `?${search}` : ""}`).then((rows) => {
    const entry: ProjectEntry = { statuses: new Map(rows.map((row) => [row.harnessId, row])), loadedAt: Date.now() };
    publish({ ...snapshot, projects: new Map(snapshot.projects).set(key, entry) });
  }, () => {
    const previous = snapshot.projects.get(key);
    publish({ ...snapshot, projects: new Map(snapshot.projects).set(key, { statuses: previous?.statuses ?? emptyStatuses, loadedAt: Date.now() }) });
  });
  publish({ ...snapshot, projects: new Map(snapshot.projects).set(key, { statuses: current?.statuses ?? emptyStatuses, ...(current?.loadedAt !== undefined ? { loadedAt: current.loadedAt } : {}), loading }) });
  return loading;
}

/** Run the harness CLI's own updater on this machine (instance owner only;
 *  the server enforces it). Running conversations keep the old binary until
 *  their runtime restarts. */
export async function runHarnessUpdate(harnessId: string, projectId?: string | null): Promise<HarnessUpdateRun> {
  if (snapshot.runs.get(harnessId)?.state === "running") return snapshot.runs.get(harnessId)!;
  const before = snapshot.projects.get(projectKey(projectId))?.statuses.get(harnessId);
  const setRun = (run: HarnessUpdateRun) => publish({ ...snapshot, runs: new Map(snapshot.runs).set(harnessId, run) });
  setRun({ state: "running", startedAt: Date.now() });
  let result: { ok: boolean; exitCode: number | null; output: string } | undefined;
  let message: string | undefined;
  try {
    result = await api.post<{ ok: boolean; exitCode: number | null; output: string }>(`/api/harnesses/${encodeURIComponent(harnessId)}/update`, {});
  } catch (cause) {
    message = cause instanceof Error ? cause.message : String(cause);
  }
  // The server dropped this harness's snapshot and model caches. Re-read the
  // installed version before reporting: an updater may follow its own release
  // channel, so the outcome names what is installed now, not what was hoped.
  invalidateRuntimeCatalogs();
  await loadHarnessUpdates(projectId, { force: true });
  const after = snapshot.projects.get(projectKey(projectId))?.statuses.get(harnessId);
  const run: HarnessUpdateRun = result?.ok
    ? { state: "done", at: Date.now(), output: result.output, ...(before?.current ? { from: before.current } : {}), ...(after?.current ? { to: after.current } : {}) }
    : { state: "failed", at: Date.now(), output: result?.output ?? "", exitCode: result?.exitCode ?? null, ...(message ? { message } : {}) };
  setRun(run);
  return run;
}

export function dismissHarnessUpdateRun(harnessId: string): void {
  if (!snapshot.runs.has(harnessId) || snapshot.runs.get(harnessId)?.state === "running") return;
  const runs = new Map(snapshot.runs);
  runs.delete(harnessId);
  publish({ ...snapshot, runs });
}

/** Update availability for one project's harnesses, loaded on first use. */
export function useHarnessUpdates(projectId?: string | null) {
  const current = useSyncExternalStore(subscribe, () => snapshot);
  useEffect(() => { void loadHarnessUpdates(projectId); }, [projectId]);
  const entry = current.projects.get(projectKey(projectId));
  const refresh = useCallback((force = false) => loadHarnessUpdates(projectId, { force }), [projectId]);
  return {
    statuses: entry?.statuses ?? emptyStatuses,
    loading: Boolean(entry?.loading),
    runs: current.runs,
    refresh,
  };
}

/** A newer release the caller may install from Settings right now. */
export const installableUpdate = (status: HarnessUpdateStatus | undefined): status is HarnessUpdateStatus & { latest: string } =>
  Boolean(status?.available && status.canUpdate && status.latest);
