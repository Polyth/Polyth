// Recorded (batch) dictation on the server: chunked upload, ordering, gaps,
// limits, the batch engine choice, the stream fallback for engines without a
// file endpoint, failover, cancellation and the HTTP routes a phone uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DictationError,
  createDictationService,
  createFailoverSttAdapter,
  recordingModelFor,
  transcribeRecording,
  type SttAdapter,
  type SttTranscribeInput,
} from "@polyth/dictation";
import { dictationRoutes } from "../src/serverEntry.ts";

const pcm = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes);

const batchAdapter = (respond: (input: SttTranscribeInput) => Promise<string> | string = (input) => `heard ${input.audio.byteLength}`) => {
  const calls: SttTranscribeInput[] = [];
  const adapter: SttAdapter = {
    engine: "fake-batch",
    createStream: () => { throw new Error("a recording must not open a live stream"); },
    async transcribe(input) {
      calls.push(input);
      return respond(input);
    },
  };
  return { adapter, calls };
};

const streamOnlyAdapter = () => {
  const pushes: Uint8Array[] = [];
  let finalized = 0;
  const adapter: SttAdapter = {
    engine: "fake-stream",
    createStream: () => ({
      push(chunk) { pushes.push(chunk.slice()); },
      async finalize() {
        finalized++;
        return `streamed ${pushes.reduce((sum, chunk) => sum + chunk.byteLength, 0)}`;
      },
    }),
  };
  return { adapter, pushes, finalized: () => finalized };
};

test("a recording is stored chunk by chunk and transcribed once, in order, on finalize", async () => {
  const { adapter, calls } = batchAdapter();
  const service = createDictationService({ adapter });
  const session = service.create({ mode: "batch", language: "uk-UA", context: { keywords: ["Polyth"] } });
  assert.equal(session.mode, "batch");

  assert.deepEqual(await service.push(session.id, 2, pcm(3, 4)), { ack: 0, duplicate: false, buffered: true });
  assert.equal(calls.length, 0, "no audio reaches the provider before finalize");
  assert.deepEqual(await service.push(session.id, 1, pcm(1, 2)), { ack: 2, duplicate: false });
  assert.deepEqual(await service.push(session.id, 2, pcm(3, 4)), { ack: 2, duplicate: true },
    "a resent chunk is a duplicate, not a second copy");
  await assert.rejects(() => service.push(session.id, 2, pcm(9, 9, 9, 9)), (error: unknown) =>
    (error as { code?: string }).code === "conflict");

  const done = await service.finalize(session.id);
  assert.equal(done.status, "done");
  assert.equal(done.transcript, "heard 4");
  assert.equal(calls.length, 1);
  assert.deepEqual([...calls[0]!.audio], [1, 2, 3, 4]);
  assert.equal(calls[0]!.language, "uk-UA");
  assert.deepEqual(calls[0]!.context?.keywords, ["Polyth"]);
  assert.ok(calls[0]!.signal instanceof AbortSignal);
  assert.deepEqual(await service.finalize(session.id), done, "finalize is idempotent");
  await assert.rejects(() => service.push(session.id, 3, pcm(5, 6)), (error: unknown) =>
    (error as { code?: string }).code === "conflict");
});

test("a missing chunk keeps the recording open for the resend", async () => {
  const { adapter, calls } = batchAdapter();
  const service = createDictationService({ adapter });
  const session = service.create({ mode: "batch" });
  await service.push(session.id, 1, pcm(1, 2));
  await service.push(session.id, 3, pcm(5, 6));
  await assert.rejects(() => service.finalize(session.id), (error: unknown) =>
    (error as { code?: string }).code === "gap");
  assert.equal(service.get(session.id)?.status, "recording");
  await service.push(session.id, 2, pcm(3, 4));
  assert.equal((await service.finalize(session.id)).transcript, "heard 6");
  assert.equal(calls.length, 1);
});

test("recording chunks are validated and capped", async () => {
  const { adapter } = batchAdapter();
  const service = createDictationService({ adapter, maxBatchChunks: 4, maxBatchDurationMs: 1 });
  const session = service.create({ mode: "batch" });
  for (const [seq, chunk] of [[0, pcm(1, 2)], [5, pcm(1, 2)], [1.5, pcm(1, 2)], [1, pcm()], [1, pcm(1)]] as const) {
    await assert.rejects(() => service.push(session.id, seq, chunk));
  }
  assert.equal(service.get(session.id)?.status, "recording", "a malformed chunk does not end the recording");
  // 1 ms of 16 kHz mono PCM16 is 32 bytes.
  await service.push(session.id, 1, new Uint8Array(32));
  await assert.rejects(() => service.push(session.id, 2, new Uint8Array(2)), (error: unknown) =>
    (error as { code?: string }).code === "too-long");
  assert.equal(service.get(session.id)?.status, "failed");
});

