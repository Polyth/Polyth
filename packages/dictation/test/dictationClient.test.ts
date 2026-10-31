import { test } from "node:test";
import assert from "node:assert/strict";
import { startStreamingDictation } from "../widgets/dictationClient.ts";

const withGlobals = async (values: Record<string, unknown>, run: () => Promise<void>): Promise<void> => {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  try {
    await run();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
};

class FakeSocket {
  static readonly OPEN = 1;
  static opened: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeSocket.opened.push(this); }
  send() {}
  close() { this.readyState = 3; }
}

const fakeCapture = {
  navigator: {
    mediaDevices: {
      async getUserMedia() {
        const track = { onended: null, stop() {} };
        return { getAudioTracks: () => [track], getTracks: () => [track] };
      },
    },
  },
  AudioContext: class {
    state = "running";
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async close() {}
  },
  AudioWorkletNode: class {
    port = { onmessage: null };
    connect() {}
    disconnect() {}
  },
  URL: Object.assign(Object.create(URL), { createObjectURL: () => "blob:worklet", revokeObjectURL() {} }),
};

test("a policy close fails the dictation instead of reconnecting forever", async () => {
  FakeSocket.opened = [];
  const requests: string[] = [];
  const errors: string[] = [];
  await withGlobals({
    ...fakeCapture,
    WebSocket: FakeSocket,
    location: { protocol: "http:", host: "127.0.0.1:4000" },
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    fetch: async (path: string, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${path}`);
      return new Response(JSON.stringify({ id: "d1", acknowledgedSeq: 0 }), { status: 200 });
    },
  }, async () => {
    const stream = await startStreamingDictation({ onError: (message) => errors.push(message) });
    const socket = FakeSocket.opened[0]!;
    socket.readyState = FakeSocket.OPEN;
    socket.onopen?.();
    socket.onclose?.({ code: 1008, reason: "audio rate exceeded" } as CloseEvent);

    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(FakeSocket.opened.length, 1, "a refused socket must not be reopened");
    assert.deepEqual(errors, ["audio rate exceeded"]);
    await assert.rejects(() => stream.stop(), /audio rate exceeded/);
    assert.ok(requests.includes("DELETE /api/dictation/sessions/d1"));
  });
});

test("an ordinary close still reconnects", async () => {
  FakeSocket.opened = [];
  await withGlobals({
    ...fakeCapture,
    WebSocket: FakeSocket,
    location: { protocol: "http:", host: "127.0.0.1:4000" },
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    fetch: async () => new Response(JSON.stringify({ id: "d2", acknowledgedSeq: 0 }), { status: 200 }),
  }, async () => {
    const stream = await startStreamingDictation({});
    FakeSocket.opened[0]!.onclose?.({ code: 1006, reason: "" } as CloseEvent);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(FakeSocket.opened.length, 2);
    stream.cancel();
  });
});
