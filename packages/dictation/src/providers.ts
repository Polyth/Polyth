// Provider-neutral dictation contracts and capability registry. Vendor SDKs do
// not leak past this boundary; transports and UI consume normalized metadata.

export type DictationProviderId =
  | "elevenlabs"
  | "wispr"
  | "openai-live"
  | "openai-transcribe"
  | "deepgram"
  | "speechmatics"
  | "openai-compatible"
  | "local-nemotron"
  | "local-parakeet"
  | "web-speech";

export type DictationTransport = "auto" | "direct-browser" | "server-proxy" | "local-worker";
export type DictationLatencyPreference = "lowest" | "balanced" | "quality";
export type DictationProcessingPolicy =
  | "local-only"
  | "prefer-local"
  | "prefer-cloud"
  | "auto-fallback"
  | "browser-fallback";

export type DictationErrorCode =
  | "mic_denied"
  | "provider_unavailable"
  | "invalid_credentials"
  | "rate_limited"
  | "network_error"
  | "session_expired"
  | "unsupported_language"
  | "local_model_missing"
  | "local_model_downloading"
  | "local_model_failed"
  | "worker_crashed"
  | "audio_format_error"
  | "backpressure_overflow"
  | "protocol_error";

export class DictationError extends Error {
  readonly code: DictationErrorCode;
  readonly retryAfterMs?: number;
  constructor(code: DictationErrorCode, message: string, options: { retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DictationError";
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface DictationContext {
  /** "auto" asks the provider to detect language; otherwise BCP-47/locale-ish. */
  language: "auto" | string;
  localeHints?: string[];
  keywords?: string[];
  glossary?: Record<string, string>;
  /** Bounded lexical context assembled by the caller, never raw repository dumps. */
  lexicalContext?: string;
}

export type NormalizedSttEvent =
  | { type: "connecting" }
  | { type: "ready" }
  | { type: "speech_start" }
  | { type: "speech_end" }
  | { type: "partial"; text: string; revision: number; stable?: string; unstable?: string }
  | { type: "commit"; text: string; revision: number }
  | { type: "finalizing" }
  | { type: "final"; text: string; revision: number }
  | { type: "cancelled" }
  | { type: "error"; error: DictationError };

export interface ProviderCapabilities {
  id: DictationProviderId;
  label: string;
  streaming: boolean;
  partials: boolean;
  commits: boolean;
  transports: readonly DictationTransport[];
  /** "*" means provider-managed language detection/catalog. */
  languages: readonly string[];
  defaultModel?: string;
  context: boolean;
  local: boolean;
  /** The upstream supports ephemeral client auth even if Polyth currently keeps the provider server-proxied. */
  ephemeralClientAuth: boolean;
  /** False means Polyth deliberately has no public endpoint contract to call. */
  publicApi: boolean;
}

export interface SttSession {
  push(pcm: Uint8Array): void | Promise<void>;
  events?(): readonly NormalizedSttEvent[];
  finalize(): Promise<string>;
  cancel?(): void | Promise<void>;
}

export interface DictationProvider {
  readonly id: DictationProviderId;
  readonly capabilities: ProviderCapabilities;
  available(): { available: boolean; reason?: string };
  createSession(options: {
    format: { encoding: "pcm_s16le"; sampleRate: number; channels: number };
    context: DictationContext;
    model?: string;
    signal?: AbortSignal;
  }): SttSession;
}

const CATALOG: readonly ProviderCapabilities[] = [
  {
    id: "elevenlabs", label: "ElevenLabs Scribe Realtime v2", streaming: true,
    partials: true, commits: true, transports: ["auto", "direct-browser", "server-proxy"],
    languages: ["*"], defaultModel: "scribe_v2_realtime", context: true, local: false,
    ephemeralClientAuth: true, publicApi: true,
  },
  {
    id: "wispr", label: "Wispr Flow", streaming: true,
    partials: true, commits: true, transports: ["auto"],
    languages: ["*"], context: true, local: false,
    ephemeralClientAuth: true,
    // Keep disabled until an actual Voice Interface API contract is configured;
    // do not invent a public endpoint from the consumer Flow product.
    publicApi: false,
  },
  {
    id: "openai-live", label: "OpenAI GPT Live Transcribe", streaming: true,
    partials: true, commits: true, transports: ["auto", "server-proxy"],
    languages: ["*"], defaultModel: "gpt-live-transcribe", context: true, local: false,
    ephemeralClientAuth: true, publicApi: true,
  },
  {
    id: "openai-transcribe", label: "OpenAI GPT Transcribe", streaming: true,
    partials: true, commits: true, transports: ["auto", "server-proxy"],
    languages: ["*"], defaultModel: "gpt-transcribe", context: true, local: false,
    ephemeralClientAuth: false, publicApi: true,
  },
  {
    id: "deepgram", label: "Deepgram Nova-3", streaming: true,
    partials: true, commits: true, transports: ["auto", "server-proxy"],
    languages: ["*", "uk"], defaultModel: "nova-3", context: true, local: false,
    ephemeralClientAuth: true, publicApi: true,
  },
  {
    id: "speechmatics", label: "Speechmatics Realtime", streaming: true,
    partials: true, commits: true, transports: ["auto", "server-proxy"],
    languages: ["*"], context: true, local: false,
    ephemeralClientAuth: false, publicApi: true,
  },
  {
    id: "openai-compatible", label: "OpenAI-compatible STT", streaming: false,
    partials: false, commits: false, transports: ["auto", "server-proxy"],
    languages: ["*"], defaultModel: "whisper-1", context: true, local: false,
    ephemeralClientAuth: false, publicApi: true,
  },
  {
    id: "local-nemotron", label: "Nemotron 3.5 Streaming 0.6B", streaming: true,
    partials: true, commits: true, transports: ["auto", "local-worker"],
    languages: ["uk-UA", "en-US", "*"], context: true, local: true,
    ephemeralClientAuth: false, publicApi: true,
  },
  {
    id: "local-parakeet", label: "Parakeet (English, optional)", streaming: true,
    partials: true, commits: true, transports: ["auto"],
    languages: ["en", "en-US"], context: false, local: true,
    ephemeralClientAuth: false,
    // Not shipped: Nemotron already covers English and Ukrainian with the same
    // runtime class, so another ~0.5 GB English-only model is not justified yet.
    publicApi: false,
  },
  {
    id: "web-speech", label: "Browser Web Speech", streaming: true,
    partials: true, commits: true, transports: ["auto", "direct-browser"],
    languages: ["*"], context: false, local: true,
    ephemeralClientAuth: false, publicApi: true,
  },
] as const;

export const providerCatalog = (): readonly ProviderCapabilities[] => CATALOG;
export const providerCapabilities = (id: DictationProviderId): ProviderCapabilities | undefined =>
  CATALOG.find((provider) => provider.id === id);

export const isLocalDictationProvider = (id: DictationProviderId): boolean =>
  id === "local-nemotron" || id === "local-parakeet" || id === "web-speech";

export const isCloudDictationProvider = (id: DictationProviderId): boolean =>
  !isLocalDictationProvider(id);

export class ProviderRegistry {
  private readonly providers = new Map<DictationProviderId, DictationProvider>();

  register(provider: DictationProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  unregister(id: DictationProviderId): boolean {
    return this.providers.delete(id);
  }

  get(id: DictationProviderId): DictationProvider | undefined {
    return this.providers.get(id);
  }

  list(): readonly DictationProvider[] {
    return [...this.providers.values()];
  }
}

export interface DictationPreferences {
  provider: DictationProviderId;
  transport: DictationTransport;
  model?: string;
  localModel?: string;
  language: "auto" | string;
  contextInjection: boolean;
  processingPolicy: DictationProcessingPolicy;
  /** Explicit secondary cloud provider. Never inferred for new settings. */
  fallbackProvider?: DictationProviderId;
  /** @deprecated persisted for older clients; processingPolicy owns routing. */
  cloudFallback: boolean;
  latencyPreference: DictationLatencyPreference;
}

export const DEFAULT_DICTATION_PREFERENCES: DictationPreferences = {
  provider: "elevenlabs",
  transport: "auto",
  language: "auto",
  contextInjection: true,
  processingPolicy: "prefer-cloud",
  cloudFallback: false,
  latencyPreference: "lowest",
};

const providerIds = new Set<DictationProviderId>(CATALOG.map((item) => item.id));
const transports = new Set<DictationTransport>(["auto", "direct-browser", "server-proxy", "local-worker"]);
const latencyPreferences = new Set<DictationLatencyPreference>(["lowest", "balanced", "quality"]);
const processingPolicies = new Set<DictationProcessingPolicy>([
  "local-only", "prefer-local", "prefer-cloud", "auto-fallback", "browser-fallback",
]);

const derivedPolicy = (provider: DictationProviderId, legacyCloudFallback: boolean): DictationProcessingPolicy => {
  if (provider === "web-speech") return "browser-fallback";
  if (provider === "local-nemotron" || provider === "local-parakeet") {
    return legacyCloudFallback ? "prefer-local" : "local-only";
  }
  return "prefer-cloud";
};

export function migrateDictationPreferences(input: unknown): DictationPreferences {
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const legacyEngine = typeof raw.engine === "string" ? raw.engine
    : typeof raw.sttEngine === "string" ? raw.sttEngine
    : undefined;

  let provider: DictationProviderId = DEFAULT_DICTATION_PREFERENCES.provider;
  const requestedProvider = raw.provider ?? raw.dictationProvider;
  if (typeof requestedProvider === "string" && providerIds.has(requestedProvider as DictationProviderId)) {
    provider = requestedProvider as DictationProviderId;
  } else if (legacyEngine === "browser" || legacyEngine === "web-speech") {
    provider = "web-speech";
  } else if (legacyEngine === "whisper" || legacyEngine === "custom") {
    provider = "openai-compatible";
  }

  let transport: DictationTransport = DEFAULT_DICTATION_PREFERENCES.transport;
  const requestedTransport = raw.transport ?? raw.dictationTransport;
  if (typeof requestedTransport === "string" && transports.has(requestedTransport as DictationTransport)) {
    transport = requestedTransport as DictationTransport;
  } else if (provider === "web-speech") {
    transport = "direct-browser";
  } else if (provider === "openai-compatible") {
    transport = "server-proxy";
  }

  // Persisted settings may outlive an experimental transport. Never leave the
  // picker in an impossible state: prefer auto when supported, then the first
  // concrete transport advertised by the current provider.
  const supportedTransports = providerCapabilities(provider)?.transports ?? ["auto"];
  if (!supportedTransports.includes(transport)) {
    transport = supportedTransports.includes("auto") ? "auto" : supportedTransports[0] ?? "auto";
  }

  const language = typeof raw.language === "string" && raw.language.trim()
    ? raw.language.trim()
    : typeof raw.lang === "string" && raw.lang.trim()
      ? raw.lang.trim()
      : DEFAULT_DICTATION_PREFERENCES.language;
  const latency = raw.latencyPreference;
  const legacyCloudFallback = raw.cloudFallback === true;
  const requestedPolicy = raw.processingPolicy;
  const processingPolicy = typeof requestedPolicy === "string" && processingPolicies.has(requestedPolicy as DictationProcessingPolicy)
    ? requestedPolicy as DictationProcessingPolicy
    : derivedPolicy(provider, legacyCloudFallback);

  const requestedFallback = raw.fallbackProvider;
  let fallbackProvider = typeof requestedFallback === "string" && providerIds.has(requestedFallback as DictationProviderId)
    && isCloudDictationProvider(requestedFallback as DictationProviderId)
    && requestedFallback !== provider
      ? requestedFallback as DictationProviderId
      : undefined;
  // The old boolean specifically meant local Nemotron -> ElevenLabs. Preserve
  // that explicit historical opt-in, but never infer a provider for new prefs.
  if (!fallbackProvider && legacyCloudFallback && (provider === "local-nemotron" || provider === "local-parakeet")) {
    fallbackProvider = "elevenlabs";
  }

  return {
    provider,
    transport,
    ...(typeof raw.model === "string" && raw.model.trim() ? { model: raw.model.trim() } : {}),
    ...(typeof raw.localModel === "string" && raw.localModel.trim() ? { localModel: raw.localModel.trim() } : {}),
    language,
    contextInjection: typeof raw.contextInjection === "boolean" ? raw.contextInjection : DEFAULT_DICTATION_PREFERENCES.contextInjection,
    processingPolicy,
    ...(fallbackProvider ? { fallbackProvider } : {}),
    cloudFallback: Boolean(fallbackProvider) && (processingPolicy === "prefer-local" || processingPolicy === "auto-fallback"),
    latencyPreference: typeof latency === "string" && latencyPreferences.has(latency as DictationLatencyPreference)
      ? latency as DictationLatencyPreference
      : DEFAULT_DICTATION_PREFERENCES.latencyPreference,
  };
}

const cleanList = (values: readonly string[] | undefined, max: number, itemMax: number): string[] | undefined => {
  if (!values?.length) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim().replace(/\s+/g, " ").slice(0, itemMax);
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out.length ? out : undefined;
};

/** Bound user/project lexical context before it reaches any cloud provider. */
export function normalizeDictationContext(input: Partial<DictationContext> = {}): DictationContext {
  const lexical = typeof input.lexicalContext === "string"
    ? input.lexicalContext.trim().replace(/\s+/g, " ").slice(0, 8_000)
    : "";
  const glossaryEntries = Object.entries(input.glossary ?? {}).slice(0, 64)
    .map(([from, to]) => [from.trim().slice(0, 96), to.trim().slice(0, 96)] as const)
    .filter(([from, to]) => from && to);
  return {
    language: typeof input.language === "string" && input.language.trim() ? input.language.trim() : "auto",
    ...(cleanList(input.localeHints, 8, 32) ? { localeHints: cleanList(input.localeHints, 8, 32) } : {}),
    ...(cleanList(input.keywords, 64, 96) ? { keywords: cleanList(input.keywords, 64, 96) } : {}),
    ...(glossaryEntries.length ? { glossary: Object.fromEntries(glossaryEntries) } : {}),
    ...(lexical ? { lexicalContext: lexical } : {}),
  };
}

export function normalizeDictationError(error: unknown, fallback: DictationErrorCode = "provider_unavailable"): DictationError {
  if (error instanceof DictationError) return error;
  const candidate = error as { code?: unknown; message?: unknown; retryAfterMs?: unknown } | null;
  const code = candidate && typeof candidate.code === "string" && [
    "mic_denied", "provider_unavailable", "invalid_credentials", "rate_limited", "network_error",
    "session_expired", "unsupported_language", "local_model_missing", "local_model_downloading",
    "local_model_failed", "worker_crashed", "audio_format_error", "backpressure_overflow", "protocol_error",
  ].includes(candidate.code)
    ? candidate.code as DictationErrorCode
    : fallback;
  const message = candidate && typeof candidate.message === "string" ? candidate.message : String(error ?? code);
  return new DictationError(code, message, {
    ...(candidate && typeof candidate.retryAfterMs === "number" ? { retryAfterMs: candidate.retryAfterMs } : {}),
    cause: error,
  });
}
