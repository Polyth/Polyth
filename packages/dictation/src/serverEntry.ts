import type { RouteHandler } from "@polyth/contracts";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import type { DictationService } from "./index.ts";

interface VoiceEngineSettings {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
}

interface VoiceSettings {
  stt: VoiceEngineSettings & { language: string };
  tts: VoiceEngineSettings & { voice: string };
}

interface VoiceSettingsService {
  get(): VoiceSettings;
  put(next: unknown): VoiceSettings;
  resolveKey(section: "stt" | "tts"): string | undefined;
}

const DICTATION_STATUS: Record<string, number> = {
  "not-found": 404,
  "invalid-input": 400,
  unavailable: 503,
  limit: 429,
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
        json(200, dictation.create({
          ...(input.sessionId ? { sessionId: String(input.sessionId) } : {}),
          ...(input.language ? { language: String(input.language) } : {}),
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
      const failure = error as Error & { code?: string };
      json(DICTATION_STATUS[failure.code ?? ""] ?? 500, {
        error: failure.code ?? "internal",
        message: failure.message,
      });
      return true;
    }
  };
}

const MAX_SPEAK_CHARS = 8_000;

export function voiceRoutes(deps: {
  voice: VoiceSettingsService;
  fetchFn?: typeof fetch;
  summarize?: (text: string) => Promise<string>;
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
      });
      return true;
    }
    if (path === "/api/settings/voice" && method === "PUT") {
      const settings = deps.voice.put(await request.body());
      json(200, {
        ...settings,
        sttConfigured: !!settings.stt.baseUrl,
        ttsConfigured: !!settings.tts.baseUrl,
      });
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
        return true;
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
  let routes: RouteHandler | null = null;
  return {
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      const dictation = host.services.require(
        serverServiceKey<DictationService>("dictation"),
      );
      const voice = host.services.require(
        serverServiceKey<VoiceSettingsService>("voice.settings"),
      );
      const dictationRoute = dictationRoutes(dictation);
      const voiceRoute = voiceRoutes({
        voice,
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
        if (await dictationRoute(request)) return true;
        return voiceRoute(request);
      };
    },
  };
}
