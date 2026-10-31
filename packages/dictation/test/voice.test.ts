// Voice settings hold secret REFERENCES only (env var names — never
// values), URLs are validated, the TTS proxy sends standard fields only and
// buffers the clip, and summarize fails soft for its callers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVoiceSettings } from "../../server/src/voice.ts";
import { ProviderRegistry } from "../src/providers.ts";
import { voiceRoutes } from "../src/serverEntry.ts";
import type { RouteRequest } from "../../server/src/http.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-voice-"));

test("voice settings: round-trip persists refs, validates URLs and env names", () => {
  const file = join(tmp(), "voice.json");
  const svc = createVoiceSettings({ file, env: { WHISPER_KEY: "secret-value" } });

  assert.deepEqual(svc.get().stt, { baseUrl: "", model: "", language: "", apiKeyEnv: "" });
  assert.equal(svc.get().dictation.localModel, "nemotron-3.5-streaming-0.6b-560ms");
  assert.equal(svc.get().dictation.processingPolicy, "prefer-cloud");
  assert.equal(svc.get().dictation.fallbackProvider, undefined);

  const saved = svc.put({
    stt: { baseUrl: "http://127.0.0.1:8000/v1", model: "whisper-1", language: "en", apiKeyEnv: "WHISPER_KEY" },
    tts: { baseUrl: "https://tts.example/v1", model: "tts-1", voice: "alloy", apiKeyEnv: "" },
  });
  assert.equal(saved.stt.apiKeyEnv, "WHISPER_KEY");
  assert.equal(svc.resolveKey("stt"), "secret-value");
  assert.equal(svc.resolveKey("tts"), undefined);

  const onDisk = readFileSync(file, "utf8");
  assert.match(onDisk, /WHISPER_KEY/);
  assert.doesNotMatch(onDisk, /secret-value/);

  const reloaded = createVoiceSettings({ file, env: {} });
  assert.equal(reloaded.get().tts.model, "tts-1");

  assert.throws(() => svc.put({ stt: { baseUrl: "ftp://x" } }), /http\(s\)/);
  assert.throws(() => svc.put({ stt: { baseUrl: "not a url" } }), /invalid/);
  assert.throws(() => svc.put({ tts: { apiKeyEnv: "sk-abc!*" } }), /environment variable NAME/);
});

function harness(opts: {
  env?: Record<string, string>;
  fetchFn?: typeof fetch;
  summarize?: (text: string, userId?: string) => Promise<string>;
}) {
  const voice = createVoiceSettings({ file: join(tmp(), "voice.json"), env: opts.env ?? {} });
  const routes = voiceRoutes({
    voice,
    providers: new ProviderRegistry(),
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    ...(opts.summarize ? { summarize: opts.summarize } : {}),
  });
  const call = async (method: string, path: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    let rawBody: Buffer | null = null;
    let rawHeaders: Record<string, unknown> = {};
    const rc = {
      req: {},
      res: {
        writeHead: (code: number, headers: Record<string, unknown>) => { status = code; rawHeaders = headers; },
        end: (b: Buffer) => { rawBody = b; },
      },
      url: new URL(`http://x${path}`),
      space: { userId: "usr_test" },
      path, method,
      body: async () => body,
      json: (code: number, b: unknown) => { status = code; payload = b; },
    } as unknown as RouteRequest;
    const handled = await routes(rc);
    return { handled, status, payload, rawBody: rawBody as Buffer | null, rawHeaders };
  };
  return { voice, call };
}

test("GET /api/settings/voice exposes refs + configured flags, never key values", async () => {
  const { voice, call } = harness({ env: { TTS_KEY: "super-secret" } });
  voice.put({ tts: { baseUrl: "https://tts.example/v1", apiKeyEnv: "TTS_KEY" } });
  const r = await call("GET", "/api/settings/voice");
  assert.equal(r.status, 200);
  const dto = r.payload as { sttConfigured: boolean; ttsConfigured: boolean };
  assert.equal(dto.sttConfigured, false);
  assert.equal(dto.ttsConfigured, true);
  assert.doesNotMatch(JSON.stringify(r.payload), /super-secret/);
});

