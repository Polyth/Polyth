import { api } from "@polyth/session/web-api";
import { installIntegrationsPackage } from "./integrations.ts";
import { installMcpPackage } from "./mcp.ts";
import { configurePackageReconcile, reconcilePackage } from "./reconcile.ts";
import { registerBuiltinPackageTours } from "./onboarding/builtinTours.ts";
import { getState, openWorkspacePane, setActiveView } from "../store.ts";
import { loadWebPackageInstallers } from "./webEntries.ts";
import { webPackageHost } from "./webHost.ts";

// Tours for surfaces without an installer (built-in settings pages) exist for
// the whole app session, independent of package enable/disable syncing.
registerBuiltinPackageTours();

type PackageInstaller = () => () => void;

const installers = new Map<string, PackageInstaller>([
  ["mcp", installMcpPackage],
  ["integrations", installIntegrationsPackage],
]);

// Some backend package names describe the implementation package rather than
// the user-facing feature. Keep settings metadata stable across either form.
const aliases = new Map<string, string>([
  ["dictation", "voice"],
]);

const active = new Map<string, () => void>();
let enabled = new Set<string>();
const packageStates = new Map<string, boolean>();
const listeners = new Set<() => void>();
let bootQueue = Promise.resolve();
let webEntriesLoaded: Promise<void> | null = null;

const canonicalId = (id: string): string => aliases.get(id) ?? id;

const applyCanonicalState = (id: string): void => {
  const canonical = canonicalId(id);
  const shouldEnable = [...packageStates].some(
    ([candidate, value]) => value && canonicalId(candidate) === canonical,
  );
  if (shouldEnable) {
    enabled.add(canonical);
    if (!active.has(canonical)) {
      const install = installers.get(canonical);
      if (install) active.set(canonical, install());
    }
  } else {
    enabled.delete(canonical);
    const unregister = active.get(canonical);
    unregister?.();
    active.delete(canonical);
  }
};

configurePackageReconcile({
  packageStates,
  applyCanonicalState,
  notify: () => {
    for (const listener of [...listeners]) listener();
  },
});

async function syncPackages(): Promise<void> {
  webEntriesLoaded ??= loadWebPackageInstallers(webPackageHost).then((discovered) => {
    for (const [id, install] of discovered) {
      const canonical = canonicalId(id);
      if (installers.has(canonical)) {
        throw new Error(`web package installer already registered: ${canonical}`);
      }
      installers.set(canonical, install);
    }
  });
  await webEntriesLoaded;
  const response = await api.packagesList();
  const next = new Set<string>();
  packageStates.clear();
  for (const descriptor of response.packages) {
    packageStates.set(descriptor.id, descriptor.enabled);
    if (descriptor.enabled) next.add(canonicalId(descriptor.id));
  }

  for (const [id, unregister] of [...active]) {
    if (next.has(id)) continue;
    unregister();
    active.delete(id);
  }

  enabled = next;
  for (const id of next) {
    if (active.has(id)) continue;
    const install = installers.get(id);
    if (install) active.set(id, install());
  }
  // Migrate pre-window active-view preferences after package registration.
  const restoredView = getState().activeView;
  if (restoredView !== "session" && !openWorkspacePane(restoredView)) {
    setActiveView("session");
  }

  for (const listener of [...listeners]) listener();
}

export { reconcilePackage };

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
