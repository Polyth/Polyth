import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpeechmaticsSttAdapter, DICTATION_FORMAT } from "@polyth/dictation";

class FakeSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  sent: Array<string | Uint8Array> = [];
  send(data: string | Uint8Array, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    callback?.();
  }
  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", code, Buffer.from(reason)));
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
}

const controls = (socket: FakeSocket) => socket.sent
  .filter((item): item is string => typeof item === "string")
  .map((item) => JSON.parse(item) as Record<string, unknown>);

test("Speechmatics starts realtime recognition with safe auth and bounded context", async () => {
  const socket = new FakeSocket();
  let url = "";
  let headers: Record<string, string> = {};
  const adapter = createSpeechmaticsSttAdapter({
    apiKey: "speechmatics-secret",
    latencyPreference: "lowest",
    connect(nextUrl, nextHeaders) {
      url = nextUrl;
      headers = nextHeaders;
      return socket as never;
    },
  });
  const stream = adapter.createStream({
    format: DICTATION_FORMAT,
    language: "uk-UA",
    context: {
      language: "uk-UA",
      keywords: ["Polyth", "worktree"],
      glossary: { harness: "agent harness" },
    },
  });

  assert.equal(url, "wss://global.rt.speechmatics.com/v2");
  assert.equal(headers.Authorization, "Bearer speechmatics-secret");
  assert.equal(url.includes("speechmatics-secret"), false);

  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  const start = controls(socket)[0] as {
    message: string;
    audio_format: { type: string; encoding: string; sample_rate: number };
    transcription_config: { language: string; model: string; max_delay: number; enable_partials: boolean; additional_vocab?: string[] };
  };
  assert.equal(start.message, "StartRecognition");
  assert.deepEqual(start.audio_format, { type: "raw", encoding: "pcm_s16le", sample_rate: 16000 });
  assert.equal(start.transcription_config.language, "uk");
  assert.equal(start.transcription_config.model, "enhanced");
  assert.equal(start.transcription_config.max_delay, 0.7);
  assert.equal(start.transcription_config.enable_partials, true);
  assert.ok(start.transcription_config.additional_vocab?.includes("Polyth"));
  assert.ok(start.transcription_config.additional_vocab?.includes("agent harness"));

  socket.emit("message", JSON.stringify({ message: "RecognitionStarted" }));
  const pcm = new Uint8Array([1, 0, 2, 0]);
  await stream.push(pcm);
  assert.ok(socket.sent.some((item) => item instanceof Uint8Array));
  socket.emit("message", JSON.stringify({ message: "AddPartialTranscript", metadata: { transcript: "прив" } }));
  assert.equal(stream.partial?.(), "прив");
  await stream.cancel?.();
});

test("Speechmatics finalization uses the last audio sequence and returns committed text", async () => {
  const socket = new FakeSocket();
  const adapter = createSpeechmaticsSttAdapter({
    apiKey: "test",
    connect: () => socket as never,
    finalTimeoutMs: 500,
  });
  const stream = adapter.createStream({ format: DICTATION_FORMAT, language: "uk-UA" });
  socket.open();
  socket.emit("message", JSON.stringify({ message: "RecognitionStarted" }));
  await stream.push(new Uint8Array([1, 0]));
  await stream.push(new Uint8Array([2, 0]));
  socket.emit("message", JSON.stringify({ message: "AddTranscript", metadata: { transcript: "привіт" } }));

  const finalPromise = stream.finalize();
  await new Promise((resolve) => setImmediate(resolve));
  const end = controls(socket).find((item) => item.message === "EndOfStream") as { last_seq_no?: number } | undefined;
  assert.equal(end?.last_seq_no, 2);
  socket.emit("message", JSON.stringify({ message: "AddTranscript", metadata: { transcript: "світ" } }));
  socket.emit("message", JSON.stringify({ message: "EndOfTranscript" }));
  assert.equal(await finalPromise, "привіт світ");
});

test("Speechmatics maps authorization and quota failures", async () => {
  for (const [type, expected] of [
    ["not_authorised", "invalid_credentials"],
    ["quota_exceeded", "rate_limited"],
  ] as const) {
    const socket = new FakeSocket();
    const adapter = createSpeechmaticsSttAdapter({ apiKey: "test", connect: () => socket as never });
    const stream = adapter.createStream({ format: DICTATION_FORMAT, language: "en" });
    socket.open();
    socket.emit("message", JSON.stringify({ message: "Error", type, reason: type }));
    await assert.rejects(
      async () => { await stream.push(new Uint8Array([1, 0])); },
      (error: unknown) => (error as { code?: string }).code === expected,
    );
  }
});
