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
  createDictationService,
  createWhisperSttAdapter,
  providerCatalog,
  type DictationContext,
  type DictationProviderId,
  type DictationService,
  type DictationTransport,
  type DictationLatencyPreference,
  type SttAdapter,
} from "./index.ts";
import { createDeepgramSttAdapter } from "./deepgram.ts";
import { createElevenLabsSttAdapter } from "./elevenlabs.ts";
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

export function dictationRoutes(dictation: DictationService): RouteHandler {
  return async ({ path, method, body, json }) => {
    try {
      if (path === "/api/dictation/capability" && method === "GET") {
        json(200, dictation.capability());
        return true;
      }
      if (path === "/api/dictation" && method === "POST") {
        const input = await body();
        const rawContext = input.context;
        const context = rawContext && typeof rawContext === "object" && !Array.isArray(rawContext)
          ? rawContext as Partial<DictationContext>
          : undefined;
        json(200, dictation.create({
          ...(input.sessionId ? { sessionId: String(input.sessionId) } : {}),
          ...(input.language ? { language: String(input.language) } : {}),
          ...(context ? { context } : {}),
        }));
        return true;
      }
      let match = path.match(/^\/api\/dictation\/([^/]+)$/);
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

const providerAvailability = (
  voice: VoiceSettingsService,
  localModelInstalled?: (id: string) => boolean,
  localRuntimeInstalled?: () => boolean,
) => {
  const settings = voice.get();
  const selected = settings.dictation.provider;
  const key = voice.resolveKey("dictation");
  return providerCatalog().map((provider) => {
    let available = false;
    let reason: string | undefined;
    if (["elevenlabs", "deepgram", "openai-live", "openai-transcribe", "speechmatics"].includes(provider.id)) {
      available = selected === provider.id && !!key;
      if (!available && selected === provider.id) {
        const fallback = provider.id === "elevenlabs" ? "ELEVENLABS_API_KEY"
          : provider.id === "deepgram" ? "DEEPGRAM_API_KEY"
            : provider.id === "speechmatics" ? "SPEECHMATICS_API_KEY"
              : "OPENAI_API_KEY";
        reason = `missing ${settings.dictation.apiKeyEnv || fallback}`;
      } else if (!available) reason = "not selected";
    } else if (provider.id === "openai-compatible") {
      available = selected === provider.id && !!settings.stt.baseUrl;
      if (!available) reason = selected === provider.id ? "OpenAI-compatible STT base URL is missing" : "not selected";
    } else if (provider.id === "local-nemotron") {
      const model = settings.dictation.localModel || "nemotron-3.5-streaming-0.6b-80ms";
      const modelReady = !!localModelInstalled?.(model);
      const runtimeReady = !!localRuntimeInstalled?.();
      available = selected === provider.id && modelReady && runtimeReady;
      if (!available) {
        reason = selected !== provider.id ? "not selected"
          : !runtimeReady ? "local sherpa runtime is not downloaded"
            : !modelReady ? "local model is not downloaded"
              : undefined;
      }
    } else if (provider.id === "web-speech") {
      available = selected === provider.id;
    } else {
      reason = provider.publicApi ? "provider adapter not enabled yet" : "public Voice Interface API contract unavailable";
    }
    return { ...provider, available, ...(reason ? { reason } : {}) };
  });
};

export function voiceRoutes(deps: {
  voice: VoiceSettingsService;
  fetchFn?: typeof fetch;
  summarize?: (text: string) => Promise<string>;
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
        dictationKeyConfigured: !!deps.voice.resolveKey("dictation"),
      });
      return true;
    }
    if (path === "/api/settings/voice" && method === "PUT") {
      const settings = deps.voice.put(await request.body());
      json(200, {
        ...settings,
        sttConfigured: !!settings.stt.baseUrl,
        ttsConfigured: !!settings.tts.baseUrl,
        dictationKeyConfigured: !!deps.voice.resolveKey("dictation"),
      });
      return true;
    }
    if (path === "/api/voice/providers" && method === "GET") {
      json(200, { providers: providerAvailability(deps.voice, deps.localModelInstalled, deps.localRuntimeInstalled) });
      return true;
    }
    if (path === "/api/dictation/token" && method === "POST") {
      const settings = deps.voice.get().dictation;
      const input = await request.body();
      const provider = String(input.provider ?? settings.provider);
      if (provider !== "elevenlabs" || settings.provider !== "elevenlabs") {
        json(400, { error: "provider_unavailable", message: "single-use tokens are only enabled for the selected ElevenLabs provider" });
        return true;
      }
      const key = deps.voice.resolveKey("dictation");
      if (!key) {
        json(401, { error: "invalid_credentials", message: `missing ${settings.apiKeyEnv || "ELEVENLABS_API_KEY"}` });
        return true;
      }
      try {
        const response = await fetchFn("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", {
          method: "POST",
          headers: { "xi-api-key": key },
        });
        if (!response.ok) {
          const code = response.status === 401 || response.status === 403 ? "invalid_credentials"
            : response.status === 429 ? "rate_limited" : "provider_unavailable";
          json(response.status === 429 ? 429 : response.status === 401 || response.status === 403 ? 401 : 502, {
            error: code,
            message: `ElevenLabs token request failed: HTTP ${response.status}`,
          });
          return true;
        }
        const payload = await response.json() as { token?: unknown };
        if (typeof payload.token !== "string" || !payload.token) {
          json(502, { error: "protocol_error", message: "ElevenLabs token response did not include a token" });
          return true;
        }
        json(200, { provider: "elevenlabs", token: payload.token, expiresInSeconds: 900 });
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
        json(200, { text: (await deps.summarize(text)).trim() });
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

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const voice = host.services.require(
    serverServiceKey<VoiceSettingsService>("voice.settings"),
  );
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
      localAdapter = createLocalNemotronSttAdapter({ modelDir, runtimeDir });
      localAdapterKey = key;
    }
    return localAdapter;
  };

  const dictation = createDictationService({
    adapter: () => {
      const settings = voice.get();
      const selected = settings.dictation;
      if (selected.provider === "web-speech" || selected.transport === "direct-browser") return null;
      if (selected.provider === "local-nemotron") {
        if (selected.transport !== "auto" && selected.transport !== "local-worker") return null;
        return localNemotronAdapter(selected.localModel || "nemotron-3.5-streaming-0.6b-80ms");
      }
      if (selected.transport === "local-worker") return null;
      if (selected.provider === "elevenlabs") {
        const apiKey = voice.resolveKey("dictation");
        if (!apiKey) return null;
        return createElevenLabsSttAdapter({
          apiKey,
          model: selected.model || "scribe_v2_realtime",
        });
      }
      if (selected.provider === "deepgram") {
        const apiKey = voice.resolveKey("dictation");
        if (!apiKey) return null;
        return createDeepgramSttAdapter({
          apiKey,
          model: selected.model || "nova-3",
        });
      }
      if (selected.provider === "openai-live" || selected.provider === "openai-transcribe") {
        const apiKey = voice.resolveKey("dictation");
        if (!apiKey) return null;
        return createOpenAIRealtimeSttAdapter({
          apiKey,
          model: selected.model || (selected.provider === "openai-live" ? "gpt-live-transcribe" : "gpt-transcribe"),
          latencyPreference: selected.latencyPreference,
        });
      }
      if (selected.provider === "speechmatics") {
        const apiKey = voice.resolveKey("dictation");
        if (!apiKey) return null;
        return createSpeechmaticsSttAdapter({
          apiKey,
          model: selected.model || "enhanced",
          latencyPreference: selected.latencyPreference,
        });
      }
      if (selected.provider === "openai-compatible") {
        const stt = settings.stt;
        if (!stt.baseUrl) return null;
        const apiKey = voice.resolveKey("dictation") ?? voice.resolveKey("stt");
        return createWhisperSttAdapter({
          baseUrl: stt.baseUrl,
          model: selected.model || stt.model || "whisper-1",
          ...(selected.language && selected.language !== "auto" ? { language: selected.language } : stt.language ? { language: stt.language } : {}),
          ...(apiKey ? { apiKey } : {}),
        });
      }
      return null;
    },
    unavailableReason: "selected dictation provider is unavailable, missing credentials, or its local model/runtime is not installed",
  });
  host.services.provide(serverServiceKey<DictationService>("dictation"), dictation);
  let routes: RouteHandler | null = null;
  return {
    remoteAccess: localOnlyRemoteAccess(["dictation"]),
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      const dictationRoute = dictationRoutes(dictation);
      const modelRoute = localModelRoutes(localModels, localRuntime);
      const runtimeRoute = localRuntimeRoutes(localRuntime);
      const voiceRoute = voiceRoutes({
        voice,
        localModelInstalled: (id) => !!installedLocalModel(id),
        localRuntimeInstalled: () => !!installedLocalRuntime(),
        summarize: async (text) => {
          const runtime = await host.runtimes.forProject("__default__");
          return host.oneShot(runtime, {
            cwd: process.cwd(),
            ...(host.smallModel() ? { model: host.smallModel()! } : {}),
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
  };
}
