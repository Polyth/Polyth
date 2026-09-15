// Backend configuration applier (WP9, hardened in P1). This module is the ONLY
// place that may write OpenCode-facing configuration: global behavior
// instructions (AGENTS.md) and owned fragments of opencode.json. The server
// owns the canonical revisioned copies; this applier projects them into the
// backend's config directory with atomic writes so a crash never leaves a torn
// file.
//
// Preservation contract (invariants 11/14, plan P1):
// - Every operation patches only the fields Polyth owns and preserves every
//   unowned key at every nesting level, including unsupported MCP entries and
//   unknown provider/model/agent/plugin properties.
// - Reads/imports never write; a semantically no-op apply performs zero writes
//   so untouched files keep their exact bytes.
// - SEMANTIC preservation is guaranteed; FORMATTING is not: OpenCode treats
//   the file as JSONC, and a real write re-serializes strict JSON, so comments
//   and layout may be lost on the first genuine mutation. Comment-preserving
//   edits would need a JSONC rewriter dependency this package does not have.
// - When a RuntimeConfigAuthority is supplied, writes require a writable
//   authority whose targetId exactly matches this applier's target.
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  CustomProviderApply,
  CustomProviderModelApply,
  JsonObject,
  JsonValue,
  OpenCodePluginConfigEntry,
  ProviderInspect,
  RuntimeConfigAuthority,
} from "@polyth/contracts";
import {
  inspectProviderEntry,
  projectConfig,
  providerConfigKey,
  type StagedProviderOp,
} from "./customProvider.ts";

export interface McpApplyEntry {
  name: string;
  transport:
    | { kind: "stdio"; command: string; args: string[]; env: Record<string, string> }
    | { kind: "http"; url: string; headers: Record<string, string> };
  enabled: boolean;
  /** Opaque unowned fields retained for this managed entry (captured when the
   * entry was imported from the backend config). Used as the patch base when
   * the entry is absent from the file — e.g. re-enabling after a disable
   * removed it — so unknown metadata survives the round trip. */
  raw?: Record<string, unknown>;
}

/** Entries plus batch-level management metadata. The metadata rides on the
 * array itself because intermediate appliers forward and structuredClone a
 * single argument. */
export type McpApplyBatch = McpApplyEntry[] & {
  /** Every Polyth-managed entry name (enabled or not, including names retired
   * by rename/removal). A managed name absent from the entries list is
   * removed from the config block (disabled servers are represented as
   * absent). Names NOT listed here are never touched, so unsupported and
   * unknown entries survive every managed edit. Defaults to the entry names,
   * which makes a plain-array call patch-only. */
  managedNames?: string[];
};

export interface ProviderVisibilityApply {
  /** OpenCode `disabled_providers`: providers hidden entirely. */
  disabledProviders: string[];
  /** Per-provider model blacklists → `provider.<id>.blacklist`. */
  blacklists: Record<string, string[]>;
}

