// F10: parse a pasted "mcpServers" block into MCP server create inputs.
// Pure and side-effect free so it can be unit-tested and previewed before any
// save. Accepts the common Claude-style shape ({command, args, env} /
// {url, headers}) and the OpenCode shape ({type:"local", command:[...],
// environment} / {type:"remote", url, headers}). Env/header VALUES are treated
// as write-once secrets: they go to the server on create and are never shown
// again.
import type { McpTransport } from "@polyth/contracts";

export interface McpImportEntry {
  name: string;
  transport: McpTransport;
  /** secret values keyed by env key / header name; write-only */
  secrets?: Record<string, string>;
  enabled: boolean;
}

export interface McpImportResult {
  entries: McpImportEntry[];
  errors: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const stringMap = (v: unknown): Record<string, string> => {
  if (!isRecord(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
};

function parseOne(name: string, raw: unknown): McpImportEntry | string {
  if (!isRecord(raw)) return `${name}: entry must be an object`;
  if (!name.trim() || name.length > 64) return `${name || "(unnamed)"}: name required (≤64 chars)`;
  const enabled = raw.enabled !== false;

  // remote/http: {url} or {type:"remote", url}
  const url = typeof raw.url === "string" ? raw.url : undefined;
  if (url !== undefined || raw.type === "remote") {
    if (!url) return `${name}: remote entry needs a url`;
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return `${name}: only http(s) URLs are allowed`;
    } catch {
      return `${name}: invalid url`;
    }
    const headers = stringMap(raw.headers);
    const refs = Object.keys(headers);
    return {
      name: name.trim(),
      transport: { kind: "http", url, headersSecretRefs: refs },
      ...(refs.length ? { secrets: headers } : {}),
      enabled,
    };
  }

  // local/stdio: {command: "npx", args: []} or {type:"local", command: ["npx", ...]}
  let command = "";
  let args: string[] = [];
  if (typeof raw.command === "string") {
    command = raw.command;
    args = strings(raw.args);
  } else if (Array.isArray(raw.command)) {
    const parts = strings(raw.command);
    command = parts[0] ?? "";
    args = parts.slice(1);
  }
  if (!command.trim()) return `${name}: stdio entry needs a command`;
  const env = { ...stringMap(raw.env), ...stringMap(raw.environment) };
  const envKeys = Object.keys(env);
  return {
    name: name.trim(),
    transport: { kind: "stdio", command: command.trim(), args, envKeys },
    ...(envKeys.length ? { secrets: env } : {}),
    enabled,
  };
}

/** Parse pasted JSON. Never throws; malformed entries land in `errors`. */
export function parseMcpServersJson(text: string): McpImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { entries: [], errors: [`not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!isRecord(parsed)) return { entries: [], errors: ["expected a JSON object"] };

  // accept {mcpServers: {...}}, {mcp: {...}}, or the server map directly
  const block = isRecord(parsed.mcpServers) ? parsed.mcpServers
    : isRecord(parsed.mcp) ? parsed.mcp
    : parsed;
  const names = Object.keys(block);
  if (names.length === 0) return { entries: [], errors: ["no servers found — paste an mcpServers block"] };

  const entries: McpImportEntry[] = [];
  const errors: string[] = [];
  for (const name of names) {
    const r = parseOne(name, block[name]);
    if (typeof r === "string") errors.push(r);
    else entries.push(r);
  }
  return { entries, errors };
}
