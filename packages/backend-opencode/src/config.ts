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

export interface BackendConfigApplier {
  /** Overwrite the backend's global instruction file. Returns the applied byte length. */
  applyBehavior(text: string): Promise<number>;
  /** Replace the "mcp" block of the backend config, preserving all other keys. */
  applyMcp(entries: McpApplyEntry[]): Promise<void>;
  /** Where behavior text lands (for the settings UI path label). */
  behaviorPath(): string;
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

  return {
    behaviorPath: () => agentsPath,

    async applyBehavior(text: string): Promise<number> {
      await atomicWrite(agentsPath, text);
      return Buffer.byteLength(text, "utf8");
    },

    async applyMcp(entries: McpApplyEntry[]): Promise<void> {
      let existing: Record<string, unknown> = {};
      try {
        const raw = await readFile(configPath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        } else {
          throw new Error("backend config is not a JSON object");
        }
      } catch (err) {
        // Missing file is fine (fresh install); a corrupt one must not be
        // silently clobbered — the caller rolls its store back.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }

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
