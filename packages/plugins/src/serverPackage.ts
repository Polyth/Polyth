// Autonomous server-package discovery. Workspace feature packages opt in with
// a `"polyth": { "serverEntry": "./src/serverEntry.ts", "descriptor": ... }`
// marker in package.json; the entry default-exports a `registerPackage(host)`
// factory returning a `ServerPackage` (routes + enable/disable hooks). The
// server scans packages/*, loads every marked entry, and wires it into the
// package lifecycle — no static imports, descriptors, or manual registration
// in the composition root.
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { cap } from "@polyth/contracts";
import type {
  AgentRuntime,
  AuthPrincipal,
  AuthResolution,
  CapabilityKey,
  Disposable,
  InstalledPluginDto,
  JsonObject,
  ModelRef,
  NotificationRecord,
  PackageDescriptorDto,
  Plugin,
  ProjectService,
  RemoteAccessPolicy,
  RequestIngress,
  RouteHandler,
  SessionEvent,
  SessionPersistence,
  SessionProjection,
  SessionService,
  SpaceContext,
  SpaceStorage,
  DeploymentProfile,
} from "@polyth/contracts";
import type { RuntimeMutationStore } from "@polyth/session";
import type { TrustedServerPluginHost } from "./trustedServerEntry.ts";
import type { PairedSocketRegistry } from "./pairedSockets.ts";

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

// ---- server package contract ------------------------------------------------------

/** What a feature package's serverEntry returns; mirrors the server's
 *  packageLifecycle contract. `routes` is added to the route registry while the
 *  package is enabled and removed when it is disabled. */
export function localOnlyRemoteAccess(routeScopes: readonly string[]): RemoteAccessPolicy {
  return { routeScopes, http: [] };
}

/** What a feature package's serverEntry returns. Remote access is default-deny:
 *  omit `remoteAccess` and paired devices cannot reach the package. */
export interface ServerPackage {
  routes?: RouteHandler;
  remoteAccess?: RemoteAccessPolicy;
  onEnable?: () => void | Promise<void>;
  onDisable?: () => void | Promise<void>;
}

export type ServerPackageFactory = (
  host: ServerPackageHost,
) => ServerPackage | Promise<ServerPackage>;

// ---- shared core services on the host --------------------------------------------

/** Session fan-out to connected clients (structural mirror of the server's
 *  Broadcaster; events must already be persisted before they are broadcast). */
export interface ServerBroadcast {
  event(ev: SessionEvent): void;
  projection(p: SessionProjection): void;
  notification?(record: NotificationRecord): void;
  pluginChanged?(plugin: InstalledPluginDto): void;
  packageChanged?(pkg: PackageDescriptorDto): void;
}

/** Per-project agent-runtime pool (structural mirror of the server's pool). */
export interface ServerRuntimePool {
  /** `cwd` overrides the project root — that is how worktree sessions are isolated. */
  forProject(projectId: string, cwd?: string): Promise<AgentRuntime>;
  forSession?(projection: SessionProjection, cwd: string, targetHarnessId?: string): Promise<AgentRuntime>;
  restartAll?(): Promise<number>;
}

/** A session's runtime plus the context needed to run one-shot completions on it. */
export interface SessionRuntimeBinding {
  rt: AgentRuntime;
  cwd: string;
  model?: ModelRef;
  agent?: string;
}

export interface ServerOneShotOptions {
  cwd: string;
  prompt: string;
  model?: ModelRef;
  agent?: string;
  timeoutMs?: number;
  /** Stable logical task identity for response-loss deduplication. */
  taskId?: string;
}

export interface ServerSmallModelOptions {
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  model?: ModelRef;
  maxOutputTokens: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  responseSchema?: JsonObject;
}

export interface ServerSmallModelResult {
  text: string;
  providerID: string;
  modelID: string;
  inputTruncated: boolean;
  transport: "direct" | "compatibility";
  latencyMs: number;
  firstTokenMs?: number;
}

export type AppendEventOptions = Partial<
  Pick<SessionEvent, "ignorable" | "surfaceOp" | "sourceEventSeqs" | "producerPlugin">
>;

