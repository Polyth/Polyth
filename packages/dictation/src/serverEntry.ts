import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RouteHandler } from "@polyth/contracts";
import {
  adoptLegacyPackageData,
  localOnlyRemoteAccess,
  packageDataDir,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import {
  DEFAULT_LOCAL_MODEL_ID,
  ProviderRegistry,
  createDictationService,
  createWhisperSttAdapter,
  providerCapabilities,
  providerCatalog,
  providerToSttAdapter,
  selectDictationAdapter,
  type DictationContext,
  type DictationLatencyPreference,
  type DictationProcessingPolicy,
  type DictationProviderId,
  type DictationService,
  type DictationTransport,
  type SttAdapter,
} from "./index.ts";
import { createDeepgramSttAdapter } from "./deepgram.ts";
import { createElevenLabsSttAdapter } from "./elevenlabs.ts";
import { createWisprSttAdapter } from "./wispr.ts";
import { createOpenAIRealtimeSttAdapter } from "./openaiRealtime.ts";
import { createSpeechmaticsSttAdapter } from "./speechmatics.ts";
import { createLocalModelManager, localModelCatalog } from "./localModels.ts";
import { localModelRoutes } from "./localModelRoutes.ts";
import { createLocalNemotronSttAdapter } from "./localNemotron.ts";
import { createLocalRuntimeManager, SHERPA_RUNTIME_VERSION } from "./localRuntime.ts";
import { localRuntimeRoutes } from "./localRuntimeRoutes.ts";
import { localVoiceCatalog, type LocalVoiceDescriptor } from "./localVoiceCatalog.ts";
import { createLocalTts } from "./localTts.ts";
import { localVoiceRoutes } from "./localVoiceRoutes.ts";
import { ttsProviderInfo, type TtsProviderId } from "./ttsCatalog.ts";
import { synthesizeSpeech } from "./ttsProviders.ts";

interface VoiceEngineSettings {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
}

interface VoiceDictationSettings {
  provider: DictationProviderId;
  transport: DictationTransport;
  model: string;
  localModel: string;
  language: string;
  contextInjection: boolean;
  processingPolicy: DictationProcessingPolicy;
  fallbackProvider?: DictationProviderId;
  fallbackApiKeyEnv: string;
  cloudFallback: boolean;
  latencyPreference: DictationLatencyPreference;
  apiKeyEnv: string;
}

interface VoiceSettings {
  stt: VoiceEngineSettings & { language: string };
  tts: VoiceEngineSettings & { provider?: TtsProviderId; voice: string; secretKeyEnv?: string; region?: string };
  dictation: VoiceDictationSettings;
}

interface VoiceSettingsService {
  get(): VoiceSettings;
  put(next: unknown): VoiceSettings;
  /** Slots holding a key typed in Settings → Voice; names only. */
  storedKeys?(): string[];
  resolveKey(section: "stt" | "tts" | "dictation"): string | undefined;
  resolveTtsSecret?(): string | undefined;
  resolveDictationProviderKey(provider: DictationProviderId): string | undefined;
}

const DICTATION_STATUS: Record<string, number> = {
  "not-found": 404,
  "invalid-input": 400,
  audio_format_error: 400,
  protocol_error: 400,
  unavailable: 503,
  provider_unavailable: 503,
  invalid_credentials: 401,
  rate_limited: 429,
  network_error: 502,
  local_model_missing: 404,
  local_model_downloading: 409,
  local_model_failed: 500,
  worker_crashed: 503,
  session_expired: 409,
  unsupported_language: 400,
  limit: 429,
  backpressure_overflow: 429,
  conflict: 409,
  gap: 409,
  "out-of-order": 409,
  "too-long": 413,
};

const createSession = async (
  dictation: DictationService,
  body: () => Promise<Record<string, unknown>>,
) => {
  const input = await body();
  const rawContext = input.context;
  const context = rawContext && typeof rawContext === "object" && !Array.isArray(rawContext)
    ? rawContext as Partial<DictationContext>
    : undefined;
  return dictation.create({
    ...(input.sessionId ? { sessionId: String(input.sessionId) } : {}),
    ...(input.language ? { language: String(input.language) } : {}),
    ...(context ? { context } : {}),
  });
};

/** The server's recognition routing choice. Paired devices cannot read
 *  `/api/settings/voice` (it names endpoints and key variables), so the
 *  capability carries just this — clients must not guess it from local prefs. */
export interface DictationSelection {
  provider: DictationProviderId;
  transport: DictationTransport;
  model: string;
  language: string;
  contextInjection: boolean;
  processingPolicy: DictationProcessingPolicy;
}

export function dictationRoutes(dictation: DictationService, selection?: () => DictationSelection): RouteHandler {
  return async ({ path, method, body, json }) => {
    try {
      if (path === "/api/dictation/capability" && method === "GET") {
        json(200, { ...dictation.capability(), ...(selection ? { selection: selection() } : {}) });
        return true;
      }
      if ((path === "/api/dictation/sessions" || path === "/api/dictation") && method === "POST") {
        json(200, await createSession(dictation, body));
        return true;
      }

      let match = path.match(/^\/api\/dictation\/sessions\/([^/]+)$/);
      if (match && method === "GET") {
        const session = dictation.get(match[1]!);
        json(session ? 200 : 404, session ?? { error: "not-found" });
        return true;
      }
      if (match && method === "DELETE") {
        dictation.cancel(match[1]!);
        json(200, { ok: true });
        return true;
      }

      match = path.match(/^\/api\/dictation\/sessions\/([^/]+)\/finalize$/);
      if (match && method === "POST") {
        json(200, await dictation.finalize(match[1]!));
        return true;
      }

      match = path.match(/^\/api\/dictation\/([^/]+)$/);
      if (match && match[1] !== "capability" && method === "GET") {
        const session = dictation.get(match[1]!);
        json(session ? 200 : 404, session ?? { error: "not-found" });
        return true;
      }
      if (match && method === "DELETE") {
        dictation.cancel(match[1]!);
        json(200, { ok: true });
        return true;
      }
      match = path.match(/^\/api\/dictation\/([^/]+)\/finalize$/);
      if (match && method === "POST") {
        json(200, await dictation.finalize(match[1]!));
        return true;
      }
      return false;
    } catch (error) {
      const failure = error as Error & { code?: string; retryAfterMs?: number };
      json(DICTATION_STATUS[failure.code ?? ""] ?? 500, {
        error: failure.code ?? "internal",
        message: failure.message,
        ...(typeof failure.retryAfterMs === "number" ? { retryAfterMs: failure.retryAfterMs } : {}),
      });
      return true;
    }
  };
}

/** Whether the server voice can be attempted: a server URL for an
 *  OpenAI-compatible server, the resolved key (pair) for a hosted service. */
const ttsConfigured = (voice: VoiceSettingsService): boolean => {
  const tts = voice.get().tts;
  const info = ttsProviderInfo(tts.provider ?? "openai-compatible");
  if (info.needsBaseUrl) return !!tts.baseUrl;
  return !!voice.resolveKey("tts") && (!info.needsSecret || !!voice.resolveTtsSecret?.());
};

/** Settings plus what is usable. Typed keys are reported by slot name only. */
const settingsView = (voice: VoiceSettingsService, settings: VoiceSettings) => ({
  ...settings,
  sttConfigured: !!settings.stt.baseUrl,
  ttsConfigured: ttsConfigured(voice),
  dictationKeyConfigured: !!voice.resolveDictationProviderKey(settings.dictation.provider),
  fallbackKeyConfigured: settings.dictation.fallbackProvider
    ? !!voice.resolveDictationProviderKey(settings.dictation.fallbackProvider)
    : false,
  storedKeys: voice.storedKeys?.() ?? [],
});

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

const providerAvailability = (
  voice: VoiceSettingsService,
  providers: ProviderRegistry,
  localModelInstalled?: (id: string) => boolean,
  localRuntimeInstalled?: () => boolean,
) => {
  const settings = voice.get();
  const selected = settings.dictation.provider;
  const fallback = settings.dictation.fallbackProvider;
  return providerCatalog().map((provider) => {
    const extension = providers.get(provider.id);
    const extensionAvailability = extension?.available();
    if (extension && extensionAvailability?.available) {
      return { ...provider, available: true, extension: true };
    }

    let available = false;
    let reason: string | undefined;
    const participating = provider.id === selected || provider.id === fallback;
    if (["elevenlabs", "wispr", "deepgram", "openai-live", "openai-transcribe", "speechmatics"].includes(provider.id)) {
      available = !!voice.resolveDictationProviderKey(provider.id);
      if (!available) reason = participating
        ? `missing ${provider.id === fallback ? settings.dictation.fallbackApiKeyEnv : settings.dictation.apiKeyEnv || providerDefaultEnv(provider.id)}`
        : "not configured for this route";
    } else if (provider.id === "openai-compatible") {
      available = !!settings.stt.baseUrl;
      if (!available) reason = participating ? "OpenAI-compatible STT base URL is missing" : "not configured for this route";
    } else if (provider.id === "local-nemotron") {
      const model = settings.dictation.localModel || DEFAULT_LOCAL_MODEL_ID;
      const modelReady = !!localModelInstalled?.(model);
      const runtimeReady = !!localRuntimeInstalled?.();
      available = modelReady && runtimeReady;
      if (!runtimeReady) reason = "local sherpa runtime is not downloaded";
      else if (!modelReady) reason = "local model is not downloaded";
    } else if (provider.id === "web-speech") {
      available = provider.id === selected || settings.dictation.processingPolicy === "browser-fallback";
    } else if (extension && extensionAvailability && !extensionAvailability.available) {
      reason = extensionAvailability.reason ?? "registered provider is unavailable";
    } else {
      reason = provider.publicApi ? "provider adapter not enabled yet" : "private provider adapter is not registered";
    }
    return { ...provider, available, ...(reason ? { reason } : {}) };
  });
};

const tokenFailure = (status: number): { status: number; code: string } => status === 429
  ? { status: 429, code: "rate_limited" }
  : status === 401 || status === 403
    ? { status: 401, code: "invalid_credentials" }
    : { status: 502, code: "provider_unavailable" };

export function voiceRoutes(deps: {
  voice: VoiceSettingsService;
  providers: ProviderRegistry;
  fetchFn?: typeof fetch;
  summarize?: (text: string, userId?: string) => Promise<string>;
  localModelInstalled?: (id: string) => boolean;
  localRuntimeInstalled?: () => boolean;
}): RouteHandler {
  const fetchFn = deps.fetchFn ?? fetch;
  return async (request) => {
    const { path, method, json } = request;
    if (path === "/api/settings/voice" && method === "GET") {
      json(200, settingsView(deps.voice, deps.voice.get()));
      return true;
    }
    if (path === "/api/settings/voice" && method === "PUT") {
      json(200, settingsView(deps.voice, deps.voice.put(await request.body())));
      return true;
    }
    if (path === "/api/voice/providers" && method === "GET") {
      json(200, { providers: providerAvailability(deps.voice, deps.providers, deps.localModelInstalled, deps.localRuntimeInstalled) });
      return true;
    }
    if (path === "/api/dictation/token" && method === "POST") {
      const settings = deps.voice.get().dictation;
      const input = await request.body();
      const provider = String(input.provider ?? settings.provider) as DictationProviderId;
      const directCloudAllowed = settings.processingPolicy === "prefer-cloud"
        || settings.processingPolicy === "browser-fallback";
      const directProvider = provider === "elevenlabs" || provider === "wispr" || provider === "deepgram";
      if (!directProvider || settings.provider !== provider || !directCloudAllowed) {
        json(400, {
          error: "provider_unavailable",
          message: "Direct dictation tokens require the requested provider to be the selected cloud provider and a direct-compatible cloud-processing policy",
        });
        return true;
      }
      const key = deps.voice.resolveDictationProviderKey(provider);
      if (!key) {
        json(401, { error: "invalid_credentials", message: `missing ${settings.apiKeyEnv || providerDefaultEnv(provider)}` });
        return true;
      }
      try {
        if (provider === "elevenlabs") {
          const response = await fetchFn("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", {
            method: "POST",
            headers: { "xi-api-key": key },
          });
          if (!response.ok) {
            const failure = tokenFailure(response.status);
            json(failure.status, { error: failure.code, message: `ElevenLabs token request failed: HTTP ${response.status}` });
            return true;
          }
          const payload = await response.json() as { token?: unknown };
          if (typeof payload.token !== "string" || !payload.token) {
            json(502, { error: "protocol_error", message: "ElevenLabs token response did not include a token" });
            return true;
          }
          json(200, { provider: "elevenlabs", token: payload.token, expiresInSeconds: 900 });
          return true;
        }

        if (provider === "deepgram") {
          const response = await fetchFn("https://api.deepgram.com/v1/auth/grant", {
            method: "POST",
            headers: {
              authorization: `Token ${key}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ ttl_seconds: 60 }),
          });
          if (!response.ok) {
            const failure = tokenFailure(response.status);
            json(failure.status, { error: failure.code, message: `Deepgram token request failed: HTTP ${response.status}` });
            return true;
          }
          const payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
          if (typeof payload.access_token !== "string" || !payload.access_token) {
            json(502, { error: "protocol_error", message: "Deepgram token response did not include an access token" });
            return true;
          }
          json(200, {
            provider: "deepgram",
            token: payload.access_token,
            expiresInSeconds: typeof payload.expires_in === "number" ? payload.expires_in : 60,
          });
          return true;
        }

        const clientId = String(input.clientId ?? "").trim().slice(0, 128);
        if (!clientId || !/^[A-Za-z0-9._:-]+$/.test(clientId)) {
          json(400, { error: "invalid-input", message: "Wispr clientId is required and must be an opaque identifier" });
          return true;
        }
        void fetchFn("https://platform-api.wisprflow.ai/api/v1/dash/warmup_dash", {
          headers: { authorization: `Bearer ${key}` },
        }).catch(() => {});
        const response = await fetchFn("https://platform-api.wisprflow.ai/api/v1/dash/generate_access_token", {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ client_id: clientId, duration_secs: 900 }),
        });
        if (!response.ok) {
          const failure = tokenFailure(response.status);
          json(failure.status, { error: failure.code, message: `Wispr Flow token request failed: HTTP ${response.status}` });
          return true;
        }
        const payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
        if (typeof payload.access_token !== "string" || !payload.access_token) {
          json(502, { error: "protocol_error", message: "Wispr Flow token response did not include an access token" });
          return true;
        }
        json(200, {
          provider: "wispr",
          token: payload.access_token,
          expiresInSeconds: typeof payload.expires_in === "number" ? payload.expires_in : 900,
        });
      } catch (error) {
        json(502, {
          error: "network_error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }
    if (path === "/api/tts/speak" && method === "POST") {
      const input = await request.body();
      const text = String(input.text ?? "").trim();
      if (!text) {
        json(400, { error: "invalid-input", message: "text is required" });
        return true;
      }
      const settings = deps.voice.get().tts;
      const provider = settings.provider ?? "openai-compatible";
      const info = ttsProviderInfo(provider);
      if (!ttsConfigured(deps.voice)) {
        json(503, {
          error: "unavailable",
          message: info.needsBaseUrl
            ? "no text-to-speech server configured (Settings → Voice)"
            : `${info.label} key is not set in the server environment (Settings → Voice)`,
        });
        return true;
      }
      const voiceOverride = String(input.voice ?? "");
      if (voiceOverride && !info.needsBaseUrl && !/^[A-Za-z0-9._-]{1,200}$/.test(voiceOverride)) {
        json(400, { error: "invalid-input", message: "voice must be a plain voice name or id" });
        return true;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const clip = await synthesizeSpeech({
          settings: {
            provider,
            baseUrl: settings.baseUrl,
            model: String(input.model ?? "").slice(0, 200) || settings.model,
            voice: voiceOverride || settings.voice,
            region: settings.region ?? "",
          },
          text,
          ...(input.lang ? { lang: String(input.lang).slice(0, 35) } : {}),
          ...(deps.voice.resolveKey("tts") ? { key: deps.voice.resolveKey("tts")! } : {}),
          ...(deps.voice.resolveTtsSecret?.() ? { secret: deps.voice.resolveTtsSecret()! } : {}),
          fetchFn,
          signal: controller.signal,
        });
        request.res.writeHead(200, {
          "content-type": clip.contentType,
          "content-length": clip.audio.byteLength,
          "cache-control": "no-store",
        });
        request.res.end(clip.audio);
        return true;
      } catch (error) {
        json(502, {
          error: "upstream",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        clearTimeout(timer);
      }
      return true;
    }
    if (path === "/api/tts/summarize" && method === "POST") {
      if (!deps.summarize) {
        json(503, {
          error: "unavailable",
          message: "no small model configured for summarize-speak",
        });
        return true;
      }
      const input = await request.body();
      const text = String(input.text ?? "").trim();
      if (!text) {
        json(400, { error: "invalid-input", message: "text is required" });
        return true;
      }
      try {
        json(200, { text: (await deps.summarize(text, request.space.userId)).trim() });
      } catch (error) {
        json(502, {
          error: "upstream",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }
    return false;
  };
}

export const DICTATION_REMOTE_ACCESS = {
  // The paired-device surface intentionally exposes only the rules below,
  // but every exposed rule still has to belong to a declared route scope.
  // Voice provider availability lives under /api/voice while the streaming
  // session/token lifecycle lives under /api/dictation.
  ...localOnlyRemoteAccess(["dictation", "voice", "tts"]),
  http: [
    { methods: ["GET"] as const, path: "/api/dictation/capability", capability: "dictation.use", mutation: false },
    { methods: ["POST"] as const, path: "/api/dictation/sessions", capability: "dictation.use", mutation: true, maxBodyBytes: 16 * 1024 },
    { methods: ["GET"] as const, path: "/api/dictation/sessions/:id", capability: "dictation.use", mutation: false },
    { methods: ["DELETE"] as const, path: "/api/dictation/sessions/:id", capability: "dictation.use", mutation: true },
    { methods: ["POST"] as const, path: "/api/dictation/sessions/:id/finalize", capability: "dictation.use", mutation: true, maxBodyBytes: 256 },
    { methods: ["GET"] as const, path: "/api/voice/providers", capability: "dictation.use", mutation: false },
    { methods: ["POST"] as const, path: "/api/dictation/token", capability: "dictation.use", mutation: true, maxBodyBytes: 512 },
    // Built-in voices run on this server at no cost, so a paired phone may
    // pick one and hear it. Installing/removing voices and the paid custom
    // server voice (`/api/tts/speak`) stay on the server's own screen.
    { methods: ["GET"] as const, path: "/api/tts/voices", capability: "dictation.use", mutation: false },
    { methods: ["POST"] as const, path: "/api/tts/local", capability: "dictation.use", mutation: true, maxBodyBytes: 16 * 1024 },
  ],
};

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const voice = host.services.require(
    serverServiceKey<VoiceSettingsService>("voice.settings"),
  );
  const providers = new ProviderRegistry();
  host.services.provide(serverServiceKey<ProviderRegistry>("dictation.providers"), providers);

  const dataDir = packageDataDir(host);
  // Before the package owned a directory it wrote `<dataDir>/models`,
  // `<dataDir>/runtime` and `<dataDir>/voices` — generic names other owners
  // may also use. Adopt only entries this package created: the sherpa runtime
  // dirs and the ids from its own model/voice catalogs.
  const legacyEntries = (name: string): string[] => {
    try {
      return readdirSync(join(host.storageDir, name));
    } catch {
      return [];
    }
  };
  const modelIds = new Set(localModelCatalog().map((model) => model.id));
  const voiceIds = new Set(localVoiceCatalog().map((voice) => voice.id));
  adoptLegacyPackageData(host, [
    ...legacyEntries("runtime")
      .filter((name) => name.startsWith("sherpa-onnx-node-"))
      .map((name) => `runtime/${name}`),
    ...legacyEntries("models")
      .filter((name) => modelIds.has(name))
      .map((name) => `models/${name}`),
    ...legacyEntries("voices")
      .filter((name) => voiceIds.has(name))
      .map((name) => `voices/${name}`),
  ]);
  const modelsRoot = join(dataDir, "models");
  const runtimeRoot = join(dataDir, "runtime");
  const localModels = createLocalModelManager({ root: modelsRoot });
  const localVoices = createLocalModelManager<LocalVoiceDescriptor>({ root: join(dataDir, "voices"), catalog: localVoiceCatalog });
  const localRuntime = createLocalRuntimeManager({ root: runtimeRoot });
  const runtimePath = () => join(runtimeRoot, `sherpa-onnx-node-${SHERPA_RUNTIME_VERSION}`);
  let localAdapter: SttAdapter | null = null;
  let localAdapterKey = "";

  const installedLocalModel = (id: string): string | null => {
    const path = join(modelsRoot, id);
    return existsSync(path) ? path : null;
  };
  const installedLocalRuntime = (): string | null => {
    const path = runtimePath();
    return existsSync(path) ? path : null;
  };

  const localNemotronAdapter = (id: string): SttAdapter | null => {
    const modelDir = installedLocalModel(id);
    const runtimeDir = installedLocalRuntime();
    if (!modelDir || !runtimeDir) return null;
    const key = `${runtimeDir}\0${modelDir}`;
    if (!localAdapter || localAdapterKey !== key) {
      (localAdapter as (SttAdapter & { dispose?(): void }) | null)?.dispose?.();
      localAdapter = createLocalNemotronSttAdapter({ modelDir, runtimeDir });
      localAdapterKey = key;
    }
    return localAdapter;
  };

  const registeredAdapter = (id: DictationProviderId): SttAdapter | null => {
    const provider = providers.get(id);
    if (!provider) return null;
    const availability = provider.available();
    return availability.available ? providerToSttAdapter(provider) : null;
  };

  const adapterFor = (
    id: DictationProviderId,
    settings: VoiceSettings,
    primary: boolean,
  ): SttAdapter | null => {
    const extension = registeredAdapter(id);
    if (extension) return extension;

    if (id === "local-nemotron") {
      return localNemotronAdapter(settings.dictation.localModel || DEFAULT_LOCAL_MODEL_ID);
    }
    if (id === "local-parakeet" || id === "web-speech") return null;

    const apiKey = voice.resolveDictationProviderKey(id);
    const model = primary && settings.dictation.provider === id && settings.dictation.model
      ? settings.dictation.model
      : providerCapabilities(id)?.defaultModel ?? "";

    if (id === "elevenlabs") {
      return apiKey ? createElevenLabsSttAdapter({ apiKey, model: model || "scribe_v2_realtime" }) : null;
    }
    if (id === "wispr") {
      return apiKey ? createWisprSttAdapter({ apiKey }) : null;
    }
    if (id === "deepgram") {
      return apiKey ? createDeepgramSttAdapter({ apiKey, model: model || "nova-3" }) : null;
    }
    if (id === "openai-live" || id === "openai-transcribe") {
      return apiKey ? createOpenAIRealtimeSttAdapter({
        apiKey,
        model: model || (id === "openai-live" ? "gpt-live-transcribe" : "gpt-transcribe"),
        latencyPreference: settings.dictation.latencyPreference,
      }) : null;
    }
    if (id === "speechmatics") {
      return apiKey ? createSpeechmaticsSttAdapter({
        apiKey,
        model: model || "enhanced",
        latencyPreference: settings.dictation.latencyPreference,
      }) : null;
    }
    if (id === "openai-compatible") {
      const stt = settings.stt;
      if (!stt.baseUrl) return null;
      return createWhisperSttAdapter({
        baseUrl: stt.baseUrl,
        model: model || stt.model || "whisper-1",
        ...(settings.dictation.language && settings.dictation.language !== "auto"
          ? { language: settings.dictation.language }
          : stt.language ? { language: stt.language } : {}),
        ...(apiKey ?? voice.resolveKey("stt") ? { apiKey: apiKey ?? voice.resolveKey("stt") } : {}),
      });
    }
    return null;
  };

  const dictation = createDictationService({
    adapter: () => {
      const settings = voice.get();
      const selected = settings.dictation;

      if (selected.transport === "direct-browser") return null;
      if (selected.transport === "local-worker" && selected.provider !== "local-nemotron") return null;

      const local = localNemotronAdapter(selected.localModel || DEFAULT_LOCAL_MODEL_ID);
      const primary = adapterFor(selected.provider, settings, true);
      const explicitFallback = selected.fallbackProvider
        ? adapterFor(selected.fallbackProvider, settings, false)
        : null;
      return selectDictationAdapter({
        policy: selected.processingPolicy,
        selectedProvider: selected.provider,
        selected: primary,
        local,
        explicitFallback,
      });
    },
    contextFilter: (context) => {
      const settings = voice.get().dictation;
      if (settings.contextInjection) return context;
      return {
        language: context.language,
        ...(context.localeHints?.length ? { localeHints: context.localeHints } : {}),
      };
    },
    unavailableReason: "selected dictation processing route is unavailable or missing its configured model/runtime/credentials",
  });
  host.services.provide(serverServiceKey<DictationService>("dictation"), dictation);

  let routes: RouteHandler | null = null;
  let localTts: ReturnType<typeof createLocalTts> | null = null;
  return {
    remoteAccess: DICTATION_REMOTE_ACCESS,
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      const dictationRoute = dictationRoutes(dictation, () => {
        const { provider, transport, model, language, contextInjection, processingPolicy } = voice.get().dictation;
        return { provider, transport, model, language, contextInjection, processingPolicy };
      });
      const modelRoute = localModelRoutes(localModels, localRuntime);
      const runtimeRoute = localRuntimeRoutes(localRuntime);
      const voiceRoute = voiceRoutes({
        voice,
        providers,
        localModelInstalled: (id) => !!installedLocalModel(id),
        localRuntimeInstalled: () => !!installedLocalRuntime(),
        summarize: async (text, userId) => {
          const model = host.smallModel(userId);
          const runtime = await host.runtimes.forProject("__default__", undefined, model?.harnessId);
          return host.oneShot(runtime, {
            cwd: process.cwd(),
            ...(model ? { model } : {}),
            prompt: [
              "Summarize the following assistant reply for text-to-speech playback.",
              "Keep it under 3 sentences, plain prose, no markdown, no preamble.",
              "", "<reply>", text.slice(0, 24_000), "</reply>",
            ].join("\n"),
          });
        },
      });
      localTts ??= createLocalTts({ runtimeDir: installedLocalRuntime });
      const voicesRoute = localVoiceRoutes({ voices: localVoices, runtime: localRuntime, tts: localTts });
      routes ??= async (request) => {
        if (await voicesRoute(request)) return true;
        if (await runtimeRoute(request)) return true;
        if (await modelRoute(request)) return true;
        if (await dictationRoute(request)) return true;
        return voiceRoute(request);
      };
    },
    async onDisable() {
      dictation.closeAll();
      (localAdapter as (SttAdapter & { dispose?(): void }) | null)?.dispose?.();
      localAdapter = null;
      localAdapterKey = "";
      localTts?.dispose();
      localTts = null;
      routes = null;
      await Promise.allSettled([
        localVoices.cancelAll(),
        localModels.cancelAll(),
        localRuntime.cancel(),
      ]);
    },
  };
}