test("ElevenLabs direct token is forbidden by local processing policies before any upstream call", async () => {
  let fetches = 0;
  const { voice, call } = harness({
    env: { ELEVENLABS_API_KEY: "long-lived-secret" },
    fetchFn: (async () => {
      fetches++;
      return new Response(JSON.stringify({ token: "should-not-happen" }), { status: 200 });
    }) as typeof fetch,
  });
  voice.put({
    dictation: {
      provider: "elevenlabs",
      transport: "direct-browser",
      processingPolicy: "local-only",
      apiKeyEnv: "ELEVENLABS_API_KEY",
    },
  });
  const result = await call("POST", "/api/dictation/token", { provider: "elevenlabs" });
  assert.equal(result.status, 400);
  assert.equal(fetches, 0);
  assert.doesNotMatch(JSON.stringify(result.payload), /long-lived-secret/);
});

test("ElevenLabs direct token is minted server-side without echoing the long-lived key", async () => {
  const upstreamKeys: string[] = [];
  const { voice, call } = harness({
    env: { ELEVENLABS_API_KEY: "long-lived-secret" },
    fetchFn: (async (_url, init) => {
      upstreamKeys.push(String((init?.headers as Record<string, string>)?.["xi-api-key"] ?? ""));
      return new Response(JSON.stringify({ token: "single-use-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  voice.put({
    dictation: {
      provider: "elevenlabs",
      transport: "direct-browser",
      processingPolicy: "prefer-cloud",
      apiKeyEnv: "ELEVENLABS_API_KEY",
    },
  });
  const result = await call("POST", "/api/dictation/token", { provider: "elevenlabs" });
  assert.equal(result.status, 200);
  assert.deepEqual(upstreamKeys, ["long-lived-secret"]);
  assert.deepEqual(result.payload, { provider: "elevenlabs", token: "single-use-token", expiresInSeconds: 900 });
  assert.doesNotMatch(JSON.stringify(result.payload), /long-lived-secret/);
});

test("a cloud fallback provider cannot mint a direct token while local is primary", async () => {
  let fetches = 0;
  const { voice, call } = harness({
    env: { ELEVENLABS_API_KEY: "fallback-secret" },
    fetchFn: (async () => {
      fetches++;
      return new Response(JSON.stringify({ token: "unexpected" }), { status: 200 });
    }) as typeof fetch,
  });
  voice.put({
    dictation: {
      provider: "local-nemotron",
      transport: "local-worker",
      processingPolicy: "prefer-local",
      fallbackProvider: "elevenlabs",
      fallbackApiKeyEnv: "ELEVENLABS_API_KEY",
    },
  });
  const result = await call("POST", "/api/dictation/token", { provider: "elevenlabs" });
  assert.equal(result.status, 400);
  assert.equal(fetches, 0);
});

test("tts/speak is an honest 503 unconfigured, proxies standard fields when set", async () => {
  const unset = harness({});
  const off = await unset.call("POST", "/api/tts/speak", { text: "hi" });
  assert.equal(off.status, 503);

  const sent: Array<{ url: string; body: string; auth: string | undefined }> = [];
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(url),
      body: String(init?.body ?? ""),
      auth: (init?.headers as Record<string, string>)?.authorization,
    });
    return new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200, headers: { "content-type": "audio/mpeg" } });
  }) as typeof fetch;

  const { voice, call } = harness({ env: { TTS_KEY: "resolved-key" }, fetchFn });
  voice.put({ tts: { baseUrl: "https://tts.example/v1/", model: "tts-1", voice: "alloy", apiKeyEnv: "TTS_KEY" } });

  const noText = await call("POST", "/api/tts/speak", { text: " " });
  assert.equal(noText.status, 400);

  const ok = await call("POST", "/api/tts/speak", { text: "read this", voice: "nova" });
  assert.equal(ok.status, 200);
  assert.equal(ok.rawHeaders["content-type"], "audio/mpeg");
  assert.deepEqual([...(ok.rawBody ?? Buffer.alloc(0))], [1, 2, 3]);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.url, "https://tts.example/v1/audio/speech");
  assert.equal(sent[0]?.auth, "Bearer resolved-key");
  assert.deepEqual(Object.keys(JSON.parse(sent[0]!.body)).sort(), ["input", "model", "response_format", "voice"]);
  assert.equal(JSON.parse(sent[0]!.body).voice, "nova");

  const upstreamFail = harness({
    fetchFn: (async () => new Response("no", { status: 500 })) as typeof fetch,
  });
  upstreamFail.voice.put({ tts: { baseUrl: "https://tts.example" } });
  const bad = await upstreamFail.call("POST", "/api/tts/speak", { text: "x" });
  assert.equal(bad.status, 502);
});

