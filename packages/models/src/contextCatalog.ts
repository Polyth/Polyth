import type { ModelDescriptor } from "@polyth/contracts";

const MODELS_DEV_URL = "https://models.dev/api.json";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_RETRY_MS = 5 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDERS = 1_024;
const MAX_MODELS = 250_000;
const MAX_CONTEXT_TOKENS = 100_000_000;
const HARNESS_PROVIDER_IDS = new Set([
  "acp",
  "antigravity",
  "claude",
  "codex",
  "command-code",
  "commandcode",
  "cursor",
  "fx",
  "grok",
  "omp",
  "opencode",
  "pi",
]);

/** Harnesses whose extra native logins register as `<family>-<account>`; an
 * ACP account catalog uses that harness id as its provider id. */
const ACCOUNT_HARNESS_FAMILIES = new Set(["antigravity", "claude", "codex", "commandcode", "cursor", "deepseek", "grok", "omp", "pi"]);
/** The harness provider id a provider id stands for (`grok-work` → `grok`). */
const harnessProviderId = (providerID: string): string => {
  const normalized = providerID.trim().toLowerCase();
  const family = /^([a-z]+)-[a-z0-9][a-z0-9-]*$/.exec(normalized)?.[1];
  return family && ACCOUNT_HARNESS_FAMILIES.has(family) && !HARNESS_PROVIDER_IDS.has(normalized) ? family : normalized;
};

/** `undefined` marks a provider/model pair whose duplicate rows disagree. */
type ContextByProvider = Map<string, number | undefined>;

export interface ModelContextIndex {
  readonly byModel: ReadonlyMap<string, ContextByProvider>;
}

export interface ModelContextCatalog {
  enrich(models: readonly ModelDescriptor[]): Promise<ModelDescriptor[]>;
}

export interface ModelContextCatalogOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  retryMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const positiveCount = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | undefined => {
  let numeric = Number.NaN;
  if (typeof value === "number") numeric = value;
  else if (typeof value === "string") {
    const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(value.trim());
    if (match) {
      const multiplier = match[2]?.toLowerCase() === "k"
        ? 1_000
        : match[2]?.toLowerCase() === "m"
          ? 1_000_000
          : 1;
      numeric = Number(match[1]) * multiplier;
    }
  }
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > maximum) return undefined;
  const rounded = Math.round(numeric);
  return rounded > 0 ? rounded : undefined;
};

const normalizedModelId = (value: string): string =>
  value.trim().toLowerCase().replace(/\s*\[[^\]]*\]\s*$/, "");

const EXPLICIT_CONTEXT_CONFLICT = Symbol("explicit-context-conflict");

const contextFromModelId = (value: string): number | typeof EXPLICIT_CONTEXT_CONFLICT | undefined => {
  const matches = [...value.matchAll(/(?:^|[,[(])\s*context\s*=\s*([\s\S]*?)(?=\s*(?:,|\]|\)|$))/gi)];
  if (matches.length === 0) return undefined;
  const values = matches.map((match) => positiveCount(match[1], MAX_CONTEXT_TOKENS));
  if (values.some((value) => value === undefined) || new Set(values).size !== 1) {
    return EXPLICIT_CONTEXT_CONFLICT;
  }
  return values[0];
};

const inferredProvider = (modelId: string): string | undefined => {
  const id = normalizedModelId(modelId).split("/").at(-1) ?? "";
  if (id.startsWith("claude-")) return "anthropic";
  if (/^(?:gpt-|o[134](?:-|$)|codex)/.test(id)) return "openai";
  if (id.startsWith("gemini-")) return "google";
  if (id.startsWith("grok-")) return "xai";
  if (id.startsWith("qwen")) return "alibaba";
  if (id.startsWith("glm-")) return "zhipuai";
  if (id.startsWith("kimi") || id.startsWith("moonshot")) return "moonshotai";
  if (id.startsWith("mimo-")) return "xiaomi";
  if (id.startsWith("minimax")) return "minimax";
  if (id.startsWith("deepseek-")) return "deepseek";
  if (id.startsWith("mistral-")) return "mistral";
  if (id.startsWith("llama-")) return "meta";
  return undefined;
};

