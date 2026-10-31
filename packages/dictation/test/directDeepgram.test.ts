import { test } from "node:test";
import assert from "node:assert/strict";
import { startDirectDeepgramDictation } from "../widgets/directDeepgram.ts";
import type { Pcm16Capture, Pcm16CaptureOptions } from "../widgets/audioCapture.ts";

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<string | Uint8Array> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor() {
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
    if (typeof data !== "string") return;
    const message = JSON.parse(data) as { type?: string };
    if (message.type === "Finalize") {
      queueMicrotask(() => this.onmessage?.({
        data: JSON.stringify({
          type: "Results",
          is_final: true,
          channel: { alternatives: [{ transcript: "Привіт з Deepgram" }] },
        }),
      }));
    }
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
}

test("Deepgram direct transport uses an ephemeral Bearer subprotocol and raw PCM", async () => {
  const tokenRequests: Array<{ path: string; body: string }> = [];
  const sockets: FakeSocket[] = [];
  const protocolsSeen: string[][] = [];
  const urls: string[] = [];
  let captureOptions: Pcm16CaptureOptions | null = null;
  let stopped = false;

  const fetchFn: typeof fetch = async (input, init) => {
    tokenRequests.push({ path: String(input), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ token: "header.payload.signature", expiresInSeconds: 60 }), {
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

  const stream = await startDirectDeepgramDictation({
    model: "nova-3",
    language: "uk-UA",
    context: { language: "uk-UA", keywords: ["Polyth"] },
    fetchFn,
    socketFactory(url, protocols) {
      urls.push(url);
      protocolsSeen.push(protocols);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    captureFactory,
  });

  assert.deepEqual(tokenRequests, [{ path: "/api/dictation/token", body: JSON.stringify({ provider: "deepgram" }) }]);
  assert.deepEqual(protocolsSeen[0], ["bearer", "header.payload.signature"]);
  const url = new URL(urls[0]!);
  assert.equal(url.origin, "wss://api.deepgram.com");
  assert.equal(url.pathname, "/v1/listen");
  assert.equal(url.searchParams.get("model"), "nova-3");
  assert.equal(url.searchParams.get("encoding"), "linear16");
  assert.equal(url.searchParams.get("sample_rate"), "16000");
  assert.equal(url.searchParams.get("language"), "uk");
  assert.ok(url.searchParams.getAll("keyterm").includes("Polyth"));
  assert.equal(urls[0]!.includes("header.payload.signature"), false);

  captureOptions!.onChunk(new Uint8Array([1, 0, 2, 0]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(sockets[0]!.sent.some((message) => message instanceof Uint8Array));

  assert.equal(await stream.stop(), "Привіт з Deepgram");
  assert.equal(stopped, true);
  assert.ok(sockets[0]!.sent.some((message) =>
    typeof message === "string" && JSON.parse(message).type === "Finalize"));
});
