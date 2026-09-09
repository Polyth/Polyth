// Space-owned MCP desired state. Project entries share the existing store and
// own only their configuration; inherited entries are never copied to projects.
import { existsSync, mkdirSync, readFileSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteSync } from "@polyth/plugins";
import { createSpaceStorage } from "@polyth/tenancy";
import type {
  DeploymentProfile, McpStatus, McpTombstone, McpTransport, SpaceContext,
} from "@polyth/contracts";
import type { McpInstallationDto } from "@polyth/contracts/capability-installations";

export interface McpProjectorServer {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  raw?: Record<string, unknown>;
  revision: number;
  projectId?: string;
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
  /** Omit projectId for Space installations; supply it for the effective project set. */
  list(space: SpaceContext, projectId?: string): McpInstallationDto[];
  create(space: SpaceContext, input: McpCreateInput, projectId?: string): Promise<McpInstallationDto>;
  update(space: SpaceContext, id: string, patch: McpPatchInput, expectedRevision: number, projectId?: string): Promise<McpInstallationDto>;
  remove(space: SpaceContext, id: string, projectId?: string): Promise<boolean>;
  test(space: SpaceContext, id: string, projectId?: string): Promise<{ ok: boolean; message: string }>;
  /** Trusted projector read; credentials are restricted to this effective snapshot. */
  projection(space: SpaceContext, projectId?: string): McpProjectionState;
  /** Trusted project-removal hook. Does not remove inherited installations. */
  removeProject(space: SpaceContext, projectId: string): void;
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
  }
};

const retainReferencedSecrets = (
  transport: McpTransport,
  secrets: Record<string, string>,
): Record<string, string> => Object.fromEntries(
  secretKeys(transport).flatMap((key) =>
    Object.prototype.hasOwnProperty.call(secrets, key) ? [[key, secrets[key]!]] : []),
);

const validateTransport = (t: McpTransport): void => {
  if (t?.kind === "stdio") {
    if (!t.command || typeof t.command !== "string") throw err("invalid-input", "stdio transport needs a command");
    if (/[;&|<>`$\0]/.test(t.command)) throw err("invalid-input", "command must be a bare executable, not a shell expression");
    if (!Array.isArray(t.args) || t.args.some((a) => typeof a !== "string")) throw err("invalid-input", "args must be strings");
    if (!Array.isArray(t.envKeys) || t.envKeys.some((k) => typeof k !== "string" || !k)) throw err("invalid-input", "envKeys must be non-empty strings");
  } else if (t?.kind === "http") {
    let u: URL;
    try { u = new URL(t.url); } catch { throw err("invalid-input", "http transport needs a valid URL"); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw err("invalid-input", "only http(s) URLs are allowed");
    if (!Array.isArray(t.headersSecretRefs) || t.headersSecretRefs.some((k) => typeof k !== "string" || !k)) {
      throw err("invalid-input", "headersSecretRefs must be non-empty strings");
    }
  } else throw err("invalid-input", "unknown transport kind");
};

async function commandExists(command: string): Promise<boolean> {
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, command));
  for (const c of candidates) {
    try { await access(c, constants.X_OK); return true; } catch { /* keep looking */ }
  }
  return false;
}

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
  onChanged?: (space: SpaceContext, projectId?: string) => Promise<void>;
}): McpConfigService {
  mkdirSync(opts.dataDir, { recursive: true });
  const cache = new Map<string, SpaceMcpState>();
  const migrated = new Set<string>();
  const filesFor = (space: SpaceContext) => {
    const storage = createSpaceStorage(space.storageDir);
    return { servers: storage.path("mcp.json"), secrets: storage.path("mcp-secrets.json") };
  };
  const assertScope = (space: SpaceContext, projectId?: string, write = false): void => {
    if (projectId !== undefined) {
      if (!projectId || typeof projectId !== "string" || !opts.assertProject) throw err("not-found", "project not found");
      opts.assertProject(space, projectId);
    }
    if (write && (space.role === "viewer" || (projectId === undefined && space.role === "member"))) {
      throw err("forbidden", "insufficient role to manage this scope");
    }
  };
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
  const toDto = (s: StoredServer): McpInstallationDto => ({
    id: s.id, name: s.name, transport: structuredClone(s.transport),
    enabled: s.enabled, status: s.status, revision: s.revision,
    scope: s.projectId === undefined ? "space" : "project",
    ...(s.projectId !== undefined ? { projectId: s.projectId } : {}),
    ...(s.lastError ? { lastError: s.lastError } : {}),
  });
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
    if (!name || name.length > 64) throw err("invalid-input", "server name required (≤64 chars)");
    return name;
  };
  return {
    list(space, projectId) { assertScope(space, projectId); return effective(load(space), projectId).map(toDto); },
    projection(space, projectId) {
      // Internal callers without a registry (standalone/test service consumers)
      // can project a scoped snapshot, but public project CRUD requires a guard.
      if (projectId !== undefined) opts.assertProject?.(space, projectId);
      const state = load(space);
      const rows = effective(state, projectId);
      const names = new Set(rows.map((row) => row.name));
      const tombstones = effectiveTombstones(state, projectId, names);
      const secrets = new Map(rows.map((row) => [
        row.id,
        retainReferencedSecrets(row.transport, state.secrets[row.id] ?? {}),
      ]));
      return {
        servers: rows.map(({ status: _status, lastError: _lastError, ...row }) => structuredClone(row)),
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
        return toDto(row);
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
        return toDto(current);
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
    removeProject(space, projectId) {
      const next = structuredClone(load(space));
      for (const row of next.servers) if (row.projectId === projectId) delete next.secrets[row.id];
      next.servers = next.servers.filter((s) => s.projectId !== projectId);
      next.tombstones = next.tombstones.filter((t) => t.projectId !== projectId);
      persist(space, next);
    },
    async test(space, id, projectId) {
      assertScope(space, projectId, true);
      const row = structuredClone(requireRow(load(space), id, projectId));
      const set = (status: McpStatus, lastError?: string): void => {
        assertScope(space, projectId, true);
        const next = structuredClone(load(space));
        const current = requireRow(next, id, projectId);
        if (current.revision !== row.revision) return;
        current.status = status;
        if (lastError) current.lastError = lastError; else delete current.lastError;
        persist(space, next);
      };
      if (row.transport.kind === "stdio") {
        const found = await commandExists(row.transport.command);
        const message = found ? "command resolved on PATH" : `command not found: ${row.transport.command}`;
        set(found ? "connected" : "error", found ? undefined : message);
        return { ok: found, message };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        const url = row.transport.url;
        const res = await fetch(url, { method: "HEAD", signal: controller.signal }).catch(() =>
          fetch(url, { method: "GET", signal: controller.signal }));
        await res.body?.cancel();
        const ok = res.ok || res.status < 500;
        set(ok ? "connected" : "error", res.ok ? undefined : `HTTP ${res.status}`);
        return { ok, message: `HTTP ${res.status}` };
      } catch (error) {
        if ((error as { code?: string }).code === "not-found") throw error;
        const message = error instanceof Error ? error.message : String(error);
        set("error", message);
        return { ok: false, message };
      } finally { clearTimeout(timer); }
    },
  };
}