const providerCandidates = (providerID: string, modelID: string): string[] => {
  const normalizedProvider = harnessProviderId(providerID);
  const pathProvider = modelID.includes("/")
    ? modelID.split("/", 1)[0]?.trim().toLowerCase()
    : undefined;
  const inferred = inferredProvider(modelID);
  const harnessProviders = HARNESS_PROVIDER_IDS;
  const aliases: Record<string, string | undefined> = {
    antigravity: inferred,
    claude: "anthropic",
    codex: "openai",
    cursor: inferred,
    grok: "xai",
    "google-antigravity": "google",
    "openai-codex": "openai",
  };
  return [...new Set([
    aliases[normalizedProvider],
    harnessProviders.has(normalizedProvider) ? undefined : normalizedProvider,
    pathProvider,
    inferred,
  ].filter((value): value is string => Boolean(value)))];
};

const modelIdCandidates = (modelID: string): string[] => {
  const base = normalizedModelId(modelID);
  const values = [base];
  const slash = base.indexOf("/");
  if (slash >= 0 && slash < base.length - 1) values.push(base.slice(slash + 1));
  // Claude's SDK uses stable family aliases (`sonnet`, `opus`, `haiku`)
  // while models.dev names the concrete versioned rows. Apply this to a
  // provider-prefixed id as well as a bare SDK alias.
  for (const value of [...values]) {
    if (["haiku", "opus", "sonnet"].includes(value)) values.push(`claude-${value}`);
    const withoutEffort = value.replace(/-(?:low|medium|high|xhigh|max)$/i, "");
    if (withoutEffort !== value) values.push(withoutEffort);
    // Antigravity lists Claude's extended-thinking mode as its own id
    // (`claude-opus-4-6-thinking`); thinking does not change Claude's window.
    // Other families' `-thinking` ids are distinct models, so Claude only.
    if (/^claude-.+-thinking$/.test(value)) values.push(value.slice(0, -"-thinking".length));
  }
  return [...new Set(values.filter(Boolean))];
};

export function buildModelContextIndex(payload: unknown): ModelContextIndex {
  const providers = record(payload);
  const byModel = new Map<string, ContextByProvider>();
  if (!providers) return { byModel };

  let modelCount = 0;
  for (const [providerID, rawProvider] of Object.entries(providers).slice(0, MAX_PROVIDERS)) {
    const provider = record(rawProvider);
    const models = record(provider?.models);
    if (!models) continue;
    for (const [modelID, rawModel] of Object.entries(models)) {
      if (modelCount >= MAX_MODELS) return { byModel };
      const context = positiveCount(record(record(rawModel)?.limit)?.context, MAX_CONTEXT_TOKENS);
      if (context === undefined) continue;
      const id = normalizedModelId(modelID);
      if (!id) continue;
      modelCount += 1;
      const provider = providerID.trim().toLowerCase();
      if (!provider) continue;
      const contexts = byModel.get(id) ?? new Map<string, number | undefined>();
      const previous = contexts.get(provider);
      if (!contexts.has(provider)) contexts.set(provider, context);
      else if (previous !== undefined && previous !== context) contexts.set(provider, undefined);
      byModel.set(id, contexts);
    }
  }
  return { byModel };
}

const familyContexts = (
  index: ModelContextIndex,
  candidate: string,
): ContextByProvider | undefined => {
  if (!candidate.startsWith("claude-")) return undefined;
  const prefix = `${candidate}-`;
  const rows = [...index.byModel.entries()]
    .filter(([modelID]) => modelID.startsWith(prefix));
  if (rows.length === 0) return undefined;
  const merged = new Map<string, number | undefined>();
  for (const [, contexts] of rows) {
    for (const [provider, context] of contexts) {
      if (!merged.has(provider)) merged.set(provider, context);
      else if (merged.get(provider) !== context) merged.set(provider, undefined);
    }
  }
  return merged;
};

const contextsForCandidate = (
  index: ModelContextIndex,
  candidate: string,
): ContextByProvider | undefined =>
  index.byModel.get(candidate) ?? familyContexts(index, candidate);

