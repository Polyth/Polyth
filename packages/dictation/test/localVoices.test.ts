// Built-in voices: a pinned catalog, one-step install (speech engine
// included), synthesis served as WAV with its measured speed, and the
// sherpa configuration each Kokoro language needs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KOKORO_VOICE_ID, defaultSpeaker, localVoice, localVoiceCatalog } from "../src/localVoiceCatalog.ts";
import { localVoiceConfig, type LocalTts } from "../src/localTts.ts";
import { localVoiceRoutes } from "../src/localVoiceRoutes.ts";
import type { LocalRuntimeManager, LocalRuntimeStatus } from "../src/localRuntime.ts";

test("every catalog voice is pinned, unique and speaks at least one language", () => {
  const voices = localVoiceCatalog();
  assert.equal(new Set(voices.map((voice) => voice.id)).size, voices.length);
  for (const voice of voices) {
    assert.match(voice.sha256, /^[0-9a-f]{64}$/, voice.id);
    assert.ok(voice.archiveBytes > 1_000_000, voice.id);
    assert.ok(voice.archiveUrl.startsWith("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"), voice.id);
    assert.ok(voice.languages.length >= 1, voice.id);
  }
  assert.ok(voices.some((voice) => voice.languages.includes("uk-UA")), "Ukrainian has a voice");
  const kokoro = localVoice(KOKORO_VOICE_ID)!;
  assert.ok(!kokoro.speakers!.some((speaker) => speaker.lang.startsWith("ja")), "Japanese speakers are not offered");
  assert.equal(defaultSpeaker(kokoro, "en-US"), 3, "American English defaults to Heart");
  assert.equal(kokoro.speakers!.find((speaker) => speaker.id === defaultSpeaker(kokoro, "es"))!.lang, "es-ES");
});

test("Kokoro gets one configuration per language, Piper one per voice", () => {
  const kokoro = localVoice(KOKORO_VOICE_ID)!;
  const english = localVoiceConfig(kokoro, "/v/k", 3, 4);
  const spanish = localVoiceConfig(kokoro, "/v/k", 28, 4);
  const chinese = localVoiceConfig(kokoro, "/v/k", 47, 4);
  assert.notEqual(english.key, spanish.key);
  assert.equal((english.config.model as { kokoro: { lang?: string } }).kokoro.lang, undefined, "English reads through its lexicon");
  assert.equal((spanish.config.model as { kokoro: { lang?: string } }).kokoro.lang, "es");
  assert.match(String((chinese.config as { ruleFsts?: string }).ruleFsts), /number-zh\.fst/);
  const lada = localVoiceConfig(localVoice("piper-uk_UA-lada-x_low")!, "/v/lada", 0, 2);
  assert.equal((lada.config.model as { vits: { model: string } }).vits.model, "/v/lada/uk_UA-lada-x_low.onnx");
});

const runtime = (state: LocalRuntimeStatus["state"]) => {
  const calls: string[] = [];
  const manager: LocalRuntimeManager = {
    status: async () => ({ state, version: "1", platform: "linux", arch: "arm64", downloadedBytes: 0 }),
    download: async () => { calls.push("download"); return { state: "installed", version: "1", platform: "linux", arch: "arm64", downloadedBytes: 0 }; },
    cancel: async () => {},
    remove: async () => {},
    path: async () => state === "installed" ? "/runtime" : null,
  };
  return { manager, calls };
};

const voices = (installed: string[]) => {
  const calls: string[] = [];
  return {
    calls,
    manager: {
      list: async () => localVoiceCatalog().map(({ archiveUrl: _u, sha256: _s, ...voice }) => ({
        ...voice, state: installed.includes(voice.id) ? "installed" as const : "missing" as const, downloadedBytes: 0, totalBytes: voice.archiveBytes,
      })),
      status: async (id: string) => {
        if (!localVoice(id)) throw Object.assign(new Error("unknown"), { code: "local_model_missing" });
        return {} as never;
      },
      download: async (id: string) => { calls.push(`download:${id}`); return {} as never; },
      cancelAll: async () => {},
      remove: async (id: string) => { calls.push(`remove:${id}`); },
      path: async (id: string) => installed.includes(id) ? `/voices/${id}` : null,
    },
  };
};

const call = async (route: ReturnType<typeof localVoiceRoutes>, method: string, path: string, body: Record<string, unknown> = {}) => {
  let status = 0;
  let payload: unknown;
  const sent: { headers?: Record<string, unknown>; body?: Buffer } = {};
  await route({
    path,
    method,
    body: async () => body,
    json(code: number, value: unknown) { status = code; payload = value; },
    res: {
      writeHead(code: number, headers: Record<string, unknown>) { status = code; sent.headers = headers; },
      end(data: Buffer) { sent.body = data; },
    },
  } as never);
  return { status, payload, sent };
};

test("one download installs the voice and, when missing, the speech engine", async () => {
  const engine = runtime("missing");
  const store = voices([]);
  const route = localVoiceRoutes({ voices: store.manager as never, runtime: engine.manager, tts: {} as LocalTts });
  const result = await call(route, "POST", "/api/tts/voices/piper-uk_UA-lada-x_low/download");
  assert.equal(result.status, 202);
  assert.deepEqual(engine.calls, ["download"]);
  assert.deepEqual(store.calls, ["download:piper-uk_UA-lada-x_low"]);
  assert.equal((await call(route, "POST", "/api/tts/voices/nope/download")).status, 404);
});

test("synthesis returns WAV and the voice's measured speed is listed", async () => {
  const requests: unknown[] = [];
  const tts: LocalTts = {
    synthesize: async (voice, dir, request) => {
      requests.push({ voice: voice.id, dir, request });
      return { wav: Buffer.from("RIFF...."), seconds: 2, genMs: 3_200 };
    },
    dispose() {},
  };
  const route = localVoiceRoutes({ voices: voices([KOKORO_VOICE_ID]).manager as never, runtime: runtime("installed").manager, tts });
  const spoken = await call(route, "POST", "/api/tts/local", { text: " Hola. ", voice: KOKORO_VOICE_ID, speaker: 28, speed: 1.1, lang: "es-ES" });
  assert.equal(spoken.status, 200);
  assert.equal(spoken.sent.headers?.["content-type"], "audio/wav");
  assert.deepEqual(requests, [{ voice: KOKORO_VOICE_ID, dir: `/voices/${KOKORO_VOICE_ID}`, request: { text: "Hola.", speaker: 28, lang: "es-ES", speed: 1.1 } }]);
  const listed = await call(route, "GET", "/api/tts/voices");
  const kokoro = (listed.payload as { voices: Array<{ id: string; realtimeFactor?: number }> }).voices.find((voice) => voice.id === KOKORO_VOICE_ID);
  assert.equal(kokoro?.realtimeFactor, 1.6, "1.6 s of work per second of audio");

  assert.equal((await call(route, "POST", "/api/tts/local", { text: "Hi", voice: "piper-uk_UA-lada-x_low" })).status, 409, "not downloaded");
  assert.equal((await call(route, "POST", "/api/tts/local", { text: "Hi", voice: "nope" })).status, 400);
  assert.equal((await call(route, "POST", "/api/tts/local", { text: "Hi", voice: KOKORO_VOICE_ID, speaker: 999 })).status, 200);
  assert.equal((requests.at(-1) as { request: { speaker?: number } }).request.speaker, undefined, "an unknown speaker falls back to the default");
});
