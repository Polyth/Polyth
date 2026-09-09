import { test } from "node:test";
import assert from "node:assert/strict";
import { startDirectWisprDictation } from "../widgets/directWispr.ts";
import type { Pcm16Capture, Pcm16CaptureOptions } from "../widgets/audioCapture.ts";

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    this.sent.push(data);
    const message = JSON.parse(data) as { type?: string };
    if (message.type === "auth") {
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ status: "auth" }) }));
    } else if (message.type === "commit") {
      queueMicrotask(() => this.onmessage?.({
        data: JSON.stringify({ status: "text", final: false, body: { text: "Привіт з Wispr" } }),
      }));
    }
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
}

test("Wispr direct transport mints a client JWT and keeps the org API key off the browser wire", async () => {
  const urls: string[] = [];
  const tokenRequests: Array<{ path: string; body: string }> = [];
  const sockets: FakeSocket[] = [];
  let captureOptions: Pcm16CaptureOptions | null = null;
  let stopped = false;

  const fetchFn: typeof fetch = async (input, init) => {
    tokenRequests.push({ path: String(input), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ token: "wispr-client-jwt", expiresInSeconds: 900 }), {
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

  const stream = await startDirectWisprDictation({
    language: "uk-UA",
    clientId: "test-client",
    context: {
      language: "uk-UA",
      keywords: ["Polyth", "Nemotron"],
      technicalVocabulary: ["AudioWorklet"],
      composer: { beforeCursor: "before ", afterCursor: " after" },
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
  assert.deepEqual(JSON.parse(tokenRequests[0]!.body), { provider: "wispr", clientId: "test-client" });
  const providerUrl = new URL(urls[0]!);
  assert.equal(providerUrl.origin, "wss://platform-api.wisprflow.ai");
  assert.equal(providerUrl.pathname, "/api/v1/dash/client_ws");
  assert.equal(providerUrl.searchParams.get("client_key"), "Bearer wispr-client-jwt");
  assert.equal(urls[0]!.includes("fl-"), false);

  const auth = JSON.parse(sockets[0]!.sent[0]!) as {
    type?: string;
    access_token?: string;
    language?: string[];
    context?: { dictionary_context?: string[] };
  };
  assert.equal(auth.type, "auth");
  assert.equal(auth.access_token, "wispr-client-jwt");
  assert.deepEqual(auth.language, ["uk"]);
  assert.ok(auth.context?.dictionary_context?.includes("Polyth"));
  assert.ok(auth.context?.dictionary_context?.includes("AudioWorklet"));

  // A complete one-second canonical PCM packet becomes one documented WAV append.
  captureOptions!.onChunk(new Uint8Array(32_000));
  await new Promise((resolve) => setImmediate(resolve));
  const append = sockets[0]!.sent
    .map((item) => JSON.parse(item) as {
      type?: string;
      position?: number;
      audio_packets?: { packet_duration?: number; audio_encoding?: string; byte_encoding?: string };
    })
    .find((item) => item.type === "append");
  assert.equal(append?.position, 0);
  assert.equal(append?.audio_packets?.packet_duration, 1);
  assert.equal(append?.audio_packets?.audio_encoding, "wav");
  assert.equal(append?.audio_packets?.byte_encoding, "base64");

  assert.equal(await stream.stop(), "Привіт з Wispr");
  assert.equal(stopped, true);
  const commit = sockets[0]!.sent
    .map((item) => JSON.parse(item) as { type?: string; total_packets?: number })
    .find((item) => item.type === "commit");
  assert.equal(commit?.total_packets, 1);
});