/** Handed to `onHttpServer` callbacks once the gateway's HTTP server exists. */
export interface HttpServerContext {
  server: import("node:http").Server;
  /** Public listener id, or `polyth-link` for the internal tunnel ingress. */
  listenerId: string;
  /** Canonical HTTP handler shared by the public listener and tunnel ingress. */
  dispatch(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
    ingress: RequestIngress,
  ): Promise<void>;
  resolve(
    request: import("node:http").IncomingMessage,
    ingress: RequestIngress,
  ): AuthResolution;
  /** True when the upgrade may proceed. Uses the listener's trusted ingress. */
  authorize(request: import("node:http").IncomingMessage): boolean;
  /** Immutable identity accepted for this upgrade. */
  identity(request: import("node:http").IncomingMessage): AuthResolution;
  /** Re-read live paired-device grants. Null means the principal is gone/revoked. */
  refreshPrincipal(principal: AuthPrincipal): AuthPrincipal | null;
  /** Close matching paired-device sockets on revoke/disconnect. */
  pairedSockets: PairedSocketRegistry;
}

/** Cross-package service seam. Each discovered package constructs its own
 *  services during `registerPackage` and provides them under well-known keys
 *  (`serverServiceKey(name)`); the composition root only provides the few
 *  infrastructure seams packages cannot build themselves (voice settings,
 *  secure-safe, config applier, remote probe). Resolve dependencies lazily
 *  (inside `onEnable` or route handlers), never at `registerPackage` time —
 *  load order between packages is alphabetical, not dependency-sorted. */
export interface ServerServiceRegistry {
  /** Register a service instance. Throws on a duplicate id. */
  provide<T>(key: CapabilityKey<T>, service: T): void;
  get<T>(key: CapabilityKey<T>): T | undefined;
  /** Like `get`, but throws `not-found` when the service is missing. */
  require<T>(key: CapabilityKey<T>): T;
  ids(): string[];
}

/** Well-known id convention for shared server services: `polyth.service.<name>`. */
export const serverServiceKey = <T>(name: string): CapabilityKey<T> =>
  cap<T>(`polyth.service.${name}`);

export function createServerServiceRegistry(): ServerServiceRegistry {
  const services = new Map<string, unknown>();
  return {
    provide(key, service) {
      if (services.has(key.id)) throw err("conflict", `server service already provided: ${key.id}`);
      services.set(key.id, service);
    },
    get: <T>(key: CapabilityKey<T>) => services.get(key.id) as T | undefined,
    require<T>(key: CapabilityKey<T>): T {
      if (!services.has(key.id)) throw err("not-found", `server service not provided: ${key.id}`);
      return services.get(key.id) as T;
    },
    ids: () => [...services.keys()].sort(),
  };
}

/** The host handed to every discovered workspace package. Extends the trusted
 *  plugin host with the shared core services the composition root constructs,
 *  so cross-dependent packages resolve autonomously instead of being hand-wired
 *  in `packages/server/src/index.ts`. */
