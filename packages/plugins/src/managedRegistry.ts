import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createContext, type KernelContext } from "@polyth/kernel";
import {
  type Disposable,
  type InstalledPluginDto,
  type JsonObject,
  type PackageCapabilityRequestDto,
  type PluginContext,
  type RouteHandler,
  type SpaceStorage,
  type UiSlotItem,
  type WidgetContributionDescriptor,
} from "@polyth/contracts";
import {
  assertEngineCompatible,
  requiredAssets,
  type DeclaredCapability,
  type PackageManifest,
  type PackageManifestV2,
} from "@polyth/package-sdk/manifest";
import { loadCanonicalManifest } from "./canonical.ts";
import { type ManagedPluginManifest } from "./managedManifest.ts";
import { loadServerEntry } from "./trustedServerEntry.ts";
import { buildUiBundle } from "./uiBundle.ts";
import { buildSandboxBundle } from "./sandboxBundle.ts";
import { stageInstallSource } from "./installSources.ts";
import { publishVersion, treeIntegrity, writeActive } from "./versions.ts";
import {
  activeVersion,
  invalidateVersionCache,
  listInstalledVersions,
  loadVersionRecord,
  migratePackageLayout,
  migratePersisted,
  publishedAssets,
  type PersistedPackage,
  type VersionRecord,
} from "./versionRecords.ts";
import {
  approveConnectionDefinitions,
  connectionReviewRequired,
  deleteGrants,
  grantCapabilities,
  missingGrants,
  missingRequiredGrants,
  readConnectionFingerprints,
  readGrants,
} from "./grants.ts";
import { connectionReviewItems } from "./connectionFingerprint.ts";
import { deleteConnectionSecrets, listPublicConnections } from "./connections.ts";
import { kvClear } from "./packageKv.ts";
import { redactSecrets } from "./redact.ts";
import { readSpaceEnabled, writeSpaceEnabled } from "./spaceEnabled.ts";
import { atomicWriteSync } from "./atomicWrite.ts";
import type { PackageOpaqueVault } from "./connections.ts";
import type { PackageSpaceAdminView } from "./serverPackage.ts";

const err = (code: string, message: string) => Object.assign(new Error(message), { code });
const ENGINE_VERSION = "0.1.0";
const MAX_LOG_LINES = 500;

export interface PluginLogEntry { at: number; line: string }

export interface PluginRegistryOptions {
  dir: string;
  trustedDir?: string;
  slots?: { add(item: UiSlotItem): { dispose(): void } };
  routes?: { add(handler: RouteHandler): Disposable };
  root?: PluginContext;
  onChange?: (packageId: string) => void;
  allowDevPath?: boolean;
  hostVersion?: string;
  secrets?: PackageOpaqueVault | (() => PackageOpaqueVault | undefined);
  /** Host-owned administrative Space enumeration. */
  packageSpaces?: () => PackageSpaceAdminView[];
  writeEnabled?: (storage: SpaceStorage, packageId: string, enabled: boolean) => void;
}

export interface PluginRegistry {
  list(storage?: SpaceStorage): InstalledPluginDto[];
  detail(id: string, storage?: SpaceStorage): InstalledPluginDto;
  install(source: string): Promise<InstalledPluginDto>;
  enable(id: string, storage?: SpaceStorage): Promise<InstalledPluginDto>;
  disable(id: string, storage?: SpaceStorage): Promise<InstalledPluginDto>;
  reload(id: string): Promise<InstalledPluginDto>;
  remove(id: string, storage?: SpaceStorage): Promise<boolean>;
  has(id: string): boolean;
  grant(id: string, capabilityNames: string[], storage: SpaceStorage, grantedBy?: string, connectionIds?: string[]): Promise<InstalledPluginDto>;
  update(id: string, opts?: { storage?: SpaceStorage }): Promise<InstalledPluginDto>;
  rollback(id: string, version?: string, storage?: SpaceStorage): Promise<InstalledPluginDto>;
  canonicalManifest(id: string): PackageManifest;
  activeIdentity(id: string): { packageId: string; version: string; integrity: string; installGeneration: string };
  installDir(id: string): string;
  isEnabled(id: string, storage?: SpaceStorage): boolean;
  logs(id: string, opts?: { after?: number; limit?: number }): PluginLogEntry[];
  log(id: string, line: string): void;
  scopeState(id: string): { providers: string[]; listeners: string[]; contributions: number } | null;
  dispose(): Promise<void>;
}

interface RuntimePackage {
  persisted: PersistedPackage;
  status: InstalledPluginDto["status"];
}

