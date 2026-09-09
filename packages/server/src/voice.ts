// Server-owned voice engine settings. Only REFERENCES to secrets are stored —
// apiKeyEnv names an environment variable; its value is resolved at call time
// and is never persisted or returned by this service.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";

// Persistence DTOs intentionally stay package-neutral. Feature packages may
// structurally narrow these values, but the core server must not depend on a
// non-core package such as @polyth/dictation.
type DictationProviderId =
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
type DictationTransport = "auto" | "direct-browser" | "server-proxy" | "local-worker";
type DictationLatencyPreference = "lowest" | "balanced" | "quality";
type DictationProcessingPolicy =
  | "local-only"
  | "prefer-local"
  | "prefer-cloud"
  | "auto-fallback"
  | "browser-fallback";

const DEFAULT_LOCAL_MODEL_ID = "nemotron-3.5-streaming-0.6b-560ms";
const CLOUD_DICTATION_PROVIDERS = new Set<DictationProviderId>([
  "elevenlabs", "wispr", "openai-live", "openai-transcribe", "deepgram",
  "speechmatics", "openai-compatible",
]);
const isCloudDictationProvider = (provider: DictationProviderId): boolean =>
  CLOUD_DICTATION_PROVIDERS.has(provider);

export interface VoiceSttSettings {
  /** Legacy/OpenAI-compatible batch STT endpoint. */
  baseUrl: string;
  model: string;
  language: string;
  apiKeyEnv: string;
}

export interface VoiceTtsSettings {
  baseUrl: string;
  model: string;
  voice: string;
  apiKeyEnv: string;
}

export interface VoiceDictationSettings {
  provider: DictationProviderId;
  transport: DictationTransport;
  model: string;
  localModel: string;
  language: string;
  contextInjection: boolean;
  processingPolicy: DictationProcessingPolicy;
  fallbackProvider?: DictationProviderId;
  fallbackApiKeyEnv: string;
  /** @deprecated compatibility mirror; processingPolicy owns routing. */
  cloudFallback: boolean;
  latencyPreference: DictationLatencyPreference;
  /** Env-var reference for the selected cloud provider; never the key value. */
  apiKeyEnv: string;
}

export interface VoiceSettings {
  stt: VoiceSttSettings;
  tts: VoiceTtsSettings;
  dictation: VoiceDictationSettings;
}

export interface VoiceSettingsService {
  get(): VoiceSettings;
  put(next: unknown): VoiceSettings;
  resolveKey(section: "stt" | "tts" | "dictation"): string | undefined;
  resolveDictationProviderKey(provider: DictationProviderId): string | undefined;
}

const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const DICTATION_PROVIDERS = new Set<DictationProviderId>([
  "elevenlabs", "wispr", "openai-live", "openai-transcribe", "deepgram",
  "speechmatics", "openai-compatible", "local-nemotron", "local-parakeet", "web-speech",
]);
const DICTATION_TRANSPORTS = new Set<DictationTransport>(["auto", "direct-browser", "server-proxy", "local-worker"]);
const LATENCY = new Set<DictationLatencyPreference>(["lowest", "balanced", "quality"]);
const PROCESSING_POLICIES = new Set<DictationProcessingPolicy>([
  "local-only", "prefer-local", "prefer-cloud", "auto-fallback", "browser-fallback",
]);

const defaults = (): VoiceSettings => ({
  stt: { baseUrl: "", model: "", language: "", apiKeyEnv: "" },
  tts: { baseUrl: "", model: "", voice: "", apiKeyEnv: "" },
  dictation: {
    provider: "elevenlabs",
    transport: "auto",
    model: "scribe_v2_realtime",
    localModel: DEFAULT_LOCAL_MODEL_ID,
    language: "auto",
    contextInjection: true,
    processingPolicy: "prefer-cloud",
    fallbackApiKeyEnv: "",
    cloudFallback: false,
    latencyPreference: "lowest",
    apiKeyEnv: "ELEVENLABS_API_KEY",
  },
});

const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const bool = (v: unknown, fallback: boolean): boolean => typeof v === "boolean" ? v : fallback;

