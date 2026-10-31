import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElevenLabsSttAdapter, DICTATION_FORMAT } from "@polyth/dictation";

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

test("ElevenLabs realtime maps bounded context to documented keyterm query params", async () => {
  const socket = new FakeSocket();
  let connectedUrl = "";
  let headers: Record<string, string> = {};
  const adapter = createElevenLabsSttAdapter({
    apiKey: "server-secret",
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
      keywords: ["Polyth", "very-long-repository-symbol-name"],
      glossary: { "worktree": "робоче дерево" },
    },
  });
  const url = new URL(connectedUrl);
  assert.equal(url.searchParams.get("model_id"), "scribe_v2_realtime");
  assert.equal(url.searchParams.get("language_code"), "uk");
  assert.equal(url.searchParams.get("audio_format"), "pcm_16000");
  const keyterms = url.searchParams.getAll("keyterms");
  assert.ok(keyterms.includes("Polyth"));
  assert.ok(keyterms.includes("worktree"));
  assert.ok(keyterms.every((term) => term.length <= 20));
  assert.equal(headers["xi-api-key"], "server-secret");

  // No API secret is serialized into the connection URL.
  assert.equal(connectedUrl.includes("server-secret"), false);
  await stream.cancel?.();
});
