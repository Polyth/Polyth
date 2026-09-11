import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RouteHandler } from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
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
import { createLocalModelManager } from "./localModels.ts";
import { localModelRoutes } from "./localModelRoutes.ts";
import { createLocalNemotronSttAdapter } from "./localNemotron.ts";
import { createLocalRuntimeManager, SHERPA_RUNTIME_VERSION } from "./localRuntime.ts";
import { localRuntimeRoutes } from "./localRuntimeRoutes.ts";

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
  tts: VoiceEngineSettings & { voice: string };
  dictation: VoiceDictationSettings;
}

interface VoiceSettingsService {
  get(): VoiceSettings;
  put(next: unknown): VoiceSettings;
  resolveKey(section: "stt" | "tts" | "dictation"): string | undefined;
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

export function dictationRoutes(dictation: DictationService): RouteHandler {
  return async ({ path, method, body, json }) => {
    try {
      if (path === "/api/dictation/capability" && method === "GET") {
        json(200, dictation.capability());
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

const MAX_SPEAK_CHARS = 8_000;

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
      const settings = deps.voice.get();
      json(200, {
        ...settings,
        sttConfigured: !!settings.stt.baseUrl,
        ttsConfigured: !!settings.tts.baseUrl,
        dictationKeyConfigured: !!deps.voice.resolveDictationProviderKey(settings.dictation.provider),
        fallbackKeyConfigured: settings.dictation.fallbackProvider
          ? !!deps.voice.resolveDictationProviderKey(settings.dictation.fallbackProvider)
          : false,
      });
      return true;
    }
    if (path === "/api/settings/voice" && method === "PUT") {
      const settings = deps.voice.put(await request.body());
      json(200, {
        ...settings,
        sttConfigured: !!settings.stt.baseUrl,
        ttsConfigured: !!settings.tts.baseUrl,
        dictationKeyConfigured: !!deps.voice.resolveDictationProviderKey(settings.dictation.provider),
        fallbackKeyConfigured: settings.dictation.fallbackProvider
          ? !!deps.voice.resolveDictationProviderKey(settings.dictation.fallbackProvider)
          : false,
      });
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
      if (!settings.baseUrl) {
        json(503, {
          error: "unavailable",
          message: "no text-to-speech server configured (Settings → Voice)",
        });
        return true;
      }
      const key = deps.voice.resolveKey("tts");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetchFn(
          `${settings.baseUrl.replace(/\/+$/, "")}/audio/speech`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(key ? { authorization: `Bearer ${key}` } : {}),
            },
            body: JSON.stringify({
              model: String(input.model ?? "") || settings.model || "tts-1",
              input: text.slice(0, MAX_SPEAK_CHARS),
              voice: String(input.voice ?? "") || settings.voice || "alloy",
              response_format: "mp3",
            }),
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          json(502, {
            error: "upstream",
            message: `TTS server error: HTTP ${response.status}`,
          });
          return true;
        }
        const audio = Buffer.from(await response.arrayBuffer());
        request.res.writeHead(200, {
          "content-type": response.headers.get("content-type") ?? "audio/mpeg",
          "content-length": audio.byteLength,
          "cache-control": "no-store",
        });
        request.res.end(audio);
        return true;
      } catch (error) {
        json(502, {
          error: "upstream",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        clearTimeout(timer);
      }
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
  ...localOnlyRemoteAccess(["dictation", "voice"]),
  http: [
    { methods: ["GET"] as const, path: "/api/dictation/capability", capability: "dictation.use", mutation: false },
    { methods: ["POST"] as const, path: "/api/dictation/sessions", capability: "dictation.use", mutation: true, maxBodyBytes: 16 * 1024 },
    { methods: ["GET"] as const, path: "/api/dictation/sessions/:id", capability: "dictation.use", mutation: false },
    { methods: ["DELETE"] as const, path: "/api/dictation/sessions/:id", capability: "dictation.use", mutation: true },
    { methods: ["POST"] as const, path: "/api/dictation/sessions/:id/finalize", capability: "dictation.use", mutation: true, maxBodyBytes: 256 },
    { methods: ["GET"] as const, path: "/api/voice/providers", capability: "dictation.use", mutation: false },
    { methods: ["POST"] as const, path: "/api/dictation/token", capability: "dictation.use", mutation: true, maxBodyBytes: 512 },
  ],
};

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const voice = host.services.require(
    serverServiceKey<VoiceSettingsService>("voice.settings"),
  );
  const providers = new ProviderRegistry();
  host.services.provide(serverServiceKey<ProviderRegistry>("dictation.providers"), providers);

  const modelsRoot = join(host.storageDir, "models");
  const runtimeRoot = join(host.storageDir, "runtime");
  const localModels = createLocalModelManager({ root: modelsRoot });
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
  return {
    remoteAccess: DICTATION_REMOTE_ACCESS,
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      const dictationRoute = dictationRoutes(dictation);
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
      routes ??= async (request) => {
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
      await Promise.allSettled([
        localModels.cancelAll(),
        localRuntime.cancel(),
      ]);
    },
  };
}