const checkUrl = (url: string, label: string): void => {
  if (!url) return;
  let u: URL;
  try { u = new URL(url); } catch { throw err("invalid-input", `${label} URL is invalid`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw err("invalid-input", `${label} URL must be http(s)`);
};

// Env refs are names, not values — refuse anything that looks like a secret
// pasted by mistake (long, or containing non-identifier characters).
const checkEnvRef = (ref: string, label: string): void => {
  if (!ref) return;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(ref)) {
    throw err("invalid-input", `${label} API key must be an environment variable NAME (the value is read from the server environment)`);
  }
};

const providerDefaultEnv = (provider: DictationProviderId): string => {
  switch (provider) {
    case "elevenlabs": return "ELEVENLABS_API_KEY";
    case "deepgram": return "DEEPGRAM_API_KEY";
    case "speechmatics": return "SPEECHMATICS_API_KEY";
    case "wispr": return "WISPR_API_KEY";
    case "openai-live":
    case "openai-transcribe":
    case "openai-compatible": return "OPENAI_API_KEY";
    default: return "";
  }
};

const derivedPolicy = (provider: DictationProviderId, legacyCloudFallback: boolean): DictationProcessingPolicy => {
  if (provider === "web-speech") return "browser-fallback";
  if (provider === "local-nemotron" || provider === "local-parakeet") {
    return legacyCloudFallback ? "prefer-local" : "local-only";
  }
  return "prefer-cloud";
};

export function createVoiceSettings(opts: { file: string; env?: Record<string, string | undefined> }): VoiceSettingsService {
  mkdirSync(dirname(opts.file), { recursive: true });
  const env = opts.env ?? process.env;

  const sanitize = (raw: unknown): VoiceSettings => {
    const d = defaults();
    const r = (raw ?? {}) as {
      stt?: Record<string, unknown>;
      tts?: Record<string, unknown>;
      dictation?: Record<string, unknown>;
    };
    const legacyStt: VoiceSttSettings = {
      baseUrl: str(r.stt?.baseUrl, 1024) || d.stt.baseUrl,
      model: str(r.stt?.model),
      language: str(r.stt?.language, 32),
      apiKeyEnv: str(r.stt?.apiKeyEnv, 128),
    };
    const hasDictation = !!r.dictation && typeof r.dictation === "object";
    const requestedProvider = str(r.dictation?.provider, 64) as DictationProviderId;
    const provider: DictationProviderId = DICTATION_PROVIDERS.has(requestedProvider)
      ? requestedProvider
      : !hasDictation && legacyStt.baseUrl
        ? "openai-compatible"
        : d.dictation.provider;
    const requestedTransport = str(r.dictation?.transport, 32) as DictationTransport;
    const transport: DictationTransport = DICTATION_TRANSPORTS.has(requestedTransport)
      ? requestedTransport
      : provider === "openai-compatible" ? "server-proxy"
        : provider === "web-speech" ? "direct-browser"
          : provider.startsWith("local-") ? "local-worker"
            : d.dictation.transport;
    const requestedLatency = str(r.dictation?.latencyPreference, 32) as DictationLatencyPreference;
    const model = str(r.dictation?.model) || (!hasDictation && legacyStt.model ? legacyStt.model : provider === "elevenlabs" ? "scribe_v2_realtime" : "");
    const language = str(r.dictation?.language, 32) || (!hasDictation && legacyStt.language ? legacyStt.language : d.dictation.language);
    const explicitEnv = str(r.dictation?.apiKeyEnv, 128);
    const apiKeyEnv = explicitEnv || (!hasDictation && legacyStt.apiKeyEnv ? legacyStt.apiKeyEnv : providerDefaultEnv(provider));

    const legacyCloudFallback = bool(r.dictation?.cloudFallback, false);
    const requestedPolicy = str(r.dictation?.processingPolicy, 32) as DictationProcessingPolicy;
    const processingPolicy = PROCESSING_POLICIES.has(requestedPolicy)
      ? requestedPolicy
      : derivedPolicy(provider, legacyCloudFallback);
    const requestedFallback = str(r.dictation?.fallbackProvider, 64) as DictationProviderId;
    let fallbackProvider = DICTATION_PROVIDERS.has(requestedFallback)
      && isCloudDictationProvider(requestedFallback)
      && requestedFallback !== provider
        ? requestedFallback
        : undefined;
    if (!fallbackProvider && legacyCloudFallback && (provider === "local-nemotron" || provider === "local-parakeet")) {
      fallbackProvider = "elevenlabs";
    }
    const fallbackApiKeyEnv = fallbackProvider
      ? str(r.dictation?.fallbackApiKeyEnv, 128) || providerDefaultEnv(fallbackProvider)
      : "";
    const cloudFallback = Boolean(fallbackProvider)
      && (processingPolicy === "prefer-local" || processingPolicy === "auto-fallback");

    const out: VoiceSettings = {
      stt: legacyStt,
      tts: {
        baseUrl: str(r.tts?.baseUrl, 1024) || d.tts.baseUrl,
        model: str(r.tts?.model),
        voice: str(r.tts?.voice),
        apiKeyEnv: str(r.tts?.apiKeyEnv, 128),
      },
      dictation: {
        provider,
        transport,
        model,
        localModel: str(r.dictation?.localModel) || d.dictation.localModel,
        language,
        contextInjection: bool(r.dictation?.contextInjection, d.dictation.contextInjection),
        processingPolicy,
        ...(fallbackProvider ? { fallbackProvider } : {}),
        fallbackApiKeyEnv,
        cloudFallback,
        latencyPreference: LATENCY.has(requestedLatency) ? requestedLatency : d.dictation.latencyPreference,
        apiKeyEnv,
      },
    };
    checkUrl(out.stt.baseUrl, "speech-to-text");
    checkUrl(out.tts.baseUrl, "text-to-speech");
    checkEnvRef(out.stt.apiKeyEnv, "speech-to-text");
    checkEnvRef(out.tts.apiKeyEnv, "text-to-speech");
    checkEnvRef(out.dictation.apiKeyEnv, "dictation");
    checkEnvRef(out.dictation.fallbackApiKeyEnv, "dictation fallback");
    return out;
  };

  let settings: VoiceSettings;
  try {
    settings = sanitize(JSON.parse(readFileSync(opts.file, "utf8")));
  } catch {
    settings = defaults();
  }

  return {
    get: () => structuredClone(settings),
    put(next) {
      const incoming = next && typeof next === "object" ? next as Record<string, unknown> : {};
      // Older web clients only PUT {stt, tts}. Preserve the already-migrated
      // provider block instead of interpreting every legacy save as a fresh
      // migration and silently resetting the selected realtime provider.
      settings = sanitize({
        ...incoming,
        dictation: incoming.dictation ?? settings.dictation,
      });
      atomicWriteSync(opts.file, JSON.stringify(settings, null, 2));
      return structuredClone(settings);
    },
    resolveKey(section) {
      const ref = settings[section].apiKeyEnv;
      const value = ref ? env[ref] : undefined;
      return value || undefined;
    },
    resolveDictationProviderKey(provider) {
      const ref = provider === settings.dictation.provider
        ? settings.dictation.apiKeyEnv
        : provider === settings.dictation.fallbackProvider
          ? settings.dictation.fallbackApiKeyEnv
          : "";
      const value = ref ? env[ref] : undefined;
      return value || undefined;
    },
  };
}