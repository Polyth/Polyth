import { mkdirSync, readFileSync } from "node:fs";
import { atomicWriteSync } from "@polyth/plugins";
import { dirname } from "node:path";
import type { PackageDescriptorDto } from "@polyth/contracts";

export interface PackageRegistry {
  list(): PackageDescriptorDto[];
  get(id: string): PackageDescriptorDto | null;
  setEnabled(id: string, enabled: boolean): Promise<PackageDescriptorDto>;
  isEnabled(id: string): boolean;
}

/** Shell-owned package descriptors only. Feature descriptors are discovered
 * from each package's polyth.descriptor manifest block at boot. */
export const BUILTIN_PACKAGES = [
  { id: "session", name: "Session Runtime", description: "Durable session events and projections.", core: true, enabled: true, icon: "history", hasSettings: false },
  { id: "projects", name: "Projects", description: "Project and workspace management.", core: true, enabled: true, settingsGroup: "Engineering", icon: "files", hasSettings: true },
  { id: "behavior", name: "Behavior", description: "Agent behavior instructions.", core: true, enabled: true, settingsGroup: "Engineering", icon: "brain", hasSettings: true },
  { id: "notifications", name: "Notifications", description: "Session alerts and notification preferences.", core: true, enabled: true, settingsGroup: "Workspace", icon: "bell", hasSettings: true },
  { id: "appearance", name: "Appearance", description: "Theme and display preferences.", core: true, enabled: true, settingsGroup: "Workspace", icon: "palette", hasSettings: true },
  { id: "general", name: "General", description: "General application preferences.", core: true, enabled: true, settingsGroup: "Workspace", icon: "settings", hasSettings: true },
  { id: "chat", name: "Chat", description: "Conversation and composer preferences.", core: true, enabled: true, settingsGroup: "Workspace", icon: "chat", hasSettings: true },
  { id: "sessions", name: "Sessions", description: "Session defaults and retention preferences.", core: true, enabled: true, settingsGroup: "Workspace", icon: "layers", hasSettings: true },
  { id: "access", name: "Access", description: "Application access and authentication.", core: true, enabled: true, settingsGroup: "System", icon: "key", hasSettings: true },
  { id: "about", name: "About", description: "Application version and system information.", core: true, enabled: true, settingsGroup: "System", icon: "info", hasSettings: true },
  { id: "mcp", name: "MCP", description: "Model Context Protocol server configuration.", core: false, enabled: true, settingsGroup: "Engineering", icon: "server", hasSettings: false },
  { id: "integrations", name: "Integrations", description: "External service integrations.", core: false, enabled: true, settingsGroup: "Workspace", icon: "link", hasSettings: true },
] as const satisfies readonly PackageDescriptorDto[];

type EnabledState = Record<string, boolean>;

export function createPackageRegistry(opts: {
  file: string;
  descriptors?: readonly PackageDescriptorDto[];
  onSetEnabled?: (id: string, enabled: boolean) => void | Promise<void>;
  onChanged?: (pkg: PackageDescriptorDto) => void;
}): PackageRegistry {
  mkdirSync(dirname(opts.file), { recursive: true });

  const packages: PackageDescriptorDto[] = [
    ...BUILTIN_PACKAGES.map((descriptor): PackageDescriptorDto => ({ ...descriptor })),
    ...(opts.descriptors ?? []).map((descriptor): PackageDescriptorDto => ({ ...descriptor })),
  ];
  const ids = new Set<string>();
  for (const descriptor of packages) {
    if (ids.has(descriptor.id)) {
      throw new Error(`duplicate package descriptor "${descriptor.id}"`);
    }
    ids.add(descriptor.id);
  }
  const byId = new Map<string, PackageDescriptorDto>(
    packages.map((descriptor) => [descriptor.id, descriptor]),
  );
  // Derived discovery metadata for agent relevance. Enablement remains owned
  // by packages.json; this catalog deliberately contains no lifecycle state.
  atomicWriteSync(
    `${dirname(opts.file)}/package-composition.json`,
    `${JSON.stringify(Object.fromEntries(packages.map((descriptor) => [descriptor.id, {
      ...(descriptor.category ? { category: descriptor.category } : {}),
      ...(descriptor.projectAffinity ? { projectAffinity: descriptor.projectAffinity } : {}),
    }])), null, 2)}\n`,
  );
  const defaults: EnabledState = Object.fromEntries(
    packages
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
    list: () => packages.map((descriptor) => descriptorFor(descriptor)),
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
