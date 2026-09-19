import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createOpenAIRealtimeSttAdapter,
  createPcm16Resampler,
  DICTATION_FORMAT,
} from "@polyth/dictation";

class FakeSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  send(data: string, callback?: (error?: Error) => void): void {
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

const parseSent = (socket: FakeSocket): Array<Record<string, unknown>> =>
  socket.sent.map((value) => JSON.parse(value) as Record<string, unknown>);

const pcm16 = (samples: number[]): Uint8Array => {
  const pcm = new Int16Array(samples);
  return new Uint8Array(pcm.buffer);
};

test("16 kHz -> 24 kHz resampler preserves phase across chunk boundaries", () => {
  const resampler = createPcm16Resampler(16_000, 24_000);
  const a = resampler.push(pcm16(Array.from({ length: 320 }, (_, i) => i * 10)));
  const b = resampler.push(pcm16(Array.from({ length: 320 }, (_, i) => (i + 320) * 10)));
  const totalSamples = (a.byteLength + b.byteLength) / 2;
  assert.ok(totalSamples >= 958 && totalSamples <= 960);
  assert.equal(a.byteLength % 2, 0);
  assert.equal(b.byteLength % 2, 0);
});

test("GPT Live Transcribe configures 24 kHz manual turns and bounded context", async () => {
  const socket = new FakeSocket();
  let connectedUrl = "";
  let headers: Record<string, string> = {};
  const adapter = createOpenAIRealtimeSttAdapter({
    apiKey: "openai-secret",
    model: "gpt-live-transcribe",
    latencyPreference: "balanced",
    connect(url, suppliedHeaders) {
      connectedUrl = url;
      headers = suppliedHeaders;
      return socket as never;
    },
  });
  const stream = adapter.createStream({
    format: DICTATION_FORMAT,
    language: "uk-UA",
    context: {
      language: "uk-UA",
      localeHints: ["en-US"],
      keywords: ["Polyth", "bad<term>\nnext"],
      glossary: { harness: "agent harness" },
      lexicalContext: "Polyth coding session",
    },
  });

  assert.equal(new URL(connectedUrl).searchParams.get("model"), "gpt-live-transcribe");
  assert.equal(headers.Authorization, "Bearer openai-secret");
  assert.equal(connectedUrl.includes("openai-secret"), false);

  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  const sessionUpdate = parseSent(socket)[0]!;
  assert.equal(sessionUpdate.type, "session.update");
  const session = sessionUpdate.session as {
    type: string;
    audio: { input: { format: { type: string; rate: number }; transcription: {
      model: string; prompt?: string; keywords?: string[]; languages?: string[]; delay?: string;
    }; turn_detection: unknown } };
  };
  assert.equal(session.type, "transcription");
  assert.deepEqual(session.audio.input.format, { type: "audio/pcm", rate: 24_000 });
  assert.equal(session.audio.input.turn_detection, null);
  assert.equal(session.audio.input.transcription.model, "gpt-live-transcribe");
  assert.equal(session.audio.input.transcription.delay, "medium");
  assert.deepEqual(session.audio.input.transcription.languages, ["uk", "en"]);
  assert.ok(session.audio.input.transcription.keywords?.includes("Polyth"));
  assert.ok(session.audio.input.transcription.keywords?.every((keyword) => !/[<>\r\n]/.test(keyword)));
  assert.match(session.audio.input.transcription.prompt ?? "", /Polyth coding session/);

  const source = pcm16(Array.from({ length: 320 }, (_, i) => Math.sin(i / 10) * 10_000));
  await stream.push(source);
  const append = parseSent(socket).find((event) => event.type === "input_audio_buffer.append")!;
  const converted = Buffer.from(String(append.audio), "base64");
  assert.ok(converted.byteLength > source.byteLength);
  assert.ok(converted.byteLength >= source.byteLength * 1.49);

  socket.emit("message", JSON.stringify({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "item-1",
    delta: "Привіт",
  }));
  socket.emit("message", JSON.stringify({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "item-1",
    delta: ", світ",
  }));
  assert.equal(stream.partial?.(), "Привіт, світ");
  await stream.cancel?.();
});

test("GPT Transcribe waits for commit and resolves the completed transcript", async () => {
  const socket = new FakeSocket();
  const adapter = createOpenAIRealtimeSttAdapter({
    apiKey: "test",
    model: "gpt-transcribe",
    finalTimeoutMs: 500,
    connect: () => socket as never,
  });
  const stream = adapter.createStream({ format: DICTATION_FORMAT, language: "auto" });
  socket.open();
  await stream.push(pcm16(Array.from({ length: 320 }, () => 100)));

  const finalPromise = stream.finalize();
  await new Promise((resolve) => setImmediate(resolve));
  const sent = parseSent(socket);
  const update = sent.find((event) => event.type === "session.update")!;
  const transcription = (((update.session as { audio: { input: { transcription: Record<string, unknown> } } }).audio.input.transcription));
  assert.equal(transcription.model, "gpt-transcribe");
  assert.equal("delay" in transcription, false);
  assert.ok(sent.some((event) => event.type === "input_audio_buffer.commit"));

  socket.emit("message", JSON.stringify({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "item-1",
    delta: "Bonjour",
  }));
  socket.emit("message", JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item-1",
    transcript: "Bonjour tout le monde",
    languages: [{ code: "fr" }],
  }));
  assert.equal(await finalPromise, "Bonjour tout le monde");
});

test("OpenAI realtime maps provider auth failures", async () => {
  const socket = new FakeSocket();
  const adapter = createOpenAIRealtimeSttAdapter({
    apiKey: "bad",
    model: "gpt-live-transcribe",
    connect: () => socket as never,
  });
  const stream = adapter.createStream({ format: DICTATION_FORMAT });
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit("message", JSON.stringify({
    type: "error",
    error: { code: "invalid_api_key", message: "Incorrect API key provided" },
  }));
  await assert.rejects(
    async () => { await stream.push(pcm16([1, 2, 3, 4])); },
    (error: unknown) => (error as { code?: string }).code === "invalid_credentials",
  );
});
