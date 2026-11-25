// Streamed server voices: the services that can return raw PCM while it is
// generated are asked for it at their own fixed endpoint, and `/api/tts/speak`
// passes the audio on as it arrives instead of buffering the clip.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVoiceSettings } from "../../server/src/voice.ts";
import type { RouteRequest } from "../../server/src/http.ts";
import { ProviderRegistry } from "../src/providers.ts";
import { TTS_PCM_TYPE, voiceRoutes } from "../src/serverEntry.ts";
import type { TtsProviderId } from "../src/ttsCatalog.ts";
import { TtsUpstreamError, streamsPcm, synthesizeSpeechStream } from "../src/ttsProviders.ts";

const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-tts-stream-"));
  dirs.push(dir);
  return dir;
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const settings = (provider: TtsProviderId, extra: Partial<{ model: string; voice: string; region: string; baseUrl: string }> = {}) => ({
  provider, baseUrl: "", model: "", voice: "", region: "", ...extra,
});

interface Sent { url: string; headers: Record<string, string>; body: string; signal: AbortSignal | undefined }

const recorder = (response: () => Response) => {
  const sent: Sent[] = [];
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body ?? ""),
      signal: init?.signal ?? undefined,
    });
    return response();
  }) as typeof fetch;
  return { sent, fetchFn };
};

const pcm = () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "audio/pcm" } });

const drain = async (stream: ReadableStream<Uint8Array>): Promise<number[]> => {
  const out: number[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(...value);
  }
};

test("OpenAI, ElevenLabs and Polly are asked for headerless PCM at their own endpoints", async () => {
  assert.deepEqual((["openai-compatible", "openai", "elevenlabs", "google", "polly", "gradium"] as const).filter(streamsPcm),
    ["openai", "elevenlabs", "polly"]);

  const openai = recorder(pcm);
  const fromOpenAi = await synthesizeSpeechStream({ settings: settings("openai"), text: "hello", key: "sk-test", fetchFn: openai.fetchFn });
  assert.equal(fromOpenAi.sampleRate, 24_000);
  assert.deepEqual(await drain(fromOpenAi.body), [1, 2, 3, 4]);
  assert.equal(openai.sent[0]!.url, "https://api.openai.com/v1/audio/speech");
  assert.equal(openai.sent[0]!.headers.authorization, "Bearer sk-test");
  assert.equal(JSON.parse(openai.sent[0]!.body).response_format, "pcm");

  const eleven = recorder(pcm);
  const fromEleven = await synthesizeSpeechStream({ settings: settings("elevenlabs", { voice: "voice123" }), text: "hello", key: "xi-test", fetchFn: eleven.fetchFn });
  assert.equal(fromEleven.sampleRate, 24_000);
  assert.equal(eleven.sent[0]!.url, "https://api.elevenlabs.io/v1/text-to-speech/voice123/stream?output_format=pcm_24000");
  assert.equal(eleven.sent[0]!.headers["xi-api-key"], "xi-test");
  assert.doesNotMatch(eleven.sent[0]!.url, /xi-test/, "the key never lands in the URL");

  const polly = recorder(pcm);
  const fromPolly = await synthesizeSpeechStream({
    settings: settings("polly", { region: "eu-central-1", voice: "Vicki" }), text: "hallo", key: "AKID", secret: "aws-secret",
    fetchFn: polly.fetchFn, now: () => new Date("2026-11-23T00:00:00Z"),
  });
  assert.equal(fromPolly.sampleRate, 16_000, "Polly's PCM stops at 16 kHz");
  assert.equal(polly.sent[0]!.url, "https://polly.eu-central-1.amazonaws.com/v1/speech");
  const pollyBody = JSON.parse(polly.sent[0]!.body);
  assert.equal(pollyBody.OutputFormat, "pcm");
  assert.equal(pollyBody.SampleRate, "16000");
  assert.match(polly.sent[0]!.headers.authorization ?? "", /^AWS4-HMAC-SHA256 Credential=AKID\//);
});

test("a service without a stream, a missing key and a refusal fail before any audio", async () => {
  const none = recorder(pcm);
  await assert.rejects(synthesizeSpeechStream({ settings: settings("google"), text: "x", key: "k", fetchFn: none.fetchFn }), /does not stream/);
  await assert.rejects(synthesizeSpeechStream({ settings: settings("openai-compatible", { baseUrl: "https://tts.example/v1" }), text: "x", fetchFn: none.fetchFn }),
    TtsUpstreamError);
  await assert.rejects(synthesizeSpeechStream({ settings: settings("openai"), text: "x", fetchFn: none.fetchFn }), /API key is not set/);
  assert.equal(none.sent.length, 0);
  const refused = recorder(() => new Response("nope", { status: 401 }));
  await assert.rejects(
    synthesizeSpeechStream({ settings: settings("elevenlabs"), text: "x", key: "k", fetchFn: refused.fetchFn }),
    (error: unknown) => error instanceof TtsUpstreamError && error.status === 401,
  );
});

class FakeResponse extends EventEmitter {
  status = 0;
  headers: Record<string, unknown> = {};
  headersSent = false;
  destroyed = false;
  ended = false;
  written: number[][] = [];
  writeHead(code: number, headers: Record<string, unknown>) {
    this.status = code;
    this.headers = headers;
    this.headersSent = true;
  }
  write(chunk: Uint8Array) {
    this.written.push([...chunk]);
    return true;
  }
  end(chunk?: Uint8Array) {
    if (chunk) this.written.push([...chunk]);
    this.ended = true;
  }
  destroy() { this.destroyed = true; }
}

function harness(fetchFn: typeof fetch, provider: TtsProviderId, env: Record<string, string>) {
  const voice = createVoiceSettings({ file: join(tmp(), "voice.json"), env });
  voice.put({ tts: { provider, apiKeyEnv: Object.keys(env)[0] ?? "", voice: provider === "openai" ? "alloy" : "" } });
  const routes = voiceRoutes({ voice, providers: new ProviderRegistry(), fetchFn });
  const start = (body: Record<string, unknown>) => {
    const res = new FakeResponse();
    let status = 0;
    let payload: unknown;
    const rc = {
      req: {}, res,
      url: new URL("http://x/api/tts/speak"),
      space: { userId: "usr_test" },
      path: "/api/tts/speak", method: "POST",
      body: async () => body,
      json: (code: number, value: unknown) => { status = code; payload = value; },
    } as unknown as RouteRequest;
    return { res, done: routes(rc), json: () => ({ status, payload }) };
  };
  return { start };
}

test("tts/speak passes a streamed voice on while it arrives, with its sample rate", async () => {
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  const sent: Sent[] = [];
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body ?? ""), signal: init?.signal ?? undefined });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { feed = controller; } }), { status: 200 });
  }) as typeof fetch;
  const h = harness(fetchFn, "openai", { OPENAI_API_KEY: "sk-test" });
  const call = h.start({ text: "read this", stream: true });
  await tick();
  await tick();
  assert.equal(call.res.status, 200);
  assert.equal(call.res.headers["content-type"], `${TTS_PCM_TYPE};rate=24000`);
  assert.equal(call.res.headers["content-length"], undefined, "the length is not known up front");
  assert.equal(JSON.parse(sent[0]!.body).response_format, "pcm");

  feed.enqueue(new Uint8Array([1, 2]));
  await tick();
  assert.deepEqual(call.res.written, [[1, 2]], "the first audio reaches the listener before synthesis has finished");
  assert.equal(call.res.ended, false);
  feed.enqueue(new Uint8Array([3, 4, 5]));
  feed.close();
  assert.equal(await call.done, true);
  assert.deepEqual(call.res.written, [[1, 2], [3, 4, 5]]);
  assert.equal(call.res.ended, true);
});

