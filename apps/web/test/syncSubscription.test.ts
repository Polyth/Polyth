// Behavioral guard for the websocket resubscription contract. The original bug
// compared a raw `null` activeSessionId against a stored `undefined`, so every
// ordinary store update on New Chat re-sent the subscription until the server
// closed the socket with code 1008. Assertions observe the subscribe frames
// actually written to the socket, not the variable names in init.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });

class FakeSocket {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.({} as Event); }
}

test("the sync subscription re-sends only when the connection scope changes", async () => {
  const { SyncClient } = await import("../src/sync.ts");
  const { subscribeSyncScope } = await import("../src/init.ts");
  const store = await import("../src/store.ts");

  const sockets: FakeSocket[] = [];
  const client = new SyncClient({ webSocket: () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  } });
  client.connect("ws://test/ws");
  const socket = sockets[0]!;
  socket.open();
  const frames = (): Array<Record<string, unknown>> => socket.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((message) => message.type === "subscribe");

  // New Chat: a project is active but no session. This is the shape that
  // previously produced the raw null/undefined mismatch.
  store.activateProject("scope-project");
  const stop = subscribeSyncScope(client);
  try {
    store.setGitBranch("main");
    assert.equal(frames().length, 1, "the first update establishes the scope exactly once");
    assert.equal(frames()[0]!.sessionId, undefined, "New Chat sends no sessionId");
    assert.equal(frames()[0]!.projectId, "scope-project");

    store.setGitBranch("main-2");
    store.setGitBranch("main-3");
    assert.equal(frames().length, 1, "no-op updates on New Chat must not resubscribe");

    store.activateSession("scope-session");
    assert.equal(frames().length, 2, "a genuine session change resubscribes exactly once");
    assert.equal(frames()[1]!.sessionId, "scope-session");
    assert.equal(frames()[1]!.projectId, "scope-project");
    assert.equal(frames()[1]!.afterSeq, 0, "a fresh session subscribes from cursor 0");

    store.setGitBranch("main-4");
    assert.equal(frames().length, 2, "updates while a session is active must not resubscribe");

    store.activateProject("scope-project-2");
    assert.equal(frames().length, 3, "a project change resubscribes exactly once");
    assert.equal(frames()[2]!.sessionId, undefined, "a project switch drops the session from the scope");
    assert.equal(frames()[2]!.projectId, "scope-project-2");

    store.setGitBranch("main-5");
    assert.equal(frames().length, 3, "updates after a project switch must not resubscribe");

    store.activateSession("scope-session-2");
    assert.equal(frames().length, 4, "the next session resubscribes exactly once");
    assert.equal(frames()[3]!.sessionId, "scope-session-2");
    assert.equal(frames()[3]!.projectId, "scope-project-2");

    store.activateSession(null);
    assert.equal(frames().length, 5, "returning to New Chat resubscribes exactly once");
    assert.equal(frames()[4]!.sessionId, undefined);
    assert.equal(frames()[4]!.projectId, "scope-project-2");

    store.setGitBranch("main-6");
    store.setGitBranch("main-7");
    assert.equal(frames().length, 5, "no-op updates after returning to New Chat must not resubscribe");
  } finally {
    stop();
    client.close();
  }
});
