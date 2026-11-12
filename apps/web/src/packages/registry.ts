import { api } from "@polyth/session/web-api";
import { invalidateRuntimeCatalogs, reconcileHarnessTopology } from "@polyth/models/runtime-catalog";
import { installMcpPackage } from "./mcp.ts";
import { configurePackageReconcile, reconcilePackage } from "./reconcile.ts";
import { registerBuiltinPackageTours } from "./onboarding/builtinTours.ts";
import { getState, openWorkspacePane, setActiveView, setRailPlugin, subscribeStore } from "../store.ts";
import { hasSurfaceRegistration, isSurfaceProjectRelevant } from "../surfaces.ts";
import {
  activateWebPackage,
  loadWebPackageCatalog,
  type WebEntryLoaderOptions,
  type WebPackageAsset,
} from "./webEntries.ts";
import { createPackageActivation } from "./activation.ts";
import { webPackageHost } from "./webHost.ts";
import { replaceProjectPackageCatalog, setProjectCompositionContext } from "./projectRelevance.ts";
import { installProjectWidgetReconciler } from "./projectWidgetReconcile.ts";
import { installCapabilityArrivalReconciler } from "../capabilityArrivals.ts";

registerBuiltinPackageTours();
installProjectWidgetReconciler();

type PackageInstaller = () => () => void;

const builtinInstallers = new Map<string, PackageInstaller>([
  ["mcp", installMcpPackage],
]);

const aliases = new Map<string, string>([
  ["dictation", "voice"],
]);

type PackageRuntime = {
  generation: number;
  desired: boolean;
  state: "inactive" | "loading" | "active" | "failed";
  dispose: (() => void) | null;
  inflight: Promise<void> | null;
  hadFailure: boolean;
};

const runtimes = new Map<string, PackageRuntime>();
let enabled = new Set<string>();
const packageStates = new Map<string, boolean>();
const listeners = new Set<() => void>();
let bootQueue = Promise.resolve();
let packagesSynced = false;
let harnessTopologySynced = false;
let catalogByCanonical = new Map<string, WebPackageAsset>();
let loaderOptions: WebEntryLoaderOptions = {};

// An installer publishes to stores the shell renders from, and React commits at
// the end of the task that did it. Installing each package in the task its
// import resolved in re-rendered the shell once per package, which costs far
// more than the modules themselves. So installs that arrive together run
// synchronously in one task and commit once. A slow import holds the others
// back for at most the window, and a batch that outruns its slice yields so
// the commit that follows does not make one long task of it. A hidden tab paints
// nothing and throttles its timers, so there installs simply run.
const INSTALL_BATCH_WINDOW_MS = 100;
let installSliceMs = 16;
let pendingInstalls: Array<() => void> = [];
let installTimer: ReturnType<typeof setTimeout> | null = null;
let importsInFlight = 0;

const pageHidden = (): boolean =>
  typeof document !== "undefined" && document.visibilityState === "hidden";

function flushInstalls(): void {
  if (installTimer !== null) clearTimeout(installTimer);
  installTimer = null;
  const deadline = performance.now() + installSliceMs;
  while (pendingInstalls.length > 0) {
    pendingInstalls.shift()!();
    if (pendingInstalls.length > 0 && performance.now() >= deadline && !pageHidden()) {
      installTimer = setTimeout(flushInstalls, 0);
      return;
    }
  }
}

function scheduleInstall(install: () => void): void {
  pendingInstalls.push(install);
  if (pageHidden()) flushInstalls();
  else installTimer ??= setTimeout(flushInstalls, INSTALL_BATCH_WINDOW_MS);
}

/** One import no longer outstanding. The last one needs no window to wait out. */
function noteImportFinished(): void {
  importsInFlight -= 1;
  if (importsInFlight === 0 && pendingInstalls.length > 0) flushInstalls();
}

const canonicalId = (id: string): string => aliases.get(id) ?? id;
const isHarnessTopologyPackage = (id: string): boolean =>
  id === "harness-runtime" || id.startsWith("backend-");

const syncProjectCompositionContext = (): void => {
  const state = getState();
  const project = state.projectRegistry.projects.find((candidate) => candidate.id === state.activeProjectId);
  setProjectCompositionContext(project?.id ?? null, project?.composition, { personal: project?.personal === true });

  // Preserve unknown ids for late web-package registration, but close a
  // surface we KNOW is registered when the newly active project's composition
  // makes its owner irrelevant. Without the raw-registration probe the
  // relevance-filtered catalog made this case indistinguishable from "not
  // loaded yet", leaving railPlugin set and rendering an empty open pane.
  const rail = state.railPlugin;
  if (rail !== null && hasSurfaceRegistration(rail) && !isSurfaceProjectRelevant(rail)) {
    setRailPlugin(null);
  }
};

subscribeStore(syncProjectCompositionContext);
syncProjectCompositionContext();