test("without the flag, and for a service that cannot stream, tts/speak returns the whole clip as before", async () => {
  const clip = () => new Response(new Uint8Array([9, 9]).buffer, { status: 200, headers: { "content-type": "audio/mpeg" } });
  const openai = recorder(clip);
  const plain = harness(openai.fetchFn, "openai", { OPENAI_API_KEY: "sk-test" }).start({ text: "read this" });
  await plain.done;
  assert.equal(plain.res.headers["content-type"], "audio/mpeg");
  assert.equal(JSON.parse(openai.sent[0]!.body).response_format, "mp3");

  const google = recorder(() => new Response(JSON.stringify({ audioContent: Buffer.from([7]).toString("base64") }), { status: 200 }));
  const whole = harness(google.fetchFn, "google", { GOOGLE_TTS_API_KEY: "g-test" }).start({ text: "read this", stream: true });
  await whole.done;
  assert.equal(whole.res.headers["content-type"], "audio/mpeg", "the stream flag is a request, not a promise");
  assert.deepEqual(whole.res.written, [[7]]);
});

test("a refusal before any audio is an ordinary error; a listener who leaves stops the synthesis", async () => {
  const refused = harness((async () => new Response("no", { status: 500 })) as typeof fetch, "openai", { OPENAI_API_KEY: "sk-test" })
    .start({ text: "x", stream: true });
  await refused.done;
  assert.equal(refused.json().status, 502, "the client can still fall back to another voice");
  assert.equal(refused.res.headersSent, false);

  let signal: AbortSignal | undefined;
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { feed = controller; } }), { status: 200 });
  }) as typeof fetch;
  const left = harness(fetchFn, "openai", { OPENAI_API_KEY: "sk-test" }).start({ text: "a long reply", stream: true });
  await tick();
  await tick();
  feed.enqueue(new Uint8Array([1, 2]));
  await tick();
  assert.equal(signal?.aborted, false);
  left.res.emit("close");
  assert.equal(signal?.aborted, true, "an interrupted reply is not paid for to the end");
  feed.error(new Error("aborted"));
  await left.done;
  assert.equal(left.res.ended, false);
  assert.equal(left.res.destroyed, true, "after audio has gone out, a cut connection is the only honest signal");
});