test("an empty recording finishes without calling the provider", async () => {
  const { adapter, calls } = batchAdapter();
  const service = createDictationService({ adapter });
  const session = service.create({ mode: "batch" });
  assert.equal((await service.finalize(session.id)).transcript, "");
  assert.equal(calls.length, 0);
});

test("recordings use the batch engine, which may exist when the live route does not", async () => {
  const { adapter } = batchAdapter();
  const service = createDictationService({ adapter: null, batchAdapter: adapter, unavailableReason: "browser-direct" });
  assert.deepEqual(service.capability(), { available: false, reason: "browser-direct" });
  assert.deepEqual(service.capability("batch"), { available: true, engine: "fake-batch" });
  assert.throws(() => service.create({}), (error: unknown) => (error as { code?: string }).code === "unavailable");
  assert.equal(service.create({ mode: "batch" }).metrics.provider, "fake-batch");

  const off = createDictationService({ adapter, batchAdapter: null });
  assert.equal(off.capability("batch").available, false);
  assert.equal(off.capability().available, true);
});

test("an engine without a file endpoint hears the recording through its live stream", async () => {
  const { adapter, pushes, finalized } = streamOnlyAdapter();
  const service = createDictationService({ adapter });
  const session = service.create({ mode: "batch" });
  // 250 ms of audio arrives as one chunk and is fed in 100 ms writes.
  await service.push(session.id, 1, new Uint8Array(8_000));
  const done = await service.finalize(session.id);
  assert.equal(done.transcript, "streamed 8000");
  assert.deepEqual(pushes.map((chunk) => chunk.byteLength), [3_200, 3_200, 1_600]);
  assert.equal(finalized(), 1);
});