export interface BackendConfigApplier {
  /** Overwrite the backend's global instruction file. Returns the applied byte length. */
  applyBehavior(text: string): Promise<number>;
  /** Patch managed entries of the "mcp" block, preserving unsupported entries
   *  and every unowned field of managed entries. */
  applyMcp(entries: McpApplyBatch): Promise<void>;
  /** Read valid entries from OpenCode's `plugin` array. */
  listPlugins(): Promise<OpenCodePluginConfigEntry[]>;
  /** Merge entries into OpenCode's `plugin` array, deduplicated by package spec. */
  applyPlugins(plugins: unknown[]): Promise<OpenCodePluginConfigEntry[]>;
  /** Replace OpenCode's plugin list with a validated desired state. */
  replacePlugins(plugins: unknown[]): Promise<OpenCodePluginConfigEntry[]>;
  /** Remove every string/tuple entry matching a package spec. */
  removePlugin(spec: string): Promise<{ plugins: OpenCodePluginConfigEntry[]; removed: boolean }>;
  /** Mirror provider/model visibility into the backend config, preserving all
   *  other keys (including unrelated per-provider options). */
  applyProviderVisibility(v: ProviderVisibilityApply): Promise<void>;
  /** Create or update one Polyth-owned custom provider stanza. */
  applyCustomProvider(input: CustomProviderApply): Promise<void>;
  /** Remove one Polyth-owned custom provider stanza. Sibling providers stay. */
  removeCustomProvider(id: string): Promise<void>;
  inspectProvider(id: string): Promise<ProviderInspect | undefined>;
  /** Re-read physical config and apply coalesced provider ops in one write. */
  applyStagedProviderOps(ops: readonly StagedProviderOp[]): Promise<void>;
  mergeDiscoveredModels(
    id: string,
    discovered: ReadonlyArray<{ id: string; name?: string }>,
  ): Promise<void>;
  addManualModel(id: string, model: CustomProviderModelApply & { id: string }): Promise<void>;
  removeConfiguredModel(id: string, modelId: string): Promise<void>;
  /** Merge one role override without disturbing plugins or unrelated options. */
  applyAgent(name: string, role: {
    prompt?: string;
    model?: { providerID: string; modelID: string };
    mode: "primary" | "subagent" | "all" | "auto";
  }): Promise<void>;
  /** Read the backend config ({} when the file is missing; throws on corrupt
   *  content so callers never trust a torn read). OpenCode treats the file as
   *  JSONC — it rewrites it with trailing commas — so parsing is lenient. */
  readConfig(): Promise<Record<string, unknown>>;
  /** Where behavior text lands (for the settings UI path label). */
  behaviorPath(): string;
  /** Where the backend JSON config lives (opencode.json). */
  configPath(): string;
  /** Exact writable-target identity of this applier, matched against a
   *  writable RuntimeConfigAuthority's targetId before any write. Optional so
   *  existing decorating appliers remain structurally valid. */
  configTargetId?(): string;
  /** Current independent write authority. Decorating/deferred appliers must
   * forward this rather than silently widening access. */
  configAuthority?(): RuntimeConfigAuthority;
}

export interface ConfigApplierOptions {
  configDir?: string;
  /** Independent config authority (invariant 14). When provided, every write
   *  requires kind "writable" with a targetId exactly equal to this applier's
   *  target; a read-only authority refuses all writes. Reads never require
   *  authority. When omitted (legacy wiring without an endpoint lease), writes
   *  are permitted as before. */
  authority?: RuntimeConfigAuthority | (() => RuntimeConfigAuthority);
  /** Exact target identity of this applier; defaults to the resolved backend
   *  config file path. */
  targetId?: string;
}

const POLYTH_AGENT_MODE_OPTION = "polyth.mode";

const defaultConfigDir = (): string =>
  process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode");

/** V2 normalizes legacy config but drops model blacklists. Keep the native
 * projection ephemeral so unhiding restores the original user configuration. */
export async function projectV2ModelVisibility(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const directory = env.OPENCODE_CONFIG_DIR
    ?? join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config"), "opencode");
  const path = existsSync(join(directory, "opencode.jsonc"))
    ? join(directory, "opencode.jsonc") : join(directory, "opencode.json");
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stripJsonc(await readFile(path, "utf8")));
    if (!isPlainObject(parsed)) throw new Error("OpenCode config must be an object");
    config = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return env;
    throw error;
  }
  const hidden = Object.entries(isPlainObject(config.provider) ? config.provider : {}).flatMap(([id, value]) => {
    const entry = isPlainObject(value) ? value : {};
    if (!Array.isArray(entry.blacklist)) return [];
    return entry.blacklist.filter((name): name is string => typeof name === "string" && name.length > 0).map((name) => [id, name] as const);
  });
  if (!hidden.length) return env;
  const parsed: unknown = JSON.parse(stripJsonc(env.OPENCODE_CONFIG_CONTENT || "{}"));
  if (!isPlainObject(parsed)) throw new Error("OpenCode inline config must be an object");
  const providers = isPlainObject(parsed.providers) ? { ...parsed.providers } : {};
  for (const [id, modelID] of hidden) {
    const provider = isPlainObject(providers[id]) ? { ...providers[id] } : {};
    const models = isPlainObject(provider.models) ? { ...provider.models } : {};
    const model = isPlainObject(models[modelID]) ? models[modelID] : {};
    Object.defineProperty(models, modelID, { value: { ...model, disabled: true }, enumerable: true, configurable: true, writable: true });
    Object.defineProperty(providers, id, { value: { ...provider, models }, enumerable: true, configurable: true, writable: true });
  }
  return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...parsed, providers }) };
}

