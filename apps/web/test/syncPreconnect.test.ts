// The early /ws dial: main.tsx starts it while the app graph evaluates, and the
// SyncClient adopts it. Everything the early socket saw reaches the adopter in
// order, once its handlers are on; a socket that already failed is never
// handed over, so the client dials at once instead of backing off.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adoptPreconnectedSync,
  adoptedSocketOpenBefore,
  preconnectSync,
  resetPreconnectForTest,
  syncSocketUrl,
} from "../src/syncPreconnect.ts";
import { SyncClient } from "../src/sync.ts";

class FakeSocket {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: string[] = [];
  closed = false;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.({} as Event); }
  message(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent); }
  ended(code = 1006): void { this.readyState = 3; this.onclose?.({ code } as CloseEvent); }
}

const URL = "ws://polyth.test/ws";
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("the socket URL follows the page's scheme", () => {
  assert.equal(syncSocketUrl({ protocol: "https:", host: "polyth.app" }), "wss://polyth.app/ws");
  assert.equal(syncSocketUrl({ protocol: "http:", host: "127.0.0.1:4400" }), "ws://127.0.0.1:4400/ws");
});

test("a SyncClient adopts the early socket and receives what it saw, in order, after its handlers are on", async () => {
  resetPreconnectForTest();
  const early = new FakeSocket();
  preconnectSync(URL, () => early);
  early.open();
  early.message({ type: "client-settings/changed", settings: { revision: 3, settings: {} } });
  const dialled: string[] = [];
  const client = new SyncClient({
    webSocket: (url) => adoptPreconnectedSync(url) ?? (dialled.push(url), new FakeSocket()),
  });
  const seen: string[] = [];
  client.onEvent((message) => seen.push(message.type));
  client.setSubscription("s1", 7, "p1");
  client.connect(URL);
  assert.deepEqual(dialled, [], "no second handshake");
  assert.equal(client.getStatus(), "connecting", "nothing replays synchronously");
  await settle();
  assert.equal(client.getStatus(), "connected");
  assert.deepEqual(seen, ["client-settings/changed"]);
  const subscribe = JSON.parse(early.sent[0]!);
  assert.equal(subscribe.type, "subscribe");
  assert.equal(subscribe.sessionId, "s1");
  assert.equal(subscribe.afterSeq, 7);
  // Later traffic flows straight through.
  early.message({ type: "projection", session: { id: "s1", status: "idle" } });
  assert.deepEqual(seen, ["client-settings/changed", "projection"]);
  assert.ok(adoptedSocketOpenBefore(performance.now()), "it was open before now");
  assert.equal(adoptedSocketOpenBefore(-1), false);
  // Its close reaches the client, which then retries as usual.
  early.ended();
  assert.equal(client.getStatus(), "reconnecting");
  client.close();
  resetPreconnectForTest();
});

test("an early socket still connecting is adopted and opens under the client", async () => {
  resetPreconnectForTest();
  const early = new FakeSocket();
  preconnectSync(URL, () => early);
  const client = new SyncClient({ webSocket: (url) => adoptPreconnectedSync(url) ?? new FakeSocket() });
  client.setSubscription("s1", 0);
  client.connect(URL);
  await settle();
  assert.equal(client.getStatus(), "connecting");
  early.open();
  assert.equal(client.getStatus(), "connected");
  assert.equal(JSON.parse(early.sent[0]!).type, "subscribe");
  assert.equal(adoptedSocketOpenBefore(performance.now()), false, "it opened only after adoption");
  client.close();
  assert.equal(early.closed, true);
  resetPreconnectForTest();
});

test("a failed or foreign early socket is dropped, never handed over", () => {
  resetPreconnectForTest();
  const failed = new FakeSocket();
  preconnectSync(URL, () => failed);
  failed.ended();
  assert.equal(adoptPreconnectedSync(URL), null);
  assert.equal(adoptPreconnectedSync(URL), null, "at most once");

  const other = new FakeSocket();
  preconnectSync(URL, () => other);
  assert.equal(adoptPreconnectedSync("ws://elsewhere.test/ws"), null);
  assert.equal(other.closed, true, "a mismatched dial is closed, not leaked");
  assert.equal(adoptPreconnectedSync(URL), null);
  resetPreconnectForTest();
});

test("one early dial per document; a throwing constructor leaves nothing behind", () => {
  resetPreconnectForTest();
  let made = 0;
  preconnectSync(URL, () => { made++; return new FakeSocket(); });
  preconnectSync(URL, () => { made++; return new FakeSocket(); });
  assert.equal(made, 1);
  resetPreconnectForTest();
  preconnectSync(URL, () => { throw new Error("blocked"); });
  assert.equal(adoptPreconnectedSync(URL), null);
  resetPreconnectForTest();
});
