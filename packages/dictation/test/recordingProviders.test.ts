// Provider file endpoints for finished recordings, against a stubbed fetch:
// the exact URL, auth header, body and model each provider receives, the
// transcript each returns, and how HTTP failures map to dictation codes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DICTATION_FORMAT,
  createDeepgramSttAdapter,
  createElevenLabsSttAdapter,
  createOpenAIRealtimeSttAdapter,
  createWhisperSttAdapter,
} from "@polyth/dictation";

interface Seen { url: string; method: string; headers: Record<string, string>; body: unknown }

const stubFetch = (respond: (seen: Seen, index: number) => { status: number; body: string; headers?: Record<string, string> }) => {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const entry: Seen = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: init?.body,
    };
    seen.push(entry);
    const answer = respond(entry, seen.length - 1);
    return new Response(answer.body, { status: answer.status, headers: answer.headers ?? { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, seen };
};

const audio = new Uint8Array(3_200).fill(1);
const isWav = async (body: unknown): Promise<boolean> => {
  const bytes = new Uint8Array(await (body as Blob).arrayBuffer());
  return String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE"
    && bytes.byteLength === 44 + audio.byteLength;
};

test("Deepgram recordings go to pre-recorded /v1/listen as one WAV", async () => {
  const { fetchFn, seen } = stubFetch(() => ({
    status: 200,
    body: JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: " Привіт, Polyth. " }] }] } }),
  }));
  const adapter = createDeepgramSttAdapter({ apiKey: "dg-key", model: "nova-3", fetchFn });
  const text = await adapter.transcribe!({
    audio,
    format: DICTATION_FORMAT,
    language: "uk-UA",
    context: { language: "uk-UA", keywords: ["Polyth", "polyth"] },
  });
  assert.equal(text, "Привіт, Polyth.");
  const url = new URL(seen[0]!.url);
  assert.equal(`${url.origin}${url.pathname}`, "https://api.deepgram.com/v1/listen");
  assert.equal(url.searchParams.get("model"), "nova-3");
  assert.equal(url.searchParams.get("language"), "uk");
  assert.equal(url.searchParams.get("detect_language"), null);
  assert.deepEqual(url.searchParams.getAll("keyterm"), ["Polyth"]);
  assert.equal(seen[0]!.headers.authorization, "Token dg-key");
  assert.equal(seen[0]!.headers["content-type"], "audio/wav");
  assert.equal(await isWav(seen[0]!.body), true);

  await adapter.transcribe!({ audio, format: DICTATION_FORMAT });
  const auto = new URL(seen[1]!.url);
  assert.equal(auto.searchParams.get("detect_language"), "true", "a file can detect its language");
  assert.equal(auto.searchParams.get("language"), null);
});

test("recording failures map HTTP status to dictation codes", async () => {
  for (const [status, code] of [[401, "invalid_credentials"], [403, "invalid_credentials"], [429, "rate_limited"], [500, "provider_unavailable"], [413, "audio_format_error"]] as const) {
    const { fetchFn } = stubFetch(() => ({ status, body: "{}", headers: { "retry-after": "3" } }));
    const adapter = createDeepgramSttAdapter({ apiKey: "dg-key", fetchFn });
    await assert.rejects(() => adapter.transcribe!({ audio, format: DICTATION_FORMAT }), (error: unknown) => {
      const failure = error as { code?: string; retryAfterMs?: number; message?: string };
      assert.equal(failure.code, code);
      assert.match(failure.message ?? "", new RegExp(`HTTP ${status}`));
      if (status === 429) assert.equal(failure.retryAfterMs, 3_000);
      return true;
    });
  }
  const offline = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  await assert.rejects(
    () => createDeepgramSttAdapter({ apiKey: "dg-key", fetchFn: offline }).transcribe!({ audio, format: DICTATION_FORMAT }),
    (error: unknown) => (error as { code?: string }).code === "network_error",
  );
});

