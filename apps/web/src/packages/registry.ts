import { api } from "../api.ts";
import { installAgentsPackage } from "./agents.ts";
import { installCommandsPackage } from "./commands.ts";
import { installGitPackage } from "./git.ts";
import { installHomeAssistantPackage } from "./home-assistant.ts";
import { installIntegrationsPackage } from "./integrations.ts";
import { installMcpPackage } from "./mcp.ts";
import { installModelsPackage } from "./models.ts";
import { installPluginsPackage } from "./plugins.ts";
import { installSecureSafePackage } from "./secure-safe.ts";
import { combineUnregister } from "./settingsPage.ts";
import { installUsagePackage } from "./usage.ts";
import { installVoicePackage } from "./voice.ts";
import { configurePackageReconcile, reconcilePackage } from "./reconcile.ts";

type PackageInstaller = () => () => void;

const installers = new Map<string, PackageInstaller>([
  ["voice", installVoicePackage],
  ["git", installGitPackage],
  ["usage", installUsagePackage],
  ["models", () => combineUnregister(installModelsPackage(), installAgentsPackage())],
  ["mcp", installMcpPackage],
  ["commands", installCommandsPackage],
  ["integrations", installIntegrationsPackage],
  ["plugins", installPluginsPackage],
  ["secure-safe", installSecureSafePackage],
  ["home-assistant", installHomeAssistantPackage],
]);

// Some backend package names describe the implementation package rather than
// the user-facing feature. Keep settings metadata stable across either form.
const aliases = new Map<string, string>([
  ["dictation", "voice"],
  ["github", "integrations"],
]);

const active = new Map<string, () => void>();
let enabled = new Set<string>();
const packageStates = new Map<string, boolean>();
const listeners = new Set<() => void>();
let bootQueue = Promise.resolve();

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
