// F8 routes: voice engine settings (refs only — never secret values) and the
// OpenAI-compatible TTS proxy. The proxy buffers the whole clip server-side
// (arrayBuffer delivery) and sends ONLY standard fields (model, input, voice,
// response_format) so non-OpenAI servers accept the request. Raw audio never
// touches the session event log.
import type { RouteHandler } from "../http.ts";
import type { VoiceSettingsService } from "../voice.ts";

const MAX_SPEAK_CHARS = 8000;

export function voiceRoutes(deps: {
  voice: VoiceSettingsService;
  fetchFn?: typeof fetch;
  /** Small-model summarize for speak-mode; absent = honest 503. */
  summarize?: (text: string) => Promise<string>;
}): RouteHandler {
  const fetchFn = deps.fetchFn ?? fetch;

  return async (rc) => {
    const { path, method, json } = rc;

    if (path === "/api/settings/voice" && method === "GET") {
      const s = deps.voice.get();
      // refs + configured flags only; key values are never in any response
      json(200, { ...s, sttConfigured: !!s.stt.baseUrl, ttsConfigured: !!s.tts.baseUrl });
      return true;
    }
    if (path === "/api/settings/voice" && method === "PUT") {
      const b = await rc.body();
      const s = deps.voice.put(b);
      json(200, { ...s, sttConfigured: !!s.stt.baseUrl, ttsConfigured: !!s.tts.baseUrl });
      return true;
    }

    if (path === "/api/tts/speak" && method === "POST") {
      const b = await rc.body();
      const text = String(b.text ?? "").trim();
      if (!text) { json(400, { error: "invalid-input", message: "text is required" }); return true; }
      const settings = deps.voice.get().tts;
      if (!settings.baseUrl) {
        json(503, { error: "unavailable", message: "no text-to-speech server configured (Settings → Voice)" });
        return true;
      }
      const key = deps.voice.resolveKey("tts");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await fetchFn(`${settings.baseUrl.replace(/\/+$/, "")}/audio/speech`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(key ? { authorization: `Bearer ${key}` } : {}),
          },
          body: JSON.stringify({
            model: String(b.model ?? "") || settings.model || "tts-1",
            input: text.slice(0, MAX_SPEAK_CHARS),
            voice: String(b.voice ?? "") || settings.voice || "alloy",
            response_format: "mp3",
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          json(502, { error: "upstream", message: `TTS server error: HTTP ${res.status}` });
          return true;
        }
        const audio = Buffer.from(await res.arrayBuffer());
        rc.res.writeHead(200, {
          "content-type": res.headers.get("content-type") ?? "audio/mpeg",
          "content-length": audio.byteLength,
          "cache-control": "no-store",
        });
        rc.res.end(audio);
        return true;
      } catch (e) {
        json(502, { error: "upstream", message: e instanceof Error ? e.message : String(e) });
        return true;
      } finally {
        clearTimeout(timer);
      }
    }

    if (path === "/api/tts/summarize" && method === "POST") {
      if (!deps.summarize) {
        json(503, { error: "unavailable", message: "no small model configured for summarize-speak" });
        return true;
      }
      const b = await rc.body();
      const text = String(b.text ?? "").trim();
      if (!text) { json(400, { error: "invalid-input", message: "text is required" }); return true; }
      try {
        json(200, { text: (await deps.summarize(text)).trim() });
      } catch (e) {
        // callers fall back to the raw text; give them the reason
        json(502, { error: "upstream", message: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    return false;
  };
}
