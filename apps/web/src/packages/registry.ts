import { api } from "../api.ts";
import { installAgentsPackage } from "./agents.ts";
import { installCommandsPackage } from "./commands.ts";
import { installGitPackage } from "./git.ts";
import { installGithubPackage } from "./github.ts";
import { installHomeAssistantPackage } from "./home-assistant.ts";
import { installIntegrationsPackage } from "./integrations.ts";
import { installKnowledgePackage } from "./knowledge.ts";
import { installMcpPackage } from "./mcp.ts";
import { installModelsPackage } from "./models.ts";
import { installPluginsPackage } from "./plugins.ts";
import { installSecureSafePackage } from "./secure-safe.ts";
import { installSshPackage } from "./ssh.ts";
import { installTaskTrackersPackage } from "./task-trackers.ts";
import { combineUnregister } from "./settingsPage.ts";
import { installUsagePackage } from "./usage.ts";
import { installVoicePackage } from "./voice.ts";
import { installWorkflowPackage } from "./workflow.ts";
import { configurePackageReconcile, reconcilePackage } from "./reconcile.ts";
import { registerBuiltinPackageTours } from "./onboarding/builtinTours.ts";
import { getState, setActiveView } from "../store.ts";

// Tours for surfaces without an installer (built-in settings pages) exist for
// the whole app session, independent of package enable/disable syncing.
registerBuiltinPackageTours();

type PackageInstaller = () => () => void;

const installers = new Map<string, PackageInstaller>([
  ["voice", installVoicePackage],
  ["git", installGitPackage],
  ["github", installGithubPackage],
  ["usage", installUsagePackage],
  ["models", () => combineUnregister(installModelsPackage(), installAgentsPackage())],
  ["mcp", installMcpPackage],
  ["commands", installCommandsPackage],
  ["integrations", installIntegrationsPackage],
  ["plugins", installPluginsPackage],
  ["knowledge", installKnowledgePackage],
  ["secure-safe", installSecureSafePackage],
  ["home-assistant", installHomeAssistantPackage],
  ["ssh", installSshPackage],
  ["task-trackers", installTaskTrackersPackage],
  ["workflow", installWorkflowPackage],
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
  // An active optional view must not survive a cold boot where its package is
  // already disabled (there is no installed disposer to perform the handoff).
  if (!next.has("workflow") && getState().activeView === "workflow") {
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
