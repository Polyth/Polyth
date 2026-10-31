// One-click terminal. Activating the
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
/** When set, the terminal list answers only after it resolves. */
let listGate: Promise<void> | null = null;
let spawnCount = 0;
const calls: Array<{ url: string; method: string; body?: string }> = [];
(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: { method?: string; body?: string }) => {
  const method = init?.method ?? "GET";
  calls.push({ url: String(url), method, body: init?.body });
  if (method === "GET" && String(url).includes("/api/terminals?") && listGate) await listGate;
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
const CustomEventFromDom = (dom as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent;
const CustomEventCtor = CustomEventFromDom;

function installTerminalMetrics() {
  const metrics = { width: 780, height: 240, cellW: 12, cellH: 20 };
  const observers = new Set<() => void>();
  const proto = dom.HTMLElement.prototype;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const replace = (key: string, descriptor: PropertyDescriptor) => {
    originals.set(key, Object.getOwnPropertyDescriptor(proto, key));
    Object.defineProperty(proto, key, { configurable: true, ...descriptor });
  };
  replace("clientWidth", { get(this: typeof proto) { return this.classList.contains("term-body") ? metrics.width : 0; } });
  replace("clientHeight", { get(this: typeof proto) { return this.classList.contains("term-body") ? metrics.height : 0; } });
  replace("offsetWidth", { get(this: typeof proto) { return this.classList.contains("term-measure") ? (this.textContent?.length ?? 0) * metrics.cellW : 0; } });
  replace("offsetHeight", { get(this: typeof proto) { return this.classList.contains("term-measure") ? metrics.cellH : 0; } });
  const originalRect = proto.getBoundingClientRect;
  replace("getBoundingClientRect", { value(this: typeof proto) {
    const rect = originalRect.call(this);
    // The window is halfway through a scale animation; layout dimensions
    // remain unchanged. This also covers the former dynamically added probe.
    if (this.tagName === "SPAN") {
      return { ...rect, width: (this.textContent?.length ?? 0) * metrics.cellW / 2, height: metrics.cellH / 2 };
    }
    return rect;
  } });
  const previousObserver = globalThis.ResizeObserver;
  const previousStyle = globalThis.getComputedStyle;
  class Observer {
    notify: () => void;
    constructor(callback: ResizeObserverCallback) {
      this.notify = () => callback([], this as unknown as ResizeObserver);
      observers.add(this.notify);
    }
    observe() {}
    unobserve() {}
    disconnect() { observers.delete(this.notify); }
  }
  globalThis.ResizeObserver = Observer as unknown as typeof ResizeObserver;
  globalThis.getComputedStyle = dom.getComputedStyle.bind(dom) as unknown as typeof getComputedStyle;
  return {
    metrics,
    notify: async () => {
      await act(async () => {
        for (const notify of observers) notify();
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
    },
    restore: () => {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(proto, key, descriptor);
        else Reflect.deleteProperty(proto, key);
      }
      globalThis.ResizeObserver = previousObserver;
      globalThis.getComputedStyle = previousStyle;
    },
  };
}

async function mountTerminal(props: { projectId?: string; sessionId?: string } = {}) {
  activateProject("p-term");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (visible: boolean) => {
    await act(async () => {
      root.render(createElement(
        PaneVisibilityContext.Provider,
        { value: visible },
        createElement(TerminalView, props),
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
    assert.ok(calls.some((call) => call.method === "DELETE" && call.url.includes("/api/terminals/")), "closing a tab requests process termination");
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

test("a terminal announced while the list loads keeps its tab and focus", async () => {
  let release!: () => void;
  listGate = new Promise<void>((resolve) => { release = resolve; });
  listResponse = [
    { id: "t-older", title: "older shell", cwd: "/tmp", projectId: "p-term", createdAt: Date.now(), running: true },
    { id: "t-action", title: "Run tests", cwd: "/tmp", projectId: "p-term", createdAt: Date.now(), running: true },
  ];
  const before = createCalls().length;
  const { container, render, unmount } = await mountTerminal();
  try {
    await render(true);
    // A custom action created its terminal and announced it before the list answered.
    await act(async () => {
      window.dispatchEvent(new CustomEventCtor("polyth:terminal-created", {
        detail: { terminalId: "t-action", projectId: "p-term", title: "Run tests" },
      }));
    });
    release();
    listGate = null;
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const tabs = Array.from(container.querySelectorAll(".term-tab"));
    assert.equal(tabs.length, 2, "the announced tab merges with the adopted list without duplicates");
    assert.match(container.querySelector(".term-tab.active")?.textContent ?? "", /Run tests/, "the announced terminal keeps focus");
    assert.equal(createCalls().length, before, "an announced terminal prevents the empty-list auto-spawn");
  } finally {
    listGate = null;
    await unmount();
  }
});

test("a harness sign-in terminal shows in a chat's Terminal view, listed or announced", async () => {
  listResponse = [
    { id: "t-signin", title: "Sign in · Claude Code", cwd: "/tmp", projectId: "p-term", createdAt: Date.now(), running: true, purpose: "harness-setup" },
    { id: "t-project", title: "project shell", cwd: "/tmp", projectId: "p-term", createdAt: Date.now(), running: true },
  ];
  const { container, render, unmount } = await mountTerminal({ projectId: "p-term", sessionId: "s-chat" });
  try {
    await render(true);
    assert.match(container.textContent ?? "", /Sign in · Claude Code/, "a listed setup terminal is adopted inside a chat view");
    assert.doesNotMatch(container.textContent ?? "", /project shell/, "an ordinary project shell stays out of the chat view");
    await act(async () => {
      window.dispatchEvent(new CustomEventCtor("polyth:terminal-created", {
        detail: { terminalId: "t-install", projectId: "p-term", title: "Install Codex", purpose: "harness-setup" },
      }));
    });
    assert.match(container.querySelector(".term-tab.active")?.textContent ?? "", /Install Codex/, "an announced setup terminal opens focused");
  } finally {
    await unmount();
  }
});

test("adoption excludes terminals retained from another canonical session", async () => {
  listResponse = [
    { id: "t-foreign", title: "foreign session", cwd: "/tmp", projectId: "p-term", sessionId: "old-session", createdAt: Date.now(), running: true },
    { id: "t-project", title: "project shell", cwd: "/tmp", projectId: "p-term", createdAt: Date.now(), running: true },
  ];
  const before = createCalls().length;
  const { container, render, unmount } = await mountTerminal();
  try {
    await render(true);
    assert.equal(createCalls().length, before, "the current project terminal prevents an auto-spawn");
    assert.match(container.textContent ?? "", /project shell/);
    assert.doesNotMatch(container.textContent ?? "", /foreign session/);
    assert.match(FakeWebSocket.instances.at(-1)!.url, /\/ws\/terminal\/t-project$/);
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

test("shell startup, window animations and font changes keep the rendered and PTY grids aligned", async () => {
  const geometry = installTerminalMetrics();
  listResponse = [];
  const { container, render, unmount } = await mountTerminal();
  try {
    await render(true);
    const socket = FakeWebSocket.instances.at(-1)!;
    const sizes = () => socket.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === "resize");
    const created = JSON.parse(createCalls().at(-1)!.body!);
    assert.equal(created.cols, 65, "measure before spawn: scaled screen pixels must not double the initial PTY columns");
    assert.equal(created.rows, 12);
    assert.deepEqual(sizes(), [], "the first paint must not resize a shell that just started at the correct grid");
    await act(async () => {
      const prompt = "dev@workstation:/home/dev/src/polyth-example-builds-c9d687fb5a67$ ";
      socket.onmessage?.({ data: JSON.stringify({ type: "data", data: `${prompt}\r echo hi` }) });
      await new Promise((resolve) => setTimeout(resolve, 25)); // coalesced emulator repaint
    });
    assert.ok(Array.from(container.querySelectorAll(".term-row")).some((row) => row.textContent === " echo hi"), "a short command fits on the prompt's second row without an extra readline wrap");
    geometry.metrics.cellW = 10;
    geometry.metrics.cellH = 24;
    await geometry.notify();
    assert.deepEqual(sizes().at(-1), { type: "resize", cols: 78, rows: 10 }, "font changes resize even when the window box stays fixed");
  } finally {
    await unmount();
    geometry.restore();
  }
});

test("closing the window preserves the shell, grid and unfinished command", async () => {
  const geometry = installTerminalMetrics();
  listResponse = [];
  const { container, render, unmount } = await mountTerminal();
  try {
    await render(true);
    const socket = FakeWebSocket.instances.at(-1)!;
    await act(async () => { socket.onmessage?.({ data: JSON.stringify({ type: "data", data: "ubuntu$ echo" }) }); });
    const frames = socket.sent.length;
    const deletes = calls.filter((call) => call.method === "DELETE").length;
    await render(false);
    geometry.metrics.width = 30;
    geometry.metrics.height = 30;
    await geometry.notify();
    assert.equal(socket.sent.length, frames, "hidden geometry must not resize the PTY");
    assert.equal(socket.readyState, FakeWebSocket.OPEN, "the shell connection stays attached");
    assert.equal(calls.filter((call) => call.method === "DELETE").length, deletes, "dismissing a window must not close its tab");
    geometry.metrics.width = 780;
    geometry.metrics.height = 240;
    await render(true);
    assert.equal(FakeWebSocket.instances.at(-1), socket, "reopening uses the same shell");
    assert.equal(socket.sent.length, frames, "reopening at the same size needs no SIGWINCH");
    assert.equal(container.querySelector(".term-row")?.textContent, "ubuntu$ echo");
  } finally {
    await unmount();
    geometry.restore();
  }
});

test("replay restores display without sending historical terminal query replies to the shell", async () => {
  listResponse = [];
  const { render, unmount } = await mountTerminal();
  try {
    await render(true);
    const socket = FakeWebSocket.instances.at(-1)!;
    const data = "ubuntu$ \x1b[6n\x1b[c";
    for (const frames of [undefined, [{ type: "resize", cols: 80, rows: 24 }, { type: "data", data }]]) {
      await act(async () => {
        socket.onmessage?.({ data: JSON.stringify({ type: "replay", data, frames }) });
      });
    }
    assert.deepEqual(socket.sent, [], "old DSR/DA queries must not become new shell input");
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: "data", data: "\x1b[6n" }) });
    });
    assert.deepEqual(socket.sent.map((raw) => JSON.parse(raw)), [{ type: "data", data: "\x1b[1;9R" }], "live terminal queries still receive replies");
  } finally {
    await unmount();
  }
});
