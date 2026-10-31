import type { RouteHandler } from "@polyth/contracts";
import type { LocalArchiveStatus, LocalModelManager } from "./localModels.ts";
import type { LocalRuntimeManager } from "./localRuntime.ts";
import type { LocalTts } from "./localTts.ts";
import { localVoice, type LocalVoiceDescriptor } from "./localVoiceCatalog.ts";

type VoiceStatus = LocalArchiveStatus<LocalVoiceDescriptor>;

const MAX_LOCAL_SPEAK_CHARS = 2_000;

const statusOf = (code?: string): number => {
  switch (code) {
    case "local_model_missing": return 404;
    case "invalid-input": return 400;
    case "network_error": return 502;
    case "session_expired": return 409;
    default: return 500;
  }
};

/** Built-in voices: list, one-step install (voice + speech engine), removal
 *  and synthesis. Synthesis is the only route paired devices may use. */
export function localVoiceRoutes(deps: {
  voices: LocalModelManager<LocalVoiceDescriptor, VoiceStatus>;
  runtime: LocalRuntimeManager;
  tts: LocalTts;
}): RouteHandler {
  // Measured on this server: synthesis seconds per audio second, per voice.
  // Above 1 the voice cannot keep up with playback here.
  const realtime = new Map<string, number>();

  const list = async () => ({
    runtime: await deps.runtime.status(),
    voices: (await deps.voices.list()).map((voice) => ({
      ...voice,
      ...(realtime.has(voice.id) ? { realtimeFactor: realtime.get(voice.id) } : {}),
    })),
  });

  return async (request) => {
    const { path, method, json } = request;
    try {
      if (path === "/api/tts/voices" && method === "GET") {
        json(200, await list());
        return true;
      }
      let match = path.match(/^\/api\/tts\/voices\/([^/]+)\/download$/);
      if (match && method === "POST") {
        const id = decodeURIComponent(match[1]!);
        await deps.voices.status(id);
        // One click installs everything a voice needs: the shared speech
        // engine (also used by local dictation) and the voice itself.
        const runtime = await deps.runtime.status();
        if (runtime.state === "unsupported") {
          json(409, { error: "unsupported", message: runtime.error ?? "Built-in voices are not supported on this server" });
          return true;
        }
        if (runtime.state !== "installed" && runtime.state !== "downloading") void deps.runtime.download().catch(() => {});
        void deps.voices.download(id).catch(() => {});
        json(202, await list());
        return true;
      }
      match = path.match(/^\/api\/tts\/voices\/([^/]+)$/);
      if (match && method === "DELETE") {
        await deps.voices.remove(decodeURIComponent(match[1]!));
        json(200, await list());
        return true;
      }
      if (path === "/api/tts/local" && method === "POST") {
        const input = await request.body();
        const text = String(input.text ?? "").trim().slice(0, MAX_LOCAL_SPEAK_CHARS);
        const voice = localVoice(String(input.voice ?? ""));
        if (!text || !voice) {
          json(400, { error: "invalid-input", message: text ? "Unknown voice" : "text is required" });
          return true;
        }
        const dir = await deps.voices.path(voice.id);
        if (!dir || !(await deps.runtime.path())) {
          json(409, { error: "not-installed", message: `${voice.label} is not downloaded on this server` });
          return true;
        }
        const speaker = Number.isInteger(input.speaker) && voice.speakers?.some((entry) => entry.id === input.speaker)
          ? input.speaker as number
          : undefined;
        const speed = typeof input.speed === "number" && Number.isFinite(input.speed) ? input.speed : 1;
        const lang = typeof input.lang === "string" ? input.lang.slice(0, 35) : undefined;
        const speech = await deps.tts.synthesize(voice, dir, {
          text,
          ...(speaker !== undefined ? { speaker } : {}),
          ...(lang ? { lang } : {}),
          speed,
        });
        if (speech.seconds > 0) realtime.set(voice.id, Math.round((speech.genMs / 1000 / speech.seconds) * 100) / 100);
        request.res.writeHead(200, {
          "content-type": "audio/wav",
          "content-length": speech.wav.byteLength,
          "cache-control": "no-store",
        });
        request.res.end(speech.wav);
        return true;
      }
      return false;
    } catch (error) {
      const failure = error as Error & { code?: string };
      json(statusOf(failure.code), { error: failure.code ?? "local_voice_failed", message: failure.message });
      return true;
    }
  };
}
