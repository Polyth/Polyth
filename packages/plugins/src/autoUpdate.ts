import type { PluginRegistry } from "./managedRegistry.ts";

/** How stale a package's last check may get before the host checks again. */
export const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How often operator-local sources are stat-ed for a new version. */
export const LOCAL_SOURCE_TICK_MS = 30 * 1000;
const TICK_MS = 15 * 60 * 1000;
const FIRST_TICK_MS = 2 * 60 * 1000;

export interface AutoUpdaterOptions {
  registry: Pick<PluginRegistry, "list" | "checkUpdate" | "update">;
  /** Apply a staged update; the host wraps it with connection retirement. */
  apply: (id: string) => Promise<unknown>;
  intervalMs?: number;
  now?: () => number;
}

export interface LocalSourceUpdaterOptions {
  registry: Pick<PluginRegistry, "checkUpdate" | "changedLocalSources">;
  apply: (id: string) => Promise<unknown>;
}

/** Check one package and stage an update only when the check found one.
 *  Updates go through the ordinary candidate path, so new access still waits
 *  for review instead of activating. */
async function checkAndApply(
  options: { registry: Pick<PluginRegistry, "checkUpdate">; apply: (id: string) => Promise<unknown> },
  id: string,
): Promise<boolean> {
  try {
    const checked = await options.registry.checkUpdate(id);
    if (!checked.updateCheck?.available) return false;
    await options.apply(id);
    return true;
  } catch {
    // Recorded in updateCheck.error by the registry.
    return false;
  }
}

/** One pass over opted-in packages: check each due source. Failures are
 *  recorded on the package by the registry and never stop the pass. */
export async function runAutoUpdates(options: AutoUpdaterOptions): Promise<string[]> {
  const interval = options.intervalMs ?? AUTO_UPDATE_INTERVAL_MS;
  const now = options.now?.() ?? Date.now();
  const updated: string[] = [];
  for (const plugin of options.registry.list()) {
    if (!plugin.autoUpdate || plugin.updatable === false) continue;
    if (plugin.update) continue; // a staged candidate already awaits review
    if (plugin.updateCheck && now - plugin.updateCheck.checkedAt < interval) continue;
    if (await checkAndApply(options, plugin.id)) updated.push(plugin.id);
  }
  return updated;
}

/** Check each opted-in package whose operator-local source changed since its
 *  last check, so a new local version applies within a tick instead of
 *  waiting out the interval. Every check records the source stamp it saw, so
 *  an unchanged source is not checked again — after a restart or a rollback
 *  either — and a failed check waits for the next change or the full pass. */
export async function runLocalSourceUpdates(options: LocalSourceUpdaterOptions): Promise<string[]> {
  const updated: string[] = [];
  for (const id of options.registry.changedLocalSources()) {
    if (await checkAndApply(options, id)) updated.push(id);
  }
  return updated;
}

/** Periodic driver: a full pass every tick, plus a cheap look at local
 *  sources every 30 seconds. Passes run one at a time and a pass already
 *  queued is not queued twice. Returns a disposer that stops future passes; a
 *  pass in flight finishes under the registry's per-package locks. */
export function startAutoUpdater(
  options: AutoUpdaterOptions & { registry: Pick<PluginRegistry, "changedLocalSources"> },
): { dispose(): void } {
  const queued = new Set<string>();
  let chain: Promise<unknown> = Promise.resolve();
  let disposed = false;
  let localTimer: ReturnType<typeof setInterval> | undefined;
  const schedule = (name: string, pass: () => Promise<unknown>) => {
    if (disposed || queued.has(name)) return;
    queued.add(name);
    chain = chain
      .then(() => {
        queued.delete(name);
        return disposed ? undefined : pass();
      })
      .catch(() => {});
  };
  const full = () => schedule("full", () => runAutoUpdates(options));
  const local = () => schedule("local", () => runLocalSourceUpdates(options));
  const first = setTimeout(() => {
    // Local sources first: a check they make is fresh by the time the full pass lists.
    local();
    full();
    localTimer = setInterval(local, LOCAL_SOURCE_TICK_MS);
    localTimer.unref?.();
  }, FIRST_TICK_MS);
  const timer = setInterval(full, TICK_MS);
  first.unref?.();
  timer.unref?.();
  return {
    dispose() {
      disposed = true;
      clearTimeout(first);
      clearInterval(timer);
      clearInterval(localTimer);
    },
  };
}
