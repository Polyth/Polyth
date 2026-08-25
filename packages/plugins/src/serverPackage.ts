// Autonomous server-package discovery. Workspace feature packages opt in with
// a `"polyth": { "serverEntry": "./src/serverEntry.ts" }` marker in their
// package.json; the entry default-exports a `registerPackage(host)` factory
// returning a `ServerPackage` (routes + enable/disable hooks). The server
// scans packages/*, loads every marked entry, and wires it into the package
// lifecycle — no static imports or manual registration in the composition root.
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { cap } from "@polyth/contracts";
import type {
  AgentRuntime,
  CapabilityKey,
  Disposable,
  InstalledPluginDto,
  JsonObject,
  ModelRef,
  NotificationRecord,
  PackageDescriptorDto,
  Plugin,
  ProjectService,
  RouteHandler,
  SessionEvent,
  SessionPersistence,
  SessionProjection,
  SessionService,
} from "@polyth/contracts";
import type { TrustedServerPluginHost } from "./trustedServerEntry.ts";

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

// ---- server package contract ------------------------------------------------------

/** What a feature package's serverEntry returns; mirrors the server's
 *  packageLifecycle contract. `routes` is added to the route registry while the
 *  package is enabled and removed when it is disabled. */
export interface ServerPackage {
  routes?: RouteHandler;
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
}

export type AppendEventOptions = Partial<
  Pick<SessionEvent, "ignorable" | "surfaceOp" | "sourceEventSeqs" | "producerPlugin">
>;

/** Cross-package service seam. The composition root provides the shared
 *  instances it constructs (git, terminals, browser, …) under well-known keys
 *  (`serverServiceKey(name)`); packages provide their own services for others
 *  to consume. Resolve dependencies lazily (inside `onEnable` or route
 *  handlers), never at `registerPackage` time — load order between packages is
 *  alphabetical, not dependency-sorted. */
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
  projects: ProjectService;
  sessions: SessionService;
  /** Append-only session event store. Appends here are NOT broadcast; use
   *  `events.append` for the persist-then-broadcast pattern. */
  store: SessionPersistence;
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
  /** POLYTH_SMALL_MODEL when configured — cheap model for auditors/summaries. */
  smallModel(): ModelRef | undefined;
  /** Resolve a session's project runtime + cwd/model/agent context. */
  resolveSessionRuntime(sessionId: string): Promise<SessionRuntimeBinding>;
  /** Mount a kernel plugin on the composition root; dispose to unmount. */
  loadPlugin(plugin: Plugin): Promise<Disposable>;
}

// ---- discovery --------------------------------------------------------------------

/** Composition/infrastructure packages may never be discovered as features. */
export const INFRASTRUCTURE_PACKAGE_DIRS: ReadonlySet<string> = new Set([
  "contracts",
  "kernel",
  "session",
  "backend-opencode",
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
}

const validEntryPath = (entry: string): boolean =>
  !!entry
  && !entry.includes("\\")
  && !isAbsolute(entry)
  && !win32.isAbsolute(entry)
  && !entry.split("/").includes("..");

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
    const pkg = parsed as { name?: unknown; polyth?: { serverEntry?: unknown } } | null;
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
  return pkg;
}
