import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { gt as semverGt, valid as validSemver } from "semver";
import { createContext, type KernelContext } from "@polyth/kernel";
import {
  type Disposable,
  type InstalledPluginDto,
  type JsonObject,
  type PackageCapabilityRequestDto,
  type PackageScreenshotDto,
  type PluginContext,
  type RouteHandler,
  type SpaceStorage,
  type UiSlotItem,
  type WidgetContributionDescriptor,
} from "@polyth/contracts";
import {
  assertEngineCompatible,
  packageClassifiers,
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
import {
  describeInstallSource,
  localSourceDir,
  localSourceFingerprint,
  stageArchiveBuffer,
  stageInstallSource,
  type RepositoryArchiveDownloader,
  type StagedSource,
} from "./installSources.ts";
import {
  checkFork,
  cloneFork,
  forkCloneAttempts,
  forkDir,
  forkVersion,
  stageFork,
  syncFork,
  type ForkStrategy,
  type ForkTracking,
} from "./forkSources.ts";
import { publishVersion, pruneVersionsSync, treeIntegrity, writeActive } from "./versions.ts";
import {
  activeVersion,
  invalidateVersionCache,
  listInstalledVersions,
  loadVersionRecord,
  migratePackageLayout,
  migratePersisted,
  publishedAssets,
  type PersistedPackage,
  type PersistedUpdateCheck,
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
import { assertPackageServices, type PackageSpaceAdminView, type ServerServiceRegistry } from "./serverPackage.ts";

const err = (code: string, message: string) => Object.assign(new Error(message), { code });
const ENGINE_VERSION = "0.1.0";
const MAX_LOG_LINES = 500;
/** Uploaded/served gallery frame ceiling; the asset route shares this. */
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
/** Ceiling for a settings-page zip upload before base64/JSON framing. */
export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;

export interface PluginLogEntry { at: number; line: string }

export interface InstallOptions {
  /** Install a repository as a Polyth-owned fork that integrates upstream with this strategy. */
  fork?: { strategy: ForkStrategy };
  autoUpdate?: boolean;
}

export interface PackageUpdateSettings {
  autoUpdate?: boolean;
  forkStrategy?: ForkStrategy;
}

/** Only an uploaded archive cannot be refetched from its recorded source. */
export const sourceCanRefetch = (source: string): boolean => !source.startsWith("upload:");

/** The persisted check without the host-only source stamp. */
const publicUpdateCheck = (
  { sourceFingerprint: _stamp, ...check }: PersistedUpdateCheck,
): Omit<PersistedUpdateCheck, "sourceFingerprint"> => check;

export interface PluginRegistryOptions {
  dir: string;
  trustedDir?: string;
  slots?: { add(item: UiSlotItem): { dispose(): void } };
  routes?: { add(handler: RouteHandler): Disposable };
  root?: PluginContext;
  onChange?: (packageId: string) => void;
  allowDevPath?: boolean;
  downloadRepository?: RepositoryArchiveDownloader;
  /** Clone commands for a fork install; defaults to gh, https, then ssh. */
  forkCloneAttempts?: typeof forkCloneAttempts;
  hostVersion?: string;
  secrets?: PackageOpaqueVault | (() => PackageOpaqueVault | undefined);
  /** Host-owned service delegation for a trusted managed entry's canonical id:
   * the only way a managed entry receives services. The manager's own services
   * are bound to "plugins" and are never handed on. */
  managedPackageServices?: (packageId: string) => ServerServiceRegistry;
  /** Host-owned administrative Space enumeration. */
  packageSpaces?: () => PackageSpaceAdminView[];
  writeEnabled?: (storage: SpaceStorage, packageId: string, enabled: boolean) => void;
}

export interface PluginRegistry {
  list(storage?: SpaceStorage): InstalledPluginDto[];
  detail(id: string, storage?: SpaceStorage): InstalledPluginDto;
  install(source: string, options?: InstallOptions): Promise<InstalledPluginDto>;
  /** Install (or stage an update) from an uploaded archive. The buffer is
   *  untrusted input; extraction and trust-class rules match a downloaded zip. */
  installArchive(archive: Buffer, filename: string): Promise<InstalledPluginDto>;
  enable(id: string, storage?: SpaceStorage): Promise<InstalledPluginDto>;
  disable(id: string, storage?: SpaceStorage): Promise<InstalledPluginDto>;
  reload(id: string): Promise<InstalledPluginDto>;
  remove(id: string, storage?: SpaceStorage): Promise<boolean>;
  has(id: string): boolean;
  grant(id: string, capabilityNames: string[], storage: SpaceStorage, grantedBy?: string, connectionIds?: string[]): Promise<InstalledPluginDto>;
  update(id: string, opts?: { storage?: SpaceStorage }): Promise<InstalledPluginDto>;
  /** Ask the install source whether a newer version exists without staging it. */
  checkUpdate(id: string, opts?: { storage?: SpaceStorage }): Promise<InstalledPluginDto>;
  /** Auto-updating packages whose operator-local source (`file:` or an
   *  allowed dev path) changed since its last check: its manifest stamp
   *  differs from the one that check recorded. Cheap enough to run often.
   *  Forks, remote sources, unreadable sources and a candidate whose new
   *  access awaits review are left out. */
  changedLocalSources(): string[];
  configure(id: string, settings: PackageUpdateSettings, storage?: SpaceStorage): Promise<InstalledPluginDto>;
  rollback(id: string, version?: string, storage?: SpaceStorage): Promise<InstalledPluginDto>;
  /** Resolve one declared gallery frame of the version the URL names. Returns
   *  null when the version is not published or declares no such frame. */
  screenshotFrame(id: string, version: string, index: number): { src: string } | null;
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

const assertServerEntryAllowed = (manifest: ManagedPluginManifest, trustedSource: boolean): void => {
  if (!manifest.entries?.server) return;
  if (manifest.trust !== "privileged" && manifest.trust !== "credentialed") {
    throw err("invalid-input", `trust class "${manifest.trust}" cannot declare entries.server`);
  }
  if (!trustedSource) {
    throw err("invalid-input", "entries.server requires a trusted local source or authenticated repository checkout");
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

/** Gallery frames the active version actually published. A declared frame
 *  that is missing, empty, or absurdly large is dropped instead of becoming a
 *  broken image in settings. */
function screenshotDtos(packageId: string, record: VersionRecord): PackageScreenshotDto[] {
  const out: PackageScreenshotDto[] = [];
  (record.canonical.display.screenshots ?? []).forEach((frame, index) => {
    let bytes: number;
    try {
      const stat = statSync(join(record.dir, frame.src));
      if (!stat.isFile()) return;
      bytes = stat.size;
    } catch {
      return;
    }
    if (bytes === 0 || bytes > MAX_SCREENSHOT_BYTES) return;
    const name = frame.src.split("/").pop() ?? "screenshot";
    out.push({
      url: `/api/plugins/${encodeURIComponent(packageId)}/screenshots/${encodeURIComponent(record.version)}/${index}/${encodeURIComponent(name)}`,
      ...(frame.caption ? { caption: frame.caption } : {}),
      ...(frame.alt ? { alt: frame.alt } : {}),
    });
  });
  return out;
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

  const updateFields = (pkg: RuntimePackage): Pick<InstalledPluginDto, "updatable" | "autoUpdate" | "fork" | "updateCheck"> => ({
    updatable: sourceCanRefetch(pkg.persisted.source),
    ...(pkg.persisted.autoUpdate ? { autoUpdate: true } : {}),
    ...(pkg.persisted.fork ? { fork: { ...pkg.persisted.fork } } : {}),
    ...(pkg.persisted.updateCheck ? { updateCheck: publicUpdateCheck(pkg.persisted.updateCheck) } : {}),
  });

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
        ...updateFields(pkg),
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
    const screenshots = screenshotDtos(pkg.persisted.id, record);
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
      ...(record.canonical.display.summary ? { summary: record.canonical.display.summary } : {}),
      ...(record.canonical.display.tags?.length ? { tags: record.canonical.display.tags } : {}),
      classifiers: packageClassifiers(record.canonical),
      ...(screenshots.length ? { screenshots } : {}),
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
      ...updateFields(pkg),
      versions: listInstalledVersions(pluginHomeOf(pkg.persisted.id)),
    };
  };

  const prepareDir = async (
    pkgDir: string,
    source: string,
    trustedLocal = false,
  ): Promise<VersionRecord> => {
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
    const trustedSource = trustedLocal
      || source.startsWith("file:")
      || ((source.startsWith("path:") || source.startsWith("dir:")) && allowDevPath);
    if (requestedKind === "trusted-local" && !trustedSource) {
      throw err(
        "invalid-input",
        "trusted-local runtime requires a trusted local source; remote packages must use sandboxed runtime",
      );
    }
    assertServerEntryAllowed(loaded.legacy, trustedSource);
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
        const trustedSource = pkg.persisted.trustedSource === true
          || pkg.persisted.source.startsWith("file:")
          || ((pkg.persisted.source.startsWith("path:") || pkg.persisted.source.startsWith("dir:")) && allowDevPath);
        assertServerEntryAllowed(record.legacy, trustedSource);
        if (!opts.root || !opts.routes) {
          throw new Error("server entry activation requires plugin root and route registry");
        }
        const storageDir = join(pluginHomeOf(pkg.persisted.id), "storage");
        mkdirSync(storageDir, { recursive: true });
        const legacyStorageDir = join(record.dir, ".polyth");
        if (existsSync(legacyStorageDir)) {
          for (const name of readdirSync(legacyStorageDir)) {
            if (name === "ui" || name === "sandbox") continue;
            const from = join(legacyStorageDir, name);
            const to = join(storageDir, name);
            if (!existsSync(to)) cpSync(from, to, { recursive: true });
          }
        }
        const services = opts.managedPackageServices?.(pkg.persisted.id);
        if (services) assertPackageServices(services, pkg.persisted.id);
        const serverPlugin = await loadServerEntry({
          installDir: record.dir,
          entryPath: record.legacy.entries.server,
          integrity: record.integrity,
          host: {
            pluginId: pkg.persisted.id,
            storageDir,
            routes: {
              add(handler) {
                return opts.routes!.add(async (request) => {
                  // Trusted server code is process-global, but package enablement
                  // remains Space-scoped. Never let a global handler observe a
                  // request from a Space where the package is disabled.
                  if (!opts.packageSpaces) return handler(request);
                  const target = allSpaces().find((space) => space.spaceId === request.space.spaceId);
                  if (!target || !readSpaceEnabled(target.storage, pkg.persisted.id)) return false;
                  return handler(request);
                });
              },
            },
            root: opts.root,
            ...(services ? { services } : {}),
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

  /** Publish a package that is not installed yet. Both the fetched and the
   *  uploaded path go through here so their activation rules cannot drift. */
  const publishFresh = async (
    prepared: VersionRecord,
    staged: StagedSource,
    sourceLabel: string,
    extra: Pick<PersistedPackage, "autoUpdate" | "fork"> = {},
    adopt?: (home: string) => void,
  ): Promise<InstalledPluginDto> => {
    const home = pluginHomeOf(prepared.legacy.id);
    await publishVersion(home, prepared.version, staged.pkgDir);
    await writeActive(home, prepared.version);
    invalidateVersionCache(versionCache, home);
    adopt?.(home);
    const stored: RuntimePackage = {
      persisted: {
        id: prepared.legacy.id,
        source: sourceLabel,
        installationId: randomBytes(8).toString("hex"),
        ...(staged.trustedLocal === true ? { trustedSource: true } : {}),
        ...(extra.autoUpdate ? { autoUpdate: true } : {}),
        ...(extra.fork ? { fork: extra.fork } : {}),
      },
      status: "installed",
    };
    loadVersionRecord(home, prepared.version, versionCache);
    plugins.set(prepared.legacy.id, stored);
    persist();
    notify(opts, stored.persisted.id);
    return toDto(stored);
  };

  /** Stage a newer version of an installed package. The candidate keeps the
   *  original install source; a trust-class downgrade or a missing grant only
   *  leaves a reviewable candidate instead of swapping the active runtime. */
  const stageCandidate = async (
    pkg: RuntimePackage,
    prepared: VersionRecord,
    staged: StagedSource,
  ): Promise<InstalledPluginDto> => {
    const home = pluginHomeOf(pkg.persisted.id);
    if (staged.trustedLocal === true) pkg.persisted.trustedSource = true;
    if (runtimeKindOf(activeRecord(pkg).canonical) === "sandboxed" && runtimeKindOf(prepared.canonical) !== "sandboxed") {
      throw err("conflict", "an update cannot change a sandboxed package into a trusted-local package; reinstall explicitly");
    }
    await publishVersion(home, prepared.version, staged.pkgDir);
    invalidateVersionCache(versionCache, home, prepared.version);
    pkg.persisted.candidateVersion = prepared.version;
    try {
      await tryActivateCandidate(pkg);
    } finally {
      persist();
      notify(opts, pkg.persisted.id);
    }
    return toDto(pkg);
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

  /** Stamp of a package's operator-local source, or undefined for a fork, a
   *  remote source or a source that cannot be read right now. */
  const localFingerprint = (pkg: RuntimePackage): string | undefined => {
    if (pkg.persisted.fork) return undefined;
    try {
      const dir = localSourceDir(pkg.persisted.source, { trustedDir: opts.trustedDir, allowDevPath });
      return (dir === null ? null : localSourceFingerprint(dir)) ?? undefined;
    } catch {
      return undefined;
    }
  };

  /** `sourceFingerprint` is read before the check, so a source that moves
   *  while it runs still counts as changed afterwards. */
  const recordCheck = (
    pkg: RuntimePackage,
    outcome: Omit<PersistedUpdateCheck, "checkedAt" | "sourceFingerprint">,
    sourceFingerprint?: string,
  ): void => {
    pkg.persisted.updateCheck = { checkedAt: Date.now(), ...outcome, ...(sourceFingerprint ? { sourceFingerprint } : {}) };
  };

  const pruneHome = (pkg: RuntimePackage): void => {
    const home = pluginHomeOf(pkg.persisted.id);
    const keep = new Set<string>();
    const active = activeVersion(home);
    if (active) keep.add(active);
    if (pkg.persisted.previousVersion) keep.add(pkg.persisted.previousVersion);
    if (pkg.persisted.candidateVersion) keep.add(pkg.persisted.candidateVersion);
    pruneVersionsSync(home, keep);
    invalidateVersionCache(versionCache, home);
  };

  /** Fetch the source and stage whatever it now holds as a candidate. A fork
   *  first integrates upstream into its local commits; a conflict aborts
   *  before anything is published. */
  const applyUpdate = async (pkg: RuntimePackage, sourceFingerprint?: string): Promise<void> => {
    const id = pkg.persisted.id;
    const home = pluginHomeOf(id);
    const current = activeRecord(pkg);
    const staging = uniqueStaging();
    try {
      let staged: StagedSource;
      let prepared: VersionRecord;
      const fork = pkg.persisted.fork;
      if (fork) {
        const repo = forkDir(home);
        if (!existsSync(repo)) throw err("conflict", "the package fork checkout is missing; reinstall the package");
        await syncFork(repo, fork);
        const tree = await stageFork(repo, staging);
        staged = { pkgDir: tree.pkgDir, trustedLocal: false };
        const built = await prepareDir(staged.pkgDir, pkg.persisted.source, false);
        prepared = { ...built, version: forkVersion(built.version, tree.head) };
      } else {
        staged = await stageInstallSource({
          source: pkg.persisted.source,
          staging,
          trustedDir: opts.trustedDir,
          allowDevPath,
          downloadRepository: opts.downloadRepository,
        });
        prepared = await prepareDir(staged.pkgDir, pkg.persisted.source, staged.trustedLocal === true);
      }
      if (prepared.legacy.id !== id) throw err("invalid-input", "updated package id does not match");
      if (runtimeKindOf(current.canonical) === "sandboxed" && runtimeKindOf(prepared.canonical) !== "sandboxed") {
        throw err("conflict", "an update cannot change a sandboxed package into a trusted-local package; reinstall explicitly");
      }
      // Same version as the active one: nothing to update, matching probeUpdate.
      // Republishing it would only conflict with the already published tree.
      if (prepared.version === current.version) {
        recordCheck(pkg, { available: false }, sourceFingerprint);
        return;
      }
      await publishVersion(home, prepared.version, staged.pkgDir);
      invalidateVersionCache(versionCache, home, prepared.version);
      pkg.persisted.candidateVersion = prepared.version;
      await tryActivateCandidate(pkg);
      recordCheck(pkg, pkg.persisted.candidateVersion
        ? { available: true, version: pkg.persisted.candidateVersion }
        : { available: false }, sourceFingerprint);
      pruneHome(pkg);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  };

  /** Read-only: fetch upstream (fork) or the source manifest and compare. */
  const probeUpdate = async (pkg: RuntimePackage): Promise<Omit<PersistedUpdateCheck, "checkedAt">> => {
    if (!sourceCanRefetch(pkg.persisted.source)) {
      throw err("invalid-input", "this package was installed from an uploaded archive; upload a new archive to update it");
    }
    const fork = pkg.persisted.fork;
    if (fork) {
      const repo = forkDir(pluginHomeOf(pkg.persisted.id));
      if (!existsSync(repo)) throw err("conflict", "the package fork checkout is missing; reinstall the package");
      const status = await checkFork(repo, fork);
      return status.behind > 0 ? { available: true, behind: status.behind } : { available: false };
    }
    const staging = uniqueStaging();
    try {
      const staged = await stageInstallSource({
        source: pkg.persisted.source,
        staging,
        trustedDir: opts.trustedDir,
        allowDevPath,
        downloadRepository: opts.downloadRepository,
      });
      const next = loadCanonicalManifest(staged.pkgDir).legacy;
      if (next.id !== pkg.persisted.id) throw err("invalid-input", "the source now holds a different package id");
      const current = activeRecord(pkg).legacy.version;
      const newer = validSemver(next.version) && validSemver(current)
        ? semverGt(next.version, current)
        : next.version !== current;
      return newer ? { available: true, version: next.version } : { available: false };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  };

  const installFork = async (source: string, strategy: ForkStrategy, autoUpdate: boolean): Promise<InstalledPluginDto> => {
    const described = describeInstallSource(source, allowDevPath);
    if (described.kind !== "repository" || !described.repositoryHost || !described.repositoryPath || !described.repositoryRef) {
      throw err("invalid-input", "only a GitHub, GitLab or Codeberg repository link can be installed as a fork");
    }
    const tracking: ForkTracking = { strategy, ref: described.repositoryRef };
    const staging = uniqueStaging();
    const repo = join(staging, "fork");
    try {
      await cloneFork((opts.forkCloneAttempts ?? forkCloneAttempts)({
        host: described.repositoryHost,
        path: described.repositoryPath,
        ref: described.repositoryRef,
      }, repo), repo, staging);
      return await installForkCheckout(source, repo, staging, tracking, autoUpdate);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  };

  /** Publish a freshly cloned fork. Fork bytes are a public checkout chosen by
   *  the operator, not an operator-owned local tree, so they keep the remote
   *  trust class: sandboxed runtimes only. */
  const installForkCheckout = async (
    source: string,
    repo: string,
    staging: string,
    tracking: ForkTracking,
    autoUpdate: boolean,
  ): Promise<InstalledPluginDto> => {
    const tree = await stageFork(repo, staging);
    const staged: StagedSource = { pkgDir: tree.pkgDir, trustedLocal: false };
    const built = await prepareDir(staged.pkgDir, source, false);
    if (plugins.has(built.legacy.id)) throw err("conflict", `plugin already installed: ${built.legacy.id}`);
    const prepared = { ...built, version: forkVersion(built.version, tree.head) };
    return publishFresh(prepared, staged, source, { autoUpdate, fork: tracking }, (home) => {
      rmSync(forkDir(home), { recursive: true, force: true });
      renameSync(repo, forkDir(home));
    });
  };

  const registry: PluginRegistry = {
    list: (storage) => [...plugins.values()].map((pkg) => toDto(pkg, storage)),
    detail: (id, storage) => toDto(get(id), storage),

    /** Uploaded archive: install a new package, or stage an update when the id
     *  is already installed. `prepareDir` receives an `upload:` label, so a
     *  trusted-local runtime is still rejected — an upload is never a trusted
     *  local source, and `update()` cannot refetch it. */
    async installArchive(archive: Buffer, filename: string): Promise<InstalledPluginDto> {
      if (!archive.length) throw err("invalid-input", "archive is empty");
      if (archive.length > MAX_ARCHIVE_BYTES) throw err("invalid-input", "zip archive is too large");
      const safeName = ((filename.trim().split(/[/\\]/).pop() ?? "package.zip")
        .replace(/[^A-Za-z0-9._-]/g, "_")
        .slice(0, 64)) || "package.zip";
      const label = `upload:${safeName}`;
      const staging = uniqueStaging();
      try {
        const staged = await stageArchiveBuffer(archive, staging);
        const prepared = await prepareDir(staged.pkgDir, label, staged.trustedLocal === true);
        const existing = plugins.get(prepared.legacy.id);
        if (!existing) return await publishFresh(prepared, staged, label);
        // `await` (not a bare return) keeps the staging dir alive until the
        // locked update finished; `finally` runs before an unawaited return.
        return await withLock(prepared.legacy.id, () => stageCandidate(existing, prepared, staged));
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    },

    async install(source: string, options: InstallOptions = {}): Promise<InstalledPluginDto> {
      if (typeof source !== "string" || !source.trim()) throw err("invalid-input", "install source required");
      if (options.fork) return installFork(source.trim(), options.fork.strategy, options.autoUpdate === true);
      const staging = uniqueStaging();
      try {
        const staged = await stageInstallSource({
          source: source.trim(),
          staging,
          trustedDir: opts.trustedDir,
          allowDevPath,
          downloadRepository: opts.downloadRepository,
        });
        const prepared = await prepareDir(staged.pkgDir, source.trim(), staged.trustedLocal === true);
        if (plugins.has(prepared.legacy.id)) {
          throw err("conflict", `plugin already installed: ${prepared.legacy.id}`);
        }
        return await publishFresh(prepared, staged, source.trim(), { autoUpdate: options.autoUpdate === true });
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

    screenshotFrame(id: string, version: string, index: number): { src: string } | null {
      if (!plugins.has(id) || !Number.isInteger(index) || index < 0) return null;
      const home = pluginHomeOf(id);
      if (!listInstalledVersions(home).includes(version)) return null;
      let record: VersionRecord;
      try {
        record = loadVersionRecord(home, version, versionCache);
      } catch {
        return null;
      }
      const frame = record.canonical.display.screenshots?.[index];
      return frame ? { src: frame.src } : null;
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
        const fingerprint = localFingerprint(pkg);
        try {
          await applyUpdate(pkg, fingerprint);
        } catch (cause) {
          recordCheck(pkg, { available: false, error: (cause as Error).message }, fingerprint);
          throw cause;
        } finally {
          persist();
          notify(opts, id);
        }
        return toDto(pkg, options.storage);
      });
    },

    checkUpdate(id: string, options: { storage?: SpaceStorage } = {}): Promise<InstalledPluginDto> {
      return withLock(id, async () => {
        const pkg = get(id);
        const fingerprint = localFingerprint(pkg);
        try {
          const outcome = await probeUpdate(pkg);
          // A found release stays pending for the local-source pass until
          // update() acts on it: only a check that settles the source takes its stamp.
          recordCheck(pkg, outcome, outcome.available ? pkg.persisted.updateCheck?.sourceFingerprint : fingerprint);
        } catch (cause) {
          recordCheck(pkg, { available: false, error: (cause as Error).message }, fingerprint);
          throw cause;
        } finally {
          persist();
          notify(opts, id);
        }
        return toDto(pkg, options.storage);
      });
    },

    changedLocalSources(): string[] {
      const changed: string[] = [];
      for (const pkg of plugins.values()) {
        if (!pkg.persisted.autoUpdate) continue;
        const fingerprint = localFingerprint(pkg);
        if (!fingerprint || fingerprint === pkg.persisted.updateCheck?.sourceFingerprint) continue;
        try {
          // New access waits for the owner; a candidate that only failed to
          // activate is replaced by the next release instead.
          const candidate = candidateRecord(pkg);
          if (candidate && !versionCompatible(pkg.persisted.id, candidate)) continue;
        } catch {
          continue;
        }
        changed.push(pkg.persisted.id);
      }
      return changed;
    },

    configure(id: string, settings: PackageUpdateSettings, storage?: SpaceStorage): Promise<InstalledPluginDto> {
      return withLock(id, async () => {
        const pkg = get(id);
        if (settings.autoUpdate !== undefined) {
          if (settings.autoUpdate && !sourceCanRefetch(pkg.persisted.source)) {
            throw err("invalid-input", "this package was installed from an uploaded archive and cannot update automatically");
          }
          if (settings.autoUpdate) pkg.persisted.autoUpdate = true;
          else delete pkg.persisted.autoUpdate;
        }
        if (settings.forkStrategy !== undefined) {
          if (!pkg.persisted.fork) throw err("invalid-input", "only a forked package has an update strategy");
          pkg.persisted.fork = { ...pkg.persisted.fork, strategy: settings.forkStrategy };
        }
        persist();
        notify(opts, id);
        return toDto(pkg, storage);
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