export interface ServerPackageHost extends TrustedServerPluginHost {
  /**
   * Tenancy seam. A package should NOT answer "who is the user / which Space /
   * where is my data / may this be accessed" for itself — it receives an
   * already-validated `SpaceContext` on every request (`rc.space`) and asks the
   * host for the rest:
   *
   *   host.spaceStorage(rc.space).packageDir(id)  // its own dir in that Space
   *   host.spaceStorage(rc.space).path(relative)  // validated, escape-proof
   *   host.deployment                             // trusted vs hosted profile
   *
   * `storageDir` (inherited) stays the SHARED, non-tenant root. It is correct
   * for genuinely deployment-wide state (a binary cache, a trusted registry)
   * and wrong for anything a Space owns. Packages still holding tenant state
   * there are being migrated; new tenant state goes through `spaceStorage`.
   */
  spaceStorage(ctx: SpaceContext): SpaceStorage;
  /** Resolve tenant-scoped core services inside request handlers. */
  forSpace(ctx: SpaceContext): { projects: ProjectService; sessions: SessionService };
  /** Deployment/security profile. Branch on this instead of ad-hoc
   *  `if (cloud)` checks — see `allowsHostFilesystemBrowsing` and
   *  `allowsTenantPackagesInControlPlane` in @polyth/contracts. */
  deployment: DeploymentProfile;
  projects: ProjectService;
  /** Canonical session service. The reference is stable, but the service is
   *  composed AFTER package load — capture it in closures freely, never invoke
   *  its methods while `registerPackage` runs. */
  sessions: SessionService;
  /** Append-only session event store. Appends here are NOT broadcast; use
   *  `events.append` for the persist-then-broadcast pattern. */
  store: SessionPersistence & RuntimeMutationStore;
  broadcast: ServerBroadcast;
  runtimes: ServerRuntimePool;
  services: ServerServiceRegistry;
  /** Persist an event to the session log, then broadcast it. Pass
   *  `producerPlugin`/`ignorable` opts exactly as the feature requires. */
  events: {
    append(
      sessionId: string,
      type: string,
      data: JsonObject,
      opts?: AppendEventOptions,
    ): Promise<SessionEvent>;
  };
  /** One-shot cheap-model completion on a throwaway backend session (never a
   *  user session; never written to the canonical log). */
  oneShot(runtime: AgentRuntime, opts: ServerOneShotOptions): Promise<string>;
  /** Lightweight utility inference. Uses a direct provider request whenever
   * supported; oneShot is only a compatibility fallback. */
  smallModelComplete(runtime: AgentRuntime, opts: ServerSmallModelOptions): Promise<ServerSmallModelResult>;
  smallModelInputBudget(runtime: AgentRuntime, model: ModelRef | undefined, maxOutputTokens: number): Promise<number>;
  /** POLYTH_SMALL_MODEL when configured — cheap model for auditors/summaries. */
  smallModel(): ModelRef | undefined;
  /** Resolve a session's project runtime + cwd/model/agent context. */
  resolveSessionRuntime(sessionId: string): Promise<SessionRuntimeBinding>;
  /** Mount a kernel plugin on the composition root; dispose to unmount. */
  loadPlugin(plugin: Plugin): Promise<Disposable>;
  /** Defer work until the gateway's HTTP server exists (e.g. attaching a WS
   *  upgrade channel). Callbacks registered during package load run before the
   *  core session gateway claims `/ws` upgrades, preserving upgrade priority. */
  onHttpServer(cb: (ctx: HttpServerContext) => void): void;
  /** Re-run HTTP-server callbacks against an additional listener (tunnel ingress). */
  attachHttpChannels(ctx: HttpServerContext): void;
  /** Start the canonical private Polyth Link HTTP/WS ingress. */
  startTunnelIngress(opts: {
    socketPath: string;
    secret: string;
    lookup(connectionId: string): Extract<RequestIngress, { kind: "polyth-link" }> | null;
  }): Promise<{ close(): Promise<void> }>;
  /** Enabled package remote-access policies plus whatever the registry currently holds. */
  remotePolicies(): ReadonlyArray<{ owner: string; policy: RemoteAccessPolicy }>;
  /** Tunnel ingress supplies the live paired-device principal. Never reads headers. */
  attachPairedDeviceResolver(
    resolver: (ingress: Extract<RequestIngress, { kind: "polyth-link" }>) => AuthPrincipal | null,
  ): void;
  /** Close WebSocket/proxy sockets belonging to one paired device. */
  closePairedDevice(deviceId: string): void;
  pairedSockets: PairedSocketRegistry;
}

// ---- discovery --------------------------------------------------------------------

/** Composition/infrastructure packages may never be discovered as features. */
export const INFRASTRUCTURE_PACKAGE_DIRS: ReadonlySet<string> = new Set([
  "contracts",
  "kernel",
  "session",
  "tenancy",
  "server",
]);

export interface DiscoveredServerPackage {
  /** Directory name; doubles as the package-lifecycle / registry id. */
  id: string;
  /** package.json "name", e.g. "@polyth/home-assistant". */
  packageName: string;
  /** Absolute package directory. */
  dir: string;
  /** The polyth.serverEntry marker value, relative to `dir`. */
  entryPath: string;
  /** Package-owned settings/lifecycle metadata from polyth.descriptor. */
  descriptor: PackageDescriptorDto;
}

const validEntryPath = (entry: string): boolean =>
  !!entry
  && !entry.includes("\\")
  && !isAbsolute(entry)
  && !win32.isAbsolute(entry)
  && !entry.split("/").includes("..");

const SETTINGS_GROUPS = new Set(["Workspace", "Engineering", "Customize", "System"]);

function packageDescriptor(id: string, value: unknown): PackageDescriptorDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw err("invalid-input", `package "${id}" must declare a polyth.descriptor object`);
  }
  const descriptor = value as Record<string, unknown>;
  if (
    typeof descriptor.name !== "string" || !descriptor.name.trim()
    || typeof descriptor.description !== "string" || !descriptor.description.trim()
    || typeof descriptor.core !== "boolean"
    || typeof descriptor.enabled !== "boolean"
    || typeof descriptor.hasSettings !== "boolean"
  ) {
    throw err(
      "invalid-input",
      `package "${id}" polyth.descriptor requires name, description, core, enabled, and hasSettings`,
    );
  }
  if (
    descriptor.settingsGroup !== undefined
    && (typeof descriptor.settingsGroup !== "string"
      || !SETTINGS_GROUPS.has(descriptor.settingsGroup))
  ) {
    throw err("invalid-input", `package "${id}" polyth.descriptor.settingsGroup is invalid`);
  }
  if (
    descriptor.icon !== undefined
    && (typeof descriptor.icon !== "string" || !descriptor.icon.trim())
  ) {
    throw err("invalid-input", `package "${id}" polyth.descriptor.icon must be a non-empty string`);
  }
  if (descriptor.core && !descriptor.enabled) {
    throw err("invalid-input", `core package "${id}" must be enabled by default`);
  }
  return {
    id,
    name: descriptor.name,
    description: descriptor.description,
    core: descriptor.core,
    enabled: descriptor.enabled,
    hasSettings: descriptor.hasSettings,
    ...(typeof descriptor.settingsGroup === "string"
      ? { settingsGroup: descriptor.settingsGroup as PackageDescriptorDto["settingsGroup"] }
      : {}),
    ...(typeof descriptor.icon === "string" ? { icon: descriptor.icon } : {}),
  };
}