const notify = (opts: PluginRegistryOptions, id: string): void => {
  opts.onChange?.(id);
};

const assertServerEntryAllowed = (manifest: ManagedPluginManifest, source: string): void => {
  if (!manifest.entries?.server) return;
  if (manifest.trust === "ui-only" || manifest.trust === "pure") {
    throw err("invalid-input", `trust class "${manifest.trust}" cannot declare entries.server`);
  }
  if (!source.startsWith("file:")) {
    throw err("invalid-input", "entries.server is allowed only for trusted file: installs");
  }
};

function runtimeKindOf(canonical: PackageManifest): InstalledPluginDto["runtimeKind"] {
  return canonical.runtime?.kind === "sandboxed" ? "sandboxed" : "trusted-local";
}

function contributionItem(input: {
  pluginId: string;
  kind: string;
  id: string;
  slot: UiSlotItem["slot"];
  order?: number;
  props: Record<string, unknown>;
}): UiSlotItem {
  return {
    slot: input.slot,
    id: `${input.pluginId}.${input.kind}.${input.id}`,
    module: `sandbox-contribution:${input.kind}:${input.id}`,
    ...(input.order !== undefined ? { order: input.order } : {}),
    props: {
      pluginId: input.pluginId,
      contributionKind: input.kind,
      contributionId: input.id,
      ...input.props,
    } as JsonObject,
  };
}

function sandboxContributions(canonical: PackageManifest, pluginId: string): UiSlotItem[] {
  const items: UiSlotItem[] = [];
  for (const surface of canonical.contributes?.surfaces ?? []) {
    items.push({
      slot: "workspace.right.tabs",
      id: `${pluginId}.surface.${surface.id}`,
      module: `sandbox-surface:${surface.id}`,
      order: surface.order,
      props: {
        pluginId,
        surfaceId: surface.id,
        title: surface.title,
        description: surface.description ?? "",
      } as JsonObject,
    });
  }
  for (const action of canonical.contributes?.composerActions ?? []) {
    items.push({
      slot: "composer.trailing",
      id: `${pluginId}.action.${action.id}`,
      module: `sandbox-action:${action.id}`,
      props: {
        pluginId,
        actionId: action.id,
        label: action.label,
        description: action.description ?? "",
        icon: action.icon ?? "",
      } as JsonObject,
    });
  }
  if (canonical.manifestVersion !== 2) return items;
  const v2 = canonical as PackageManifestV2;
  for (const provider of v2.contributes?.attachmentProviders ?? []) {
    items.push(contributionItem({
      pluginId, kind: "attachment-provider", id: provider.id, slot: "composer.leading", order: provider.order,
      props: { label: provider.label, description: provider.description ?? "", icon: provider.icon ?? "" },
    }));
  }
  for (const action of v2.contributes?.messageActions ?? []) {
    items.push(contributionItem({
      pluginId, kind: "message-action", id: action.id, slot: "session.message.actions", order: action.order,
      props: { label: action.label, description: action.description ?? "", icon: action.icon ?? "", roles: action.roles ?? [] },
    }));
  }
  for (const action of v2.contributes?.sessionActions ?? []) {
    items.push(contributionItem({
      pluginId, kind: "session-action", id: action.id, slot: "session.header.actions", order: action.order,
      props: { label: action.label, description: action.description ?? "", icon: action.icon ?? "" },
    }));
  }
  for (const command of v2.contributes?.commands ?? []) {
    items.push(contributionItem({
      pluginId, kind: "command", id: command.id, slot: "commandPalette.commands", order: command.order,
      props: { name: command.name, label: command.label ?? command.name, description: command.description, icon: command.icon ?? "" },
    }));
  }
  for (const renderer of v2.contributes?.toolRenderers ?? []) {
    items.push(contributionItem({
      pluginId, kind: "tool-renderer", id: renderer.id, slot: "session.timeline.event", order: renderer.order,
      props: {
        label: renderer.label ?? renderer.id,
        matcher: renderer.matcher,
        presentation: renderer.presentation ?? {},
        dynamic: renderer.dynamic === true,
      },
    }));
  }
  for (const badge of v2.contributes?.statusBadges ?? []) {
    items.push(contributionItem({
      pluginId, kind: "status-badge", id: badge.id, slot: "session.list.badges", order: badge.order,
      props: { label: badge.label, description: badge.description ?? "", icon: badge.icon ?? "" },
    }));
  }
  for (const section of v2.contributes?.settingsSections ?? []) {
    items.push(contributionItem({
      pluginId, kind: "settings-section", id: section.id, slot: "settings.integrations", order: section.order,
      props: { title: section.title, description: section.description ?? "", icon: section.icon ?? "" },
    }));
  }
  for (const provider of v2.contributes?.contextProviders ?? []) {
    items.push(contributionItem({
      pluginId, kind: "context-provider", id: provider.id, slot: "contextRail.tabs", order: provider.order,
      props: { label: provider.label, description: provider.description ?? "", icon: provider.icon ?? "" },
    }));
  }
  for (const widget of v2.contributes?.widgets ?? []) {
    const defaultSlot = widget.defaultSlot ?? "workspace.right";
    items.push(contributionItem({
      pluginId, kind: "widget", id: widget.id, slot: "widget.catalog", order: widget.order,
      props: {
        title: widget.title,
        description: widget.description,
        icon: widget.icon ?? "",
        kind: "widget",
        defaultSlot,
        supportedSlots: [defaultSlot],
      },
    }));
  }
  return items;
}

