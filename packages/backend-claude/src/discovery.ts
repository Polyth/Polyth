// Claude's model catalog comes from the Agent SDK's `initialize` control
// response, which `Query.supportedModels()` simply awaits — it does not start a
// conversation. So a catalog is obtainable without a user turn: open a query
// whose prompt generator never yields, read the models, close it.
//
// That is still a process spawn, so it is cached and deduped here rather than
// run per `models()` call. A live session's query is always preferred by the
// runtime; this path only serves a cold composer.
import { realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { ModelDescriptor } from "@polyth/contracts";
import type { ModelInfo, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export type ClaudeQueryFactory = (input: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Record<string, unknown>;
}) => Query;

/** Named effort levels the SDK accepts, in the order the UI should show them. */
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
/** A picker-only variant: Claude Code's ultracode setting is separate from
 *  effort, and the CLI's launch form runs it at xhigh. */
export const CLAUDE_ULTRACODE_VARIANT = "ultracode";

const orderedEfforts = (levels: readonly string[]): string[] => {
  const known = EFFORT_ORDER.filter((level) => levels.includes(level));
  const extra = levels.filter((level) => !EFFORT_ORDER.includes(level));
  return [...known, ...extra];
};

/** Map the SDK's model rows onto the canonical descriptor shape. Alias rows
 *  (`opus`, `default`) keep the concrete id the binary resolves them to, so a
 *  reported `claude-opus-5-5` maps back to the row a selection must name. */
export const claudeModelDescriptors = (models: readonly ModelInfo[]): ModelDescriptor[] =>
  models.map((model) => {
    const levels = orderedEfforts(model.supportedEffortLevels ?? []);
    // The SDK does not report ultracode support. xhigh is the level it runs at,
    // so a model that advertises xhigh can offer it; a CLI that later reports
    // ultracode itself still yields one entry.
    const offersUltracode = levels.includes("xhigh") || levels.includes(CLAUDE_ULTRACODE_VARIANT);
    const variants = model.supportsEffort === true
      ? offersUltracode ? [...new Set([...levels, CLAUDE_ULTRACODE_VARIANT])] : levels
      : [];
    const resolved = model.resolvedModel?.trim();
    return {
      providerID: "anthropic",
      modelID: model.value,
      ...(resolved && resolved !== model.value ? { resolvedModelID: resolved } : {}),
      name: model.displayName || model.value,
      connected: true,
      capabilities: ["input:text", "input:image", "input:pdf", "output:text", "toolcall"],
      ...(variants.length ? { variants } : {}),
    } satisfies ModelDescriptor;
  });

export interface ClaudeDiscoveryOptions {
  query: ClaudeQueryFactory;
  cwd: string;
  /** Resolved Claude Code executable — part of the cache identity. */
  executable: string;
  /** Which credential source is in play; a change must not serve a stale list. */
  authFingerprint: string;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => number;
}

interface CacheEntry {
  models?: ModelDescriptor[];
  expiresAt: number;
  pending?: Promise<ModelDescriptor[]>;
}

const cache = new Map<string, CacheEntry>();
const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;

const locateExecutable = (spec: string, env: NodeJS.ProcessEnv): string | undefined => {
  if (isAbsolute(spec) || spec.includes("/") || spec.includes("\\")) return spec;
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, spec);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* not in this directory */ }
  }
  return undefined;
};

/**
 * The binary the executable spec resolves to right now, with its size and
 * modification time. A bare `claude`, its launcher symlink and the versioned
 * file it points at are one binary, and an auto-update (the launcher moves to
 * a new versioned file) is a different one. The catalog is cached per binary,
 * so a spec whose target changed never serves the previous binary's models
 * and effort levels. When the spec cannot be resolved, the spec itself is the
 * identity, as before.
 */
export const claudeBinaryIdentity = (executable: string, env: NodeJS.ProcessEnv = process.env): string => {
  try {
    const located = locateExecutable(executable, env);
    if (!located) return executable;
    const real = realpathSync(located);
    const stat = statSync(real);
    return `${real}#${stat.size}@${Math.floor(stat.mtimeMs)}`;
  } catch {
    return executable;
  }
};

const cacheKey = (options: ClaudeDiscoveryOptions): string =>
  JSON.stringify(["claude", claudeBinaryIdentity(options.executable), options.authFingerprint]);

/** Credential-source identity: secret names only, never values. The account
 *  config directory is a path, not a secret, and separates accounts. */
export const claudeAuthFingerprint = (env: NodeJS.ProcessEnv = process.env): string =>
  (["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"]
    .filter((name) => Boolean(env[name]))
    .join(",") || "native")
  + (env.CLAUDE_CONFIG_DIR ? `@${env.CLAUDE_CONFIG_DIR}` : "");

/** A prompt that never yields keeps `initialize` the only exchange. */
async function* silentPrompt(): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>(() => {});
}

export function invalidateClaudeModelCache(options?: Pick<ClaudeDiscoveryOptions, "executable" | "authFingerprint">): void {
  if (!options) { cache.clear(); return; }
  cache.delete(cacheKey(options as ClaudeDiscoveryOptions));
}

/** Warm-cache read: never spawns. Used at session create so a picker-warmed
 *  catalog can validate effort without a second Claude process. An expired
 *  entry is not an answer: a stale list would refuse models and effort levels
 *  the current binary offers. */
export function peekClaudeModels(options: Pick<ClaudeDiscoveryOptions, "executable" | "authFingerprint" | "now">): ModelDescriptor[] | undefined {
  const entry = cache.get(cacheKey(options as ClaudeDiscoveryOptions));
  if (!entry?.models) return undefined;
  const now = options.now ?? Date.now;
  return entry.expiresAt > now() ? entry.models : undefined;
}

export async function discoverClaudeModels(options: ClaudeDiscoveryOptions): Promise<ModelDescriptor[]> {
  const now = options.now ?? Date.now;
  const key = cacheKey(options);
  const entry = cache.get(key);
  if (entry?.models && entry.expiresAt > now()) return entry.models;
  if (entry?.pending) return entry.pending;
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending = (async () => {
    let probe: Query | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      probe = options.query({
        prompt: silentPrompt(),
        options: {
          cwd: options.cwd,
          pathToClaudeCodeExecutable: options.executable,
          permissionMode: "default",
          includePartialMessages: false,
        },
      });
      const models = await new Promise<ModelInfo[]>((resolve, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error("Claude Code did not report its models in time"), { code: "discovery-unavailable" })),
          timeoutMs,
        );
        probe!.supportedModels().then(resolve, reject);
      });
      const descriptors = claudeModelDescriptors(models);
      cache.set(key, { models: descriptors, expiresAt: now() + ttl });
      return descriptors;
    } finally {
      if (timer) clearTimeout(timer);
      try { probe?.close(); } catch { /* the probe process is already gone */ }
    }
  })();
  cache.set(key, { ...(entry?.models ? { models: entry.models } : {}), expiresAt: entry?.expiresAt ?? 0, pending });
  return pending.finally(() => {
    const current = cache.get(key);
    if (current?.pending === pending) {
      if (current.models) cache.set(key, { models: current.models, expiresAt: current.expiresAt });
      else cache.delete(key);
    }
  });
}