/** Scan `packagesDir` for workspace packages that opt in to server discovery
 *  via a `polyth.serverEntry` package.json marker. Unmarked and unreadable
 *  packages are skipped; a marked infrastructure package or an invalid entry
 *  path is a developer error and throws. Results sort by id for determinism. */
export async function discoverServerPackages(
  packagesDir: string,
): Promise<DiscoveredServerPackage[]> {
  let entries;
  try {
    entries = await readdir(packagesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const discovered: DiscoveredServerPackage[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    } catch {
      continue; // no package.json (or unparseable) — cannot opt in
    }
    const pkg = parsed as {
      name?: unknown;
      polyth?: { serverEntry?: unknown; descriptor?: unknown };
    } | null;
    const entryPath = pkg?.polyth?.serverEntry;
    if (entryPath === undefined) continue;
    if (INFRASTRUCTURE_PACKAGE_DIRS.has(entry.name)) {
      throw err(
        "invalid-input",
        `infrastructure package "${entry.name}" must not declare polyth.serverEntry`,
      );
    }
    if (typeof entryPath !== "string" || !validEntryPath(entryPath)) {
      throw err(
        "invalid-input",
        `package "${entry.name}" polyth.serverEntry must be a relative path without ".." or backslashes`,
      );
    }
    discovered.push({
      id: entry.name,
      packageName: typeof pkg?.name === "string" ? pkg.name : `@polyth/${entry.name}`,
      dir,
      entryPath,
      descriptor: packageDescriptor(entry.name, pkg?.polyth?.descriptor),
    });
  }
  return discovered.sort((a, b) => a.id.localeCompare(b.id));
}

// ---- loader -----------------------------------------------------------------------

const inside = (base: string, candidate: string): boolean =>
  candidate === base || candidate.startsWith(base + sep);

/** Import a discovered package's serverEntry and run its registerPackage
 *  factory. The entry must stay inside the package directory and must
 *  default-export a function returning a `ServerPackage`. */
export async function loadServerPackage(
  discovered: DiscoveredServerPackage,
  host: ServerPackageHost,
): Promise<ServerPackage> {
  const dir = await realpath(discovered.dir);
  const requested = resolve(dir, discovered.entryPath);
  if (!inside(dir, requested)) {
    throw err("invalid-path", `server entry for "${discovered.id}" escapes its package directory`);
  }
  const entry = await realpath(requested);
  if (!inside(dir, entry)) {
    throw err("invalid-path", `server entry for "${discovered.id}" escapes its package directory`);
  }
  if (!(await stat(entry)).isFile()) {
    throw err("invalid-input", `server entry for "${discovered.id}" must resolve to a file`);
  }

  const loaded = await import(pathToFileURL(entry).href) as { default?: unknown };
  if (typeof loaded.default !== "function") {
    throw err(
      "invalid-input",
      `server entry for "${discovered.id}" must default-export a registerPackage(host) function`,
    );
  }

  const pkg = await (loaded.default as ServerPackageFactory)(host);
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
    throw err("invalid-input", `registerPackage for "${discovered.id}" must return a ServerPackage object`);
  }
  for (const field of ["routes", "onEnable", "onDisable"] as const) {
    if (pkg[field] !== undefined && typeof pkg[field] !== "function") {
      throw err(
        "invalid-input",
        `registerPackage for "${discovered.id}" returned a non-function "${field}"`,
      );
    }
  }
  if (pkg.remoteAccess !== undefined) {
    if (!pkg.remoteAccess || typeof pkg.remoteAccess !== "object" || Array.isArray(pkg.remoteAccess)) {
      throw err("invalid-input", `registerPackage for "${discovered.id}" returned invalid remoteAccess`);
    }
  }
  return pkg;
}
