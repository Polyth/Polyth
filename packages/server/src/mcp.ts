// MCP desired state with an owner (Spaces §14.6).
//
// Space-owned servers live in the Space (`mcp.json` + `mcp-secrets.json`);
// project entries share that store and own their configuration, inherited
// entries are copied only by an explicit override. Only Space admins change
// them; other members list them with arguments and URLs redacted, and nobody
// ever reads a secret value back.
//
// Person-owned servers live outside every Space, in the person's `mcp`
// storage and Credential Vault partition (§14.4). They are listed only to
// their owner and attach only to that person's private chats: native MCP
// tools live in the harness process, which cannot gate them per turn, so a
// chat anyone else can open never gets them.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteSync, type PeopleHost } from "@polyth/plugins";
import { createSpaceStorage } from "@polyth/tenancy";
import { roleAtLeast } from "@polyth/contracts";
import type {
  DeploymentProfile, JsonObject, McpStatus, McpTombstone, McpTransport, SpaceContext,
} from "@polyth/contracts";
import type {
  McpAccessDto, McpInspectionDto, McpInstallationDto, McpSessionScope, McpToolCallResult,
} from "@polyth/contracts/capability-installations";
import { callMcpTool, inspectMcpServer } from "./mcpProbe.ts";
import { isSystemContext } from "./sessionPeople.ts";

/** Package id of person-owned MCP data in `host.people`. */
export const PERSONAL_MCP_PACKAGE = "mcp";
const MAX_PERSONAL_SERVERS = 64;

export interface McpProjectorServer {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  raw?: Record<string, unknown>;
  revision: number;
  projectId?: string;
  /** Set on a person-owned server attached to its owner's private chat. */
  ownerUserId?: string;
}

interface ScopedTombstone extends McpTombstone { projectId?: string }

export interface McpProjectionState {
  servers: McpProjectorServer[];
  retiredNames: string[];
  tombstones: ScopedTombstone[];
  secretsFor(id: string): Record<string, string>;
}

export interface McpCreateInput {
  name: string;
  transport: McpTransport;
  secrets?: Record<string, string>;
  enabled?: boolean;
  /** Read-only adoption: never write native backend configuration. */
  origin?: "backend-import";
  raw?: Record<string, unknown>;
}

export interface McpPatchInput {
  name?: string;
  transport?: McpTransport;
  secrets?: Record<string, string>;
  enabled?: boolean;
}

export interface McpConfigService {
  /** What the caller may change here. */
  access(space: SpaceContext): McpAccessDto;
  /** Omit projectId for Space installations; supply it for the effective project set.
   *  `session` adds the actor's personal servers when that chat qualifies. */
  list(space: SpaceContext, projectId?: string, session?: McpSessionScope): McpInstallationDto[];
  create(space: SpaceContext, input: McpCreateInput, projectId?: string): Promise<McpInstallationDto>;
  update(space: SpaceContext, id: string, patch: McpPatchInput, expectedRevision: number, projectId?: string): Promise<McpInstallationDto>;
  remove(space: SpaceContext, id: string, projectId?: string): Promise<boolean>;
  importServers(space: SpaceContext, inputs: McpCreateInput[], projectId?: string): Promise<McpInstallationDto[]>;
  override(space: SpaceContext, id: string, projectId: string, enabled: boolean): Promise<McpInstallationDto>;
  tools(space: SpaceContext, id: string, projectId?: string, session?: McpSessionScope): McpInspectionDto;
  test(space: SpaceContext, id: string, projectId?: string, session?: McpSessionScope): Promise<McpInspectionDto>;
  call(space: SpaceContext, id: string, projectId: string, input: { toolName: string; arguments: JsonObject; sessionId: string; cwd: string; signal?: AbortSignal; actorUserId?: string }): Promise<McpToolCallResult>;
  /** Trusted projector read; credentials are restricted to this effective
   *  snapshot. A `sessionId` adds the personal servers of the person that chat
   *  is private to; omit it for a runtime that serves more than one chat. */
  projection(space: SpaceContext, projectId?: string, sessionId?: string): McpProjectionState;
  /** Trusted project-removal hook. Does not remove inherited installations. */
  removeProject(space: SpaceContext, projectId: string): void;
  /** The signed-in person's own servers. */
  listPersonal(space: SpaceContext): McpInstallationDto[];
  createPersonal(space: SpaceContext, input: McpCreateInput): Promise<McpInstallationDto>;
  updatePersonal(space: SpaceContext, id: string, patch: McpPatchInput, expectedRevision: number): Promise<McpInstallationDto>;
  removePersonal(space: SpaceContext, id: string): Promise<boolean>;
  personalTools(space: SpaceContext, id: string): McpInspectionDto;
  testPersonal(space: SpaceContext, id: string): Promise<McpInspectionDto>;
  /** Does this person keep an enabled personal server? */
  hasPersonalServers(userId: string): boolean;
}

const MCP_OWNED_ENTRY_FIELDS = new Set(["type", "command", "environment", "enabled", "url", "headers"]);
const opaqueMcpFragment = (entry: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(entry).filter(([key]) => !MCP_OWNED_ENTRY_FIELDS.has(key)));

