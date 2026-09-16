import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  requestAnimationFrame: (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  },
  cancelAnimationFrame: () => {},
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let fetchHandler: typeof fetch = async () => new Response("[]");
globalThis.fetch = ((input, init) => fetchHandler(input, init)) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: HarnessAuthRecovery, harnessRecoveryKind } = await import("../widgets/HarnessAuthRecovery.tsx");

const transition = (code: string | undefined, message: string) => ({
  id: "switch-1",
  selection: { mode: "pinned" as const, harnessId: "codex" },
  targetHarnessId: "codex",
  timing: "after-turn" as const,
  phase: "failed" as const,
  released: { authorityId: "authority-1", generation: 1, backendSessionId: "native-1" },
  attempt: 1,
  lastAttemptAt: 1,
  error: { stage: "starting-target" as const, ...(code ? { code } : {}), message },
});

const snapshot = (state = "auth-required") => ({
  identity: { id: "codex", name: "Codex", integration: "App Server" },
  policy: { enabled: true, priority: 10 },
  availability: {
    state,
    installed: true,
    healthy: true,
    authenticated: state === "ready",
    checkedAt: Date.now(),
  },
  context: { projectId: "project-1", cwd: "/tmp/project", remote: false },
  setup: { signInCommand: "codex login", setupUrl: "https://developers.openai.com/codex/cli/" },
});

type HostState = {
  panes: string[];
  settings: Array<{ page: string; target?: unknown }>;
  projections: unknown[];
  overlays: unknown[];
};

const host = (state: HostState) => ({
  errors: {
    friendly: (action: string, cause: unknown) => `${action}: ${cause instanceof Error ? cause.message : String(cause)}`,
    show: () => { throw new Error("auth recovery must not use the transient error surface"); },
  },
  sessions: { upsert: (projection: unknown) => state.projections.push(projection) },
  navigation: {
    openWorkspacePane: (pane: string) => { state.panes.push(pane); return true; },
    closeWorkspacePane: () => { state.panes.push("closed"); },
    openSettingsPage: (page: string, target?: unknown) => state.settings.push({ page, target }),
    setOverlay: (value: unknown) => state.overlays.push(value),
  },
}) as never;

test("classifies native sign-in separately from the private bridge reconnect anomaly", () => {
  assert.equal(harnessRecoveryKind(transition("auth", "Native sign-in required")), "sign-in");
  assert.equal(harnessRecoveryKind(transition(undefined, "Credentials expired")), "sign-in");
  assert.equal(harnessRecoveryKind(transition(undefined, "Polyth agent-tools bridge failed to connect (Codex status: authenticationRequired)")), "bridge-reconnect");
  assert.equal(harnessRecoveryKind(transition("native-failure", "Native process exited")), undefined);
});

test("auth-required snapshot upgrades a generic startup failure into sign-in recovery", async () => {
  fetchHandler = async (input) => {
    const url = new URL(String(input), "http://test");
    if (url.pathname === "/api/harnesses/snapshots") return new Response(JSON.stringify([snapshot()]));
    return new Response(JSON.stringify([]));
  };
  const state: HostState = { panes: [], settings: [], projections: [], overlays: [] };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(HarnessAuthRecovery, {
        host: host(state),
        projectId: "project-1",
        spaceId: "space-1",
        sessionId: "session-1",
        transition: transition("discovery-unavailable", "Codex could not verify the requested model"),
      }));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert.match(container.textContent ?? "", /Sign in to Codex to continue/);
    assert.match(container.textContent ?? "", /Your conversation is safe/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("auth failure stays in chat, reviews the native sign-in command, then opens the terminal", async () => {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  fetchHandler = async (input, init) => {
    const url = new URL(String(input), "http://test");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: `${url.pathname}${url.search}`, ...(body ? { body } : {}) });
    if (url.pathname === "/api/harnesses/snapshots") return new Response(JSON.stringify([snapshot()]));
    if (url.pathname === "/api/terminals" && method === "POST") return new Response(JSON.stringify({ terminalId: "term-1" }));
    return new Response(JSON.stringify([]));
  };
  const state: HostState = { panes: [], settings: [], projections: [], overlays: [] };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(HarnessAuthRecovery, {
        host: host(state),
        projectId: "project-1",
        spaceId: "space-1",
        sessionId: "session-1",
        transition: transition("auth", "Codex credentials expired"),
      }));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert.match(container.textContent ?? "", /Sign in to Codex to continue/);
    assert.match(container.textContent ?? "", /Your conversation is safe/);

    const signIn = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Sign in");
    assert.ok(signIn);
    await act(async () => { signIn.click(); });
    assert.match(container.textContent ?? "", /codex login/);
    assert.match(container.textContent ?? "", /conversation stays open/i);

    const run = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Run sign-in");
    assert.ok(run);
    await act(async () => { run.click(); await Promise.resolve(); });

    const terminalRequest = requests.find((request) => request.method === "POST" && request.path === "/api/terminals");
    assert.deepEqual(terminalRequest?.body, { projectId: "project-1", cmd: "codex login" });
    assert.deepEqual(state.panes, ["terminal"]);
    assert.equal(state.overlays.at(-1), null);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("private bridge authenticationRequired becomes an in-chat reconnect instead of a fake OAuth login", async () => {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  fetchHandler = async (input, init) => {
    const url = new URL(String(input), "http://test");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: `${url.pathname}${url.search}`, ...(body ? { body } : {}) });
    if (url.pathname === "/api/harnesses/sessions/session-1" && method === "POST") {
      return new Response(JSON.stringify({ id: "session-1", status: "idle" }));
    }
    return new Response(JSON.stringify([]));
  };
  const state: HostState = { panes: [], settings: [], projections: [], overlays: [] };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(HarnessAuthRecovery, {
        host: host(state),
        projectId: "project-1",
        sessionId: "session-1",
        transition: transition(undefined, "Polyth agent-tools bridge failed to connect (Codex status: authenticationRequired)"),
      }));
    });
    assert.match(container.textContent ?? "", /agent tools need to reconnect/i);
    assert.doesNotMatch(container.textContent ?? "", /Run sign-in|codex mcp login/i);

    const reconnect = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Reconnect");
    assert.ok(reconnect);
    await act(async () => { reconnect.click(); await Promise.resolve(); });

    const retryRequest = requests.find((request) => request.method === "POST" && request.path === "/api/harnesses/sessions/session-1");
    assert.deepEqual(retryRequest?.body, {
      selection: { mode: "pinned", harnessId: "codex" },
      timing: "after-turn",
    });
    assert.equal(state.projections.length, 1);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
