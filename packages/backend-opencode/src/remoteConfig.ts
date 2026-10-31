// The part of this machine's OpenCode configuration that a remote OpenCode
// can use as-is: model choices, provider/model definitions and agent
// settings. It is layered over the host's own configuration at launch
// (OPENCODE_CONFIG_CONTENT), memory-only, never written on the host.
//
// What stays behind:
// - credentials: literal secret values are dropped (an `{env:NAME}` or
//   `{file:path}` reference is kept — it resolves against the HOST's own
//   environment, which is the point of a portable reference);
// - anything bound to this machine's filesystem or processes: local MCP
//   commands, plugins, instruction/skill paths. Polyth's own capabilities
//   reach the remote leg through its capability bridge instead.

/** Top-level keys that describe choices, not this machine. */
const PORTABLE_KEYS = [
  "model",
  "small_model",
  "provider",
  "agent",
  "mode",
  "disabled_providers",
  "enabled_providers",
] as const;

const SECRET_KEY_RE = /^(api[-_]?key|apikey|token|access[-_]?token|refresh[-_]?token|id[-_]?token|secret|client[-_]?secret|password|passphrase|authorization|cookie|private[-_]?key|bearer|credentials?)$/i;
/** Header maps carry bearer tokens and API keys more often than not. */
const HEADER_KEY_RE = /^headers$/i;
const REFERENCE_RE = /^\{(env|file):[^}\n]+\}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const scrub = (value: unknown, depth: number): unknown => {
  if (depth > 12) return undefined;
  if (Array.isArray(value)) {
    return value.map((entry) => scrub(entry, depth + 1)).filter((entry) => entry !== undefined);
  }
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (HEADER_KEY_RE.test(key)) {
      if (!isRecord(entry)) continue;
      const references = Object.fromEntries(Object.entries(entry)
        .filter(([, header]) => typeof header === "string" && REFERENCE_RE.test(header.trim())));
      if (Object.keys(references).length) next[key] = references;
      continue;
    }
    if (SECRET_KEY_RE.test(key)) {
      if (typeof entry === "string" && REFERENCE_RE.test(entry.trim())) next[key] = entry.trim();
      continue;
    }
    const cleaned = scrub(entry, depth + 1);
    if (cleaned !== undefined) next[key] = cleaned;
  }
  return next;
};

/** Portable, credential-free projection of a local OpenCode config. Returns
 * undefined when nothing portable is configured. */
export function portableOpenCodeConfig(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!isRecord(config)) return undefined;
  const next: Record<string, unknown> = {};
  for (const key of PORTABLE_KEYS) {
    if (config[key] === undefined) continue;
    const cleaned = scrub(config[key], 0);
    if (cleaned === undefined) continue;
    if (isRecord(cleaned) && Object.keys(cleaned).length === 0) continue;
    next[key] = cleaned;
  }
  return Object.keys(next).length ? next : undefined;
}

/** Layer Polyth's launch config (MCP bridge) over the portable local config;
 * the two never share a top-level key, and Polyth's would win if they did. */
export function mergeRemoteConfigContent(
  local: Record<string, unknown> | undefined,
  launch: string | undefined,
): string | undefined {
  if (!local) return launch;
  const parsed: unknown = launch?.trim() ? JSON.parse(launch) : {};
  if (!isRecord(parsed)) throw new Error("OpenCode launch config must be an object");
  return JSON.stringify({ ...local, ...parsed });
}
