import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWisprSttAdapter, DICTATION_FORMAT } from "@polyth/dictation";

class FakeSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    callback?.();
  }

  close(): void {
    this.readyState = 3;
  }
}

const message = (socket: FakeSocket, at: number): Record<string, unknown> =>
  JSON.parse(socket.sent[at]!) as Record<string, unknown>;

test("Wispr Flow proxy uses documented 16k WAV auth/append/commit protocol with bounded context", async () => {
  const socket = new FakeSocket();
  let connectedUrl = "";
  const adapter = createWisprSttAdapter({
    apiKey: "fl-server-secret",
    connect(url) {
      connectedUrl = url;
      return socket as never;
    },
  });

  const stream = adapter.createStream({
    format: DICTATION_FORMAT,
    language: "uk-UA",
    context: {
      language: "uk-UA",
      keywords: ["Polyth", "Nemotron"],
      technicalVocabulary: ["AudioWorklet"],
      glossary: { worktree: "робоче дерево" },
      app: { name: "Polyth", type: "ai" },
      composer: { beforeCursor: "before ", selection: "selected", afterCursor: " after" },
    },
  });

  const url = new URL(connectedUrl);
  assert.equal(url.origin, "wss://platform-api.wisprflow.ai");
  assert.equal(url.pathname, "/api/v1/dash/ws");
  assert.equal(url.searchParams.get("api_key"), "Bearer fl-server-secret");

  socket.readyState = 1;
  socket.emit("open");
  const auth = message(socket, 0);
  assert.equal(auth.type, "auth");
  assert.equal(auth.access_token, "fl-server-secret");
  assert.deepEqual(auth.language, ["uk"]);
  const context = auth.context as {
    dictionary_context?: string[];
    textbox_contents?: Record<string, string>;
  };
  assert.ok(context.dictionary_context?.includes("Polyth"));
  assert.ok(context.dictionary_context?.includes("AudioWorklet"));
  assert.ok(context.dictionary_context?.includes("worktree"));
  assert.deepEqual(context.textbox_contents, {
    before_text: "before ",
    selected_text: "selected",
    after_text: " after",
  });

  socket.emit("message", JSON.stringify({ status: "auth" }));
  await stream.push(new Uint8Array(32_000));
  const append = message(socket, 1) as {
    type?: string;
    position?: number;
    audio_packets?: {
      packets?: string[];
      volumes?: number[];
      packet_duration?: number;
      audio_encoding?: string;
      byte_encoding?: string;
    };
  };
  assert.equal(append.type, "append");
  assert.equal(append.position, 0);
  assert.equal(append.audio_packets?.packet_duration, 1);
  assert.equal(append.audio_packets?.audio_encoding, "wav");
  assert.equal(append.audio_packets?.byte_encoding, "base64");
  assert.equal(append.audio_packets?.packets?.length, 1);
  assert.equal(append.audio_packets?.volumes?.length, 1);

  const final = stream.finalize();
  await nextTurn();
  const commit = message(socket, 2);
  assert.equal(commit.type, "commit");
  assert.equal(commit.total_packets, 1);

  // Wispr's published examples currently show final=false even for the final
  // text block, so an answer received after an explicit commit is authoritative.
  socket.emit("message", JSON.stringify({
    status: "text",
    final: false,
    body: { text: "Привіт з Polyth" },
  }));
  assert.equal(await final, "Привіт з Polyth");
});

test("Wispr Flow rejects non-16k canonical audio before opening a provider socket", () => {
  const adapter = createWisprSttAdapter({
    apiKey: "fl-server-secret",
    connect() {
      throw new Error("must not connect");
    },
  });
  assert.throws(
    () => adapter.createStream({
      format: { encoding: "pcm_s16le", sampleRate: 24_000, channels: 1 },
    }),
    (error: unknown) => (error as { code?: string }).code === "audio_format_error",
  );
});
