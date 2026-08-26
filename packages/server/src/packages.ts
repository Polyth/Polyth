import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PackageDescriptorDto } from "@polyth/contracts";

export interface PackageRegistry {
  list(): PackageDescriptorDto[];
  get(id: string): PackageDescriptorDto | null;
  setEnabled(id: string, enabled: boolean): Promise<PackageDescriptorDto>;
  isEnabled(id: string): boolean;
}

export const BUILTIN_PACKAGES = [
  { id: "session", name: "Session Runtime", description: "Durable session events and projections.", core: true, enabled: true, hasSettings: false },
  { id: "files", name: "Files", description: "Workspace file access and attachments.", core: true, enabled: true, hasSettings: false },
  { id: "projects", name: "Projects", description: "Project and workspace management.", core: true, enabled: true, settingsGroup: "Engineering", hasSettings: true },
  { id: "behavior", name: "Behavior", description: "Agent behavior instructions.", core: true, enabled: true, settingsGroup: "Engineering", hasSettings: true },
  { id: "models", name: "Providers & Models", description: "Model providers, visibility, and defaults.", core: true, enabled: true, settingsGroup: "Engineering", hasSettings: true },
  { id: "permissions", name: "Permissions", description: "Tool permission review and policy enforcement.", core: true, enabled: true, hasSettings: false },
  { id: "notifications", name: "Notifications", description: "Session alerts and notification preferences.", core: true, enabled: true, settingsGroup: "Workspace", hasSettings: true },
  { id: "appearance", name: "Appearance", description: "Theme and display preferences.", core: true, enabled: true, settingsGroup: "Workspace", hasSettings: true },
  { id: "general", name: "General", description: "General application preferences.", core: true, enabled: true, settingsGroup: "Workspace", hasSettings: true },
  { id: "chat", name: "Chat", description: "Conversation and composer preferences.", core: true, enabled: true, settingsGroup: "Workspace", hasSettings: true },
  { id: "sessions", name: "Sessions", description: "Session defaults and retention preferences.", core: true, enabled: true, settingsGroup: "Workspace", hasSettings: true },
  { id: "shortcuts", name: "Shortcuts", description: "Keyboard shortcut configuration.", core: true, enabled: true, settingsGroup: "Workspace", hasSettings: true },
  { id: "hotkeys", name: "Hotkeys Runtime", description: "Keyboard shortcut package registration.", core: true, enabled: true, hasSettings: false },
  { id: "access", name: "Access", description: "Application access and authentication.", core: true, enabled: true, settingsGroup: "System", hasSettings: true },
  { id: "about", name: "About", description: "Application version and system information.", core: true, enabled: true, settingsGroup: "System", hasSettings: true },

  { id: "git", name: "Git", description: "Source control status, diffs, commits, and worktrees.", core: false, enabled: true, settingsGroup: "Engineering", icon: "⎇", hasSettings: true },
  { id: "terminal", name: "Terminal", description: "Project-scoped terminal sessions.", core: false, enabled: true, settingsGroup: "Engineering", icon: "⌨", hasSettings: false },
  { id: "browser", name: "Browser", description: "A shared internal browser for users, agents, and element context.", core: false, enabled: true, settingsGroup: "Engineering", icon: "🌐", hasSettings: false },
  { id: "goals", name: "Goals", description: "Goal tracking and completion audits.", core: false, enabled: true, settingsGroup: "Workspace", icon: "◎", hasSettings: false },
  { id: "multirun", name: "Multirun", description: "Run prompts across multiple models.", core: false, enabled: true, settingsGroup: "Engineering", icon: "⑂", hasSettings: false },
  { id: "workflow", name: "Workflows", description: "Orchestrate multi-agent DAG pipelines.", core: false, enabled: true, settingsGroup: "Engineering", icon: "◇", hasSettings: false },
  { id: "fusion", name: "Fusion", description: "Synthesize multiple model responses.", core: false, enabled: true, settingsGroup: "Engineering", icon: "⧉", hasSettings: false },
  { id: "walkthrough", name: "Walkthrough", description: "Generate and review code walkthroughs.", core: false, enabled: true, settingsGroup: "Engineering", icon: "→", hasSettings: false },
  { id: "schedule", name: "Schedule", description: "Schedule recurring and one-time agent tasks.", core: false, enabled: true, settingsGroup: "Engineering", icon: "⏱", hasSettings: false },
  { id: "usage", name: "Usage", description: "Model quota and usage reporting.", core: false, enabled: true, settingsGroup: "Workspace", icon: "📊", hasSettings: true },
  { id: "github", name: "GitHub", description: "GitHub pull request and check integration.", core: false, enabled: true, settingsGroup: "Engineering", icon: "⎇", hasSettings: false },
  { id: "task-trackers", name: "Jira & Trello", description: "Jira and Trello boards, tasks, agent handoffs, and status updates.", core: false, enabled: true, settingsGroup: "Engineering", icon: "▦", hasSettings: false },
  { id: "knowledge", name: "Knowledge", description: "Project notes, plans, and reusable context.", core: false, enabled: true, settingsGroup: "Workspace", icon: "📚", hasSettings: false },
  { id: "dictation", name: "Voice & Dictation", description: "Speech-to-text dictation and spoken replies.", core: false, enabled: true, settingsGroup: "Workspace", icon: "🎤", hasSettings: true },
  { id: "home-assistant", name: "Home Assistant", description: "Home Assistant entities and controls.", core: false, enabled: false, settingsGroup: "Customize", icon: "🏠", hasSettings: true },
  { id: "secure-safe", name: "Secure Safe", description: "Write-only credential handles and secret policy.", core: false, enabled: true, settingsGroup: "Engineering", icon: "🔒", hasSettings: true },
  { id: "ssh", name: "SSH Remotes", description: "SSH connections and remote projects whose agent runs on the host.", core: false, enabled: true, settingsGroup: "Engineering", icon: "🖧", hasSettings: true },
  { id: "mcp", name: "MCP", description: "Model Context Protocol server configuration.", core: false, enabled: true, settingsGroup: "Engineering", icon: "🔌", hasSettings: true },
  { id: "commands", name: "Commands", description: "Reusable project command definitions.", core: false, enabled: true, settingsGroup: "Engineering", icon: "/", hasSettings: true },
  { id: "plugins", name: "Plugins", description: "Managed plugin installation and configuration.", core: false, enabled: true, settingsGroup: "Customize", icon: "🧩", hasSettings: true },
  { id: "integrations", name: "Integrations", description: "External service integrations.", core: false, enabled: true, settingsGroup: "Workspace", icon: "🔗", hasSettings: true },
  { id: "example-feature", name: "Example Feature", description: "Proof-of-concept package registered via polyth.serverEntry discovery.", core: false, enabled: true, settingsGroup: "Customize", icon: "🧪", hasSettings: false },
] as const satisfies readonly PackageDescriptorDto[];