const runtimeOf = (canonical: string): PackageRuntime => {
  let rec = runtimes.get(canonical);
  if (!rec) {
    rec = { generation: 0, desired: false, state: "inactive", dispose: null, inflight: null, hadFailure: false };
    runtimes.set(canonical, rec);
  }
  return rec;
};

const refreshDesired = (canonical: string): boolean => {
  const desired = [...packageStates].some(
    ([candidate, value]) => value && canonicalId(candidate) === canonical,
  );
  const rec = runtimeOf(canonical);
  rec.desired = desired;
  if (desired) enabled.add(canonical);
  else enabled.delete(canonical);
  return desired;
};

async function applyCanonicalState(id: string): Promise<void> {
  const canonical = canonicalId(id);
  const rec = runtimeOf(canonical);
  const desired = refreshDesired(canonical);

  if (!desired) {
    rec.generation += 1;
    rec.dispose?.();
    rec.dispose = null;
    rec.state = "inactive";
    return;
  }

  if (rec.state === "active") return;
  if (rec.state === "loading" && rec.inflight) return rec.inflight;

  const gen = ++rec.generation;
  rec.state = "loading";
  const isCurrent = () => rec.generation === gen && rec.desired;

  const work = (async () => {
    try {
      const builtin = builtinInstallers.get(canonical);
      if (builtin) {
        if (!isCurrent()) return;
        rec.dispose = builtin();
        rec.state = "active";
        return;
      }
      const asset = catalogByCanonical.get(canonical);
      if (!asset) {
        if (!isCurrent()) return;
        rec.state = "inactive";
        return;
      }
      const loading = rec.hadFailure
        ? { ...asset, module: `${asset.module}?retry=${gen}` }
        : asset;
      let importFinished = false;
      const finishImport = (): void => {
        if (importFinished) return;
        importFinished = true;
        noteImportFinished();
      };
      importsInFlight += 1;
      let handle: Awaited<ReturnType<typeof activateWebPackage>>;
      try {
        handle = await activateWebPackage(loading, {
          ...loaderOptions,
          createActivation: (ownerPackageId) => createPackageActivation(ownerPackageId, webPackageHost),
          isCurrent,
          scheduleInstall: (install) => {
            scheduleInstall(install);
            finishImport();
          },
        });
      } finally {
        // A cancelled or failed import never reaches scheduleInstall.
        finishImport();
      }
      if (!isCurrent()) {
        handle.dispose();
        if (rec.generation === gen) rec.state = "inactive";
        return;
      }
      rec.dispose = handle.dispose;
      rec.state = "active";
      rec.hadFailure = false;
    } catch (error) {
      if (rec.generation !== gen) return;
      rec.dispose = null;
      rec.state = "failed";
      rec.hadFailure = true;
      console.error(`[polyth] web package "${assetId(canonical)}" failed to activate`, error);
      scheduleRecovery();
    }
  })();

  rec.inflight = work;
  try {
    await work;
  } finally {
    if (rec.inflight === work) rec.inflight = null;
  }
}

function assetId(canonical: string): string {
  return catalogByCanonical.get(canonical)?.id ?? canonical;
}

function knownCanonicalIds(): string[] {
  const ids = new Set<string>([
    ...[...packageStates.keys()].map(canonicalId),
    ...catalogByCanonical.keys(),
    ...builtinInstallers.keys(),
    ...runtimes.keys(),
  ]);
  return [...ids];
}

configurePackageReconcile({
  packageStates,
  applyCanonicalState: (id) => {
    if (isHarnessTopologyPackage(id)) invalidateRuntimeCatalogs();
    refreshDesired(canonicalId(id));
    void applyCanonicalState(id);
  },
  notify: () => {
    for (const listener of [...listeners]) listener();
  },
});