export function mcpEntriesFromBackendConfig(cfg: Record<string, unknown>): McpCreateInput[] {
  const block = cfg.mcp;
  if (!block || typeof block !== "object" || Array.isArray(block)) return [];
  const out: McpCreateInput[] = [];
  for (const [name, raw] of Object.entries(block as Record<string, unknown>)) {
    if (!name || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const opaque = opaqueMcpFragment(entry);
    const common = {
      enabled: entry.enabled !== false,
      origin: "backend-import" as const,
      ...(Object.keys(opaque).length ? { raw: opaque } : {}),
    };
    if (entry.type === "local") {
      const command = Array.isArray(entry.command) ? entry.command.map(String).filter(Boolean) : [];
      if (!command.length) continue;
      const env = entry.environment && typeof entry.environment === "object" && !Array.isArray(entry.environment)
        ? Object.fromEntries(Object.entries(entry.environment as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>
        : {};
      out.push({
        name,
        transport: { kind: "stdio", command: command[0]!, args: command.slice(1), envKeys: Object.keys(env) },
        ...(Object.keys(env).length ? { secrets: env } : {}),
        ...common,
      });
    } else if (entry.type === "remote") {
      const url = typeof entry.url === "string" ? entry.url : "";
      if (!url) continue;
      const headers = entry.headers && typeof entry.headers === "object" && !Array.isArray(entry.headers)
        ? Object.fromEntries(Object.entries(entry.headers as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>
        : {};
      out.push({
        name,
        transport: { kind: "http", url, headersSecretRefs: Object.keys(headers) },
        ...(Object.keys(headers).length ? { secrets: headers } : {}),
        ...common,
      });
    }
  }
  return out;
}

interface StoredServer extends McpProjectorServer {
  status: McpStatus;
  lastError?: string;
  inspections?: Record<string, { revision: number; result: McpInspectionDto }>;
}
interface StoredDocument {
  version: 2;
  servers: StoredServer[];
  tombstones: ScopedTombstone[];
}
interface SpaceMcpState {
  servers: StoredServer[];
  secrets: Record<string, Record<string, string>>;
  tombstones: ScopedTombstone[];
}
const err = (code: string, message: string) => Object.assign(new Error(message), { code });
const sameScope = (row: { projectId?: string }, projectId?: string): boolean => row.projectId === projectId;

const secretKeys = (transport: McpTransport): string[] =>
  transport.kind === "stdio" ? transport.envKeys : transport.headersSecretRefs;

const validateSecrets = (transport: McpTransport, secrets?: Record<string, string>): void => {
  if (!secrets) return;
  const allowed = new Set(secretKeys(transport));
  for (const key of Object.keys(secrets)) {
    if (!allowed.has(key)) {
      throw err("invalid-input", `secret "${key}" is not referenced by the MCP transport`);
    }
    const value = secrets[key];
    if (typeof value !== "string" || value.length > 16_384 || value.includes("\0") || (transport.kind === "http" && /[\r\n]/.test(value))) throw err("invalid-input", "invalid MCP credential value");
  }
};

const retainReferencedSecrets = (
  transport: McpTransport,
  secrets: Record<string, string>,
): Record<string, string> => Object.fromEntries(
  secretKeys(transport).flatMap((key) =>
    Object.prototype.hasOwnProperty.call(secrets, key) ? [[key, secrets[key]!]] : []),
);

/** What a member who cannot manage a Space server sees of its transport:
 * the executable and the URL origin, never arguments, paths or queries
 * (where tokens often hide). Secret names stay; their values never leave. */
const redactTransport = (t: McpTransport): McpTransport => {
  if (t.kind === "stdio") return { ...structuredClone(t), args: [] };
  let url = "";
  try { url = `${new URL(t.url).origin}/`; } catch { /* stored URLs were validated */ }
  return { ...structuredClone(t), url };
};

const validateTransport = (t: McpTransport): void => {
  if (t?.kind === "stdio") {
    if (!t.command || typeof t.command !== "string" || /[\r\n]/.test(t.command)) throw err("invalid-input", "stdio transport needs a command");
    if (/[;&|<>`$\0]/.test(t.command)) throw err("invalid-input", "command must be a bare executable, not a shell expression");
    if (!Array.isArray(t.args) || t.args.length > 256 || t.args.some((a) => typeof a !== "string" || a.includes("\0") || a.length > 16_384)) throw err("invalid-input", "args must be bounded strings");
    if (!Array.isArray(t.envKeys) || t.envKeys.length > 128 || t.envKeys.some((k) => typeof k !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) || new Set(t.envKeys).size !== t.envKeys.length) throw err("invalid-input", "envKeys must be unique environment names");
  } else if (t?.kind === "http") {
    let u: URL;
    try { u = new URL(t.url); } catch { throw err("invalid-input", "http transport needs a valid URL"); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw err("invalid-input", "only http(s) URLs are allowed");
    if (u.username || u.password || u.hash) throw err("invalid-input", "MCP URLs cannot contain credentials or fragments");
    if (!Array.isArray(t.headersSecretRefs) || t.headersSecretRefs.length > 128 || t.headersSecretRefs.some((k) => typeof k !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) || new Set(t.headersSecretRefs.map((k) => k.toLowerCase())).size !== t.headersSecretRefs.length) {
      throw err("invalid-input", "headersSecretRefs must be unique HTTP header names");
    }
  } else throw err("invalid-input", "unknown transport kind");
};

const loadJson = <T>(path: string, fallback: T): T => {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err("storage-unavailable", "MCP configuration is unreadable; the existing file was not overwritten");
  }
};
const parseDocument = (raw: unknown): Pick<SpaceMcpState, "servers" | "tombstones"> => {
  if (Array.isArray(raw)) return { servers: raw as StoredServer[], tombstones: [] };
  if (raw && typeof raw === "object") {
    const doc = raw as Partial<StoredDocument>;
    if (Array.isArray(doc.servers) && (doc.tombstones === undefined || Array.isArray(doc.tombstones))) {
      return { servers: doc.servers, tombstones: doc.tombstones ?? [] };
    }
  }
  throw err("storage-unavailable", "Invalid MCP configuration; the existing file was not overwritten");
};

export function createMcpConfigService(opts: {
  dataDir: string;
  deployment: DeploymentProfile;
  defaultSpaceId?: string;
  /** The host supplies the existing synchronous Space ownership guard. */
  assertProject?: (space: SpaceContext, projectId: string) => void;
  projectForProbe?: (space: SpaceContext, projectId: string) => Promise<{ path: string; remote?: unknown } | undefined>;
  inspect?: typeof inspectMcpServer;
  invoke?: typeof callMcpTool;
  onChanged?: (space: SpaceContext, projectId?: string) => Promise<void>;
  /** `host.people` bound to {@link PERSONAL_MCP_PACKAGE}; absent → no personal servers. */
  people?: () => PeopleHost | undefined;
  /** The person a chat is private to (`privateSessionOwner`); absent → never. */
  privateOwner?: (spaceId: string, sessionId: string) => string | undefined;
}): McpConfigService {
  mkdirSync(opts.dataDir, { recursive: true });
  const cache = new Map<string, SpaceMcpState>();
  const migrated = new Set<string>();
  const inFlight = new Map<string, Promise<McpInspectionDto>>();
  const callsInFlight = new Set<string>();
  const filesFor = (space: SpaceContext) => {
    const storage = createSpaceStorage(space.storageDir);
    return { servers: storage.path("mcp.json"), secrets: storage.path("mcp-secrets.json") };
  };
  const assertScope = (space: SpaceContext, projectId?: string, write = false): void => {
    if (projectId !== undefined) {
      if (!projectId || typeof projectId !== "string" || !opts.assertProject) throw err("not-found", "project not found");
      opts.assertProject(space, projectId);
    }
    // Space and project servers are shared by everyone in the Space, with
    // their credentials: only a Space admin changes or exercises them.
    if (write && !roleAtLeast(space.role, "admin")) {
      throw err("forbidden", "Only Space admins can manage Space MCP servers");
    }
  };
  const assertExecutableTransport = (row: StoredServer): void => {
    if (opts.deployment === "multi-tenant-sandboxed" && row.transport.kind === "stdio") {
      throw err("unsupported", "Host MCP processes are unavailable in a sandboxed deployment");
    }
  };
  const networkPolicy = opts.deployment === "multi-tenant-sandboxed" ? "public-only" as const : "user-origin" as const;
  const adoptLegacy = (space: SpaceContext): void => {
    if (migrated.has(space.spaceId)) return;
    const files = filesFor(space);
    if (!existsSync(files.servers) && !existsSync(files.secrets)
      && opts.deployment === "local-trusted" && space.spaceId === opts.defaultSpaceId) {
      const legacyServers = join(opts.dataDir, "mcp.json");
      const legacySecrets = join(opts.dataDir, "mcp-secrets.json");
      if (existsSync(legacyServers) || existsSync(legacySecrets)) {
        const parsed = parseDocument(loadJson<unknown>(legacyServers, []));
        const secrets = loadJson<Record<string, Record<string, string>>>(legacySecrets, {});
        atomicWriteSync(files.secrets, JSON.stringify(secrets), 0o600);
        atomicWriteSync(files.servers, JSON.stringify({ version: 2, ...parsed }, null, 2));
      }
    }
    migrated.add(space.spaceId);
  };
  const load = (space: SpaceContext): SpaceMcpState => {
    // Validate paths even on cache hits: replacing a directory with a symlink
    // must not retain a usable capability into another Space.
    const files = filesFor(space);
    adoptLegacy(space);
    const cached = cache.get(space.spaceId);
    if (cached) return cached;
    const parsed = parseDocument(loadJson<unknown>(files.servers, { version: 2, servers: [], tombstones: [] }));
    const state: SpaceMcpState = { ...parsed, secrets: loadJson(files.secrets, {}) };
    cache.set(space.spaceId, state);
    return state;
  };
  const persist = (space: SpaceContext, state: SpaceMcpState): void => {
    const files = filesFor(space);
    const document: StoredDocument = { version: 2, servers: state.servers, tombstones: state.tombstones };
    atomicWriteSync(files.servers, JSON.stringify(document, null, 2));
    atomicWriteSync(files.secrets, JSON.stringify(state.secrets), 0o600);
    cache.set(space.spaceId, state);
  };
  const inspectionKey = (projectId?: string): string => projectId ?? "__space__";
  const inspectionFor = (s: StoredServer, projectId?: string): McpInspectionDto | undefined => {
    const cached = s.inspections?.[inspectionKey(projectId)];
    return cached?.revision === s.revision ? structuredClone(cached.result) : undefined;
  };
  const toDto = (s: StoredServer, projectId?: string, view: { owner?: "space" | "person"; manage?: boolean } = {}): McpInstallationDto => {
    const owner = view.owner ?? "space";
    const manage = view.manage ?? true;
    const inspection = inspectionFor(s, projectId);
    return {
      id: s.id, name: s.name, transport: manage ? structuredClone(s.transport) : redactTransport(s.transport),
      enabled: s.enabled, status: !s.enabled ? "disabled" : inspection?.ok ? "connected" : inspection ? "error" : "starting", revision: s.revision,
      scope: owner === "person" ? "person" : s.projectId === undefined ? "space" : "project",
      owner,
      canManage: manage,
      ...(manage ? {} : { redacted: true }),
      ...(s.projectId !== undefined ? { projectId: s.projectId } : {}),
      ...(inspection ? { inspection } : {}),
      ...(inspection?.ok === false ? { lastError: inspection.message } : {}),
    };
  };
  const canManageSpace = (space: SpaceContext): boolean => roleAtLeast(space.role, "admin");
  const spaceDto = (space: SpaceContext, s: StoredServer, projectId?: string): McpInstallationDto =>
    toDto(s, projectId, { owner: "space", manage: canManageSpace(space) });
  const effective = (state: SpaceMcpState, projectId?: string): StoredServer[] => {
    const byName = new Map<string, StoredServer>();
    for (const row of state.servers) if (row.projectId === undefined) byName.set(row.name, row);
    if (projectId !== undefined) {
      for (const row of state.servers) if (row.projectId === projectId) byName.set(row.name, row);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  const effectiveTombstones = (
    state: SpaceMcpState,
    projectId: string | undefined,
    activeNames: ReadonlySet<string>,
  ): ScopedTombstone[] => {
    const byName = new Map<string, ScopedTombstone>();
    for (const tombstone of state.tombstones) {
      if (tombstone.projectId === undefined && !activeNames.has(tombstone.name)) {
        byName.set(tombstone.name, tombstone);
      }
    }
    if (projectId !== undefined) {
      for (const tombstone of state.tombstones) {
        if (tombstone.projectId === projectId && !activeNames.has(tombstone.name)) {
          byName.set(tombstone.name, tombstone);
        }
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  const commit = async <T>(space: SpaceContext, projectId: string | undefined, mutate: (state: SpaceMcpState) => T): Promise<T> => {
    assertScope(space, projectId, true);
    const next = structuredClone(load(space));
    const out = mutate(next);
    persist(space, next);
    try { await opts.onChanged?.(space, projectId); } catch { /* desired state remains committed */ }
    return out;
  };
  const retire = (state: SpaceMcpState, row: StoredServer): void => {
    state.tombstones = [
      ...state.tombstones.filter((t) => t.name !== row.name || !sameScope(t, row.projectId)),
      { name: row.name, revision: row.revision, retiredAt: Date.now(), ...(row.projectId !== undefined ? { projectId: row.projectId } : {}) },
    ];
  };
  const requireRow = (state: SpaceMcpState, id: string, projectId?: string): StoredServer => {
    const row = state.servers.find((s) => s.id === id && sameScope(s, projectId));
    if (!row) throw err("not-found", "mcp server not found");
    return row;
  };
  const validateName = (value: string): string => {
    const name = typeof value === "string" ? value.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) throw err("invalid-input", "server name must use letters, numbers, dots, dashes or underscores (≤64 chars)");
    if (name === "polyth-agent-tools") throw err("invalid-input", "polyth-agent-tools is reserved by Polyth");
    return name;
  };
  const effectiveRow = (space: SpaceContext, id: string, projectId?: string): StoredServer => {
    assertScope(space, projectId);
    const row = effective(load(space), projectId).find((s) => s.id === id);
    if (!row) throw err("not-found", "mcp server not found");
    return row;
  };
  const unchecked = (): McpInspectionDto => ({ ok: false, message: "Tools have not been checked", checkedAt: 0, tools: [] });

  // ---- person-owned servers ------------------------------------------------
  const personalInFlight = new Map<string, Promise<McpInspectionDto>>();
  const peopleHost = (): PeopleHost => {
    const people = opts.people?.();
    if (!people) throw err("unsupported", "Personal MCP servers need signed-in accounts");
    return people;
  };
  /** The signed-in person behind a request; system work owns no servers. */
  const personOf = (space: SpaceContext, write = false): { people: PeopleHost; userId: string } => {
    const people = peopleHost();
    if (!space.userId || isSystemContext(space)) throw err("forbidden", "Personal MCP servers belong to a signed-in person");
    if (write && !roleAtLeast(space.role, "member")) throw err("forbidden", "Viewers cannot add MCP servers");
    return { people, userId: space.userId };
  };
  const personalStorage = (people: PeopleHost, userId: string) => people.storage(userId, PERSONAL_MCP_PACKAGE);
  const loadPersonal = (people: PeopleHost, userId: string): StoredServer[] => {
    const raw = loadJson<unknown>(personalStorage(people, userId).path("servers.json"), { version: 1, servers: [] });
    const servers = raw && typeof raw === "object" ? (raw as { servers?: unknown }).servers : undefined;
    if (!Array.isArray(servers)) throw err("storage-unavailable", "Invalid personal MCP configuration; the existing file was not overwritten");
    return servers as StoredServer[];
  };
  const persistPersonal = (people: PeopleHost, userId: string, servers: StoredServer[]): void => {
    atomicWriteSync(
      personalStorage(people, userId).path("servers.json"),
      JSON.stringify({ version: 1, servers }, null, 2),
      0o600,
    );
  };
  const secretKey = (id: string): string => `mcp:server:${id}`;
  const personalSecrets = (people: PeopleHost, userId: string, row: StoredServer): Record<string, string> => {
    const stored = people.vault(userId, PERSONAL_MCP_PACKAGE).getOpaque(secretKey(row.id));
    if (!stored) return {};
    try {
      const parsed = JSON.parse(stored) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const strings = Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      return retainReferencedSecrets(row.transport, strings);
    } catch { return {}; }
  };
  const writePersonalSecrets = (people: PeopleHost, userId: string, id: string, secrets: Record<string, string>): void => {
    const vault = people.vault(userId, PERSONAL_MCP_PACKAGE);
    if (Object.keys(secrets).length) vault.putOpaque(secretKey(id), JSON.stringify(secrets));
    else vault.deleteOpaque(secretKey(id));
  };
  const requirePersonal = (servers: StoredServer[], id: string): StoredServer => {
    const row = servers.find((s) => s.id === id);
    if (!row) throw err("not-found", "mcp server not found");
    return row;
  };
  const personalDto = (s: StoredServer, projectId?: string): McpInstallationDto => toDto(s, projectId, { owner: "person", manage: true });
  /** The person whose servers this chat may carry: it is private to them and
   *  they are still a member. Undefined for any chat someone else can open. */
  const chatOwner = (spaceId: string, sessionId: string | undefined): { people: PeopleHost; userId: string } | undefined => {
    const people = opts.people?.();
    if (!people || !sessionId || !opts.privateOwner) return undefined;
    const userId = opts.privateOwner(spaceId, sessionId);
    return userId && people.isMember(userId, spaceId) ? { people, userId } : undefined;
  };
  /** Agent access: the chat qualifies AND the turn acts for its owner. */
  const actingOwner = (space: SpaceContext, session: McpSessionScope | undefined) => {
    if (!session?.actorUserId) return undefined;
    const owner = chatOwner(space.spaceId, session.sessionId);
    return owner?.userId === session.actorUserId ? owner : undefined;
  };
  /** Enabled personal servers, minus any whose name a Space or project server
   *  already uses there (the shared server wins; a duplicate native name would
   *  disable both). A broken personal file attaches nothing. */
  const attachable = (owner: { people: PeopleHost; userId: string }, taken: ReadonlySet<string>): StoredServer[] => {
    try {
      return loadPersonal(owner.people, owner.userId)
        .filter((row) => row.enabled && !taken.has(row.name))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch { return []; }
  };
  const findForSession = (space: SpaceContext, id: string, projectId: string | undefined, session: McpSessionScope | undefined) => {
    const shared = effective(load(space), projectId);
    const row = shared.find((s) => s.id === id);
    if (row) return { row, owner: undefined };
    const owner = actingOwner(space, session);
    const personal = owner ? attachable(owner, new Set(shared.map((s) => s.name))).find((s) => s.id === id) : undefined;
    if (!owner || !personal) throw err("not-found", "mcp server not found");
    return { row: personal, owner };
  };
  const probePersonal = async (
    owner: { people: PeopleHost; userId: string },
    id: string,
    target: { projectId?: string; cwd?: string; remote?: boolean },
  ): Promise<McpInspectionDto> => {
    const row = structuredClone(requirePersonal(loadPersonal(owner.people, owner.userId), id));
    if (!row.enabled) return { ...unchecked(), message: "Enable this MCP server before checking its tools" };
    assertExecutableTransport(row);
    const key = JSON.stringify(["person", owner.userId, target.projectId ?? "", id]);
    const pending = personalInFlight.get(key);
    if (pending) return pending;
    const operation = (async () => {
      const result: McpInspectionDto = target.remote
        ? { ok: false, checkedAt: Date.now(), tools: [], message: "MCP tool inspection is currently available for local projects" }
        : await (opts.inspect ?? inspectMcpServer)({
          transport: row.transport, secrets: personalSecrets(owner.people, owner.userId, row), cwd: target.cwd, networkPolicy,
          authorityFile: personalStorage(owner.people, owner.userId).path(`runtime/mcp-probes/${target.projectId ?? "person"}/${row.id}.json`),
        });
      const servers = structuredClone(loadPersonal(owner.people, owner.userId));
      const stored = requirePersonal(servers, id);
      if (stored.revision !== row.revision) throw err("conflict", "MCP configuration changed during the tool check; check the current version");
      stored.inspections = { ...stored.inspections, [inspectionKey(target.projectId)]: { revision: row.revision, result: structuredClone(result) } };
      persistPersonal(owner.people, owner.userId, servers);
      return result;
    })();
    personalInFlight.set(key, operation);
    try { return await operation; }
    finally { if (personalInFlight.get(key) === operation) personalInFlight.delete(key); }
  };
  const validateCall = (input: { toolName: string; arguments: JsonObject; sessionId: string; cwd: string; signal?: AbortSignal }): void => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.sessionId) || !input.cwd || typeof input.toolName !== "string" || !input.toolName.trim() || input.toolName.length > 128 || !input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments)) throw err("invalid-input", "a scoped session and MCP tool call are required");
    if (Buffer.byteLength(JSON.stringify(input.arguments)) > 32 * 1024) throw err("invalid-input", "MCP tool arguments are too large");
    if (input.signal?.aborted) throw err("aborted", "MCP tool call was canceled before execution");
  };
  const notifyChanged = async (space: SpaceContext): Promise<void> => {
    try { await opts.onChanged?.(space); } catch { /* desired state remains committed */ }
  };

  return {
    access(space) {
      const person = !!space.userId && !isSystemContext(space);
      return {
        canManageSpace: canManageSpace(space),
        canManagePersonal: person && !!opts.people?.() && roleAtLeast(space.role, "member"),
      };
    },
    list(space, projectId, session) {
      assertScope(space, projectId);
      const shared = effective(load(space), projectId);
      const rows = shared.map((s) => spaceDto(space, s, projectId));
      const owner = actingOwner(space, session);
      if (!owner) return rows;
      return [...rows, ...attachable(owner, new Set(shared.map((s) => s.name))).map((s) => personalDto(s, projectId))];
    },
    projection(space, projectId, sessionId) {
      // Internal callers without a registry (standalone/test service consumers)
      // can project a scoped snapshot, but public project CRUD requires a guard.
      if (projectId !== undefined) opts.assertProject?.(space, projectId);
      const state = load(space);
      const rows = effective(state, projectId);
      const owner = chatOwner(space.spaceId, sessionId);
      const personal = owner ? attachable(owner, new Set(rows.map((row) => row.name))) : [];
      const names = new Set([...rows, ...personal].map((row) => row.name));
      const tombstones = effectiveTombstones(state, projectId, names);
      const secrets = new Map(rows.map((row) => [
        row.id,
        retainReferencedSecrets(row.transport, state.secrets[row.id] ?? {}),
      ]));
      for (const row of personal) secrets.set(row.id, personalSecrets(owner!.people, owner!.userId, row));
      const strip = ({ status: _status, lastError: _lastError, inspections: _inspections, ...row }: StoredServer): McpProjectorServer => structuredClone(row);
      return {
        servers: [...rows.map(strip), ...personal.map((row) => ({ ...strip(row), ownerUserId: owner!.userId }))],
        retiredNames: tombstones.map((t) => t.name),
        tombstones: tombstones.map((t) => ({ ...t })),
        secretsFor: (id) => ({ ...secrets.get(id) }),
      };
    },
    async create(space, input, projectId) {
      assertScope(space, projectId, true);
      const name = validateName(input.name);
      validateTransport(input.transport);
      validateSecrets(input.transport, input.secrets);
      const state = load(space);
      if (input.origin === "backend-import" && state.tombstones.some((t) => t.name === name && sameScope(t, projectId))) {
        throw err("conflict", `MCP server "${name}" was deleted and must not be re-imported from backend config`);
      }
      if (state.servers.some((s) => s.name === name && sameScope(s, projectId))) throw err("conflict", `an MCP server named "${name}" already exists in this scope`);
      const row: StoredServer = {
        id: randomUUID(), name, transport: structuredClone(input.transport), enabled: input.enabled !== false,
        status: input.enabled !== false ? "starting" : "disabled", revision: 1,
        ...(projectId !== undefined ? { projectId } : {}),
        ...(input.raw && Object.keys(input.raw).length ? { raw: structuredClone(input.raw) } : {}),
      };
      const add = (next: SpaceMcpState): McpInstallationDto => {
        next.tombstones = next.tombstones.filter((t) => t.name !== name || !sameScope(t, projectId));
        next.servers.push(row);
        const secrets = retainReferencedSecrets(row.transport, input.secrets ?? {});
        if (Object.keys(secrets).length) next.secrets[row.id] = secrets;
        return toDto(row, projectId);
      };
      if (input.origin === "backend-import") {
        const next = structuredClone(state);
        const dto = add(next);
        persist(space, next);
        return dto;
      }
      return commit(space, projectId, add);
    },
    async update(space, id, patch, expectedRevision, projectId) {
      assertScope(space, projectId, true);
      const state = load(space);
      const row = requireRow(state, id, projectId);
      if (row.revision !== expectedRevision) throw err("conflict", "entry changed since you loaded it");
      const name = patch.name === undefined ? row.name : validateName(patch.name);
      if (state.servers.some((s) => s.id !== id && s.name === name && sameScope(s, projectId))) throw err("conflict", `an MCP server named "${name}" already exists in this scope`);
      const transport = patch.transport === undefined ? row.transport : patch.transport;
      if (patch.transport !== undefined) validateTransport(patch.transport);
      validateSecrets(transport, patch.secrets);
      return commit(space, projectId, (next) => {
        const current = requireRow(next, id, projectId);
        if (name !== current.name) {
          retire(next, current);
          next.tombstones = next.tombstones.filter((t) => t.name !== name || !sameScope(t, projectId));
          current.name = name;
        }
        if (patch.transport !== undefined) current.transport = structuredClone(patch.transport);
        if (patch.enabled !== undefined) { current.enabled = patch.enabled; current.status = patch.enabled ? "starting" : "disabled"; }
        const secrets = retainReferencedSecrets(current.transport, {
          ...(next.secrets[id] ?? {}),
          ...(patch.secrets ?? {}),
        });
        if (Object.keys(secrets).length) next.secrets[id] = secrets;
        else delete next.secrets[id];
        current.revision += 1;
        delete current.inspections;
        current.status = current.enabled ? "starting" : "disabled";
        delete current.lastError;
        return toDto(current, projectId);
      });
    },
    async remove(space, id, projectId) {
      assertScope(space, projectId, true);
      const state = load(space);
      if (!state.servers.some((s) => s.id === id && sameScope(s, projectId))) return false;
      return commit(space, projectId, (next) => {
        retire(next, requireRow(next, id, projectId));
        next.servers = next.servers.filter((s) => s.id !== id);
        delete next.secrets[id];
        return true;
      });
    },
    async importServers(space, inputs, projectId) {
      assertScope(space, projectId, true);
      if (!Array.isArray(inputs) || !inputs.length || inputs.length > 64) throw err("invalid-input", "import must contain 1–64 MCP servers");
      const names = new Set<string>();
      const state = load(space);
      const rows = inputs.map((input) => {
        if (!input || typeof input !== "object") throw err("invalid-input", "invalid MCP import entry");
        const name = validateName(input.name);
        if (names.has(name) || state.servers.some((s) => s.name === name && sameScope(s, projectId))) throw err("conflict", `an MCP server named "${name}" already exists in this scope`);
        names.add(name);
        validateTransport(input.transport);
        validateSecrets(input.transport, input.secrets);
        if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw err("invalid-input", "enabled must be a boolean");
        const row: StoredServer = {
          id: randomUUID(), name, transport: structuredClone(input.transport), enabled: input.enabled !== false,
          status: input.enabled !== false ? "starting" : "disabled", revision: 1,
          ...(projectId !== undefined ? { projectId } : {}),
        };
        return { row, secrets: retainReferencedSecrets(row.transport, input.secrets ?? {}) };
      });
      return commit(space, projectId, (next) => {
        for (const { row, secrets } of rows) {
          next.servers.push(row);
          next.tombstones = next.tombstones.filter((t) => t.name !== row.name || !sameScope(t, projectId));
          if (Object.keys(secrets).length) next.secrets[row.id] = secrets;
        }
        return rows.map(({ row }) => toDto(row, projectId));
      });
    },
    async override(space, id, projectId, enabled) {
      assertScope(space, projectId, true);
      if (typeof enabled !== "boolean") throw err("invalid-input", "enabled must be a boolean");
      const source = effectiveRow(space, id, projectId);
      if (source.projectId !== undefined) throw err("invalid-input", "only inherited MCP servers can be overridden");
      return this.create(space, {
        name: source.name, transport: structuredClone(source.transport), enabled,
        secrets: retainReferencedSecrets(source.transport, load(space).secrets[source.id] ?? {}),
      }, projectId);
    },
    tools(space, id, projectId, session) {
      assertScope(space, projectId);
      return inspectionFor(findForSession(space, id, projectId, session).row, projectId) ?? unchecked();
    },
    async call(space, id, projectId, input) {
      assertScope(space, projectId);
      const session = { sessionId: input.sessionId, ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}) };
      const found = findForSession(space, id, projectId, session);
      if (found.owner) {
        const owner = found.owner;
        const row = structuredClone(found.row);
        assertExecutableTransport(row);
        validateCall(input);
        const callKey = JSON.stringify(["person", owner.userId, space.spaceId, projectId, input.sessionId, id]);
        if (callsInFlight.has(callKey)) throw err("conflict", "an MCP call is already running for this session and server");
        callsInFlight.add(callKey);
        try {
          const project = await opts.projectForProbe?.(space, projectId);
          if (project?.remote) throw err("unsupported", "the portable MCP bridge cannot execute commands on a remote project");
          // Re-check after the await: the chat may have been shared meanwhile.
          const live = findForSession(space, id, projectId, session);
          if (live.owner?.userId !== owner.userId || live.row.revision !== row.revision) throw err("conflict", "MCP configuration changed before execution");
          if (input.signal?.aborted) throw err("aborted", "MCP tool call was canceled before execution");
          return await (opts.invoke ?? callMcpTool)({
            transport: row.transport, secrets: personalSecrets(owner.people, owner.userId, row), cwd: input.cwd, networkPolicy,
            authorityFile: personalStorage(owner.people, owner.userId).path(`runtime/mcp-calls/${space.spaceId}/${projectId}/${input.sessionId}/${row.id}.json`),
            toolName: input.toolName, arguments: input.arguments, signal: input.signal,
          });
        } finally { callsInFlight.delete(callKey); }
      }
      assertScope(space, projectId, true);
      const row = structuredClone(effectiveRow(space, id, projectId));
      if (!row.enabled) throw err("forbidden", "MCP server is disabled for this project");
      assertExecutableTransport(row);
      validateCall(input);
      const callKey = JSON.stringify([space.spaceId, projectId, input.sessionId, id]);
      if (callsInFlight.has(callKey)) throw err("conflict", "an MCP call is already running for this session and server");
      callsInFlight.add(callKey);
      try {
        const project = await opts.projectForProbe?.(space, projectId);
        if (project?.remote) throw err("unsupported", "the portable MCP bridge cannot execute commands on a remote project");
        const live = effectiveRow(space, id, projectId);
        if (!live.enabled || live.revision !== row.revision) throw err("conflict", "MCP configuration changed before execution");
        if (input.signal?.aborted) throw err("aborted", "MCP tool call was canceled before execution");
        const secrets = retainReferencedSecrets(row.transport, load(space).secrets[row.id] ?? {});
        const storage = createSpaceStorage(space.storageDir);
        // A separate authority per admitted session avoids sharing MCP process
        // state between concurrent conversations. No invocation is retried here.
        return await (opts.invoke ?? callMcpTool)({
          transport: row.transport, secrets, cwd: input.cwd, networkPolicy,
          authorityFile: storage.path(`runtime/mcp-calls/${projectId}/${input.sessionId}/${row.id}.json`),
          toolName: input.toolName, arguments: input.arguments, signal: input.signal,
        });
      } finally { callsInFlight.delete(callKey); }
    },
    removeProject(space, projectId) {
      const next = structuredClone(load(space));
      for (const row of next.servers) if (row.projectId === projectId) delete next.secrets[row.id];
      next.servers = next.servers.filter((s) => s.projectId !== projectId);
      next.tombstones = next.tombstones.filter((t) => t.projectId !== projectId);
      for (const row of next.servers) if (row.inspections) delete row.inspections[inspectionKey(projectId)];
      persist(space, next);
    },
    async test(space, id, projectId, session) {
      assertScope(space, projectId);
      const found = findForSession(space, id, projectId, session);
      if (found.owner) {
        const project = projectId ? await opts.projectForProbe?.(space, projectId) : undefined;
        return probePersonal(found.owner, id, {
          ...(projectId !== undefined ? { projectId } : {}),
          ...(project?.path ? { cwd: project.path } : {}),
          ...(project?.remote ? { remote: true } : {}),
        });
      }
      assertScope(space, projectId, true);
      const row = structuredClone(effectiveRow(space, id, projectId));
      if (!row.enabled) return { ...unchecked(), message: "Enable this MCP server before checking its tools" };
      assertExecutableTransport(row);
      const key = JSON.stringify([space.spaceId, projectId ?? "", id]);
      const pending = inFlight.get(key);
      if (pending) return pending;
      const operation = (async () => {
        const project = projectId ? await opts.projectForProbe?.(space, projectId) : undefined;
        const secrets = retainReferencedSecrets(row.transport, load(space).secrets[row.id] ?? {});
        const storage = createSpaceStorage(space.storageDir);
        const result = project?.remote ? { ok: false, checkedAt: Date.now(), tools: [], message: "MCP tool inspection is currently available for local projects" } : await (opts.inspect ?? inspectMcpServer)({
          transport: row.transport, secrets, cwd: project?.path, networkPolicy,
          authorityFile: storage.path(`runtime/mcp-probes/${projectId ?? "space"}/${row.id}.json`),
        });
        assertScope(space, projectId, true);
        const current = effectiveRow(space, id, projectId);
        if (current.revision !== row.revision) throw err("conflict", "MCP configuration changed during the tool check; check the current version");
        const next = structuredClone(load(space));
        const stored = next.servers.find((s) => s.id === id)!;
        stored.inspections = { ...stored.inspections, [inspectionKey(projectId)]: { revision: row.revision, result: structuredClone(result) } };
        persist(space, next);
        return result;
      })();
      inFlight.set(key, operation);
      try { return await operation; }
      finally { if (inFlight.get(key) === operation) inFlight.delete(key); }
    },
    listPersonal(space) {
      const { people, userId } = personOf(space);
      return loadPersonal(people, userId)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((row) => personalDto(row));
    },
    async createPersonal(space, input) {
      const { people, userId } = personOf(space, true);
      const name = validateName(input.name);
      validateTransport(input.transport);
      validateSecrets(input.transport, input.secrets);
      if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw err("invalid-input", "enabled must be a boolean");
      const servers = structuredClone(loadPersonal(people, userId));
      if (servers.length >= MAX_PERSONAL_SERVERS) throw err("invalid-input", `at most ${MAX_PERSONAL_SERVERS} personal MCP servers`);
      if (servers.some((s) => s.name === name)) throw err("conflict", `you already have an MCP server named "${name}"`);
      const row: StoredServer = {
        id: randomUUID(), name, transport: structuredClone(input.transport), enabled: input.enabled !== false,
        status: input.enabled !== false ? "starting" : "disabled", revision: 1,
      };
      writePersonalSecrets(people, userId, row.id, retainReferencedSecrets(row.transport, input.secrets ?? {}));
      servers.push(row);
      persistPersonal(people, userId, servers);
      await notifyChanged(space);
      return personalDto(row);
    },
    async updatePersonal(space, id, patch, expectedRevision) {
      const { people, userId } = personOf(space, true);
      const servers = structuredClone(loadPersonal(people, userId));
      const current = requirePersonal(servers, id);
      if (current.revision !== expectedRevision) throw err("conflict", "entry changed since you loaded it");
      const name = patch.name === undefined ? current.name : validateName(patch.name);
      if (servers.some((s) => s.id !== id && s.name === name)) throw err("conflict", `you already have an MCP server named "${name}"`);
      if (patch.transport !== undefined) validateTransport(patch.transport);
      const transport = patch.transport ?? current.transport;
      validateSecrets(transport, patch.secrets);
      if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw err("invalid-input", "enabled must be a boolean");
      current.name = name;
      current.transport = structuredClone(transport);
      if (patch.enabled !== undefined) current.enabled = patch.enabled;
      // Stored values the new transport still names survive; the rest go.
      writePersonalSecrets(people, userId, id, retainReferencedSecrets(transport, {
        ...personalSecrets(people, userId, current),
        ...(patch.secrets ?? {}),
      }));
      current.revision += 1;
      delete current.inspections;
      current.status = current.enabled ? "starting" : "disabled";
      delete current.lastError;
      persistPersonal(people, userId, servers);
      await notifyChanged(space);
      return personalDto(current);
    },
    async removePersonal(space, id) {
      const { people, userId } = personOf(space, true);
      const servers = loadPersonal(people, userId);
      if (!servers.some((s) => s.id === id)) return false;
      persistPersonal(people, userId, servers.filter((s) => s.id !== id));
      writePersonalSecrets(people, userId, id, {});
      await notifyChanged(space);
      return true;
    },
    personalTools(space, id) {
      const { people, userId } = personOf(space);
      return inspectionFor(requirePersonal(loadPersonal(people, userId), id)) ?? unchecked();
    },
    async testPersonal(space, id) {
      const owner = personOf(space, true);
      return probePersonal(owner, id, {});
    },
    hasPersonalServers(userId) {
      const people = opts.people?.();
      if (!people) return false;
      try { return loadPersonal(people, userId).some((row) => row.enabled); }
      catch { return false; }
    },
  };
}
