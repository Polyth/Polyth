import { api } from "@polyth/session/web-api";
import { invalidateRuntimeCatalogs, reconcileHarnessTopology } from "@polyth/models/runtime-catalog";
import { installIntegrationsPackage } from "./integrations.ts";
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

registerBuiltinPackageTours();
installProjectWidgetReconciler();

type PackageInstaller = () => () => void;

const builtinInstallers = new Map<string, PackageInstaller>([
  ["mcp", installMcpPackage],
  ["integrations", installIntegrationsPackage],
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
let harnessTopologySynced = false;
let catalogByCanonical = new Map<string, WebPackageAsset>();
let loaderOptions: WebEntryLoaderOptions = {};

const canonicalId = (id: string): string => aliases.get(id) ?? id;
const isHarnessTopologyPackage = (id: string): boolean =>
  id === "harness-runtime" || id.startsWith("backend-");

const syncProjectCompositionContext = (): void => {
  const state = getState();
  const project = state.projectRegistry.projects.find((candidate) => candidate.id === state.activeProjectId);
  setProjectCompositionContext(project?.id ?? null, project?.composition);

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
      const handle = await activateWebPackage(loading, {
        ...loaderOptions,
        createActivation: (ownerPackageId) => createPackageActivation(ownerPackageId, webPackageHost),
        isCurrent,
      });
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

  for (const listener of [...listeners]) listener();
}

export { reconcilePackage };

export function configureWebPackageLoader(options: WebEntryLoaderOptions): void {
  loaderOptions = options;
}

export function bootPackages(): Promise<void> {
  const run = bootQueue.then(syncPackages, syncPackages);
  bootQueue = run.catch(() => undefined);
  return run;
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
