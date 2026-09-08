// Space-owned MCP configuration. Entries persist in Space storage as two files:
// mcp.json (structure + tombstones, safe to read back) and mcp-secrets.json
// (values, never returned by any API and never logged).
// Canonical desired state is authoritative; harness projectors reconcile
// independently and a failed target must not roll the store back.
// Importing entries from an existing backend config is READ-ONLY discovery: it
// never triggers a backend write. Tombstones win over backend discovery.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { atomicWriteSync } from "@polyth/plugins";
import { createSpaceStorage } from "@polyth/tenancy";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  DeploymentProfile,
  McpServerDto,
  McpStatus,
  McpTombstone,
  McpTransport,
  SpaceContext,
} from "@polyth/contracts";

/** Trusted MCP payload for harness projectors. Secret values are present only
 * here, never in DTOs or capability descriptors. */
export interface McpProjectorServer {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  raw?: Record<string, unknown>;
  revision: number;
}

export interface McpProjectionState {
  servers: McpProjectorServer[];
  retiredNames: string[];
  tombstones: McpTombstone[];
  secretsFor(id: string): Record<string, string>;
}

export interface McpCreateInput {
  name: string;
  transport: McpTransport;
  /** Secret values keyed by env key / header name. Stored, never returned. */
  secrets?: Record<string, string>;
  enabled?: boolean;
  /** "backend-import" marks discovery of an entry that already exists in the
   * backend config: adopting it is READ-ONLY and must not write that config. */
  origin?: "backend-import";
  /** Opaque unowned fields of the imported backend entry (owned/secret-bearing
   * fields are stripped before this ever reaches the store). */
  raw?: Record<string, unknown>;
}

export interface McpPatchInput {
  name?: string;
  transport?: McpTransport;
  secrets?: Record<string, string>;
  enabled?: boolean;
}

export interface McpConfigService {
  list(space: SpaceContext): McpServerDto[];
  create(space: SpaceContext, input: McpCreateInput): Promise<McpServerDto>;
  update(space: SpaceContext, id: string, patch: McpPatchInput, expectedRevision: number): Promise<McpServerDto>;
  remove(space: SpaceContext, id: string): Promise<boolean>;
  /** Reachability probe; never launches anything through a shell. */
  test(space: SpaceContext, id: string): Promise<{ ok: boolean; message: string }>;
  /** Desired-state snapshot for harness projectors. Secret values stay here. */
  projection(space: SpaceContext): McpProjectionState;
}

/** MCP entry fields Polyth owns; every other field of an imported entry is
 *  retained as an opaque fragment so managed edits can restore it. Owned
 *  fields carry the secret values (environment/headers), so the retained
 *  fragment never holds secrets. */
const MCP_OWNED_ENTRY_FIELDS = new Set(["type", "command", "environment", "enabled", "url", "headers"]);

const opaqueMcpFragment = (entry: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(entry).filter(([key]) => !MCP_OWNED_ENTRY_FIELDS.has(key)));

/** Parse the `mcp` block of an opencode.json into creatable entries so a
 *  fresh Polyth store can seed from what OpenCode already has configured.
 *  Env/header values become write-only secrets — they are stored server-side
 *  and never leave through any DTO. Entries are marked "backend-import" so
 *  adopting them stays READ-ONLY: discovery never writes the backend config. */
