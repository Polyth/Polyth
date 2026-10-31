// Hosted server voices: each service gets its own fixed endpoint, auth header
// and body shape, keys never land in URLs, and Polly requests carry a valid
// SigV4 signature.
import { test } from "node:test";
import assert from "node:assert/strict";
import { googleLanguageCode, signAwsV4, synthesizeSpeech, TtsUpstreamError } from "../src/ttsProviders.ts";
import { TTS_PROVIDERS, ttsProviderInfo, type TtsProviderId } from "../src/ttsCatalog.ts";

interface Sent { url: string; headers: Record<string, string>; body: string }

const recorder = (response: () => Response) => {
  const sent: Sent[] = [];
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body ?? "") });
    return response();
  }) as typeof fetch;
  return { sent, fetchFn };
};

const audio = () => new Response(new Uint8Array([7, 8, 9]).buffer, { status: 200, headers: { "content-type": "audio/mpeg" } });

const settings = (provider: TtsProviderId, extra: Partial<{ model: string; voice: string; region: string; baseUrl: string }> = {}) => ({
  provider, baseUrl: "", model: "", voice: "", region: "", ...extra,
});

test("signAwsV4 matches the AWS get-vanilla test vector", () => {
  const headers = signAwsV4({
    method: "GET",
    host: "example.amazonaws.com",
    path: "/",
    headers: {},
    body: "",
    service: "service",
    region: "us-east-1",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    date: new Date("2015-08-30T12:36:00Z"),
  });
  assert.equal(headers["x-amz-date"], "20150830T123600Z");
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
});

test("OpenAI TTS uses the fixed OpenAI endpoint with a bearer key", async () => {
  const { sent, fetchFn } = recorder(audio);
  const clip = await synthesizeSpeech({ settings: settings("openai"), text: "hello", key: "sk-test", fetchFn });
  assert.deepEqual([...clip.audio], [7, 8, 9]);
  assert.equal(sent[0]!.url, "https://api.openai.com/v1/audio/speech");
  assert.equal(sent[0]!.headers.authorization, "Bearer sk-test");
  assert.deepEqual(JSON.parse(sent[0]!.body), { model: "gpt-4o-mini-tts", input: "hello", voice: "alloy", response_format: "mp3" });
});

test("ElevenLabs puts the voice id in the path and the key in xi-api-key", async () => {
  const { sent, fetchFn } = recorder(audio);
  await synthesizeSpeech({ settings: settings("elevenlabs", { voice: "abc123" }), text: "hello", key: "xi-key", fetchFn });
  assert.equal(sent[0]!.url, "https://api.elevenlabs.io/v1/text-to-speech/abc123?output_format=mp3_44100_128");
  assert.equal(sent[0]!.headers["xi-api-key"], "xi-key");
  assert.deepEqual(JSON.parse(sent[0]!.body), { text: "hello", model_id: "eleven_flash_v2_5" });
});

test("Google sends the key as a header and decodes base64 audio", async () => {
  const { sent, fetchFn } = recorder(() => Response.json({ audioContent: Buffer.from([1, 2]).toString("base64") }));
  const clip = await synthesizeSpeech({ settings: settings("google", { voice: "de-DE-Neural2-B" }), text: "hallo", key: "g-key", fetchFn });
  assert.deepEqual([...clip.audio], [1, 2]);
  assert.equal(clip.contentType, "audio/mpeg");
  assert.equal(sent[0]!.url, "https://texttospeech.googleapis.com/v1/text:synthesize");
  assert.ok(!sent[0]!.url.includes("g-key"));
  assert.equal(sent[0]!.headers["x-goog-api-key"], "g-key");
  assert.deepEqual(JSON.parse(sent[0]!.body), {
    input: { text: "hallo" },
    voice: { languageCode: "de-DE", name: "de-DE-Neural2-B" },
    audioConfig: { audioEncoding: "MP3" },
  });

  const empty = recorder(() => Response.json({}));
  await assert.rejects(synthesizeSpeech({ settings: settings("google"), text: "x", key: "k", fetchFn: empty.fetchFn }), TtsUpstreamError);
});

test("googleLanguageCode prefers the voice name, then the text language", () => {
  assert.equal(googleLanguageCode("en-GB-Standard-A"), "en-GB");
  assert.equal(googleLanguageCode("cmn-CN-Wavenet-A"), "cmn-CN");
  assert.equal(googleLanguageCode("", "uk-UA"), "uk-UA");
  assert.equal(googleLanguageCode("", "auto"), "en-US");
  assert.equal(googleLanguageCode("", "not a tag"), "en-US");
});

test("Amazon Polly signs a regional request with the key pair", async () => {
  const { sent, fetchFn } = recorder(audio);
  await synthesizeSpeech({
    settings: settings("polly", { region: "eu-west-1", voice: "Amy" }),
    text: "hello",
    key: "AKIDTEST",
    secret: "secret-test",
    fetchFn,
    now: () => new Date("2026-01-02T03:04:05Z"),
  });
  assert.equal(sent[0]!.url, "https://polly.eu-west-1.amazonaws.com/v1/speech");
  assert.deepEqual(JSON.parse(sent[0]!.body), { Engine: "neural", OutputFormat: "mp3", Text: "hello", VoiceId: "Amy" });
  assert.equal(sent[0]!.headers["x-amz-date"], "20260102T030405Z");
  assert.match(sent[0]!.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/20260102\/eu-west-1\/polly\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(sent[0]).includes("secret-test"));

  await assert.rejects(
    synthesizeSpeech({ settings: settings("polly"), text: "x", key: "AKID", fetchFn }),
    /secret API key is not set/,
  );
});

test("Gradium asks for raw WAV audio with x-api-key", async () => {
  const { sent, fetchFn } = recorder(() => new Response(new Uint8Array([5]).buffer, { status: 200 }));
  const clip = await synthesizeSpeech({ settings: settings("gradium", { model: "default" }), text: "hello", key: "gr-key", fetchFn });
  assert.equal(clip.contentType, "audio/wav");
  assert.equal(sent[0]!.url, "https://api.gradium.ai/api/post/speech/tts");
  assert.equal(sent[0]!.headers["x-api-key"], "gr-key");
  assert.deepEqual(JSON.parse(sent[0]!.body), {
    text: "hello", voice_id: "YTpq7expH9539ERJ", output_format: "wav", only_audio: true, model_name: "default",
  });
});

test("hosted services refuse to run without a key and report upstream status", async () => {
  const { fetchFn } = recorder(() => new Response("no", { status: 429 }));
  for (const provider of ["openai", "elevenlabs", "google", "gradium"] as const) {
    await assert.rejects(synthesizeSpeech({ settings: settings(provider), text: "x", fetchFn }), /API key is not set/);
    await assert.rejects(
      synthesizeSpeech({ settings: settings(provider), text: "x", key: "k", fetchFn }),
      (error: unknown) => error instanceof TtsUpstreamError && error.status === 429,
    );
  }
});

test("text is cut to each service's request limit", async () => {
  const { sent, fetchFn } = recorder(() => Response.json({ audioContent: "AA==" }));
  await synthesizeSpeech({ settings: settings("google"), text: "a".repeat(10_000), key: "k", fetchFn });
  assert.equal(JSON.parse(sent[0]!.body).input.text.length, ttsProviderInfo("google").maxChars);
  assert.equal(new Set(TTS_PROVIDERS.map((provider) => provider.id)).size, TTS_PROVIDERS.length);
});
