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

export interface DictationContextMessage {
  role: "user" | "assistant";
  content: string;
}

export interface DictationContext {
  /** "auto" asks the provider to detect language; otherwise BCP-47/locale-ish. */
  language: "auto" | string;
  localeHints?: string[];
  keywords?: string[];
  glossary?: Record<string, string>;
  technicalVocabulary?: string[];
  app?: {
    type: "ai" | "email" | "other";
    name?: string;
  };
  composer?: {
    beforeCursor?: string;
    selection?: string;
    afterCursor?: string;
  };
  conversation?: {
    id?: string;
    messages?: DictationContextMessage[];
  };
  project?: {
    name?: string;
    repository?: string;
    branch?: string;
    packages?: string[];
    files?: string[];
    harnesses?: string[];
    models?: string[];
  };
  /** Bounded lexical context assembled by the caller, never raw repository dumps. */
  lexicalContext?: string;
}

export type NormalizedSttEvent =
  | { type: "connecting" }
  | { type: "ready" }
  | { type: "speech_start" }
  | { type: "speech_end" }
  | { type: "partial"; text: string; revision: number; stable?: string; unstable?: string }
  | { type: "committed"; text: string; revision: number }
  | { type: "finalizing" }
  | { type: "final"; text: string; revision: number }
  | { type: "recoverable_error"; error: DictationError }
  | { type: "fatal_error"; error: DictationError }
  | { type: "cancelled" }
  /** @deprecated provider-extension compatibility; emit `committed`. */
  | { type: "commit"; text: string; revision: number }
  /** @deprecated provider-extension compatibility; emit a typed error event. */
  | { type: "error"; error: DictationError };

export interface ProviderAudioFormat {
  encoding: "pcm_s16le";
  sampleRates: readonly number[];
  channels: readonly number[];
  /** Provider wire container. Polyth may still keep canonical internal PCM raw. */
  container: "raw" | "wav";
}