export function createPluginRegistry(opts: PluginRegistryOptions): PluginRegistry {
  mkdirSync(opts.dir, { recursive: true });
  const stateFile = join(opts.dir, "registry.json");
  const stagingRoot = join(opts.dir, ".staging");
  const hostVersion = opts.hostVersion ?? ENGINE_VERSION;
  const allowDevPath = opts.allowDevPath ?? process.env.POLYTH_ALLOW_DEV_PACKAGES === "1";

  const loadState = (): RuntimePackage[] => {
    try {
      const raw = JSON.parse(readFileSync(stateFile, "utf8")) as unknown[];
      return migratePersisted(raw).map((persisted) => ({
        persisted,
        status: "installed" as InstalledPluginDto["status"],
      }));
    } catch {
      return [];
    }
  };

  const plugins = new Map<string, RuntimePackage>(loadState().map((p) => [p.persisted.id, p]));
  const versionCache = new Map<string, VersionRecord>();
  const scopes = new Map<string, KernelContext>();
  const logsBuf = new Map<string, PluginLogEntry[]>();
  const locks = new Map<string, Promise<void>>();

  const withLock = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const previous = locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const current = previous.then(() => gate);
    locks.set(id, current);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(id) === current) locks.delete(id);
    }
  };

  const persist = () => atomicWriteSync(stateFile, JSON.stringify([...plugins.values()].map((p) => p.persisted), null, 2));
  const vault = (): PackageOpaqueVault | undefined =>
    typeof opts.secrets === "function" ? opts.secrets() : opts.secrets;

  const persistEnabled = opts.writeEnabled ?? writeSpaceEnabled;
  const pluginHomeOf = (id: string) => join(opts.dir, id);
  const allSpaces = (): PackageSpaceAdminView[] => opts.packageSpaces?.() ?? [];

  const anySpaceEnabled = (id: string): boolean =>
    allSpaces().some((space) => readSpaceEnabled(space.storage, id));

  const enabledSpaces = (id: string): PackageSpaceAdminView[] =>
    allSpaces().filter((space) => readSpaceEnabled(space.storage, id));

  const widgetSlotItem = (pluginId: string, widget: WidgetContributionDescriptor): UiSlotItem => {
    const { module, defaultSlot: _defaultSlot, supportedSlots: _supportedSlots, ...metadata } = widget;
    return {
      slot: "widget.catalog",
      id: widget.id,
      module,
      order: widget.order,
      props: {
        ...metadata,
        pluginId,
        defaultSlot: widget.defaultSlot,
        supportedSlots: [...widget.supportedSlots],
      } as unknown as JsonObject,
    };
  };

  const get = (id: string): RuntimePackage => {
    const p = plugins.get(id);
    if (!p) throw err("not-found", `plugin not installed: ${id}`);
    return p;
  };

  const activeRecord = (pkg: RuntimePackage): VersionRecord => {
    const home = pluginHomeOf(pkg.persisted.id);
    const version = activeVersion(home);
    if (!version) throw err("not-found", "no active package version");
    return loadVersionRecord(home, version, versionCache);
  };

  const candidateRecord = (pkg: RuntimePackage): VersionRecord | undefined => {
    const version = pkg.persisted.candidateVersion;
    if (!version) return undefined;
    const home = pluginHomeOf(pkg.persisted.id);
    if (!existsSync(join(home, "versions", version))) return undefined;
    return loadVersionRecord(home, version, versionCache);
  };

  const capabilityRequests = (caps: readonly DeclaredCapability[]): PackageCapabilityRequestDto[] =>
    caps.map((cap) => ({
      name: cap.name,
      ...(cap.required === false ? { required: false } : {}),
      ...(cap.constraints ? { constraints: cap.constraints } : {}),
    } as unknown as PackageCapabilityRequestDto));

  const activePermissions = (
    pkg: RuntimePackage,
    storage?: SpaceStorage,
  ): Pick<InstalledPluginDto["permissions"], "requested" | "effective"> => {
    const record = activeRecord(pkg);
    const requested = capabilityRequests(record.canonical.capabilities ?? []);
    if (!storage) return { requested, effective: [] };
    const granted = new Set(readGrants(storage, pkg.persisted.id).map((grant) => grant.name));
    const declared = new Set(requested.map((item) => item.name));
    return {
      requested,
      effective: [...granted].filter((name) => declared.has(name)),
    };
  };

  const candidateReview = (
    pkg: RuntimePackage,
    storage?: SpaceStorage,
  ): InstalledPluginDto["permissions"]["review"] => {
    const candidate = candidateRecord(pkg);
    if (!candidate || !storage) return undefined;
    const active = activeRecord(pkg);
    const missing = missingGrants(readGrants(storage, pkg.persisted.id), candidate.canonical.capabilities ?? []);
    const reviewConnections = connectionReviewItems(
      active.canonical.connections ?? [],
      candidate.canonical.connections ?? [],
      readConnectionFingerprints(storage, pkg.persisted.id),
    );
    if (missing.length === 0 && reviewConnections.length === 0) return undefined;
    return {
      capabilities: capabilityRequests(missing),
      connections: reviewConnections,
    };
  };

  const toDto = (pkg: RuntimePackage, storage?: SpaceStorage): InstalledPluginDto => {
    const home = pluginHomeOf(pkg.persisted.id);
    if (!activeVersion(home)) {
      return {
        id: pkg.persisted.id,
        name: pkg.persisted.id,
        version: "unknown",
        source: pkg.persisted.source,
        trust: "ui-only",
        enabled: storage ? readSpaceEnabled(storage, pkg.persisted.id) : false,
        status: "error",
        contributions: [],
        widgets: [],
        lastError: pkg.persisted.lastError ?? "active version pointer is missing or invalid",
        runtimeKind: "sandboxed",
        permissions: { requested: [], effective: [] },
        versions: listInstalledVersions(home),
        ...(pkg.persisted.candidateVersion ? { update: { version: pkg.persisted.candidateVersion } } : {}),
      };
    }
    const record = activeRecord(pkg);
    const pending = candidateRecord(pkg);
    const kind = runtimeKindOf(record.canonical);
    const legacy = record.legacy;
    const extraSlots = kind === "sandboxed" ? sandboxContributions(record.canonical, pkg.persisted.id) : [];
    const connections = storage
      ? listPublicConnections(storage, pkg.persisted.id, record.canonical.connections ?? [])
      : undefined;
    const spaceEnabled = storage ? readSpaceEnabled(storage, pkg.persisted.id) : anySpaceEnabled(pkg.persisted.id);
    const review = candidateReview(pkg, storage);
    const permissions = {
      ...activePermissions(pkg, storage),
      ...(review ? { review } : {}),
    };
    return {
      id: pkg.persisted.id,
      name: legacy.name,
      version: record.version,
      source: pkg.persisted.source,
      trust: legacy.trust,
      enabled: spaceEnabled,
      status: pkg.status,
      contributions: [
        ...(legacy.contributions ?? []).map((c) => ({
          slot: c.slot, id: c.id, module: c.module,
        })),
        ...(legacy.widgets ?? []).map((widget) => widgetSlotItem(pkg.persisted.id, widget)),
        ...extraSlots,
      ],
      widgets: legacy.widgets ?? [],
      ...(record.ui ? {
        ui: {
          url: `/api/plugins/${encodeURIComponent(pkg.persisted.id)}/ui/${record.ui.integrity}.mjs`,
          integrity: record.ui.integrity,
        },
      } : {}),
      ...(pkg.persisted.lastError ? { lastError: pkg.persisted.lastError } : {}),
      runtimeKind: kind,
      description: record.canonical.display.description,
      icon: record.canonical.display.icon,
      ...(pkg.persisted.previousVersion ? { previousVersion: pkg.persisted.previousVersion } : {}),
      permissions,
      ...(connections ? { connections } : {}),
      ...(record.sandbox ? {
        sandbox: {
          url: `/api/plugins/${encodeURIComponent(pkg.persisted.id)}/sandbox/${record.sandbox.integrity}/entry.js`,
          integrity: record.sandbox.integrity,
        },
      } : {}),
      ...(pending ? { update: { version: pending.version } } : {}),
      versions: listInstalledVersions(pluginHomeOf(pkg.persisted.id)),
    };
  };

  const prepareDir = async (pkgDir: string, source: string): Promise<VersionRecord> => {
    const loaded = loadCanonicalManifest(pkgDir);
    assertEngineCompatible(loaded.canonical, hostVersion);
    for (const asset of requiredAssets(loaded.canonical)) {
      const path = join(pkgDir, asset);
      if (!existsSync(path) || !statSync(path).isFile()) {
        throw err("invalid-input", `missing required asset ${asset}`);
      }
    }
    if (loaded.canonical.runtime?.kind === "sandboxed" && loaded.canonical.runtime.server) {
      throw err("invalid-input", "sandboxed packages cannot execute server code");
    }
    const requestedKind = loaded.canonical.runtime?.kind ?? "trusted-local";
    const trustedSource = source.startsWith("file:")
      || ((source.startsWith("path:") || source.startsWith("dir:")) && allowDevPath);
    if (requestedKind === "trusted-local" && !trustedSource) {
      throw err(
        "invalid-input",
        "trusted-local runtime requires a trusted local source; remote packages must use sandboxed runtime",
      );
    }
    assertServerEntryAllowed(loaded.legacy, source);
    if (loaded.canonical.runtime?.kind !== "sandboxed" && loaded.legacy.entries?.ui) {
      await buildUiBundle({
        installDir: pkgDir,
        entryPath: loaded.legacy.entries.ui,
        outDir: join(pkgDir, ".polyth", "ui"),
      });
    }
    if (loaded.canonical.runtime?.kind === "sandboxed" && loaded.canonical.runtime.ui) {
      await buildSandboxBundle({
        installDir: pkgDir,
        entryPath: loaded.canonical.runtime.ui.entry,
        outDir: join(pkgDir, ".polyth", "sandbox"),
      });
    }
    return {
      version: loaded.legacy.version,
      dir: pkgDir,
      canonical: loaded.canonical,
      legacy: loaded.legacy,
      integrity: treeIntegrity(pkgDir),
      ...publishedAssets(pkgDir),
    };
  };

  const activateRuntime = async (pkg: RuntimePackage, record: VersionRecord): Promise<void> => {
    pkg.status = "loading";
    const scope = createContext(`plugin:${pkg.persisted.id}`);
    try {
      if (treeIntegrity(record.dir) !== record.integrity) {
        throw new Error("plugin files changed since install (integrity mismatch)");
      }
      const sandboxed = record.canonical.runtime?.kind === "sandboxed";
      for (const c of record.legacy.contributions ?? []) {
        const item: UiSlotItem = {
          slot: c.slot,
          id: c.id,
          module: c.module,
          props: { pluginId: pkg.persisted.id },
        };
        const d = opts.slots ? opts.slots.add(item) : scope.contribute(item);
        scope.effect(() => d.dispose());
      }
      for (const widget of record.legacy.widgets ?? []) {
        const item = widgetSlotItem(pkg.persisted.id, widget);
        const d = opts.slots ? opts.slots.add(item) : scope.contribute(item);
        scope.effect(() => d.dispose());
      }
      if (sandboxed) {
        for (const item of sandboxContributions(record.canonical, pkg.persisted.id)) {
          const d = opts.slots ? opts.slots.add(item) : scope.contribute(item);
          scope.effect(() => d.dispose());
        }
      } else if (record.legacy.entries?.server) {
        assertServerEntryAllowed(record.legacy, pkg.persisted.source);
        if (!opts.root || !opts.routes) {
          throw new Error("server entry activation requires plugin root and route registry");
        }
        const storageDir = join(record.dir, ".polyth");
        mkdirSync(storageDir, { recursive: true });
        const serverPlugin = await loadServerEntry({
          installDir: record.dir,
          entryPath: record.legacy.entries.server,
          integrity: record.integrity,
          host: {
            pluginId: pkg.persisted.id,
            storageDir,
            routes: opts.routes,
            root: opts.root,
          },
        });
        scope.effect(() => serverPlugin.dispose());
      }
      scopes.set(pkg.persisted.id, scope);
      pkg.status = "ready";
      delete pkg.persisted.lastError;
    } catch (e) {
      await scope.dispose();
      pkg.status = "error";
      pkg.persisted.lastError = (e as Error).message;
      throw e;
    }
  };

  const deactivate = async (id: string): Promise<void> => {
    const scope = scopes.get(id);
    if (scope) {
      try {
        await scope.dispose();
      } finally {
        scopes.delete(id);
      }
    }
  };

  const versionCompatible = (
    pluginId: string,
    record: VersionRecord,
  ): boolean => {
    for (const space of enabledSpaces(pluginId)) {
      if (missingRequiredGrants(readGrants(space.storage, pluginId), record.canonical.capabilities ?? []).length > 0) {
        return false;
      }
      if (connectionReviewRequired(space.storage, pluginId, record.canonical.connections ?? [])) return false;
    }
    return true;
  };

  const switchActivate = async (
    pkg: RuntimePackage,
    target: VersionRecord,
  ): Promise<boolean> => {
    const id = pkg.persisted.id;
    const home = pluginHomeOf(id);
    const current = activeRecord(pkg);
    if (current.version === target.version && current.integrity === target.integrity) {
      delete pkg.persisted.candidateVersion;
      return true;
    }
    if (runtimeKindOf(current.canonical) === "sandboxed" && runtimeKindOf(target.canonical) !== "sandboxed") {
      throw err("conflict", "an update cannot change a sandboxed package into a trusted-local package; reinstall explicitly");
    }
    if (!versionCompatible(id, target)) return false;
    const hadScope = scopes.has(id);
    const shouldRun = anySpaceEnabled(id);
    const previousVersion = current.version;
    try {
      if (hadScope) await deactivate(id);
      await writeActive(home, target.version);
      invalidateVersionCache(versionCache, home, target.version);
      invalidateVersionCache(versionCache, home, previousVersion);
      if (shouldRun) await activateRuntime(pkg, target);
      else pkg.status = "installed";
      pkg.persisted.previousVersion = previousVersion;
      delete pkg.persisted.candidateVersion;
      return true;
    } catch (cause) {
      await writeActive(home, previousVersion);
      invalidateVersionCache(versionCache, home);
      if (shouldRun) {
        try {
          await activateRuntime(pkg, loadVersionRecord(home, previousVersion, versionCache));
        } catch {
          pkg.status = "error";
        }
      }
      pkg.persisted.candidateVersion = target.version;
      throw cause;
    }
  };

  const tryActivateCandidate = async (pkg: RuntimePackage): Promise<boolean> => {
    const pending = candidateRecord(pkg);
    if (!pending) return true;
    return switchActivate(pkg, pending);
  };

  const uniqueStaging = (): string => {
    mkdirSync(stagingRoot, { recursive: true });
    return mkdtempSync(join(stagingRoot, "job-"));
  };

  const sweepSpacePackage = async (space: PackageSpaceAdminView, id: string): Promise<void> => {
    await deleteConnectionSecrets(vault(), space.storage, id, space.spaceId);
    try {
      rmSync(space.storage.path(`packages/${id}`), { recursive: true, force: true });
    } catch {
      deleteGrants(space.storage, id);
      kvClear(space.storage, id);
    }
  };

  const registry: PluginRegistry = {
    list: (storage) => [...plugins.values()].map((pkg) => toDto(pkg, storage)),
    detail: (id, storage) => toDto(get(id), storage),

    async install(source: string): Promise<InstalledPluginDto> {
      if (typeof source !== "string" || !source.trim()) throw err("invalid-input", "install source required");
      const staging = uniqueStaging();
      try {
        const staged = await stageInstallSource({
          source: source.trim(),
          staging,
          trustedDir: opts.trustedDir,
          allowDevPath,
        });
        const prepared = await prepareDir(staged.pkgDir, source.trim());
        if (plugins.has(prepared.legacy.id)) {
          throw err("conflict", `plugin already installed: ${prepared.legacy.id}`);
        }
        const home = pluginHomeOf(prepared.legacy.id);
        await publishVersion(home, prepared.version, staged.pkgDir);
        await writeActive(home, prepared.version);
        invalidateVersionCache(versionCache, home);
        const stored: RuntimePackage = {
          persisted: {
            id: prepared.legacy.id,
            source: source.trim(),
            installationId: randomBytes(8).toString("hex"),
          },
          status: "installed",
        };
        loadVersionRecord(home, prepared.version, versionCache);
        plugins.set(prepared.legacy.id, stored);
        persist();
        notify(opts, stored.persisted.id);
        return toDto(stored);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    },

    enable(id: string, storage?: SpaceStorage): Promise<InstalledPluginDto> {
      return withLock(id, async () => {
        const pkg = get(id);
        const record = activeRecord(pkg);
        if (record.canonical.runtime?.kind === "sandboxed") {
          if (!storage) throw err("conflict", "sandboxed packages require permission approval before enable");
          const missing = missingRequiredGrants(readGrants(storage, id), record.canonical.capabilities ?? []);
          if (missing.length > 0 || connectionReviewRequired(storage, id, record.canonical.connections ?? [])) {
            persist();
            throw err("conflict", "sandboxed packages require permission approval before enable");
          }
        }
        if (storage) {
          const alreadyRunning = anySpaceEnabled(id) && scopes.has(id);
          if (!alreadyRunning) {
            await activateRuntime(pkg, record);
            try {
              persistEnabled(storage, id, true);
            } catch (cause) {
              await deactivate(id);
              pkg.status = "installed";
              persist();
              throw cause;
            }
          } else {
            persistEnabled(storage, id, true);
          }
          persist();
          notify(opts, id);
          return toDto(pkg, storage);
        }
        if (!scopes.has(id)) {
          try {
            await activateRuntime(pkg, record);
          } finally {
            persist();
          }
        }
        notify(opts, id);
        return toDto(pkg, storage);
      });
    },

    disable(id: string, storage?: SpaceStorage): Promise<InstalledPluginDto> {
      return withLock(id, async () => {
        const pkg = get(id);
        if (storage) {
          persistEnabled(storage, id, false);
          if (!anySpaceEnabled(id)) {
            try {
              await deactivate(id);
            } finally {
              pkg.status = "disabled";
              delete pkg.persisted.lastError;
            }
          }
          persist();
          notify(opts, id);
          return toDto(pkg, storage);
        }
        try {
          await deactivate(id);
        } finally {
          pkg.status = "disabled";
          delete pkg.persisted.lastError;
          persist();
          notify(opts, id);
        }
        return toDto(pkg);
      });
    },

    reload(id: string): Promise<InstalledPluginDto> {
      return withLock(id, async () => {
        const pkg = get(id);
        const wasActive = scopes.has(id);
        await deactivate(id);
        const record = activeRecord(pkg);
        if (treeIntegrity(record.dir) !== record.integrity) {
          pkg.status = "error";
          pkg.persisted.lastError = "plugin files changed since install (integrity mismatch)";
          persist();
          notify(opts, id);
          throw err("conflict", pkg.persisted.lastError);
        }
        invalidateVersionCache(versionCache, pluginHomeOf(id), record.version);
        if (wasActive) {
          try {
            await activateRuntime(pkg, loadVersionRecord(pluginHomeOf(id), record.version, versionCache));
          } finally {
            persist();
          }
        } else {
          pkg.status = "installed";
          persist();
        }
        notify(opts, id);
        return toDto(pkg);
      });
    },

    remove(id: string, storage?: SpaceStorage): Promise<boolean> {
      return withLock(id, async () => {
        const pkg = plugins.get(id);
        if (!pkg) return false;
        await deactivate(id);
        pkg.status = "disabled";
        delete pkg.persisted.lastError;
        plugins.delete(id);
        logsBuf.delete(id);
        rmSync(pluginHomeOf(id), { recursive: true, force: true });
        invalidateVersionCache(versionCache, pluginHomeOf(id));
        for (const space of allSpaces()) await sweepSpacePackage(space, id);
        persist();
        notify(opts, id);
        return true;
      });
    },

    has(id: string): boolean {
      return plugins.has(id);
    },

    grant(id: string, capabilityNames: string[], storage: SpaceStorage, grantedBy?: string, connectionIds?: string[]): Promise<InstalledPluginDto> {
      return withLock(id, async () => {
        const pkg = get(id);
        const record = candidateRecord(pkg) ?? activeRecord(pkg);
        const byName = new Map<string, DeclaredCapability>(
          (record.canonical.capabilities ?? []).map((cap) => [cap.name, cap]),
        );
        const requested = capabilityNames
          .map((name) => byName.get(name))
          .filter((cap): cap is DeclaredCapability => Boolean(cap));
        if (requested.length) grantCapabilities(storage, id, requested, grantedBy);
        if (connectionIds?.length) {
          approveConnectionDefinitions(storage, id, record.canonical.connections ?? [], connectionIds);
        }
        await tryActivateCandidate(pkg);
        persist();
        notify(opts, id);
        return toDto(pkg, storage);
      });
    },

    update(id: string, options: { storage?: SpaceStorage } = {}): Promise<InstalledPluginDto> {
      return withLock(id, async () => {
        const pkg = get(id);
        const home = pluginHomeOf(id);
        const current = activeRecord(pkg);
        const staging = uniqueStaging();
        try {
          const staged = await stageInstallSource({
            source: pkg.persisted.source,
            staging,
            trustedDir: opts.trustedDir,
            allowDevPath,
          });
          const prepared = await prepareDir(staged.pkgDir, pkg.persisted.source);
          if (prepared.legacy.id !== id) throw err("invalid-input", "updated package id does not match");
          if (runtimeKindOf(current.canonical) === "sandboxed" && runtimeKindOf(prepared.canonical) !== "sandboxed") {
            throw err("conflict", "an update cannot change a sandboxed package into a trusted-local package; reinstall explicitly");
          }
          await publishVersion(home, prepared.version, staged.pkgDir);
          invalidateVersionCache(versionCache, home, prepared.version);
          pkg.persisted.candidateVersion = prepared.version;
          try {
            await tryActivateCandidate(pkg);
          } finally {
            persist();
            notify(opts, id);
          }
          return toDto(pkg, options.storage);
        } finally {
          rmSync(staging, { recursive: true, force: true });
        }
      });
    },

    rollback(id: string, version?: string, storage?: SpaceStorage): Promise<InstalledPluginDto> {
      return withLock(id, async () => {
        const pkg = get(id);
        const home = pluginHomeOf(id);
        const target = version ?? pkg.persisted.previousVersion;
        if (!target) throw err("invalid-input", "no previous version to restore");
        if (!listInstalledVersions(home).includes(target)) {
          throw err("not-found", `version ${target} is not installed`);
        }
        pkg.persisted.candidateVersion = target;
        const activated = await switchActivate(pkg, loadVersionRecord(home, target, versionCache));
        if (!activated) {
          persist();
          notify(opts, id);
          return toDto(pkg, storage);
        }
        persist();
        notify(opts, id);
        return toDto(pkg, storage);
      });
    },

    canonicalManifest: (id: string) => activeRecord(get(id)).canonical,
    activeIdentity: (id: string) => {
      const pkg = get(id);
      const record = activeRecord(pkg);
      return {
        packageId: id,
        version: record.version,
        integrity: record.integrity,
        installGeneration: pkg.persisted.installationId,
      };
    },
    installDir: (id: string) => activeRecord(get(id)).dir,
    isEnabled: (id: string, storage?: SpaceStorage) => {
      const pkg = get(id);
      if (pkg.status !== "ready") return false;
      if (storage) return readSpaceEnabled(storage, id);
      return anySpaceEnabled(id);
    },

    logs(id: string, o: { after?: number; limit?: number } = {}): PluginLogEntry[] {
      const all = logsBuf.get(id) ?? [];
      const after = o.after ?? 0;
      const limit = Math.min(Math.max(o.limit ?? 200, 1), MAX_LOG_LINES);
      return all.filter((e) => e.at > after).slice(0, limit);
    },

    log(id: string, line: string): void {
      let buf = logsBuf.get(id);
      if (!buf) {
        buf = [];
        logsBuf.set(id, buf);
      }
      buf.push({ at: Date.now(), line: redactSecrets(line.slice(0, 4000)) });
      if (buf.length > MAX_LOG_LINES) buf.splice(0, buf.length - MAX_LOG_LINES);
    },

    scopeState(id: string) {
      return scopes.get(id)?.state() ?? null;
    },

    async dispose(): Promise<void> {
      for (const id of [...scopes.keys()]) await deactivate(id);
    },
  };

  for (const pkg of plugins.values()) {
    const home = pluginHomeOf(pkg.persisted.id);
    try {
      migratePackageLayout(home);
    } catch (cause) {
      pkg.status = "error";
      pkg.persisted.lastError = (cause as Error).message;
      persist();
      continue;
    }
    const version = activeVersion(home);
    if (!version) {
      pkg.status = "error";
      pkg.persisted.lastError = "active version pointer is missing or invalid";
      persist();
      continue;
    }
    if (anySpaceEnabled(pkg.persisted.id)) {
      void withLock(pkg.persisted.id, async () => {
        try {
          await activateRuntime(pkg, loadVersionRecord(home, version, versionCache));
        } catch {
          persist();
        }
      });
    } else if (pkg.status !== "installed" && pkg.status !== "error") {
      pkg.status = "disabled";
    }
  }

  return registry;
}