// Reduce JSONC to strict JSON: drop line and block comments and trailing
// commas, all outside string literals. OpenCode itself rewrites its config
// in JSONC form (observed live: `{"$schema": …,}`), so a strict JSON.parse
// would wrongly reject a healthy file.
export function stripJsonc(raw: string): string {
  let out = "";
  let i = 0;
  const n = raw.length;
  const skipTrivia = (j: number): number => {
    for (;;) {
      const c = raw[j];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") { j += 1; continue; }
      if (c === "/" && raw[j + 1] === "/") { while (j < n && raw[j] !== "\n") j += 1; continue; }
      if (c === "/" && raw[j + 1] === "*") {
        j += 2;
        while (j < n && !(raw[j] === "*" && raw[j + 1] === "/")) j += 1;
        j += 2;
        continue;
      }
      return j;
    }
  };
  while (i < n) {
    const ch = raw[i]!;
    if (ch === '"') {
      out += ch;
      i += 1;
      while (i < n) {
        const c = raw[i]!;
        out += c;
        i += 1;
        if (c === "\\") { out += raw[i] ?? ""; i += 1; continue; }
        if (c === '"') break;
      }
      continue;
    }
    if (ch === "/" && (raw[i + 1] === "/" || raw[i + 1] === "*")) {
      i = skipTrivia(i);
      continue;
    }
    if (ch === ",") {
      const next = skipTrivia(i + 1);
      if (raw[next] === "}" || raw[next] === "]") { i += 1; continue; }
    }
    out += ch;
    i += 1;
  }
  return out;
}

async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data, "utf8");
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

const invalidPluginEntry = (message: string): Error =>
  Object.assign(new Error(message), { code: "invalid-input", field: "plugins" });

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const normalizePluginSpec = (value: unknown, index?: number): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidPluginEntry(`plugin${index === undefined ? "" : ` entry ${index + 1}`} needs a non-empty package spec`);
  }
  const spec = value.trim();
  if (spec.length > 1024 || /[\u0000-\u001f\u007f]/.test(spec)) {
    throw invalidPluginEntry(`plugin spec "${spec.slice(0, 80)}" is invalid`);
  }
  return spec;
};

/** Validate user/config data without writing. */
export function normalizePluginEntries(raw: unknown): OpenCodePluginConfigEntry[] {
  if (!Array.isArray(raw)) throw invalidPluginEntry("plugins must be an array");
  const bySpec = new Map<string, OpenCodePluginConfigEntry>();
  const order: string[] = [];
  raw.forEach((entry, index) => {
    let normalized: OpenCodePluginConfigEntry;
    if (typeof entry === "string") {
      normalized = normalizePluginSpec(entry, index);
    } else if (
      Array.isArray(entry)
      && entry.length === 2
      && entry[1] !== null
      && typeof entry[1] === "object"
      && !Array.isArray(entry[1])
      && isJsonValue(entry[1])
    ) {
      normalized = [normalizePluginSpec(entry[0], index), entry[1] as JsonObject];
    } else if (
      entry !== null
      && typeof entry === "object"
      && !Array.isArray(entry)
      && isJsonValue(entry)
    ) {
      const native = entry as Record<string, unknown>;
      const options = native.options;
      if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options) || !isJsonValue(options))) {
        throw invalidPluginEntry(`plugin entry ${index + 1} has invalid options`);
      }
      normalized = [normalizePluginSpec(native.package, index), (options ?? {}) as JsonObject];
    } else {
      throw invalidPluginEntry(`plugin entry ${index + 1} must be a package spec or [spec, options] tuple`);
    }
    const spec = typeof normalized === "string" ? normalized : normalized[0];
    if (!bySpec.has(spec)) order.push(spec);
    bySpec.set(spec, normalized);
  });
  return order.map((spec) => bySpec.get(spec)!);
}

const pluginConfigKey = (config: Record<string, unknown>): "plugin" | "plugins" =>
  Array.isArray(config.plugins) ? "plugins" : "plugin";