export interface ProviderCapabilities {
  id: DictationProviderId;
  label: string;
  streaming: boolean;
  partials: boolean;
  commits: boolean;
  finalOnly: boolean;
  manualCommit: boolean;
  vadCommit: boolean;
  languageAutoDetection: boolean;
  languageHints: boolean;
  contextualPrompting: boolean;
  vocabulary: boolean;
  timestamps: boolean;
  transports: readonly DictationTransport[];
  /** "*" means the provider owns a broader language catalog than Polyth enumerates. */
  languages: readonly string[];
  audioFormats: readonly ProviderAudioFormat[];
  defaultModel?: string;
  /** Compatibility mirror for older capability consumers. */
  context: boolean;
  local: boolean;
  localModelDownloadRequired: boolean;
  /** The upstream supports ephemeral client auth even if Polyth currently keeps the provider server-proxied. */
  ephemeralClientAuth: boolean;
  /** False means Polyth deliberately has no supported public endpoint contract to call. */
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

const RAW_16K = [{ encoding: "pcm_s16le", sampleRates: [16_000], channels: [1], container: "raw" }] as const;
const WAV_16K = [{ encoding: "pcm_s16le", sampleRates: [16_000], channels: [1], container: "wav" }] as const;
const RAW_24K = [{ encoding: "pcm_s16le", sampleRates: [24_000], channels: [1], container: "raw" }] as const;

const CATALOG: readonly ProviderCapabilities[] = [
  {
    id: "elevenlabs", label: "ElevenLabs Scribe Realtime v2", streaming: true,
    partials: true, commits: true, finalOnly: false, manualCommit: true, vadCommit: true,
    languageAutoDetection: true, languageHints: true, contextualPrompting: true, vocabulary: true,
    timestamps: true, transports: ["auto", "direct-browser", "server-proxy"],
    languages: ["*"], audioFormats: RAW_16K, defaultModel: "scribe_v2_realtime", context: true, local: false,
    localModelDownloadRequired: false, ephemeralClientAuth: true, publicApi: true,
  },
  {
    id: "wispr", label: "Wispr Flow", streaming: true,
    partials: true, commits: true, finalOnly: false, manualCommit: true, vadCommit: false,
    languageAutoDetection: true, languageHints: true, contextualPrompting: true, vocabulary: true,
    timestamps: false, transports: ["auto", "direct-browser", "server-proxy"],
    languages: ["*"], audioFormats: WAV_16K, context: true, local: false,
    localModelDownloadRequired: false, ephemeralClientAuth: true, publicApi: true,
  },
  {
    id: "openai-live", label: "OpenAI GPT Live Transcribe", streaming: true,
    partials: true, commits: true, finalOnly: false, manualCommit: true, vadCommit: true,
    languageAutoDetection: true, languageHints: true, contextualPrompting: true, vocabulary: true,
    timestamps: false, transports: ["auto", "server-proxy"],
    languages: ["*"], audioFormats: RAW_24K, defaultModel: "gpt-live-transcribe", context: true, local: false,
    localModelDownloadRequired: false, ephemeralClientAuth: true, publicApi: true,
  },
  {
    id: "openai-transcribe", label: "OpenAI GPT Transcribe", streaming: true,
    partials: true, commits: true, finalOnly: false, manualCommit: true, vadCommit: true,
    languageAutoDetection: true, languageHints: true, contextualPrompting: true, vocabulary: true,
    timestamps: false, transports: ["auto", "server-proxy"],
    languages: ["*"], audioFormats: RAW_24K, defaultModel: "gpt-transcribe", context: true, local: false,
    localModelDownloadRequired: false, ephemeralClientAuth: false, publicApi: true,
  },
  {
    id: "deepgram", label: "Deepgram Nova-3", streaming: true,
    partials: true, commits: true, finalOnly: false, manualCommit: true, vadCommit: true,
    // Current Deepgram docs explicitly exclude detect_language from streaming.
    // language=multi is multilingual transcription, not generic language detection
    // and does not currently include every monolingual Nova-3 language (notably uk).
    languageAutoDetection: false, languageHints: true, contextualPrompting: true, vocabulary: true,
    timestamps: true, transports: ["auto", "direct-browser", "server-proxy"],
    languages: ["*", "uk", "multi"], audioFormats: RAW_16K, defaultModel: "nova-3", context: true, local: false,
    localModelDownloadRequired: false, ephemeralClientAuth: true, publicApi: true,
  },
  {
    id: "speechmatics", label: "Speechmatics Realtime", streaming: true,
    partials: true, commits: true, finalOnly: false, manualCommit: true, vadCommit: false,
    languageAutoDetection: true, languageHints: true, contextualPrompting: true, vocabulary: true,
    timestamps: true, transports: ["auto", "server-proxy"],
    languages: ["*"], audioFormats: RAW_16K, context: true, local: false,
    localModelDownloadRequired: false, ephemeralClientAuth: false, publicApi: true,
  },
  {
    id: "openai-compatible", label: "OpenAI-compatible STT", streaming: false,
    partials: false, commits: false, finalOnly: true, manualCommit: false, vadCommit: false,
    languageAutoDetection: true, languageHints: true, contextualPrompting: true, vocabulary: false,
    timestamps: false, transports: ["auto", "server-proxy"],
    languages: ["*"], audioFormats: WAV_16K, defaultModel: "whisper-1", context: true, local: false,
    localModelDownloadRequired: false, ephemeralClientAuth: false, publicApi: true,
  },
  {
    id: "local-nemotron", label: "Nemotron 3.5 Streaming 0.6B", streaming: true,
    partials: true, commits: true, finalOnly: false, manualCommit: true, vadCommit: true,
    languageAutoDetection: true, languageHints: true, contextualPrompting: false, vocabulary: false,
    timestamps: false, transports: ["auto", "local-worker"],
    languages: ["uk-UA", "en-US", "es-ES", "*"], audioFormats: RAW_16K, context: false, local: true,
    localModelDownloadRequired: true, ephemeralClientAuth: false, publicApi: true,
  },
  {
    id: "local-parakeet", label: "Parakeet (English, optional)", streaming: true,
    partials: true, commits: true, finalOnly: false, manualCommit: true, vadCommit: true,
    languageAutoDetection: false, languageHints: false, contextualPrompting: false, vocabulary: false,
    timestamps: false, transports: ["auto"],
    languages: ["en", "en-US"], audioFormats: RAW_16K, context: false, local: true,
    localModelDownloadRequired: true, ephemeralClientAuth: false,
    // Not shipped: Nemotron already covers English and Ukrainian with the same
    // runtime class, so another ~0.5 GB English-only model is not justified yet.
    publicApi: false,
  },
  {
    id: "web-speech", label: "Browser Web Speech", streaming: true,
    partials: true, commits: true, finalOnly: false, manualCommit: true, vadCommit: true,
    languageAutoDetection: false, languageHints: true, contextualPrompting: false, vocabulary: false,
    timestamps: false, transports: ["auto", "direct-browser"],
    languages: ["*"], audioFormats: [], context: false, local: true,
    localModelDownloadRequired: false, ephemeralClientAuth: false, publicApi: true,
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
  // Extended composer/chat/repository context is privacy-sensitive. A user must
  // explicitly opt in before a cloud provider receives it.
  contextInjection: false,
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

const cleanText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/\s+/g, " ").slice(0, max);
  return text || undefined;
};

const cleanMessages = (messages: readonly DictationContextMessage[] | undefined): DictationContextMessage[] | undefined => {
  if (!messages?.length) return undefined;
  const out: DictationContextMessage[] = [];
  for (const raw of messages.slice(-12)) {
    if (raw?.role !== "user" && raw?.role !== "assistant") continue;
    const content = cleanText(raw.content, 600);
    if (content) out.push({ role: raw.role, content });
  }
  return out.length ? out : undefined;
};

/** Bound user/project lexical context before it reaches any cloud provider. */
export function normalizeDictationContext(input: Partial<DictationContext> = {}): DictationContext {
  const lexical = cleanText(input.lexicalContext, 4_000);
  const glossaryEntries = Object.entries(input.glossary ?? {}).slice(0, 64)
    .map(([from, to]) => [from.trim().slice(0, 96), to.trim().slice(0, 96)] as const)
    .filter(([from, to]) => from && to);
  const localeHints = cleanList(input.localeHints, 8, 32);
  const keywords = cleanList(input.keywords, 64, 96);
  const technicalVocabulary = cleanList(input.technicalVocabulary, 96, 96);
  const messages = cleanMessages(input.conversation?.messages);
  const appName = cleanText(input.app?.name, 96);
  const beforeCursor = cleanText(input.composer?.beforeCursor, 2_000);
  const selection = cleanText(input.composer?.selection, 1_000);
  const afterCursor = cleanText(input.composer?.afterCursor, 2_000);
  const conversationId = cleanText(input.conversation?.id, 128);
  const projectName = cleanText(input.project?.name, 128);
  const repository = cleanText(input.project?.repository, 160);
  const branch = cleanText(input.project?.branch, 160);
  const packages = cleanList(input.project?.packages, 32, 128);
  const files = cleanList(input.project?.files, 32, 192);
  const harnesses = cleanList(input.project?.harnesses, 16, 96);
  const models = cleanList(input.project?.models, 16, 96);

  return {
    language: typeof input.language === "string" && input.language.trim() ? input.language.trim().slice(0, 32) : "auto",
    ...(localeHints ? { localeHints } : {}),
    ...(keywords ? { keywords } : {}),
    ...(glossaryEntries.length ? { glossary: Object.fromEntries(glossaryEntries) } : {}),
    ...(technicalVocabulary ? { technicalVocabulary } : {}),
    ...(input.app?.type === "ai" || input.app?.type === "email" || input.app?.type === "other"
      ? { app: { type: input.app.type, ...(appName ? { name: appName } : {}) } }
      : {}),
    ...(beforeCursor || selection || afterCursor
      ? { composer: {
          ...(beforeCursor ? { beforeCursor } : {}),
          ...(selection ? { selection } : {}),
          ...(afterCursor ? { afterCursor } : {}),
        } }
      : {}),
    ...(conversationId || messages
      ? { conversation: {
          ...(conversationId ? { id: conversationId } : {}),
          ...(messages ? { messages } : {}),
        } }
      : {}),
    ...(projectName || repository || branch || packages || files || harnesses || models
      ? { project: {
          ...(projectName ? { name: projectName } : {}),
          ...(repository ? { repository } : {}),
          ...(branch ? { branch } : {}),
          ...(packages ? { packages } : {}),
          ...(files ? { files } : {}),
          ...(harnesses ? { harnesses } : {}),
          ...(models ? { models } : {}),
        } }
      : {}),
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