type EnabledState = Record<string, boolean>;

function atomicWriteSync(file: string, data: string): void {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, data, "utf8");
  try {
    renameSync(temporary, file);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* already removed */ }
    throw error;
  }
}

export function createPackageRegistry(opts: {
  file: string;
  onSetEnabled?: (id: string, enabled: boolean) => void | Promise<void>;
  onChanged?: (pkg: PackageDescriptorDto) => void;
}): PackageRegistry {
  mkdirSync(dirname(opts.file), { recursive: true });

  const byId = new Map<string, PackageDescriptorDto>(
    BUILTIN_PACKAGES.map((descriptor) => [descriptor.id, { ...descriptor }]),
  );
  const defaults: EnabledState = Object.fromEntries(
    BUILTIN_PACKAGES
      .filter((descriptor) => !descriptor.core)
      .map((descriptor) => [descriptor.id, descriptor.enabled]),
  );
  let enabled: EnabledState = { ...defaults };

  try {
    const raw = JSON.parse(readFileSync(opts.file, "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const id of Object.keys(defaults)) {
        const value = (raw as Record<string, unknown>)[id];
        if (typeof value === "boolean") enabled[id] = value;
      }
    }
  } catch {
    // Missing or malformed state is repaired from the built-in defaults.
  }

  const persist = (state: EnabledState): void => {
    atomicWriteSync(opts.file, `${JSON.stringify(state, null, 2)}\n`);
  };
  persist(enabled);

  const descriptorFor = (descriptor: PackageDescriptorDto): PackageDescriptorDto => {
    const isEnabled = descriptor.core || enabled[descriptor.id] === true;
    return {
      ...descriptor,
      enabled: isEnabled,
      status: isEnabled ? "ready" : "disabled",
    };
  };

  const get = (id: string): PackageDescriptorDto | null => {
    const descriptor = byId.get(id);
    return descriptor ? descriptorFor(descriptor) : null;
  };

  return {
    list: () => BUILTIN_PACKAGES.map((descriptor) => descriptorFor(descriptor)),
    get,
    async setEnabled(id, value) {
      const descriptor = byId.get(id);
      if (!descriptor) {
        throw Object.assign(new Error(`unknown package "${id}"`), { code: "not-found" });
      }
      if (descriptor.core) {
        throw Object.assign(new Error(`core package "${id}" cannot be disabled or enabled`), { code: "invalid-input" });
      }
      await opts.onSetEnabled?.(id, value);
      const next = { ...enabled, [id]: value };
      persist(next);
      enabled = next;
      const updated = descriptorFor(descriptor);
      opts.onChanged?.(updated);
      return updated;
    },
    isEnabled: (id) => get(id)?.enabled ?? false,
  };
}

/** Small route-guard helper that keeps callers decoupled from registry details. */
export function isPackageEnabled(registry: Pick<PackageRegistry, "isEnabled">, id: string): boolean {
  return registry.isEnabled(id);
}