const encodePlugins = (entries: OpenCodePluginConfigEntry[], key: "plugin" | "plugins", existing: unknown): unknown[] => {
  if (key === "plugin") return entries;
  const prior = new Map((Array.isArray(existing) ? existing : []).flatMap((entry) =>
    isPlainObject(entry) && typeof entry.package === "string" ? [[entry.package, entry] as const] : []));
  return entries.map((entry) => typeof entry === "string"
    ? entry
    : { ...prior.get(entry[0]), package: entry[0], options: entry[1] });
};

/** MCP entry fields Polyth owns; everything else is opaque and preserved. */
const MCP_OWNED_FIELDS = ["type", "command", "environment", "url", "headers", "enabled", "disabled"] as const;

/** Owned string map (environment/headers) merged over opaque leftovers: keys
 * Polyth could never have imported (non-string values) are preserved; string
 * keys are fully owned, so a key the user removed through Polyth is dropped. */
const mergedStringMap = (
  existingRaw: unknown,
  desired: Record<string, string>,
): Record<string, unknown> => {
  const opaque = existingRaw && typeof existingRaw === "object" && !Array.isArray(existingRaw)
    ? Object.fromEntries(Object.entries(existingRaw as Record<string, unknown>)
        .filter(([key, value]) => typeof value !== "string" && !(key in desired)))
    : {};
  return { ...opaque, ...desired };
};

/** Patch one managed MCP entry: owned fields are regenerated, every other
 * field of the existing fragment (or the retained import fragment) survives. */
const patchedMcpEntry = (existingRaw: unknown, e: McpApplyEntry): Record<string, unknown> => {
  const source = existingRaw && typeof existingRaw === "object" && !Array.isArray(existingRaw)
    ? (existingRaw as Record<string, unknown>)
    : (e.raw ?? {});
  const base: Record<string, unknown> = { ...source };
  const existingEnv = base.environment;
  const existingHeaders = base.headers;
  for (const key of MCP_OWNED_FIELDS) delete base[key];
  if (e.transport.kind === "stdio") {
    const environment = mergedStringMap(existingEnv, e.transport.env);
    return {
      ...base,
      type: "local",
      command: [e.transport.command, ...e.transport.args],
      enabled: e.enabled,
      ...(Object.keys(environment).length ? { environment } : {}),
    };
  }
  const headers = mergedStringMap(existingHeaders, e.transport.headers);
  return {
    ...base,
    type: "remote",
    url: e.transport.url,
    enabled: e.enabled,
    ...(Object.keys(headers).length ? { headers } : {}),
  };
};

export function projectManagedMcp(
  existing: Record<string, unknown>,
  entries: McpApplyBatch,
): Record<string, unknown> {
  const blockRaw = existing.mcp;
  const block: Record<string, unknown> =
    blockRaw && typeof blockRaw === "object" && !Array.isArray(blockRaw)
      ? { ...(blockRaw as Record<string, unknown>) }
      : {};
  const v2 = blockRaw && typeof blockRaw === "object" && !Array.isArray(blockRaw)
    && (blockRaw as Record<string, unknown>).servers !== undefined;
  const source = v2 && isPlainObject(block.servers) ? { ...(block.servers as Record<string, unknown>) } : block;
  const desiredNames = new Set(entries.map((e) => e.name));
  for (const name of entries.managedNames ?? []) {
    if (!desiredNames.has(name)) delete source[name];
  }
  for (const e of entries) {
    const projected = patchedMcpEntry(source[e.name], e);
    if (v2) {
      delete projected.enabled;
      projected.disabled = !e.enabled;
    }
    source[e.name] = projected;
  }
  if (v2) block.servers = source;
  const next: Record<string, unknown> = { ...existing };
  if (Object.keys(block).length > 0) next.mcp = block;
  else delete next.mcp;
  return next;
};

