// Server-owned voice engine settings. The settings file holds only REFERENCES
// to secrets (apiKeyEnv names an environment variable). Keys the user types in
// Settings → Voice live in a separate owner-only file and are write-only: this
// service resolves them at call time and only ever reports which are stored.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

type TtsProviderId = "openai-compatible" | "openai" | "elevenlabs" | "google" | "polly" | "gradium";
const TTS_PROVIDERS = new Set<TtsProviderId>(["openai-compatible", "openai", "elevenlabs", "google", "polly", "gradium"]);

export interface VoiceTtsSettings {
  /** Which service the server voice calls; legacy files are OpenAI-compatible. */
  provider: TtsProviderId;
  /** OpenAI-compatible server only; hosted services use their own endpoint. */
  baseUrl: string;
  model: string;
  voice: string;
  apiKeyEnv: string;
  /** Second env reference for services signing with a key pair (Amazon Polly). */
  secretKeyEnv: string;
  /** Service region (Amazon Polly). */
  region: string;
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

/** Where a typed key is used: `stt` (legacy OpenAI-compatible endpoint),
 *  `dictation:<provider>`, `tts:<provider>` or `tts-secret:<provider>`. Keyed by
 *  provider so switching engines never sends one service's key to another. */
export type VoiceKeySlot = string;

export interface VoiceSettingsService {
  get(): VoiceSettings;
  /** Saves settings. `keys` maps a slot to a new key, or to null/"" to forget it. */
  put(next: unknown): VoiceSettings;
  /** Slots holding a typed key — names only, never values. */
  storedKeys(): VoiceKeySlot[];
  resolveKey(section: "stt" | "tts" | "dictation"): string | undefined;
  resolveTtsSecret(): string | undefined;
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

const isKeySlot = (slot: string): boolean => {
  if (slot === "stt") return true;
  const [kind, provider = ""] = slot.split(":", 2) as [string, string?];
  if (kind === "dictation") return DICTATION_PROVIDERS.has(provider as DictationProviderId);
  if (kind === "tts" || kind === "tts-secret") return TTS_PROVIDERS.has(provider as TtsProviderId);
  return false;
};

const MAX_KEY_LENGTH = 4096;
const keyValue = (value: unknown): string => {
  const key = typeof value === "string" ? value.trim() : "";
  if (key.length > MAX_KEY_LENGTH || /[\s\u0000-\u001f\u007f]/.test(key)) {
    throw err("invalid-input", "API key must be a single line without spaces");
  }
  return key;
};

/** A key pasted into a "variable name" field: long, and either impossible as a
 *  variable name or mixed lower-case and digits like generated keys are. */
const looksLikePastedKey = (ref: string, env: Record<string, string | undefined>): boolean =>
  ref.length >= 20
  && env[ref] === undefined
  && (/[^A-Za-z0-9_]/.test(ref) || (/[a-z]/.test(ref) && /[0-9]/.test(ref)));

const defaults = (): VoiceSettings => ({
  stt: { baseUrl: "", model: "", language: "", apiKeyEnv: "" },
  tts: { provider: "openai-compatible", baseUrl: "", model: "", voice: "", apiKeyEnv: "", secretKeyEnv: "", region: "" },
  dictation: {
    provider: "elevenlabs",
    transport: "auto",
    model: "scribe_v2_realtime",
    localModel: DEFAULT_LOCAL_MODEL_ID,
    language: "auto",
    // Repository/chat/composer context can leave the machine when a cloud
    // provider is selected. New installations must opt in explicitly.
    contextInjection: false,
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

const providerTransports = (provider: DictationProviderId): readonly DictationTransport[] => {
  switch (provider) {
    case "elevenlabs":
    case "wispr":
    case "deepgram":
      return ["auto", "direct-browser", "server-proxy"];
    case "web-speech":
      return ["auto", "direct-browser"];
    case "local-nemotron":
      return ["auto", "local-worker"];
    case "local-parakeet":
      return ["auto"];
    default:
      return ["auto", "server-proxy"];
  }
};

const canonicalTransport = (
  provider: DictationProviderId,
  requested: DictationTransport,
  policy: DictationProcessingPolicy,
): DictationTransport => {
  const supported = providerTransports(provider);
  let value = supported.includes(requested) ? requested : "auto";
  // Mid-stream cloud -> local failover requires Polyth to retain/replay PCM on
  // the server. A direct browser socket cannot satisfy that invariant.
  if (policy === "auto-fallback" && value === "direct-browser") value = "auto";
  if (policy === "local-only" && provider === "web-speech") return "direct-browser";
  return value;
};

export function createVoiceSettings(opts: {
  file: string;
  /** Typed keys; defaults to `voice-secrets.json` beside the settings file. */
  secretsFile?: string;
  env?: Record<string, string | undefined>;
}): VoiceSettingsService {
  mkdirSync(dirname(opts.file), { recursive: true });
  const env = opts.env ?? process.env;
  const secretsFile = opts.secretsFile ?? join(dirname(opts.file), "voice-secrets.json");

  const shape = (raw: unknown): VoiceSettings => {
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
    const rawTransport: DictationTransport = DICTATION_TRANSPORTS.has(requestedTransport)
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
    const transport = canonicalTransport(provider, rawTransport, processingPolicy);
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
        provider: TTS_PROVIDERS.has(str(r.tts?.provider, 32) as TtsProviderId)
          ? str(r.tts?.provider, 32) as TtsProviderId
          : d.tts.provider,
        baseUrl: str(r.tts?.baseUrl, 1024) || d.tts.baseUrl,
        model: str(r.tts?.model),
        voice: str(r.tts?.voice),
        apiKeyEnv: str(r.tts?.apiKeyEnv, 128),
        secretKeyEnv: str(r.tts?.secretKeyEnv, 128),
        region: str(r.tts?.region, 32).toLowerCase(),
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
    return out;
  };

  const validate = (out: VoiceSettings): VoiceSettings => {
    checkUrl(out.stt.baseUrl, "speech-to-text");
    checkUrl(out.tts.baseUrl, "text-to-speech");
    checkEnvRef(out.stt.apiKeyEnv, "speech-to-text");
    checkEnvRef(out.tts.apiKeyEnv, "text-to-speech");
    checkEnvRef(out.tts.secretKeyEnv, "text-to-speech secret");
    if (out.tts.region && !/^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/.test(out.tts.region)) {
      throw err("invalid-input", "text-to-speech region is invalid");
    }
    // Hosted services path-embed the voice id; keep it to a plain name.
    if (out.tts.provider !== "openai-compatible" && out.tts.voice && !/^[A-Za-z0-9._-]+$/.test(out.tts.voice)) {
      throw err("invalid-input", "text-to-speech voice must be a plain voice name or id");
    }
    checkEnvRef(out.dictation.apiKeyEnv, "dictation");
    checkEnvRef(out.dictation.fallbackApiKeyEnv, "dictation fallback");
    return out;
  };

  /** Moves keys pasted into "variable name" fields into the key store, so they
   *  stop travelling in settings responses and start being used as keys. */
  const adoptPastedKeys = (out: VoiceSettings, into: Record<VoiceKeySlot, string>): boolean => {
    let moved = false;
    const adopt = (ref: string, slot: VoiceKeySlot): boolean => {
      if (!looksLikePastedKey(ref, env)) return false;
      into[slot] = ref;
      moved = true;
      return true;
    };
    if (adopt(out.stt.apiKeyEnv, "stt")) out.stt.apiKeyEnv = "";
    if (adopt(out.tts.apiKeyEnv, `tts:${out.tts.provider}`)) out.tts.apiKeyEnv = "";
    if (adopt(out.tts.secretKeyEnv, `tts-secret:${out.tts.provider}`)) out.tts.secretKeyEnv = "";
    if (adopt(out.dictation.apiKeyEnv, `dictation:${out.dictation.provider}`)) {
      out.dictation.apiKeyEnv = providerDefaultEnv(out.dictation.provider);
    }
    const fallback = out.dictation.fallbackProvider;
    if (fallback && adopt(out.dictation.fallbackApiKeyEnv, `dictation:${fallback}`)) {
      out.dictation.fallbackApiKeyEnv = providerDefaultEnv(fallback);
    }
    return moved;
  };

  const readKeys = (): Record<VoiceKeySlot, string> => {
    try {
      const raw = JSON.parse(readFileSync(secretsFile, "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      return Object.fromEntries(Object.entries(raw).filter(([slot, value]) =>
        isKeySlot(slot) && typeof value === "string" && value !== ""));
    } catch {
      return {};
    }
  };
  // Keys first: a crash between the two writes must never leave a key that
  // was moved out of the settings file stored nowhere.
  const persist = (nextKeys: Record<VoiceKeySlot, string> | null): void => {
    if (nextKeys) atomicWriteSync(secretsFile, `${JSON.stringify(nextKeys, null, 2)}\n`, 0o600);
    atomicWriteSync(opts.file, JSON.stringify(settings, null, 2));
  };

  let keys = readKeys();
  let settings: VoiceSettings;
  try {
    const loaded = shape(JSON.parse(readFileSync(opts.file, "utf8")));
    const nextKeys = { ...keys };
    const migrated = adoptPastedKeys(loaded, nextKeys);
    settings = validate(loaded);
    if (migrated) {
      keys = nextKeys;
      persist(keys);
    }
  } catch {
    settings = defaults();
  }

  const stored = (slot: VoiceKeySlot): string | undefined => keys[slot] || undefined;
  const fromEnv = (ref: string): string | undefined => (ref ? env[ref] : undefined) || undefined;

  return {
    get: () => structuredClone(settings),
    put(next) {
      const incoming = next && typeof next === "object" ? next as Record<string, unknown> : {};
      const shaped = shape({
        ...incoming,
        dictation: incoming.dictation ?? settings.dictation,
      });
      const nextKeys = { ...keys };
      let keysChanged = adoptPastedKeys(shaped, nextKeys);
      const typed = incoming.keys;
      if (typed && typeof typed === "object" && !Array.isArray(typed)) {
        for (const [slot, value] of Object.entries(typed as Record<string, unknown>)) {
          if (!isKeySlot(slot)) throw err("invalid-input", `unknown voice key slot: ${slot}`);
          const key = value === null ? "" : keyValue(value);
          if (key) nextKeys[slot] = key;
          else delete nextKeys[slot];
          keysChanged = true;
        }
      }
      const validated = validate(shaped);
      settings = validated;
      if (keysChanged) keys = nextKeys;
      persist(keysChanged ? keys : null);
      return structuredClone(settings);
    },
    storedKeys: () => Object.keys(keys).sort(),
    resolveKey(section) {
      const slot = section === "stt" ? "stt"
        : section === "tts" ? `tts:${settings.tts.provider}`
          : `dictation:${settings.dictation.provider}`;
      return stored(slot) ?? fromEnv(settings[section].apiKeyEnv);
    },
    resolveTtsSecret() {
      return stored(`tts-secret:${settings.tts.provider}`) ?? fromEnv(settings.tts.secretKeyEnv);
    },
    resolveDictationProviderKey(provider) {
      const ref = provider === settings.dictation.provider
        ? settings.dictation.apiKeyEnv
        : provider === settings.dictation.fallbackProvider
          ? settings.dictation.fallbackApiKeyEnv
          : null;
      if (ref === null) return undefined;
      return stored(`dictation:${provider}`) ?? fromEnv(ref);
    },
  };
}