test("tts/speak: hosted services need their key (pair) and reach their own endpoint", async () => {
  const sent: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), headers: init?.headers as Record<string, string> });
    return new Response(new Uint8Array([4]).buffer, { status: 200, headers: { "content-type": "audio/mpeg" } });
  }) as typeof fetch;
  const { voice, call } = harness({ env: { AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "aws-secret" }, fetchFn });

  // A legacy file without a provider stays OpenAI-compatible.
  assert.equal(voice.get().tts.provider, "openai-compatible");

  voice.put({ tts: { provider: "polly", apiKeyEnv: "AWS_ACCESS_KEY_ID", region: "eu-central-1", voice: "Vicki" } });
  assert.equal(((await call("GET", "/api/settings/voice")).payload as { ttsConfigured: boolean }).ttsConfigured, false);
  const missing = await call("POST", "/api/tts/speak", { text: "hallo" });
  assert.equal(missing.status, 503);
  assert.match(String((missing.payload as { message: string }).message), /Amazon Polly key/);

  const saved = voice.put({ tts: { provider: "polly", apiKeyEnv: "AWS_ACCESS_KEY_ID", secretKeyEnv: "AWS_SECRET_ACCESS_KEY", region: "eu-central-1", voice: "Vicki", baseUrl: "https://ignored.example/v1" } });
  assert.equal(saved.tts.secretKeyEnv, "AWS_SECRET_ACCESS_KEY");
  const settingsDto = await call("GET", "/api/settings/voice");
  assert.equal((settingsDto.payload as { ttsConfigured: boolean }).ttsConfigured, true);
  assert.doesNotMatch(JSON.stringify(settingsDto.payload), /aws-secret/);

  const ok = await call("POST", "/api/tts/speak", { text: "hallo" });
  assert.equal(ok.status, 200);
  assert.equal(sent.at(-1)?.url, "https://polly.eu-central-1.amazonaws.com/v1/speech");

  const badVoice = await call("POST", "/api/tts/speak", { text: "hallo", voice: "../x" });
  assert.equal(badVoice.status, 400);

  assert.throws(() => voice.put({ tts: { provider: "polly", region: "not a region" } }), /region is invalid/);
  assert.throws(() => voice.put({ tts: { provider: "elevenlabs", voice: "a/b" } }), /plain voice name/);
  assert.throws(() => voice.put({ tts: { provider: "polly", secretKeyEnv: "raw secret!" } }), /environment variable NAME/);
  assert.equal(voice.put({ tts: { provider: "nope" } }).tts.provider, "openai-compatible");
});

test("a key typed in Settings is write-only, used for its own service only, and removable", async () => {
  const sent: Array<Record<string, string>> = [];
  const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent.push(init?.headers as Record<string, string>);
    return new Response(new Uint8Array([7]).buffer, { status: 200, headers: { "content-type": "audio/mpeg" } });
  }) as typeof fetch;
  const dir = tmp();
  const file = join(dir, "voice.json");
  const voice = createVoiceSettings({ file, env: {} });
  const routes = voiceRoutes({ voice, providers: new ProviderRegistry(), fetchFn });
  const call = async (method: string, path: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    await routes({
      req: {}, res: { writeHead: (code: number) => { status = code; }, end: () => {} },
      url: new URL(`http://x${path}`), space: { userId: "usr_test" }, path, method,
      body: async () => body,
      json: (code: number, b: unknown) => { status = code; payload = b; },
    } as unknown as RouteRequest);
    return { status, payload: payload as { ttsConfigured: boolean; storedKeys: string[] } };
  };

  const typed = "sk_0123456789abcdef0123456789abcdef";
  const saved = await call("PUT", "/api/settings/voice", {
    tts: { provider: "elevenlabs", apiKeyEnv: "ELEVENLABS_API_KEY", voice: "JBFqnCBsd6RMkjVDRZzb" },
    keys: { "tts:elevenlabs": typed },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.ttsConfigured, true);
  assert.deepEqual(saved.payload.storedKeys, ["tts:elevenlabs"]);
  assert.doesNotMatch(JSON.stringify(saved.payload), new RegExp(typed));
  assert.doesNotMatch(readFileSync(file, "utf8"), new RegExp(typed));
  const secrets = join(dir, "voice-secrets.json");
  assert.equal(statSync(secrets).mode & 0o777, 0o600);

  assert.equal((await call("POST", "/api/tts/speak", { text: "hi" })).status, 200);
  assert.equal(sent.at(-1)?.["xi-api-key"], typed);

  // Survives a restart; another service never receives this key.
  const reloaded = createVoiceSettings({ file, env: {} });
  assert.equal(reloaded.resolveKey("tts"), typed);
  reloaded.put({ tts: { provider: "openai", apiKeyEnv: "OPENAI_API_KEY" } });
  assert.equal(reloaded.resolveKey("tts"), undefined);
  assert.deepEqual(reloaded.storedKeys(), ["tts:elevenlabs"]);

  // Saving other settings keeps the key; null forgets it.
  await call("PUT", "/api/settings/voice", { tts: { provider: "elevenlabs" } });
  assert.equal(voice.resolveKey("tts"), typed);
  const cleared = await call("PUT", "/api/settings/voice", { tts: { provider: "elevenlabs" }, keys: { "tts:elevenlabs": null } });
  assert.deepEqual(cleared.payload.storedKeys, []);
  assert.equal(cleared.payload.ttsConfigured, false);

  assert.throws(() => voice.put({ keys: { "tts:nope": "x" } }), /unknown voice key slot/);
  assert.throws(() => voice.put({ keys: { "tts:elevenlabs": "two words" } }), /single line/);
});

