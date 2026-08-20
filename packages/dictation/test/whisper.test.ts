// F8: Whisper adapter against a stub OpenAI-compatible HTTP server — WAV
// packaging, standard-fields-only multipart upload, auth header from the
// resolved key, JSON/plain-text response handling, and the adapter-provider
// capability flip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  DICTATION_FORMAT, createDictationService, createWhisperSttAdapter,
  downsampleToPcm16, pcmToWav, type SttAdapter,
} from "@polyth/dictation";

interface Seen { url: string; auth: string | undefined; body: Buffer; contentType: string }

function stubServer(respond: (seen: Seen) => { status: number; body: string; type?: string }): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const s: Seen = {
        url: req.url ?? "",
        auth: req.headers.authorization,
        body: Buffer.concat(chunks),
        contentType: req.headers["content-type"] ?? "",
      };
      seen.push(s);
      const r = respond(s);
      res.writeHead(r.status, { "content-type": r.type ?? "application/json" });
      res.end(r.body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, seen });
    });
  });
}

test("pcmToWav writes a correct RIFF header for 16k mono s16le", () => {
  const pcm = new Uint8Array([1, 2, 3, 4]);
  const wav = pcmToWav(pcm, DICTATION_FORMAT);
  const dv = new DataView(wav.buffer);
  assert.equal(wav.byteLength, 48);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF");
  assert.equal(dv.getUint32(4, true), 36 + 4);
  assert.equal(String.fromCharCode(...wav.subarray(8, 12)), "WAVE");
  assert.equal(dv.getUint16(20, true), 1);        // PCM
  assert.equal(dv.getUint16(22, true), 1);        // mono
  assert.equal(dv.getUint32(24, true), 16000);    // sample rate
  assert.equal(dv.getUint32(28, true), 32000);    // byte rate
  assert.equal(dv.getUint32(40, true), 4);        // data length
  assert.deepEqual([...wav.subarray(44)], [1, 2, 3, 4]);
});

test("whisper adapter uploads once on finalize with standard fields and auth", async () => {
  const { server, url, seen } = await stubServer(() => ({ status: 200, body: JSON.stringify({ text: " hello world " }) }));
  try {
    const adapter = createWhisperSttAdapter({ baseUrl: `${url}/`, model: "whisper-1", apiKey: "sk-test", language: "de" });
    const stream = adapter.createStream({ format: DICTATION_FORMAT, language: "en" });
    stream.push(new Uint8Array([0, 1]));
    stream.push(new Uint8Array([2, 3]));
    const text = await stream.finalize();
    assert.equal(text, "hello world");

    assert.equal(seen.length, 1, "single upload on finalize");
    const req = seen[0]!;
    assert.equal(req.url, "/v1/audio/transcriptions");
    assert.equal(req.auth, "Bearer sk-test");
    assert.match(req.contentType, /multipart\/form-data/);
    const body = req.body.toString("latin1");
    assert.match(body, /name="model"[\s\S]*?whisper-1/);
    assert.match(body, /name="language"[\s\S]*?en/, "per-stream language beats the default");
    assert.match(body, /name="response_format"[\s\S]*?json/);
    assert.match(body, /RIFF/, "WAV payload present");
    assert.doesNotMatch(body, /name="(temperature|stream|timestamp)/, "no non-standard params");
  } finally {
    server.close();
  }
});

test("whisper adapter handles plain-text responses and HTTP errors", async () => {
  const plain = await stubServer(() => ({ status: 200, body: "plain transcript", type: "text/plain" }));
  try {
    const stream = createWhisperSttAdapter({ baseUrl: plain.url }).createStream({ format: DICTATION_FORMAT });
    stream.push(new Uint8Array([9]));
    assert.equal(await stream.finalize(), "plain transcript");
  } finally {
    plain.server.close();
  }

  const failing = await stubServer(() => ({ status: 500, body: "boom" }));
  try {
    const stream = createWhisperSttAdapter({ baseUrl: failing.url }).createStream({ format: DICTATION_FORMAT });
    stream.push(new Uint8Array([9]));
    await assert.rejects(() => stream.finalize(), /HTTP 500/);
  } finally {
    failing.server.close();
  }

  // cancelled or empty streams never hit the network
  const untouched = await stubServer(() => ({ status: 200, body: "{}" }));
  try {
    const adapter = createWhisperSttAdapter({ baseUrl: untouched.url });
    const cancelled = adapter.createStream({ format: DICTATION_FORMAT });
    cancelled.push(new Uint8Array([1]));
    cancelled.cancel?.();
    assert.equal(await cancelled.finalize(), "");
    const empty = adapter.createStream({ format: DICTATION_FORMAT });
    assert.equal(await empty.finalize(), "");
    assert.equal(untouched.seen.length, 0);
  } finally {
    untouched.server.close();
  }
});

test("dictation service adapter provider flips capability without recreation", () => {
  let adapter: SttAdapter | null = null;
  const svc = createDictationService({ adapter: () => adapter, unavailableReason: "not configured" });
  assert.deepEqual(svc.capability(), { available: false, reason: "not configured" });
  adapter = createWhisperSttAdapter({ baseUrl: "http://127.0.0.1:1" });
  assert.deepEqual(svc.capability(), { available: true, engine: "whisper" });
  adapter = null;
  assert.equal(svc.capability().available, false);
});

test("downsampleToPcm16 averages windows and clamps to s16 range", () => {
  // 48k -> 16k: each output sample averages 3 inputs
  const input = new Float32Array([0.5, 0.5, 0.5, -2, -2, -2, 1, 1, 1]);
  const out = downsampleToPcm16(input, 48000, 16000);
  assert.equal(out.length, 3);
  assert.equal(out[0], Math.round(0.5 * 0x7fff));
  assert.equal(out[1], -0x8000, "clamped below -1");
  assert.equal(out[2], 0x7fff);
  assert.throws(() => downsampleToPcm16(new Float32Array(4), 8000, 16000), /cannot upsample/);
});
