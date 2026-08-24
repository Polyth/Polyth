// Backend configuration applier (WP9). This module is the ONLY place that may
// write OpenCode-facing configuration: global behavior instructions (AGENTS.md)
// and MCP server entries (opencode.json "mcp" block). The server owns the
// canonical revisioned copies; this applier projects them into the backend's
// config directory with atomic writes so a crash never leaves a torn file.
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonObject, JsonValue, OpenCodePluginConfigEntry } from "@polyth/contracts";

export interface McpApplyEntry {
  name: string;
  transport:
    | { kind: "stdio"; command: string; args: string[]; env: Record<string, string> }
    | { kind: "http"; url: string; headers: Record<string, string> };
  enabled: boolean;
}

export interface ProviderVisibilityApply {
  /** OpenCode `disabled_providers`: providers hidden entirely. */
  disabledProviders: string[];
  /** Per-provider model blacklists → `provider.<id>.blacklist`. */
  blacklists: Record<string, string[]>;
}

export interface BackendConfigApplier {
  /** Overwrite the backend's global instruction file. Returns the applied byte length. */
  applyBehavior(text: string): Promise<number>;
  /** Replace the "mcp" block of the backend config, preserving all other keys. */
  applyMcp(entries: McpApplyEntry[]): Promise<void>;
  /** Read valid entries from OpenCode's `plugin` array. */
  listPlugins(): Promise<OpenCodePluginConfigEntry[]>;
  /** Merge entries into OpenCode's `plugin` array, deduplicated by package spec. */
  applyPlugins(plugins: unknown[]): Promise<OpenCodePluginConfigEntry[]>;
  /** Remove every string/tuple entry matching a package spec. */
  removePlugin(spec: string): Promise<{ plugins: OpenCodePluginConfigEntry[]; removed: boolean }>;
  /** Mirror provider/model visibility into the backend config, preserving all
   *  other keys (including unrelated per-provider options). */
  applyProviderVisibility(v: ProviderVisibilityApply): Promise<void>;
  /** Merge one role override without disturbing plugins or unrelated options. */
  applyAgent(name: string, role: {
    prompt?: string;
    model?: { providerID: string; modelID: string };
    mode: "primary" | "subagent" | "all";
  }): Promise<void>;
  /** Read the backend config ({} when the file is missing; throws on corrupt
   *  content so callers never trust a torn read). OpenCode treats the file as
   *  JSONC — it rewrites it with trailing commas — so parsing is lenient. */
  readConfig(): Promise<Record<string, unknown>>;
  /** Where behavior text lands (for the settings UI path label). */
  behaviorPath(): string;
  /** Where the backend JSON config lives (opencode.json). */
  configPath(): string;
}

const defaultConfigDir = (): string =>
  process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode");

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
    } else {
      throw invalidPluginEntry(`plugin entry ${index + 1} must be a package spec or [spec, options] tuple`);
    }
    const spec = typeof normalized === "string" ? normalized : normalized[0];
    if (!bySpec.has(spec)) order.push(spec);
    bySpec.set(spec, normalized);
  });
  return order.map((spec) => bySpec.get(spec)!);
}

export function createConfigApplier(opts: { configDir?: string } = {}): BackendConfigApplier {
  const dir = opts.configDir ?? defaultConfigDir();
  mkdirSync(dir, { recursive: true });
  const agentsPath = join(dir, "AGENTS.md");
  const jsonPath = join(dir, "opencode.json");
  const jsoncPath = join(dir, "opencode.jsonc");
  // OpenCode supports both spellings. Update the file the user already owns so
  // plugin entries (including commandcode) remain in the effective config.
  const configPath = existsSync(jsoncPath) ? jsoncPath : jsonPath;
  let pluginWrite = Promise.resolve();

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

  const pluginsFrom = (config: Record<string, unknown>): OpenCodePluginConfigEntry[] =>
    config.plugin === undefined ? [] : normalizePluginEntries(config.plugin);

  // Serialize plugin mutations so simultaneous imports/removals cannot both
  // read the same base and lose one another before their atomic renames.
  const mutatePlugins = <T>(work: () => Promise<T>): Promise<T> => {
    const run = pluginWrite.then(work, work);
    pluginWrite = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    behaviorPath: () => agentsPath,
    configPath: () => configPath,
    readConfig: readExisting,

    async applyBehavior(text: string): Promise<number> {
      await atomicWrite(agentsPath, text);
      return Buffer.byteLength(text, "utf8");
    },

    async listPlugins(): Promise<OpenCodePluginConfigEntry[]> {
      return pluginsFrom(await readExisting());
    },

    async applyPlugins(raw: unknown[]): Promise<OpenCodePluginConfigEntry[]> {
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
        await atomicWrite(configPath, `${JSON.stringify({ ...existing, plugin: merged }, null, 2)}\n`);
        return merged;
      });
    },

    async removePlugin(rawSpec: string): Promise<{ plugins: OpenCodePluginConfigEntry[]; removed: boolean }> {
      const spec = normalizePluginSpec(rawSpec);
      return mutatePlugins(async () => {
        const existing = await readExisting();
        const current = pluginsFrom(existing);
        const plugins = current.filter((entry) => (typeof entry === "string" ? entry : entry[0]) !== spec);
        const removed = plugins.length !== current.length;
        if (removed) {
          const next = { ...existing };
          if (plugins.length > 0) next.plugin = plugins;
          else delete next.plugin;
          await atomicWrite(configPath, `${JSON.stringify(next, null, 2)}\n`);
        }
        return { plugins, removed };
      });
    },

    async applyProviderVisibility(v: ProviderVisibilityApply): Promise<void> {
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

      await atomicWrite(configPath, `${JSON.stringify(next, null, 2)}\n`);
    },

    async applyAgent(name, role): Promise<void> {
      if (!name.trim()) throw new Error("agent name required");
      const existing = await readExisting();
      const agentsRaw = existing.agent;
      const agents: Record<string, unknown> =
        agentsRaw && typeof agentsRaw === "object" && !Array.isArray(agentsRaw)
          ? { ...(agentsRaw as Record<string, unknown>) }
          : {};
      const currentRaw = agents[name];
      const current: Record<string, unknown> =
        currentRaw && typeof currentRaw === "object" && !Array.isArray(currentRaw)
          ? { ...(currentRaw as Record<string, unknown>) }
          : {};
      current.mode = role.mode;
      if (role.prompt?.trim()) current.prompt = role.prompt;
      else delete current.prompt;
      if (role.model) current.model = `${role.model.providerID}/${role.model.modelID}`;
      else delete current.model;
      agents[name] = current;
      await atomicWrite(configPath, `${JSON.stringify({ ...existing, agent: agents }, null, 2)}\n`);
    },

    async applyMcp(entries: McpApplyEntry[]): Promise<void> {
      const existing = await readExisting();

      const mcp: Record<string, unknown> = {};
      for (const e of entries) {
        mcp[e.name] = e.transport.kind === "stdio"
          ? {
              type: "local",
              command: [e.transport.command, ...e.transport.args],
              enabled: e.enabled,
              ...(Object.keys(e.transport.env).length ? { environment: e.transport.env } : {}),
            }
          : {
              type: "remote",
              url: e.transport.url,
              enabled: e.enabled,
              ...(Object.keys(e.transport.headers).length ? { headers: e.transport.headers } : {}),
            };
      }
      await atomicWrite(configPath, `${JSON.stringify({ ...existing, mcp }, null, 2)}\n`);
    },
  };
}