export function mcpEntriesFromBackendConfig(cfg: Record<string, unknown>): McpCreateInput[] {
  const block = cfg.mcp;
  if (!block || typeof block !== "object" || Array.isArray(block)) return [];
  const out: McpCreateInput[] = [];
  for (const [name, raw] of Object.entries(block as Record<string, unknown>)) {
    if (!name || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const enabled = entry.enabled !== false;
    const opaque = opaqueMcpFragment(entry);
    const common = {
      enabled,
      origin: "backend-import" as const,
      ...(Object.keys(opaque).length ? { raw: opaque } : {}),
    };
    if (entry.type === "local") {
      const command = Array.isArray(entry.command) ? entry.command.map(String).filter(Boolean) : [];
      if (command.length === 0) continue;
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

interface StoredServer {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  status: McpStatus;
  lastError?: string;
  revision: number;
  /** Opaque unowned fields retained from a backend import; never in a DTO and
   * secret-free by construction (owned fields are stripped before storage). */
  raw?: Record<string, unknown>;
}

interface StoredDocument {
  version: 2;
  servers: StoredServer[];
  tombstones: McpTombstone[];
}

interface SpaceMcpState {
  servers: StoredServer[];
  secrets: Record<string, Record<string, string>>;
  tombstones: McpTombstone[];
}

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

const validateTransport = (t: McpTransport): void => {
  if (t.kind === "stdio") {
    if (!t.command || typeof t.command !== "string") throw err("invalid-input", "stdio transport needs a command");
    if (/[;&|<>`$]/.test(t.command)) throw err("invalid-input", "command must be a bare executable, not a shell expression");
    if (!Array.isArray(t.args) || t.args.some((a) => typeof a !== "string")) throw err("invalid-input", "args must be strings");
    if (!Array.isArray(t.envKeys) || t.envKeys.some((k) => typeof k !== "string" || !k)) throw err("invalid-input", "envKeys must be non-empty strings");
  } else if (t.kind === "http") {
    let u: URL;
    try { u = new URL(t.url); } catch { throw err("invalid-input", "http transport needs a valid URL"); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw err("invalid-input", "only http(s) URLs are allowed");
    if (!Array.isArray(t.headersSecretRefs) || t.headersSecretRefs.some((k) => typeof k !== "string" || !k)) {
      throw err("invalid-input", "headersSecretRefs must be non-empty strings");
    }
  } else {
    throw err("invalid-input", "unknown transport kind");
  }
};

/** Resolve an executable on PATH without invoking a shell. */
async function commandExists(command: string): Promise<boolean> {
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, command));
  for (const c of candidates) {
    try {
      await access(c, constants.X_OK);
      return true;
    } catch { /* keep looking */ }
  }
  return false;
}

const loadJson = <T>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
};

const parseDocument = (raw: unknown): { servers: StoredServer[]; tombstones: McpTombstone[] } => {
  if (Array.isArray(raw)) {
    return { servers: raw as StoredServer[], tombstones: [] };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const doc = raw as { servers?: StoredServer[]; tombstones?: McpTombstone[] };
    return {
      servers: Array.isArray(doc.servers) ? doc.servers : [],
      tombstones: Array.isArray(doc.tombstones) ? doc.tombstones : [],
    };
  }
  return { servers: [], tombstones: [] };
};

export function createMcpConfigService(opts: {
  /** Deployment data dir. Used only for one-time local-trusted default-Space adoption. */
  dataDir: string;
  deployment: DeploymentProfile;
  defaultSpaceId?: string;
  /** Fired after canonical persistence. Projector failure must not roll the store back. */
  onChanged?: (space: SpaceContext) => Promise<void>;
}): McpConfigService {
  mkdirSync(opts.dataDir, { recursive: true });
  const cache = new Map<string, SpaceMcpState>();
  const migrated = new Set<string>();

  const filesFor = (space: SpaceContext) => {
    const storage = createSpaceStorage(space.storageDir);
    return {
      servers: storage.path("mcp.json"),
      secrets: storage.path("mcp-secrets.json"),
    };
  };

  const adoptLegacy = (space: SpaceContext): void => {
    if (migrated.has(space.spaceId)) return;
    migrated.add(space.spaceId);
    const files = filesFor(space);
    if (existsSync(files.servers) || existsSync(files.secrets)) return;
    const legacyServers = join(opts.dataDir, "mcp.json");
    const legacySecrets = join(opts.dataDir, "mcp-secrets.json");
    if (!existsSync(legacyServers) && !existsSync(legacySecrets)) return;
    // Fail closed unless this is the local default Space. Never fan out to
    // every Space, and never guess ownership on hosted deployments.
    if (opts.deployment !== "local-trusted") return;
    if (!opts.defaultSpaceId || space.spaceId !== opts.defaultSpaceId) return;
    const parsed = parseDocument(loadJson<unknown>(legacyServers, []));
    const secrets = loadJson<Record<string, Record<string, string>>>(legacySecrets, {});
    const document: StoredDocument = { version: 2, servers: parsed.servers, tombstones: parsed.tombstones };
    mkdirSync(space.storageDir, { recursive: true });
    atomicWriteSync(files.servers, JSON.stringify(document, null, 2));
    atomicWriteSync(files.secrets, JSON.stringify(secrets), 0o600);
  };

  const load = (space: SpaceContext): SpaceMcpState => {
    adoptLegacy(space);
    const cached = cache.get(space.spaceId);
    if (cached) return cached;
    const files = filesFor(space);
    const parsed = parseDocument(loadJson<unknown>(files.servers, { version: 2, servers: [], tombstones: [] }));
    const state: SpaceMcpState = {
      servers: parsed.servers,
      tombstones: parsed.tombstones,
      secrets: loadJson(files.secrets, {}),
    };
    cache.set(space.spaceId, state);
    return state;
  };

  const persist = (space: SpaceContext, state: SpaceMcpState) => {
    const files = filesFor(space);
    const document: StoredDocument = { version: 2, servers: state.servers, tombstones: state.tombstones };
    atomicWriteSync(files.servers, JSON.stringify(document, null, 2));
    atomicWriteSync(files.secrets, JSON.stringify(state.secrets), 0o600);
  };

  const toDto = (s: StoredServer): McpServerDto => ({
    id: s.id,
    name: s.name,
    transport: structuredClone(s.transport),
    enabled: s.enabled,
    status: s.status,
    ...(s.lastError ? { lastError: s.lastError } : {}),
    revision: s.revision,
  });

  const projection = (space: SpaceContext): McpProjectionState => {
    const state = load(space);
    return {
      servers: state.servers.map((s) => ({
        id: s.id,
        name: s.name,
        enabled: s.enabled,
        transport: structuredClone(s.transport),
        revision: s.revision,
        ...(s.raw && Object.keys(s.raw).length ? { raw: structuredClone(s.raw) } : {}),
      })),
      retiredNames: state.tombstones.map((row) => row.name),
      tombstones: state.tombstones.map((row) => ({ ...row })),
      secretsFor: (id) => ({ ...(state.secrets[id] ?? {}) }),
    };
  };

  const commit = async <T>(space: SpaceContext, mutate: (state: SpaceMcpState) => T): Promise<T> => {
    const state = load(space);
    const out = mutate(state);
    persist(space, state);
    try {
      await opts.onChanged?.(space);
    } catch {
      // Desired state is canonical. Provisioning status is recorded elsewhere.
    }
    return out;
  };

  const retire = (state: SpaceMcpState, name: string, revision: number) => {
    state.tombstones = [
      ...state.tombstones.filter((row) => row.name !== name),
      { name, revision, retiredAt: Date.now() },
    ];
  };

  return {
    list: (space) => load(space).servers.map(toDto),
    projection,

    async create(space: SpaceContext, input: McpCreateInput): Promise<McpServerDto> {
      const name = (input.name ?? "").trim();
      if (!name || name.length > 64) throw err("invalid-input", "server name required (≤64 chars)");
      const state = load(space);
      if (input.origin === "backend-import" && state.tombstones.some((row) => row.name === name)) {
        throw err("conflict", `MCP server "${name}" was deleted and must not be re-imported from backend config`);
      }
      if (state.servers.some((s) => s.name === name)) throw err("conflict", `an MCP server named "${name}" already exists`);
      validateTransport(input.transport);
      const row: StoredServer = {
        id: randomUUID(),
        name,
        transport: input.transport,
        enabled: input.enabled !== false,
        status: input.enabled !== false ? "starting" : "disabled",
        revision: 1,
        ...(input.raw && Object.keys(input.raw).length ? { raw: structuredClone(input.raw) } : {}),
      };
      if (input.origin === "backend-import") {
        state.servers.push(row);
        if (input.secrets) state.secrets[row.id] = { ...input.secrets };
        persist(space, state);
        return toDto(row);
      }
      return commit(space, (next) => {
        next.tombstones = next.tombstones.filter((row) => row.name !== name);
        next.servers.push(row);
        if (input.secrets) next.secrets[row.id] = { ...input.secrets };
        return toDto(row);
      });
    },

    async update(space: SpaceContext, id: string, patch: McpPatchInput, expectedRevision: number): Promise<McpServerDto> {
      const state = load(space);
      const row = state.servers.find((s) => s.id === id);
      if (!row) throw err("not-found", "mcp server not found");
      if (row.revision !== expectedRevision) throw err("conflict", "entry changed since you loaded it");
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (!name || name.length > 64) throw err("invalid-input", "server name required (≤64 chars)");
        if (state.servers.some((s) => s.id !== id && s.name === name)) throw err("conflict", `an MCP server named "${name}" already exists`);
      }
      if (patch.transport !== undefined) validateTransport(patch.transport);
      return commit(space, (next) => {
        const current = next.servers.find((s) => s.id === id)!;
        if (patch.name !== undefined && patch.name.trim() !== current.name) {
          retire(next, current.name, current.revision);
          next.tombstones = next.tombstones.filter((row) => row.name !== patch.name!.trim());
          current.name = patch.name.trim();
        }
        if (patch.transport !== undefined) current.transport = patch.transport;
        if (patch.enabled !== undefined) {
          current.enabled = patch.enabled;
          current.status = patch.enabled ? "starting" : "disabled";
        }
        if (patch.secrets) next.secrets[id] = { ...(next.secrets[id] ?? {}), ...patch.secrets };
        current.revision += 1;
        return toDto(current);
      });
    },

    async remove(space: SpaceContext, id: string): Promise<boolean> {
      const state = load(space);
      const i = state.servers.findIndex((s) => s.id === id);
      if (i < 0) return false;
      return commit(space, (next) => {
        const current = next.servers[i]!;
        retire(next, current.name, current.revision);
        next.servers.splice(i, 1);
        delete next.secrets[id];
        return true;
      });
    },

    async test(space: SpaceContext, id: string): Promise<{ ok: boolean; message: string }> {
      const state = load(space);
      const row = state.servers.find((s) => s.id === id);
      if (!row) throw err("not-found", "mcp server not found");
      const set = (status: McpStatus, lastError?: string) => {
        row.status = status;
        if (lastError) row.lastError = lastError;
        else delete row.lastError;
        persist(space, state);
      };
      if (row.transport.kind === "stdio") {
        const found = await commandExists(row.transport.command);
        set(found ? "connected" : "error", found ? undefined : `command not found: ${row.transport.command}`);
        return found
          ? { ok: true, message: "command resolved on PATH" }
          : { ok: false, message: `command not found: ${row.transport.command}` };
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const res = await fetch(row.transport.url, { method: "HEAD", signal: controller.signal }).catch(() =>
          fetch((row.transport as { url: string }).url, { method: "GET", signal: controller.signal }),
        );
        clearTimeout(timer);
        set(res.ok || res.status < 500 ? "connected" : "error", res.ok ? undefined : `HTTP ${res.status}`);
        return { ok: res.ok || res.status < 500, message: `HTTP ${res.status}` };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        set("error", message);
        return { ok: false, message };
      }
    },
  };
}
