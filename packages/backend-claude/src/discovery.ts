// Claude's model catalog comes from the Agent SDK's `initialize` control
// response, which `Query.supportedModels()` simply awaits — it does not start a
// conversation. So a catalog is obtainable without a user turn: open a query
// whose prompt generator never yields, read the models, close it.
//
// That is still a process spawn, so it is cached and deduped here rather than
// run per `models()` call. A live session's query is always preferred by the
// runtime; this path only serves a cold composer.
import type { ModelDescriptor } from "@polyth/contracts";
import type { ModelInfo, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export type ClaudeQueryFactory = (input: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Record<string, unknown>;
}) => Query;

/** Named effort levels the SDK accepts, in the order the UI should show them. */
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];

const orderedEfforts = (levels: readonly string[]): string[] => {
  const known = EFFORT_ORDER.filter((level) => levels.includes(level));
  const extra = levels.filter((level) => !EFFORT_ORDER.includes(level));
  return [...known, ...extra];
};

/** Map the SDK's model rows onto the canonical descriptor shape. */
export const claudeModelDescriptors = (models: readonly ModelInfo[]): ModelDescriptor[] =>
  models.map((model) => {
    const variants = model.supportsEffort === true
      ? orderedEfforts(model.supportedEffortLevels ?? [])
      : [];
    return {
      providerID: "anthropic",
      modelID: model.value,
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

const cacheKey = (options: ClaudeDiscoveryOptions): string =>
  JSON.stringify(["claude", options.executable, options.authFingerprint]);

/** Credential-source identity: names only, never values. */
export const claudeAuthFingerprint = (env: NodeJS.ProcessEnv = process.env): string =>
  ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"]
    .filter((name) => Boolean(env[name]))
    .join(",") || "native";

/** A prompt that never yields keeps `initialize` the only exchange. */
async function* silentPrompt(): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>(() => {});
}

export function invalidateClaudeModelCache(options?: Pick<ClaudeDiscoveryOptions, "executable" | "authFingerprint">): void {
  if (!options) { cache.clear(); return; }
  cache.delete(cacheKey(options as ClaudeDiscoveryOptions));
}

/** Warm-cache read: never spawns. Used at session create so a picker-warmed
 *  catalog can validate effort without a second Claude process. */
export function peekClaudeModels(options: Pick<ClaudeDiscoveryOptions, "executable" | "authFingerprint">): ModelDescriptor[] | undefined {
  const entry = cache.get(cacheKey(options as ClaudeDiscoveryOptions));
  return entry?.models;
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
