// Server-owned MCP configuration (WP9, hardened in P1). Entries persist in the
// data dir as two files: mcp.json (structure, safe to read back) and
// mcp-secrets.json (values, never returned by any API and never logged). The
// backend adapter is the only component that applies entries to the runtime; a
// failed apply rolls the stored list back so config and runtime never diverge.
// Importing entries from an existing backend config is READ-ONLY discovery: it
// never triggers a backend write. User mutations apply a patch batch that
// names exactly the Polyth-managed entries, so unsupported entries and unknown
// fields in the backend config always survive.
import { mkdirSync, readFileSync } from "node:fs";
import { atomicWriteSync } from "./atomicWrite.ts";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  McpServerDto,
  McpStatus,
  McpTransport,
} from "@polyth/contracts";

export interface McpApplier {
  applyMcp(entries: Array<{
    name: string;
    transport:
      | { kind: "stdio"; command: string; args: string[]; env: Record<string, string> }
      | { kind: "http"; url: string; headers: Record<string, string> };
    enabled: boolean;
    /** Opaque unowned fields retained from an imported backend entry. */
    raw?: Record<string, unknown>;
  }> & {
    /** All managed names (enabled, disabled, and retired). Rides on the array
     * so intermediate appliers that forward/clone one argument keep it. */
    managedNames?: string[];
  }): Promise<void>;
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
  list(): McpServerDto[];
  create(input: McpCreateInput): Promise<McpServerDto>;
  update(id: string, patch: McpPatchInput, expectedRevision: number): Promise<McpServerDto>;
  remove(id: string): Promise<boolean>;
  /** Reachability probe; never launches anything through a shell. */
  test(id: string): Promise<{ ok: boolean; message: string }>;
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

export function createMcpConfigService(opts: {
  file: string;
  applier?: McpApplier;
}): McpConfigService {
  mkdirSync(dirname(opts.file), { recursive: true });
  const secretsFile = opts.file.replace(/\.json$/, "-secrets.json");

  const load = <T>(path: string, fallback: T): T => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return fallback;
    }
  };

  let servers: StoredServer[] = load<StoredServer[]>(opts.file, []);
  // secrets: { [serverId]: { [keyName]: value } }
  let secrets: Record<string, Record<string, string>> = load(secretsFile, {});
  // Names retired by rename/removal this process: the applier must still drop
  // them from the backend config even though they are no longer stored. Kept
  // in managedNames (not as entries) so only owned names are ever touched.
  const retired = new Set<string>();

  const persist = () => {
    atomicWriteSync(opts.file, JSON.stringify(servers, null, 2));
    atomicWriteSync(secretsFile, JSON.stringify(secrets));
  };

  const toDto = (s: StoredServer): McpServerDto => ({
    id: s.id,
    name: s.name,
    transport: s.transport,
    enabled: s.enabled,
    status: s.status,
    ...(s.lastError ? { lastError: s.lastError } : {}),
    revision: s.revision,
  });

  const applyAll = async (): Promise<void> => {
    if (!opts.applier) return;
    // F10: disabled servers are REMOVED from the applied config (not written
    // with enabled:false) so the backend cannot start or list them at all.
    // The applier patches only the names listed in managedNames — unsupported
    // entries and unknown fields in the backend config are never touched.
    const entries = servers.filter((s) => s.enabled).map((s) => ({
      name: s.name,
      enabled: s.enabled,
      ...(s.raw && Object.keys(s.raw).length ? { raw: structuredClone(s.raw) } : {}),
      transport: s.transport.kind === "stdio"
        ? {
            kind: "stdio" as const,
            command: s.transport.command,
            args: s.transport.args,
            env: Object.fromEntries(s.transport.envKeys.map((k) => [k, secrets[s.id]?.[k] ?? ""])),
          }
        : {
            kind: "http" as const,
            url: s.transport.url,
            headers: Object.fromEntries(s.transport.headersSecretRefs.map((k) => [k, secrets[s.id]?.[k] ?? ""])),
          },
    }));
    const managedNames = [...new Set([...servers.map((s) => s.name), ...retired])];
    await opts.applier.applyMcp(Object.assign(entries, { managedNames }));
  };

  /** Mutate under a snapshot; failed apply restores stored state exactly. */
  const commit = async <T>(mutate: () => T): Promise<T> => {
    const beforeServers = structuredClone(servers);
    const beforeSecrets = structuredClone(secrets);
    const out = mutate();
    try {
      await applyAll();
    } catch (e) {
      servers = beforeServers;
      secrets = beforeSecrets;
      persist();
      throw err("conflict", `backend apply failed, change rolled back: ${(e as Error).message}`);
    }
    persist();
    return out;
  };

  return {
    list: () => servers.map(toDto),

    async create(input: McpCreateInput): Promise<McpServerDto> {
      const name = (input.name ?? "").trim();
      if (!name || name.length > 64) throw err("invalid-input", "server name required (≤64 chars)");
      if (servers.some((s) => s.name === name)) throw err("conflict", `an MCP server named "${name}" already exists`);
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
        // Import/seed is READ-ONLY discovery (invariant 11): the entry already
        // exists in the backend config, so adopting it must not write that
        // config back — no applyMcp, only the Polyth store is updated.
        servers.push(row);
        if (input.secrets) secrets[row.id] = { ...input.secrets };
        persist();
        return toDto(row);
      }
      return commit(() => {
        servers.push(row);
        if (input.secrets) secrets[row.id] = { ...input.secrets };
        return toDto(row);
      });
    },

    async update(id: string, patch: McpPatchInput, expectedRevision: number): Promise<McpServerDto> {
      const row = servers.find((s) => s.id === id);
      if (!row) throw err("not-found", "mcp server not found");
      if (row.revision !== expectedRevision) throw err("conflict", "entry changed since you loaded it");
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (!name || name.length > 64) throw err("invalid-input", "server name required (≤64 chars)");
        if (servers.some((s) => s.id !== id && s.name === name)) throw err("conflict", `an MCP server named "${name}" already exists`);
      }
      if (patch.transport !== undefined) validateTransport(patch.transport);
      return commit(() => {
        if (patch.name !== undefined && patch.name.trim() !== row.name) {
          retired.add(row.name);
          row.name = patch.name.trim();
        }
        if (patch.transport !== undefined) row.transport = patch.transport;
        if (patch.enabled !== undefined) {
          row.enabled = patch.enabled;
          row.status = patch.enabled ? "starting" : "disabled";
        }
        if (patch.secrets) secrets[id] = { ...(secrets[id] ?? {}), ...patch.secrets };
        row.revision += 1;
        return toDto(row);
      });
    },

    async remove(id: string): Promise<boolean> {
      const i = servers.findIndex((s) => s.id === id);
      if (i < 0) return false;
      return commit(() => {
        retired.add(servers[i]!.name);
        servers.splice(i, 1);
        delete secrets[id];
        return true;
      });
    },

    async test(id: string): Promise<{ ok: boolean; message: string }> {
      const row = servers.find((s) => s.id === id);
      if (!row) throw err("not-found", "mcp server not found");
      const set = (status: McpStatus, lastError?: string) => {
        row.status = status;
        if (lastError) row.lastError = lastError;
        else delete row.lastError;
        persist();
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
