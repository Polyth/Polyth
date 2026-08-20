// F8: voice settings hold secret REFERENCES only (env var names — never
// values), URLs are validated, the TTS proxy sends standard fields only and
// buffers the clip, and summarize fails soft for its callers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVoiceSettings } from "../src/voice.ts";
import { voiceRoutes } from "../src/routes/voice.ts";
import type { RouteRequest } from "../src/http.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-voice-"));

test("voice settings: round-trip persists refs, validates URLs and env names", () => {
  const file = join(tmp(), "voice.json");
  const svc = createVoiceSettings({ file, env: { WHISPER_KEY: "secret-value" } });

  assert.deepEqual(svc.get().stt, { baseUrl: "", model: "", language: "", apiKeyEnv: "" });

  const saved = svc.put({
    stt: { baseUrl: "http://127.0.0.1:8000/v1", model: "whisper-1", language: "en", apiKeyEnv: "WHISPER_KEY" },
    tts: { baseUrl: "https://tts.example/v1", model: "tts-1", voice: "alloy", apiKeyEnv: "" },
  });
  assert.equal(saved.stt.apiKeyEnv, "WHISPER_KEY");
  assert.equal(svc.resolveKey("stt"), "secret-value");
  assert.equal(svc.resolveKey("tts"), undefined);

  // the file on disk holds the ref, never the value
  const onDisk = readFileSync(file, "utf8");
  assert.match(onDisk, /WHISPER_KEY/);
  assert.doesNotMatch(onDisk, /secret-value/);

  // reload from disk keeps the settings
  const reloaded = createVoiceSettings({ file, env: {} });
  assert.equal(reloaded.get().tts.model, "tts-1");

  assert.throws(() => svc.put({ stt: { baseUrl: "ftp://x" } }), /http\(s\)/);
  assert.throws(() => svc.put({ stt: { baseUrl: "not a url" } }), /invalid/);
  // a pasted secret VALUE is refused as a ref
  assert.throws(() => svc.put({ tts: { apiKeyEnv: "sk-abc!*" } }), /environment variable NAME/);
});

function harness(opts: {
  env?: Record<string, string>;
  fetchFn?: typeof fetch;
  summarize?: (text: string) => Promise<string>;
}) {
  const voice = createVoiceSettings({ file: join(tmp(), "voice.json"), env: opts.env ?? {} });
  const routes = voiceRoutes({
    voice,
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
  // standard fields only — nothing non-OpenAI leaks to the upstream server
  assert.deepEqual(Object.keys(JSON.parse(sent[0]!.body)).sort(), ["input", "model", "response_format", "voice"]);
  assert.equal(JSON.parse(sent[0]!.body).voice, "nova");

  const upstreamFail = harness({
    fetchFn: (async () => new Response("no", { status: 500 })) as typeof fetch,
  });
  upstreamFail.voice.put({ tts: { baseUrl: "https://tts.example" } });
  const bad = await upstreamFail.call("POST", "/api/tts/speak", { text: "x" });
  assert.equal(bad.status, 502);
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