const contextFromIndex = (
  model: ModelDescriptor,
  index: ModelContextIndex,
): number | typeof EXPLICIT_CONTEXT_CONFLICT | undefined => {
  const explicit = contextFromModelId(model.modelID);
  if (explicit === EXPLICIT_CONTEXT_CONFLICT) return EXPLICIT_CONTEXT_CONFLICT;
  if (explicit !== undefined) return explicit;

  const providers = providerCandidates(model.providerID, model.modelID);
  const runtimeLocal = HARNESS_PROVIDER_IDS.has(harnessProviderId(model.providerID));
  for (const candidate of modelIdCandidates(model.modelID)) {
    const contexts = contextsForCandidate(index, candidate);
    if (!contexts) continue;
    for (const provider of providers) {
      if (!contexts.has(provider)) continue;
      const exact = contexts.get(provider);
      // A present-but-undefined value is an explicit ambiguous duplicate; do
      // not let a weaker provider guess override that refusal.
      if (exact !== undefined) return exact;
      return undefined;
    }
    const inferred = inferredProvider(candidate);
    if (inferred && contexts.has(inferred)) return contexts.get(inferred);
    // A transport's opaque local id (auto/default/private aliases) is not a
    // portable model identity, even if an unrelated public provider happens
    // to use the same string. Require provider or model-family evidence.
    if (runtimeLocal && providers.length === 0) continue;
    const values = [...contexts.values()];
    if (values.every((value) => value !== undefined) && new Set(values).size === 1) {
      return values[0];
    }
  }
  return undefined;
};

export function enrichModelsWithContext(
  models: readonly ModelDescriptor[],
  index: ModelContextIndex,
): ModelDescriptor[] {
  return models.map((model) => {
    // Conflict is durable negative evidence. Clear malformed contradictory
    // payloads and never replace them with the weaker public catalog.
    if (model.contextStatus === "conflict") {
      if (model.context === undefined) return model;
      const { context: _context, ...conflicted } = model;
      return conflicted;
    }
    // A native denominator is stronger than models.dev, including after the
    // runtime catalog merged a missing duplicate with a known duplicate.
    if (model.context !== undefined) return model;
    const context = contextFromIndex(model, index);
    if (context === EXPLICIT_CONTEXT_CONFLICT) return { ...model, contextStatus: "conflict" };
    return context === undefined ? model : { ...model, context };
  });
}

const readBoundedBody = async (response: Response, maxBytes: number): Promise<Uint8Array> => {
  const declared = response.headers.get("content-length");
  if (declared) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Model context catalog is too large");
    }
  }
  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maxBytes) throw new Error("Model context catalog is too large");
    return body;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Model context catalog is too large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

export function createModelContextCatalog(
  options: ModelContextCatalogOptions = {},
): ModelContextCatalog {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let cached: { index: ModelContextIndex; expiresAt: number } | undefined;
  let retryAt = 0;
  let pending: Promise<ModelContextIndex> | undefined;

  const load = (): Promise<ModelContextIndex> => {
    const timestamp = now();
    if (cached && cached.expiresAt > timestamp) return Promise.resolve(cached.index);
    if (timestamp < retryAt) return Promise.resolve({ byModel: new Map() });
    if (pending) return pending;

    const request = (async (): Promise<ModelContextIndex> => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // AbortSignal is the primary cancellation path for native fetch. The
        // race keeps the five-second bound even for a test double or a
        // non-conforming fetch implementation that ignores the signal.
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Model context catalog request timed out"));
          }, timeoutMs);
        });
        const response = await Promise.race([
          fetchImpl(MODELS_DEV_URL, {
            headers: { accept: "application/json" },
            redirect: "error",
            signal: controller.signal,
          }),
          timeout,
        ]);
        if (!response.ok) throw new Error(`Model context catalog returned ${response.status}`);
        const body = await Promise.race([
          readBoundedBody(response, maxBytes),
          timeout,
        ]);
        const index = buildModelContextIndex(JSON.parse(new TextDecoder().decode(body)));
        cached = { index, expiresAt: now() + ttlMs };
        retryAt = 0;
        return index;
      } catch {
        retryAt = now() + retryMs;
        // The TTL also bounds stale-on-error use: an expired public limit
        // cannot silently look current through an indefinite provider outage.
        return { byModel: new Map() };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    const inFlight: Promise<ModelContextIndex> = request.finally(() => {
      if (pending === inFlight) pending = undefined;
    });
    pending = inFlight;
    return inFlight;
  };

  return {
    async enrich(models) {
      if (!models.some((model) => model.context === undefined && model.contextStatus !== "conflict")) {
        return enrichModelsWithContext(models, { byModel: new Map() });
      }
      return enrichModelsWithContext(models, await load());
    },
  };
}