test("cancel and the provider deadline abort the recording's provider call", async () => {
  let seen: AbortSignal | undefined;
  const hanging: SttAdapter = {
    engine: "hang",
    createStream: () => { throw new Error("unused"); },
    transcribe: ({ signal }) => new Promise((_, reject) => {
      seen = signal;
      signal?.addEventListener("abort", () => reject(signal.reason));
    }),
  };
  const service = createDictationService({ adapter: hanging, batchTimeoutMs: 20 });
  const timed = service.create({ mode: "batch" });
  await service.push(timed.id, 1, pcm(1, 2));
  await assert.rejects(() => service.finalize(timed.id), (error: unknown) =>
    error instanceof DictationError && error.code === "network_error");
  assert.equal(service.get(timed.id)?.status, "failed");

  const slow = createDictationService({ adapter: hanging, batchTimeoutMs: 60_000 });
  const cancelled = slow.create({ mode: "batch" });
  await slow.push(cancelled.id, 1, pcm(1, 2));
  const pending = slow.finalize(cancelled.id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  slow.cancel(cancelled.id);
  await assert.rejects(pending);
  assert.equal(seen?.aborted, true);
  assert.equal(slow.get(cancelled.id), null);
});

test("transcribeRecording prefers the adapter's batch call and stops a stream on abort", async () => {
  const { adapter, calls } = batchAdapter(() => "batch");
  const format = { encoding: "pcm_s16le" as const, sampleRate: 16_000, channels: 1 };
  assert.equal(await transcribeRecording(adapter, { audio: pcm(1, 2), format }), "batch");
  assert.equal(calls.length, 1);

  let cancelled = 0;
  const controller = new AbortController();
  const streaming: SttAdapter = {
    engine: "s",
    createStream: () => ({
      push() { controller.abort(new DictationError("session_expired", "stop")); },
      finalize: async () => "never",
      cancel() { cancelled++; },
    }),
  };
  await assert.rejects(
    () => transcribeRecording(streaming, { audio: new Uint8Array(32_000), format, signal: controller.signal }),
    (error: unknown) => (error as { code?: string }).code === "session_expired",
  );
  assert.ok(cancelled >= 1, "the half-fed stream is cancelled");
});

test("failover gives a recording to the fallback only after a recoverable failure", async () => {
  const failing = (code: "network_error" | "invalid_credentials"): SttAdapter => ({
    engine: "primary",
    createStream: () => { throw new Error("unused"); },
    transcribe: async () => { throw new DictationError(code, code); },
  });
  const { adapter: fallback, calls } = batchAdapter(() => "from fallback");
  const recovered = createFailoverSttAdapter(failing("network_error"), fallback);
  const format = { encoding: "pcm_s16le" as const, sampleRate: 16_000, channels: 1 };
  assert.equal(await recovered.transcribe!({ audio: pcm(1, 2), format }), "from fallback");
  assert.deepEqual([...calls[0]!.audio], [1, 2]);

  const refused = createFailoverSttAdapter(failing("invalid_credentials"), fallback);
  await assert.rejects(() => refused.transcribe!({ audio: pcm(1, 2), format }), (error: unknown) =>
    (error as { code?: string }).code === "invalid_credentials");
  assert.equal(calls.length, 1, "a credentials failure is not sent to another provider");
});

test("recordings map realtime-only models to the provider's file model", () => {
  assert.equal(recordingModelFor("elevenlabs"), "scribe_v2");
  assert.equal(recordingModelFor("elevenlabs", "scribe_v2_realtime"), "scribe_v2");
  assert.equal(recordingModelFor("elevenlabs", "scribe_v3_realtime"), "scribe_v3");
  assert.equal(recordingModelFor("openai-live", "gpt-live-transcribe"), "gpt-transcribe");
  assert.equal(recordingModelFor("openai-transcribe", "gpt-realtime-whisper"), "gpt-transcribe");
  assert.equal(recordingModelFor("openai-transcribe", "gpt-4o-transcribe"), "gpt-4o-transcribe");
  assert.equal(recordingModelFor("deepgram", "nova-2"), "nova-2");
  assert.equal(recordingModelFor("openai-compatible", "whisper-large-v3"), "whisper-large-v3");
  assert.equal(recordingModelFor("speechmatics"), undefined, "no file model: the live stream is used");
});

const call = async (
  route: ReturnType<typeof dictationRoutes>,
  method: string,
  path: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; payload: Record<string, unknown> }> => {
  let status = 0;
  let payload: Record<string, unknown> = {};
  const url = new URL(path, "http://polyth.test");
  await route({
    path: url.pathname,
    url,
    method,
    body: async () => body,
    json(code: number, value: unknown) { status = code; payload = value as Record<string, unknown>; },
  } as never);
  return { status, payload };
};

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

test("a phone uploads a recording as base64 chunks and finalizes it over HTTP", async () => {
  const { adapter, calls } = batchAdapter((input) => `text ${[...input.audio].join(",")}`);
  const route = dictationRoutes(createDictationService({ adapter: null, batchAdapter: adapter }));

  assert.equal((await call(route, "GET", "/api/dictation/capability")).payload.available, false);
  assert.equal((await call(route, "GET", "/api/dictation/capability?mode=batch")).payload.available, true);

  assert.equal((await call(route, "POST", "/api/dictation/sessions", { mode: "live" })).status, 400);
  const created = await call(route, "POST", "/api/dictation/sessions", { mode: "batch", language: "en-US" });
  assert.equal(created.status, 200);
  const id = String(created.payload.id);

  assert.deepEqual((await call(route, "POST", `/api/dictation/sessions/${id}/audio`, { seq: 2, audio: b64(pcm(3, 4)) })).payload,
    { ack: 0, duplicate: false, buffered: true });
  assert.deepEqual((await call(route, "POST", `/api/dictation/sessions/${id}/audio`, { seq: 1, audio: b64(pcm(1, 2)) })).payload,
    { ack: 2, duplicate: false });
  assert.equal((await call(route, "POST", `/api/dictation/sessions/${id}/audio`, { seq: 3, audio: "not base64!" })).status, 400);
  assert.equal((await call(route, "POST", `/api/dictation/sessions/${id}/audio`, { seq: 3, audio: "" })).status, 400);
  assert.equal((await call(route, "POST", `/api/dictation/sessions/${id}/audio`, {
    seq: 3,
    audio: b64(new Uint8Array(512 * 1024 + 2)),
  })).status, 413, "one request carries at most one recording chunk");

  const final = await call(route, "POST", `/api/dictation/sessions/${id}/finalize`);
  assert.equal(final.status, 200);
  assert.equal(final.payload.transcript, "text 1,2,3,4");
  assert.equal(calls.length, 1);

  assert.equal((await call(route, "POST", "/api/dictation/sessions/missing/audio", { seq: 1, audio: b64(pcm(1, 2)) })).status, 404);
});

test("live sessions do not take audio over the recording route", async () => {
  const { adapter: live } = streamOnlyAdapter();
  const route = dictationRoutes(createDictationService({ adapter: live }));
  const created = await call(route, "POST", "/api/dictation/sessions", {});
  assert.equal(created.payload.mode, "stream");
  const refused = await call(route, "POST", `/api/dictation/sessions/${String(created.payload.id)}/audio`, { seq: 1, audio: b64(pcm(1, 2)) });
  assert.equal(refused.status, 409);
});
