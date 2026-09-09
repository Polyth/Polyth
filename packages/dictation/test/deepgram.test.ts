import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeepgramSttAdapter, DICTATION_FORMAT } from "@polyth/dictation";

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

test("Deepgram Nova-3 uses raw PCM, safe auth headers, and bounded keyterms", async () => {
  const socket = new FakeSocket();
  let connectedUrl = "";
  let headers: Record<string, string> = {};
  const adapter = createDeepgramSttAdapter({
    apiKey: "deepgram-secret",
    connect(url, suppliedHeaders) {
      connectedUrl = url;
      headers = suppliedHeaders;
      return socket as never;
    },
  });
  const stream = adapter.createStream({
    format: DICTATION_FORMAT,
    language: "auto",
    context: {
      language: "auto",
      keywords: ["Polyth", "worktree"],
      glossary: { harness: "agent harness" },
    },
  });

  const url = new URL(connectedUrl);
  assert.equal(url.searchParams.get("model"), "nova-3");
  assert.equal(url.searchParams.get("encoding"), "linear16");
  assert.equal(url.searchParams.get("sample_rate"), "16000");
  assert.equal(url.searchParams.get("language"), "multi");
  assert.ok(url.searchParams.getAll("keyterm").includes("Polyth"));
  assert.equal(headers.Authorization, "Token deepgram-secret");
  assert.equal(connectedUrl.includes("deepgram-secret"), false);

  socket.open();
  const pcm = new Uint8Array([1, 0, 2, 0]);
  await stream.push(pcm);
  assert.equal(socket.sent.length, 1);
  assert.ok(socket.sent[0] instanceof Uint8Array);
  assert.deepEqual([...socket.sent[0] as Uint8Array], [...pcm]);

  socket.emit("message", JSON.stringify({
    type: "Results",
    is_final: false,
    channel: { alternatives: [{ transcript: "hello" }] },
  }));
  assert.equal(stream.partial?.(), "hello");
  await stream.cancel?.();
});

test("Deepgram finalization commits the final result and sends Finalize", async () => {
  const socket = new FakeSocket();
  const adapter = createDeepgramSttAdapter({
    apiKey: "test",
    connect: () => socket as never,
    finalTimeoutMs: 500,
  });
  const stream = adapter.createStream({ format: DICTATION_FORMAT, language: "uk-UA" });
  socket.open();
  await stream.push(new Uint8Array([1, 0]));
  socket.emit("message", JSON.stringify({
    type: "Results",
    is_final: true,
    channel: { alternatives: [{ transcript: "привіт" }] },
  }));

  const finalPromise = stream.finalize();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(socket.sent.some((item) => typeof item === "string" && JSON.parse(item).type === "Finalize"));
  socket.emit("message", JSON.stringify({
    type: "Results",
    is_final: true,
    channel: { alternatives: [{ transcript: "світ" }] },
  }));
  assert.equal(await finalPromise, "привіт світ");
});
