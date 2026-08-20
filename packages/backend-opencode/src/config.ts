// Backend configuration applier (WP9). This module is the ONLY place that may
// write OpenCode-facing configuration: global behavior instructions (AGENTS.md)
// and MCP server entries (opencode.json "mcp" block). The server owns the
// canonical revisioned copies; this applier projects them into the backend's
// config directory with atomic writes so a crash never leaves a torn file.
import { mkdirSync } from "node:fs";
import { readFile, rename, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
  /** Mirror provider/model visibility into the backend config, preserving all
   *  other keys (including unrelated per-provider options). */
  applyProviderVisibility(v: ProviderVisibilityApply): Promise<void>;
  /** Read the backend config as parsed JSON ({} when the file is missing;
   *  throws on corrupt JSON so callers never trust a torn read). */
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

export function createConfigApplier(opts: { configDir?: string } = {}): BackendConfigApplier {
  const dir = opts.configDir ?? defaultConfigDir();
  mkdirSync(dir, { recursive: true });
  const agentsPath = join(dir, "AGENTS.md");
  const configPath = join(dir, "opencode.json");

  // Missing file is fine (fresh install); a corrupt one must not be
  // silently clobbered — callers roll their stores back on throw.
  const readExisting = async (): Promise<Record<string, unknown>> => {
    try {
      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      throw new Error("backend config is not a JSON object");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  };

  return {
    behaviorPath: () => agentsPath,
    configPath: () => configPath,
    readConfig: readExisting,

    async applyBehavior(text: string): Promise<number> {
      await atomicWrite(agentsPath, text);
      return Buffer.byteLength(text, "utf8");
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
