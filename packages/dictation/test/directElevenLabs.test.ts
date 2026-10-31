import { test } from "node:test";
import assert from "node:assert/strict";
import { startDirectElevenLabsDictation } from "../widgets/directElevenLabs.ts";
import type { Pcm16Capture, Pcm16CaptureOptions } from "../widgets/audioCapture.ts";

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(_url: string) {
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ message_type: "session_started" }) }));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
}

test("ElevenLabs direct transport uses a single-use token and never exposes the API key", async () => {
  const urls: string[] = [];
  const sockets: FakeSocket[] = [];
  const tokenRequests: Array<{ path: string; body: string }> = [];
  let captureOptions: Pcm16CaptureOptions | null = null;
  let stopped = false;

  const fetchFn: typeof fetch = async (input, init) => {
    const path = String(input);
    tokenRequests.push({ path, body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ token: "single-use-token" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const captureFactory = async (options: Pcm16CaptureOptions): Promise<Pcm16Capture> => {
    captureOptions = options;
    return {
      sampleRate: 16_000,
      channels: 1,
      pause: async () => {},
      resume: async () => {},
      stop: () => { stopped = true; },
    };
  };

  const stream = await startDirectElevenLabsDictation({
    model: "scribe_v2_realtime",
    language: "uk-UA",
    context: {
      language: "uk-UA",
      keywords: [
        "Polyth",
        "worktree",
        "worktree",
        "very-long-project-symbol-that-must-be-truncated",
        ...Array.from({ length: 60 }, (_, index) => `term-${index}`),
      ],
      glossary: { harness: "agent harness" },
    },
    fetchFn,
    socketFactory(url) {
      urls.push(url);
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    captureFactory,
  });

  assert.equal(tokenRequests.length, 1);
  assert.equal(tokenRequests[0]?.path, "/api/dictation/token");
  assert.match(tokenRequests[0]?.body ?? "", /elevenlabs/);
  const providerUrl = new URL(urls[0]!);
  assert.equal(providerUrl.searchParams.get("token"), "single-use-token");
  assert.equal(providerUrl.searchParams.get("model_id"), "scribe_v2_realtime");
  assert.equal(providerUrl.searchParams.get("audio_format"), "pcm_16000");
  assert.equal(providerUrl.searchParams.get("language_code"), "uk");
  const terms = providerUrl.searchParams.getAll("keyterms");
  assert.ok(terms.includes("Polyth"));
  assert.equal(terms.filter((term) => term === "worktree").length, 1);
  assert.equal(terms.length, 50);
  assert.ok(terms.every((term) => term.length <= 20));
  assert.equal(urls[0]!.includes("api-key"), false);

  captureOptions!.onChunk(new Uint8Array([1, 0, 2, 0]));
  await new Promise((resolve) => setImmediate(resolve));
  const audio = sockets[0]!.sent
    .map((item) => JSON.parse(item) as { message_type?: string; audio_base_64?: string; commit?: boolean })
    .find((item) => item.message_type === "input_audio_chunk" && !item.commit);
  assert.ok(audio?.audio_base_64);

  const finalPromise = stream.stop();
  await new Promise((resolve) => setImmediate(resolve));
  const commit = sockets[0]!.sent
    .map((item) => JSON.parse(item) as { message_type?: string; commit?: boolean })
    .find((item) => item.message_type === "input_audio_chunk" && item.commit === true);
  assert.ok(commit);
  sockets[0]!.onmessage?.({
    data: JSON.stringify({ message_type: "committed_transcript", text: "привіт Polyth" }),
  });
  assert.equal(await finalPromise, "привіт Polyth");
  assert.equal(stopped, true);
});
