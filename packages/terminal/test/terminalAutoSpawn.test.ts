// Finding 6 (UX-SHELL-CONSOLIDATION-02): one-click terminal. Activating the
// terminal pane over a project with a confirmed-empty terminal list must
// spawn one real shell (server createTerminal → terminalId) and attach its
// WebSocket — never before the list is known, never twice per activation,
// and never as a respawn after the user deliberately closed the last tab.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { TerminalInfo } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(dom as unknown as { confirm: () => boolean }).confirm = () => true;

// Fake PTY socket: records attach URLs, no network. Node 22 ships a real
// global WebSocket (undici) — replace it BEFORE the component ever connects.
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
}
(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;

// Deterministic API seam: list answers `listResponse`, create mints ids.
let listResponse: TerminalInfo[] = [];
let spawnCount = 0;
const calls: Array<{ url: string; method: string }> = [];
(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: { method?: string }) => {
  const method = init?.method ?? "GET";
  calls.push({ url: String(url), method });
  const body =
    method === "POST" && String(url).endsWith("/api/terminals")
      ? { terminalId: `t-auto-${++spawnCount}` }
      : method === "GET" && String(url).includes("/api/terminals?")
        ? listResponse
        : { ok: true };
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
};
const createCalls = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/api/terminals"));

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { activateProject } = await import("../../../apps/web/src/store.ts");
const { PaneVisibilityContext } = await import("../../../apps/web/src/workspace/paneVisibility.ts");
const { default: TerminalView } = await import("../widgets/TerminalView.tsx");

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const KeyboardEventCtor = (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;

async function mountTerminal() {
  activateProject("p-term");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (visible: boolean) => {
    await act(async () => {
      root.render(createElement(
        PaneVisibilityContext.Provider,
        { value: visible },
        createElement(TerminalView),
      ));
    });
    // settle the fetch-list → listLoaded → auto-spawn effect chain
    await act(async () => { await Promise.resolve(); });
  };
  return {
    container,
    render,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("activating the terminal pane with no terminals spawns and attaches one shell", async () => {
  listResponse = [];
  const { container, render, unmount } = await mountTerminal();
  try {
    await render(true);
    assert.equal(createCalls().length, 1, "exactly one createTerminal call");
    assert.equal(FakeWebSocket.instances.length, 1, "exactly one PTY socket attached");
    assert.match(FakeWebSocket.instances[0]!.url, /\/ws\/terminal\/t-auto-1$/);
    // Connected UI only exists AFTER the server minted the terminal.
    assert.ok(container.querySelector(".term-body"), "terminal body rendered");
    assert.match(container.textContent ?? "", /shell · 1/);

    // Hiding and re-activating the pane with a live terminal spawns nothing.
    await render(false);
    await render(true);
    assert.equal(createCalls().length, 1, "re-activation over an existing terminal does not respawn");
  } finally {
    await unmount();
  }
});

test("closing the last terminal while the pane stays active does not respawn it", async () => {
  listResponse = [];
  const { container, render, unmount } = await mountTerminal();
  try {
    await render(true);
    const before = createCalls().length;
    const close = container.querySelector<HTMLButtonElement>(".term-tab-x");
    assert.ok(close, "close button rendered");
    await act(async () => {
      close!.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });
    assert.match(container.textContent ?? "", /No terminal yet/);
    assert.equal(createCalls().length, before, "deliberate close is respected — no respawn");
  } finally {
    await unmount();
  }
});

test("activating over existing terminals adopts them instead of spawning", async () => {
  listResponse = [{
    id: "t-exist", title: "existing shell", cwd: "/tmp", projectId: "p-term",
    createdAt: Date.now(), running: true,
  }];
  const before = createCalls().length;
  const sockets = FakeWebSocket.instances.length;
  const { container, render, unmount } = await mountTerminal();
  try {
    await render(true);
    assert.equal(createCalls().length, before, "adoption does not create a terminal");
    assert.equal(FakeWebSocket.instances.length, sockets + 1, "adopted terminal attached");
    assert.match(FakeWebSocket.instances.at(-1)!.url, /\/ws\/terminal\/t-exist$/);
    assert.match(container.textContent ?? "", /existing shell/);
  } finally {
    await unmount();
  }
});

test("typing during socket connection queues ordered input and flushes once", async () => {
  listResponse = [];
  const { container, render, unmount } = await mountTerminal();
  try {
    await render(true);
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.readyState = 0;
    const body = container.querySelector<HTMLElement>(".term-body");
    assert.ok(body);
    await act(async () => {
      body!.dispatchEvent(new KeyboardEventCtor("keydown", { key: "a", bubbles: true }));
      body!.dispatchEvent(new KeyboardEventCtor("keydown", { key: "b", bubbles: true }));
    });
    assert.equal(socket.sent.length, 0, "connecting socket receives no partial input");

    socket.readyState = FakeWebSocket.OPEN;
    await act(async () => { socket.onopen?.(); });
    const frames = socket.sent.map((raw) => JSON.parse(raw) as { type: string; data?: string });
    assert.equal(frames[0]!.type, "resize");
    assert.deepEqual(frames[1], { type: "data", data: "ab" });
    assert.equal(frames.length, 2, "queued keys flush in one ordered frame");
  } finally {
    await unmount();
  }
});