test("keys pasted into a variable-name field become stored keys instead of leaking or failing", () => {
  const dir = tmp();
  const file = join(dir, "voice.json");
  const pasted = "Ab12cd34Ef56gh78Ij90kl12Mn34op56";
  const groq = "gsk_" + "a1B2c3D4e5".repeat(5);
  writeFileSync(file, JSON.stringify({
    stt: { baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo", apiKeyEnv: groq },
    tts: { provider: "openai-compatible", baseUrl: "", model: "", voice: "", apiKeyEnv: "" },
    dictation: { provider: "speechmatics", processingPolicy: "prefer-cloud", apiKeyEnv: pasted },
  }));
  const voice = createVoiceSettings({ file, env: { my_voice_key_2025_prod: "env-value" } });
  assert.equal(voice.resolveDictationProviderKey("speechmatics"), pasted);
  assert.equal(voice.resolveKey("stt"), groq);
  assert.equal(voice.get().dictation.apiKeyEnv, "SPEECHMATICS_API_KEY");
  assert.equal(voice.get().stt.apiKeyEnv, "");
  assert.deepEqual(voice.storedKeys(), ["dictation:speechmatics", "stt"]);
  const onDisk = readFileSync(file, "utf8");
  assert.doesNotMatch(onDisk, new RegExp(pasted));
  assert.doesNotMatch(onDisk, new RegExp(groq));

  // A real variable name — even a long lower-case one — stays a reference, and
  // a pasted key that is not a valid variable name is adopted, not refused.
  voice.put({ tts: { provider: "openai", apiKeyEnv: "my_voice_key_2025_prod" } });
  assert.equal(voice.resolveKey("tts"), "env-value");
  const openai = "sk-proj-" + "Zx9_yW8-".repeat(4);
  const saved = voice.put({ tts: { provider: "openai", apiKeyEnv: openai } });
  assert.equal(saved.tts.apiKeyEnv, "");
  assert.equal(voice.resolveKey("tts"), openai);
});

test("tts/summarize: 503 unwired, small-model text when wired, 502 on failure", async () => {
  const unwired = harness({});
  assert.equal((await unwired.call("POST", "/api/tts/summarize", { text: "long reply" })).status, 503);

  const wired = harness({ summarize: async (t) => `short: ${t.slice(0, 4)}` });
  const ok = await wired.call("POST", "/api/tts/summarize", { text: "long reply" });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.payload, { text: "short: long" });

  const failing = harness({ summarize: async () => { throw new Error("model offline"); } });
  const soft = await failing.call("POST", "/api/tts/summarize", { text: "x" });
  assert.equal(soft.status, 502);
  assert.match(String((soft.payload as { message: string }).message), /model offline/);
});

test("tts/summarize forwards the authenticated account to small-model selection", async () => {
  let userId: string | undefined;
  const h = harness({
    summarize: async (_text, requestedBy) => {
      userId = requestedBy;
      return "short";
    },
  });
  assert.equal((await h.call("POST", "/api/tts/summarize", { text: "long reply" })).status, 200);
  assert.equal(userId, "usr_test");
});