async function syncPackages(): Promise<void> {
  const previousHarnessStates = new Map(
    [...packageStates].filter(([id]) => isHarnessTopologyPackage(id)),
  );
  const [catalog, response] = await Promise.all([
    loadWebPackageCatalog(loaderOptions),
    api.packagesList(),
  ]);
  const nextCatalog = new Map<string, WebPackageAsset>();
  for (const asset of catalog) {
    const canonical = canonicalId(asset.id);
    const existing = nextCatalog.get(canonical);
    if (existing && existing.id !== asset.id) {
      throw new Error(`web package alias collision: "${asset.id}" and "${existing.id}"`);
    }
    if (builtinInstallers.has(canonical)) {
      throw new Error(`web package installer already registered: ${canonical}`);
    }
    nextCatalog.set(canonical, asset);
  }
  catalogByCanonical = nextCatalog;

  replaceProjectPackageCatalog(response.packages);
  packageStates.clear();
  for (const descriptor of response.packages) {
    packageStates.set(descriptor.id, descriptor.enabled);
  }
  const nextHarnessStates = new Map(
    [...packageStates].filter(([id]) => isHarnessTopologyPackage(id)),
  );
  // The first sync of a page establishes the baseline; it does not change it.
  // Treating "unknown → known" as a topology change wiped the day-long
  // persisted catalogs on every page load, so short-lived clients (phones,
  // PWA resumes) never got to paint from them before discovery finished.
  const harnessTopologyChanged = harnessTopologySynced
    && (previousHarnessStates.size !== nextHarnessStates.size
      || [...nextHarnessStates].some(([id, value]) => previousHarnessStates.get(id) !== value));
  harnessTopologySynced = true;
  if (harnessTopologyChanged) invalidateRuntimeCatalogs();
  // The baseline above only covers this page's lifetime. A harness package
  // added between page loads is only visible against the topology recorded
  // next to the persisted catalogs.
  reconcileHarnessTopology(JSON.stringify([...nextHarnessStates].toSorted(
    ([left], [right]) => left.localeCompare(right),
  )));

  const ids = knownCanonicalIds();
  for (const id of ids) refreshDesired(id);
  await Promise.all(ids.map((id) => applyCanonicalState(id)));

  const restoredView = getState().activeView;
  if (restoredView !== "session" && !openWorkspacePane(restoredView)) {
    setActiveView("session");
  }

  packagesSynced = true;
  for (const listener of [...listeners]) listener();
}

export { reconcilePackage };

export function configureWebPackageLoader(options: WebEntryLoaderOptions): void {
  loaderOptions = options;
}

export function bootPackages(): Promise<void> {
  const run = bootQueue.then(syncPackages, syncPackages);
  bootQueue = run.catch(() => undefined);
  run.then(() => { bootFailed = false; }, () => {
    bootFailed = true;
    scheduleRecovery();
  });
  return run;
}

// A page can load while the server is rewriting its web build (or over a
// flaky phone connection): the manifest or a package entry 404s once, and
// without another attempt that package — the approval card, say — stays
// missing until a manual reload while the server-side status keeps saying it
// waits. Failed work is retried with backoff, and at once when the page
// returns to the foreground or the network comes back. A retried entry is
// cache-busted (`?retry=`) because the browser memoises a failed module URL.
let recoveryDelaysMs: readonly number[] = [1_000, 3_000, 10_000, 30_000, 60_000];
let recoveryAttempt = 0;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let bootFailed = false;

const failedCanonicalIds = (): string[] =>
  [...runtimes].filter(([, rec]) => rec.desired && rec.state === "failed").map(([id]) => id);

function scheduleRecovery(): void {
  if (recoveryTimer !== null) return;
  const delay = recoveryDelaysMs[Math.min(recoveryAttempt, recoveryDelaysMs.length - 1)] ?? 60_000;
  recoveryAttempt += 1;
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    void recoverPackages();
  }, delay);
  (recoveryTimer as { unref?: () => void }).unref?.();
}

async function recoverPackages(): Promise<void> {
  // A hidden page waits for the foreground instead of spending its retries.
  if (pageHidden()) return;
  if (bootFailed) {
    // bootPackages() reschedules itself if the catalog is still unreachable.
    await bootPackages().catch(() => undefined);
  } else {
    await Promise.all(failedCanonicalIds().map((id) => applyCanonicalState(id)));
  }
  if (!bootFailed && failedCanonicalIds().length === 0) recoveryAttempt = 0;
}

function recoverNow(): void {
  if (!bootFailed && failedCanonicalIds().length === 0) return;
  if (recoveryTimer !== null) clearTimeout(recoveryTimer);
  recoveryTimer = null;
  void recoverPackages();
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("online", recoverNow);
  window.addEventListener("pageshow", recoverNow);
}
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("visibilitychange", () => {
    if (!pageHidden()) recoverNow();
  });
}

/** Test seam: how long one batch of installs runs before it yields. */
export function configureInstallBatches(options: { sliceMs: number }): void {
  installSliceMs = options.sliceMs;
}

/** Test seam: the backoff schedule for failed package work. */
export function configurePackageRecovery(options: { delaysMs: readonly number[] }): void {
  recoveryDelaysMs = options.delaysMs;
  recoveryAttempt = 0;
  if (recoveryTimer !== null) clearTimeout(recoveryTimer);
  recoveryTimer = null;
}

export function isPackageEnabled(id: string): boolean {
  return enabled.has(canonicalId(id));
}

export function subscribePackages(callback: () => void): () => void {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

export async function whenPackagesSettled(): Promise<void> {
  // bootPackages() and init() start concurrently. Waiting only on runtime
  // records could resolve before catalog/API discovery has even populated them.
  // The queue is the authoritative latest boot/reconcile barrier.
  await bootQueue;
  await Promise.all([...runtimes.values()].map((rec) => rec.inflight ?? Promise.resolve()));
}

// After the module's state is initialized: the reconciler subscribes at once.
installCapabilityArrivalReconciler({
  packagesSynced: () => packagesSynced,
  subscribePackages,
});