export function createConfigApplier(opts: ConfigApplierOptions = {}): BackendConfigApplier {
  const dir = opts.configDir ?? defaultConfigDir();
  mkdirSync(dir, { recursive: true });
  const agentsPath = join(dir, "AGENTS.md");
  const jsonPath = join(dir, "opencode.json");
  const jsoncPath = join(dir, "opencode.jsonc");
  // OpenCode supports both spellings. Update the file the user already owns so
  // plugin entries (including commandcode) remain in the effective config.
  const configPath = existsSync(jsoncPath) ? jsoncPath : jsonPath;
  const targetId = opts.targetId ?? configPath;
  let configWrite = Promise.resolve();

  // Invariant 14: config authority is separate from process ownership and is
  // read-only unless explicitly proven writable for exactly this target.
  const assertWritable = (operation: string): void => {
    const authority = typeof opts.authority === "function"
      ? opts.authority()
      : opts.authority;
    if (!authority) return;
    if (authority.kind === "read-only") {
      throw Object.assign(
        new Error(`${operation} refused: config authority is read-only`),
        { code: "config-read-only" },
      );
    }
    if (authority.targetId !== targetId) {
      throw Object.assign(
        new Error(
          `${operation} refused: writable target "${authority.targetId}" does not match config target "${targetId}"`,
        ),
        { code: "config-target-mismatch" },
      );
    }
  };

  // Missing file is fine (fresh install); a corrupt one must not be
  // silently clobbered — callers roll their stores back on throw.
  const readExisting = async (): Promise<Record<string, unknown>> => {
    try {
      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(stripJsonc(raw)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      throw new Error("backend config is not a JSON object");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  };

  // Zero-write no-op guard: a semantically unchanged document keeps its exact
  // bytes (and therefore its JSONC comments/formatting). A real change is
  // re-serialized as strict JSON — semantic fields are preserved, formatting
  // and comments are not (documented limitation; no JSONC-rewriter dependency).
  const writeConfigIfChanged = async (
    existing: Record<string, unknown>,
    next: Record<string, unknown>,
  ): Promise<void> => {
    if (isDeepStrictEqual(existing, next)) return;
    await atomicWrite(configPath, `${JSON.stringify(next, null, 2)}\n`);
  };

  const pluginsFrom = (config: Record<string, unknown>): OpenCodePluginConfigEntry[] => {
    const key = pluginConfigKey(config);
    return config[key] === undefined ? [] : normalizePluginEntries(config[key]);
  };

  // Serialize opencode.json mutations so concurrent plugin/provider writes
  // cannot both read the same base and lose one another before the rename.
  const mutateConfig = <T>(work: () => Promise<T>): Promise<T> => {
    const run = configWrite.then(work, work);
    configWrite = run.then(() => undefined, () => undefined);
    return run;
  };
  const mutatePlugins = mutateConfig;

  return {
    behaviorPath: () => agentsPath,
    configPath: () => configPath,
    configTargetId: () => targetId,
    configAuthority: () => {
      const authority = typeof opts.authority === "function"
        ? opts.authority()
        : opts.authority;
      return authority ?? { kind: "writable", targetId };
    },
    readConfig: readExisting,

    async applyBehavior(text: string): Promise<number> {
      assertWritable("applyBehavior");
      await atomicWrite(agentsPath, text);
      return Buffer.byteLength(text, "utf8");
    },

    async listPlugins(): Promise<OpenCodePluginConfigEntry[]> {
      return pluginsFrom(await readExisting());
    },

    async applyPlugins(raw: unknown[]): Promise<OpenCodePluginConfigEntry[]> {
      assertWritable("applyPlugins");
      const imported = normalizePluginEntries(raw);
      return mutatePlugins(async () => {
        const existing = await readExisting();
        const current = pluginsFrom(existing);
        const merged = [...current];
        const positions = new Map(current.map((entry, index) => [
          typeof entry === "string" ? entry : entry[0],
          index,
        ]));
        for (const entry of imported) {
          const spec = typeof entry === "string" ? entry : entry[0];
          const position = positions.get(spec);
          if (position === undefined) {
            positions.set(spec, merged.length);
            merged.push(entry);
          } else {
            // Imported options are authoritative for that package spec.
            merged[position] = entry;
          }
        }
        const key = pluginConfigKey(existing);
        await writeConfigIfChanged(existing, { ...existing, [key]: encodePlugins(merged, key, existing[key]) });
        return merged;
      });
    },

    async replacePlugins(raw: unknown[]): Promise<OpenCodePluginConfigEntry[]> {
      assertWritable("replacePlugins");
      const plugins = normalizePluginEntries(raw);
      return mutatePlugins(async () => {
        const existing = await readExisting();
        const next = { ...existing };
        const key = pluginConfigKey(existing);
        if (plugins.length > 0) next[key] = encodePlugins(plugins, key, existing[key]);
        else delete next[key];
        await writeConfigIfChanged(existing, next);
        return plugins;
      });
    },

    async removePlugin(rawSpec: string): Promise<{ plugins: OpenCodePluginConfigEntry[]; removed: boolean }> {
      assertWritable("removePlugin");
      const spec = normalizePluginSpec(rawSpec);
      return mutatePlugins(async () => {
        const existing = await readExisting();
        const current = pluginsFrom(existing);
        const plugins = current.filter((entry) => (typeof entry === "string" ? entry : entry[0]) !== spec);
        const removed = plugins.length !== current.length;
        if (removed) {
          const next = { ...existing };
          const key = pluginConfigKey(existing);
          if (plugins.length > 0) next[key] = encodePlugins(plugins, key, existing[key]);
          else delete next[key];
          await writeConfigIfChanged(existing, next);
        }
        return { plugins, removed };
      });
    },

    async applyProviderVisibility(v: ProviderVisibilityApply): Promise<void> {
      assertWritable("applyProviderVisibility");
      return mutateConfig(async () => {
        const existing = await readExisting();
        const next: Record<string, unknown> = { ...existing };

        const disabled = [...new Set(v.disabledProviders)].sort();
        if (disabled.length > 0) next.disabled_providers = disabled;
        else delete next.disabled_providers;

        // provider.<id>.blacklist — merge into existing provider entries so
        // unrelated per-provider options (apiKey, baseURL, …) survive.
        const providerRaw = existing.provider;
        const provider: Record<string, unknown> =
          providerRaw && typeof providerRaw === "object" && !Array.isArray(providerRaw)
            ? { ...(providerRaw as Record<string, unknown>) }
            : {};
        const ids = new Set([...Object.keys(provider), ...Object.keys(v.blacklists)]);
        for (const id of ids) {
          const entryRaw = provider[id];
          const entry: Record<string, unknown> =
            entryRaw && typeof entryRaw === "object" && !Array.isArray(entryRaw)
              ? { ...(entryRaw as Record<string, unknown>) }
              : {};
          const blacklist = [...new Set(v.blacklists[id] ?? [])].sort();
          if (blacklist.length > 0) entry.blacklist = blacklist;
          else delete entry.blacklist;
          if (Object.keys(entry).length > 0) provider[id] = entry;
          else delete provider[id];
        }
        if (Object.keys(provider).length > 0) next.provider = provider;
        else delete next.provider;

        await writeConfigIfChanged(existing, next);
      });
    },

    async applyCustomProvider(input: CustomProviderApply): Promise<void> {
      assertWritable("applyCustomProvider");
      if (!input.id?.trim()) throw Object.assign(new Error("provider id required"), { code: "invalid-input" });
      return mutateConfig(async () => {
        const existing = await readExisting();
        await writeConfigIfChanged(existing, projectConfig(existing, [{ kind: "upsert", input }]));
      });
    },

    async removeCustomProvider(id: string): Promise<void> {
      assertWritable("removeCustomProvider");
      if (!id?.trim()) throw Object.assign(new Error("provider id required"), { code: "invalid-input" });
      return mutateConfig(async () => {
        const existing = await readExisting();
        await writeConfigIfChanged(existing, projectConfig(existing, [{ kind: "remove", id: id.trim() }]));
      });
    },

    async inspectProvider(id: string): Promise<ProviderInspect | undefined> {
      if (!id?.trim()) return undefined;
      const existing = await readExisting();
      const provider = existing[providerConfigKey(existing, id)];
      return inspectProviderEntry(id, isPlainObject(provider) ? provider[id] : undefined);
    },

    async applyStagedProviderOps(ops: readonly StagedProviderOp[]): Promise<void> {
      assertWritable("applyStagedProviderOps");
      if (ops.length === 0) return;
      return mutateConfig(async () => {
        const existing = await readExisting();
        await writeConfigIfChanged(existing, projectConfig(existing, ops));
      });
    },

    async mergeDiscoveredModels(id, discovered): Promise<void> {
      assertWritable("mergeDiscoveredModels");
      if (!id?.trim()) throw Object.assign(new Error("provider id required"), { code: "invalid-input" });
      return mutateConfig(async () => {
        const existing = await readExisting();
        await writeConfigIfChanged(existing, projectConfig(existing, [{ kind: "mergeDiscovered", id: id.trim(), discovered }]));
      });
    },

    async addManualModel(id, model): Promise<void> {
      assertWritable("addManualModel");
      if (!id?.trim() || !model.id?.trim()) {
        throw Object.assign(new Error("provider id and model id required"), { code: "invalid-input" });
      }
      return mutateConfig(async () => {
        const existing = await readExisting();
        await writeConfigIfChanged(existing, projectConfig(existing, [{ kind: "addManual", id: id.trim(), model }]));
      });
    },

    async removeConfiguredModel(id, modelId): Promise<void> {
      assertWritable("removeConfiguredModel");
      if (!id?.trim() || !modelId?.trim()) {
        throw Object.assign(new Error("provider id and model id required"), { code: "invalid-input" });
      }
      return mutateConfig(async () => {
        const existing = await readExisting();
        await writeConfigIfChanged(existing, projectConfig(existing, [{ kind: "dropModel", id: id.trim(), modelId: modelId.trim() }]));
      });
    },

    async applyAgent(name, role): Promise<void> {
      assertWritable("applyAgent");
      if (!name.trim()) throw new Error("agent name required");
      const existing = await readExisting();
      const agentKey = isPlainObject(existing.agents) ? "agents" : "agent";
      const agentsRaw = existing[agentKey];
      const agents: Record<string, unknown> =
        agentsRaw && typeof agentsRaw === "object" && !Array.isArray(agentsRaw)
          ? { ...(agentsRaw as Record<string, unknown>) }
          : {};
      const currentRaw = agents[name];
      const current: Record<string, unknown> =
        currentRaw && typeof currentRaw === "object" && !Array.isArray(currentRaw)
          ? { ...(currentRaw as Record<string, unknown>) }
          : {};
      // `auto` is Polyth policy, not an OpenCode mode. Keep the native config
      // valid and persist the policy in the extensible agent options object.
      current.mode = role.mode === "auto" ? "subagent" : role.mode;
      const optionsRaw = current.options;
      if (role.mode === "auto" && agentKey === "agent") {
        const options: Record<string, unknown> =
          optionsRaw && typeof optionsRaw === "object" && !Array.isArray(optionsRaw)
            ? { ...(optionsRaw as Record<string, unknown>) }
            : {};
        options[POLYTH_AGENT_MODE_OPTION] = "auto";
        current.options = options;
      } else if (agentKey === "agent" && optionsRaw && typeof optionsRaw === "object" && !Array.isArray(optionsRaw)) {
        const options = { ...(optionsRaw as Record<string, unknown>) };
        delete options[POLYTH_AGENT_MODE_OPTION];
        if (Object.keys(options).length > 0) current.options = options;
        else delete current.options;
      }
      const promptKey = agentKey === "agents" ? "system" : "prompt";
      if (role.prompt?.trim()) current[promptKey] = role.prompt;
      else delete current[promptKey];
      if (role.mode === "auto") delete current.model;
      else if (role.model) current.model = `${role.model.providerID}/${role.model.modelID}`;
      else delete current.model;
      agents[name] = current;
      await writeConfigIfChanged(existing, { ...existing, [agentKey]: agents });
    },

    // Patch, never regenerate: unsupported entries and unmanaged names are
    // untouched; managed entries keep every unowned field; a managed name
    // absent from the desired list is removed (disabled = absent, F10).
    async applyMcp(entries: McpApplyBatch): Promise<void> {
      assertWritable("applyMcp");
      const existing = await readExisting();
      await writeConfigIfChanged(existing, projectManagedMcp(existing, entries));
    },
  };
}