test("ElevenLabs recordings use Scribe's file model with words only", async () => {
  const { fetchFn, seen } = stubFetch(() => ({ status: 200, body: JSON.stringify({ text: " Hello there. " }) }));
  const adapter = createElevenLabsSttAdapter({ apiKey: "xi-key", recordingModel: "scribe_v2", fetchFn });
  const text = await adapter.transcribe!({
    audio,
    format: DICTATION_FORMAT,
    language: "en-US",
    context: { language: "en-US", keywords: ["Polyth agents and sessions in one place"] },
  });
  assert.equal(text, "Hello there.");
  assert.equal(seen[0]!.url, "https://api.elevenlabs.io/v1/speech-to-text");
  assert.equal(seen[0]!.headers["xi-api-key"], "xi-key");
  const form = seen[0]!.body as FormData;
  assert.equal(form.get("model_id"), "scribe_v2");
  assert.equal(form.get("language_code"), "en");
  assert.equal(form.get("tag_audio_events"), "false");
  assert.deepEqual(form.getAll("keyterms"), ["Polyth agents and sessions in"], "a keyterm keeps at most five words");
  assert.equal(await isWav(form.get("file")), true);
});

test("ElevenLabs retries without keyterms when the hint itself is refused", async () => {
  const { fetchFn, seen } = stubFetch((_seen, index) => index === 0
    ? { status: 422, body: JSON.stringify({ detail: "keyterms" }) }
    : { status: 200, body: JSON.stringify({ text: "ok" }) });
  const adapter = createElevenLabsSttAdapter({ apiKey: "xi-key", fetchFn });
  const text = await adapter.transcribe!({ audio, format: DICTATION_FORMAT, context: { language: "auto", keywords: ["Polyth"] } });
  assert.equal(text, "ok");
  assert.equal(seen.length, 2);
  assert.deepEqual((seen[1]!.body as FormData).getAll("keyterms"), []);
  assert.equal((seen[0]!.body as FormData).get("model_id"), "scribe_v2", "the realtime model is never sent to the file endpoint");

  const { fetchFn: refuse, seen: once } = stubFetch(() => ({ status: 401, body: "{}" }));
  await assert.rejects(() => createElevenLabsSttAdapter({ apiKey: "xi-key", fetchFn: refuse })
    .transcribe!({ audio, format: DICTATION_FORMAT, context: { language: "auto", keywords: ["Polyth"] } }));
  assert.equal(once.length, 1, "a credentials failure is not retried");
});

test("OpenAI recordings use the file transcription endpoint with gpt-transcribe", async () => {
  const { fetchFn, seen } = stubFetch(() => ({ status: 200, body: JSON.stringify({ text: "Dictated." }) }));
  const adapter = createOpenAIRealtimeSttAdapter({ apiKey: "sk-test", model: "gpt-live-transcribe", fetchFn });
  assert.equal(await adapter.transcribe!({ audio, format: DICTATION_FORMAT, language: "de-DE" }), "Dictated.");
  assert.equal(seen[0]!.url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(seen[0]!.headers.authorization, "Bearer sk-test");
  const form = seen[0]!.body as FormData;
  assert.equal(form.get("model"), "gpt-transcribe");
  assert.equal(form.get("language"), "de");
  assert.equal(form.get("response_format"), "json");
  assert.equal(await isWav(form.get("file")), true);
});

test("an OpenAI-compatible server gets a recording as the same single upload", async () => {
  const { fetchFn, seen } = stubFetch(() => ({ status: 200, body: JSON.stringify({ text: "Local words" }) }));
  const adapter = createWhisperSttAdapter({ baseUrl: "http://stt.test/v1/", model: "whisper-1", apiKey: "k", fetchFn });
  assert.equal(await adapter.transcribe!({ audio, format: DICTATION_FORMAT }), "Local words");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "http://stt.test/v1/audio/transcriptions");
  assert.equal((seen[0]!.body as FormData).get("model"), "whisper-1");
  assert.equal(await adapter.transcribe!({ audio: new Uint8Array(0), format: DICTATION_FORMAT }), "");
  assert.equal(seen.length, 1, "nothing is uploaded for an empty recording");
});
