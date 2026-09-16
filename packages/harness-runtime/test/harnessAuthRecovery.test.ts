import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import type { SessionEvent } from "@polyth/contracts";

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
const {
  default: HarnessAuthRecovery,
  harnessRecoveryKind,
  latestHarnessAuthFailure,
} = await import("../widgets/HarnessAuthRecovery.tsx");
const {
  readHarnessSnapshots,
  resetRuntimeCatalogMemory,
} = await import("@polyth/models/runtime-catalog");

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

const snapshot = (state = "auth-required", id = "codex", signInCommand = "codex login") => ({
  identity: { id, name: id === "codex" ? "Codex" : "Example Harness", integration: "Native" },
  policy: { enabled: true, priority: 10 },
  availability: {
    state,
    installed: true,
    healthy: true,
    authenticated: state === "ready",
    checkedAt: Date.now(),
  },
  context: { spaceId: "space-1", projectId: "project-1", cwd: "/tmp/project", remote: false },
  setup: { signInCommand, setupUrl: "https://example.test/setup" },
});

const event = (seq: number, type: string, data: Record<string, unknown>): SessionEvent => ({
  id: `event-${seq}`,
  sessionId: "session-1",
  seq,
  type,
  data,
  time: seq,
}) as SessionEvent;

const authHistory = (harnessId = "codex", error = "denied", code = "auth-expired") => [
  event(1, "user/message", { text: "change the project", attachments: [{ id: "a", name: "plan.md", mime: "text/markdown", size: 10 }] }),
  event(2, "turn/started", { turnId: "turn-auth", harnessId }),
  event(3, "turn/stopped", { turnId: "turn-auth", reason: "error", error, code }),
];

type HostState = {
  panes: string[];
  settings: Array<{ page: string; target?: unknown }>;
  projections: unknown[];
  overlays: unknown[];
  drafts: Array<{ projectId: string; sessionId?: string | null; text: string }>;
  listeners: Array<(event: SessionEvent) => void>;
};

const state = (): HostState => ({ panes: [], settings: [], projections: [], overlays: [], drafts: [], listeners: [] });

const host = (value: HostState) => ({
  errors: {
    friendly: (action: string, cause: unknown) => `${action}: ${cause instanceof Error ? cause.message : String(cause)}`,
    show: () => { throw new Error("auth recovery must not use the transient error surface"); },
  },
  sessions: {
    upsert: (projection: unknown) => value.projections.push(projection),
    subscribeEvents: (listener: (event: SessionEvent) => void) => {
      value.listeners.push(listener);
      return () => {
        const index = value.listeners.indexOf(listener);
        if (index >= 0) value.listeners.splice(index, 1);
      };
    },
  },
  handoffTargets: {
    list: () => [{
      id: "draft",
      label: "Draft",
      available: () => true,
      send: async (input: { projectId: string; sessionId?: string | null; text: string }) => { value.drafts.push(input); },
    }],
  },
  navigation: {
    openWorkspacePane: (pane: string) => { value.panes.push(pane); return true; },
    closeWorkspacePane: () => { value.panes.push("closed"); },
    openSettingsPage: (page: string, target?: unknown) => value.settings.push({ page, target }),
    setOverlay: (overlay: unknown) => value.overlays.push(overlay),
  },
}) as never;

const flush = async (rounds = 6) => {
  for (let index = 0; index < rounds; index++) await act(async () => { await Promise.resolve(); });
};

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.trim() === label);

const mount = async (props: Record<string, unknown>) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(HarnessAuthRecovery, props)); });
  await flush();
  return {
    container,
    root,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
};

test("classifies native sign-in separately from the private bridge reconnect anomaly", () => {
  assert.equal(harnessRecoveryKind(transition("auth", "Native sign-in required")), "sign-in");
  assert.equal(harnessRecoveryKind(transition(undefined, "Credentials expired")), "sign-in");
  assert.equal(harnessRecoveryKind(transition(undefined, "Polyth agent-tools bridge failed to connect (Codex status: authenticationRequired)")), "bridge-reconnect");
  assert.equal(harnessRecoveryKind(transition("native-failure", "Native process exited")), undefined);
});

test("canonical turn history detects structured and conservative generic auth failures", () => {
  assert.deepEqual(latestHarnessAuthFailure(authHistory()), {
    turnId: "turn-auth",
    harnessId: "codex",
    message: "denied",
    prompt: "change the project",
    attachmentCount: 1,
  });
  assert.equal(latestHarnessAuthFailure(authHistory("example", "Authentication required", "unknown"))?.harnessId, "example");
  assert.equal(latestHarnessAuthFailure(authHistory("example", "provider stopped", "unknown")), undefined,
    "unclassified failures require authoritative snapshot confirmation before auth UI");
  assert.equal(latestHarnessAuthFailure([
    ...authHistory(),
    event(4, "user/message", { text: "new attempt" }),
    event(5, "turn/started", { turnId: "turn-new", harnessId: "codex" }),
  ]), undefined, "a newer turn supersedes stale auth recovery");
  assert.equal(latestHarnessAuthFailure([
    ...authHistory(),
    event(4, "turn/started", { turnId: "turn-new", harnessId: "codex" }),
    event(5, "turn/stopped", { turnId: "turn-new", reason: "error", error: "provider crashed", code: "unknown" }),
  ]), undefined, "a newer non-auth failure supersedes stale auth recovery");
});

test("auth-required snapshot upgrades a generic startup failure into sign-in recovery", async () => {
  resetRuntimeCatalogMemory(false);
  fetchHandler = async (input) => {
    const url = new URL(String(input), "http://test");
    if (url.pathname === "/api/harnesses/snapshots") return new Response(JSON.stringify([snapshot()]));
    if (url.pathname.endsWith("/events")) return new Response(JSON.stringify([]));
    return new Response(JSON.stringify([]));
  };
  const value = state();
  const view = await mount({
    host: host(value),
    projectId: "project-1",
    spaceId: "space-1",
    sessionId: "session-1",
    transition: transition("discovery-unavailable", "Codex could not verify the requested model"),
  });
  try {
    assert.match(view.container.textContent ?? "", /Sign in to Codex to continue/);
    assert.match(view.container.textContent ?? "", /conversation is safe/i);
  } finally {
    await view.unmount();
  }
});

test("pre-session discovery auth-required uses the same in-chat sign-in flow", async () => {
  resetRuntimeCatalogMemory(false);
  fetchHandler = async (input) => {
    const url = new URL(String(input), "http://test");
    if (url.pathname === "/api/harnesses/snapshots") return new Response(JSON.stringify([snapshot()]));
    return new Response(JSON.stringify([]));
  };
  await readHarnessSnapshots({ projectId: "project-1", spaceId: "space-1", force: true });
  const value = state();
  const view = await mount({
    host: host(value),
    projectId: "project-1",
    spaceId: "space-1",
    resolvedHarnessId: "codex",
  });
  try {
    assert.match(view.container.textContent ?? "", /Sign in to Codex to continue/);
    assert.ok(button(view.container, "Sign in"));
  } finally {
    await view.unmount();
  }
});

test("auth failure stays in chat, reviews the native sign-in command, then opens the terminal", async () => {
  resetRuntimeCatalogMemory(false);
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  fetchHandler = async (input, init) => {
    const url = new URL(String(input), "http://test");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: `${url.pathname}${url.search}`, ...(body ? { body } : {}) });
    if (url.pathname === "/api/harnesses/snapshots") return new Response(JSON.stringify([snapshot()]));
    if (url.pathname === "/api/terminals" && method === "POST") return new Response(JSON.stringify({ terminalId: "term-1" }));
    if (url.pathname.endsWith("/events")) return new Response(JSON.stringify([]));
    return new Response(JSON.stringify([]));
  };
  const value = state();
  const view = await mount({
    host: host(value),
    projectId: "project-1",
    spaceId: "space-1",
    sessionId: "session-1",
    transition: transition("auth", "Codex credentials expired"),
  });
  try {
    assert.match(view.container.textContent ?? "", /Sign in to Codex to continue/);
    const signIn = button(view.container, "Sign in");
    assert.ok(signIn);
    await act(async () => { signIn.click(); });
    assert.match(view.container.textContent ?? "", /codex login/);
    const run = button(view.container, "Run sign-in");
    assert.ok(run);
    await act(async () => { run.click(); await Promise.resolve(); });
    const terminalRequest = requests.find((request) => request.method === "POST" && request.path === "/api/terminals");
    assert.deepEqual(terminalRequest?.body, { projectId: "project-1", cmd: "codex login" });
    assert.deepEqual(value.panes, ["terminal"]);
    assert.equal(value.overlays.at(-1), null);
  } finally {
    await view.unmount();
  }
});

test("snapshot-confirmed mid-turn auth never auto-replays and restores only the draft on explicit action", async () => {
  resetRuntimeCatalogMemory(false);
  let authState = "auth-required";
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  fetchHandler = async (input, init) => {
    const url = new URL(String(input), "http://test");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: `${url.pathname}${url.search}`, ...(body ? { body } : {}) });
    if (url.pathname.endsWith("/events")) return new Response(JSON.stringify(authHistory("", "provider stopped", "unknown")));
    if (url.pathname === "/api/harnesses/snapshots") return new Response(JSON.stringify([snapshot(authState)]));
    return new Response(JSON.stringify([]));
  };
  const value = state();
  const view = await mount({
    host: host(value),
    projectId: "project-1",
    spaceId: "space-1",
    sessionId: "session-1",
    resolvedHarnessId: "codex",
    pendingHarnessSelection: { mode: "pinned", harnessId: "example" },
  });
  try {
    const historyRequest = requests.find((request) => request.method === "GET" && request.path.startsWith("/api/sessions/session-1/events?"));
    assert.match(historyRequest?.path ?? "", /beforeSeq=9007199254740991/,
      "recovery reads the newest canonical window rather than the oldest events in a long session");
    const snapshotRequest = requests.find((request) => request.method === "GET" && request.path.startsWith("/api/harnesses/snapshots?"));
    assert.match(snapshotRequest?.path ?? "", /harnessId=codex/,
      "a harness staged for the next message must not hijack recovery for the active failed turn");
    assert.match(view.container.textContent ?? "", /Sign in to Codex to retry safely/);
    assert.match(view.container.textContent ?? "", /will not replay the failed message automatically/i);
    authState = "ready";
    const signedIn = button(view.container, "I’ve signed in");
    assert.ok(signedIn);
    await act(async () => { signedIn.click(); await Promise.resolve(); await Promise.resolve(); });
    await flush();
    assert.match(view.container.textContent ?? "", /Codex sign-in restored/,
      "snapshot-confirmed auth stays attached to this turn after the snapshot becomes ready");
    assert.match(view.container.textContent ?? "", /may already have changed your project/i);
    assert.match(view.container.textContent ?? "", /original message had 1 attachment/i);
    assert.equal(requests.some((request) => request.method === "POST" && request.path.includes("/api/harnesses/sessions/")), false);
    assert.equal(requests.some((request) => request.method === "POST" && request.path.includes("/message")), false);

    const restore = button(view.container, "Restore message");
    assert.ok(restore);
    await act(async () => { restore.click(); await Promise.resolve(); });
    assert.deepEqual(value.drafts, [{ projectId: "project-1", sessionId: "session-1", text: "change the project" }]);
  } finally {
    await view.unmount();
  }
});

test("live canonical turn events refresh and clear mid-turn auth recovery", async () => {
  resetRuntimeCatalogMemory(false);
  let events: SessionEvent[] = authHistory();
  fetchHandler = async (input) => {
    const url = new URL(String(input), "http://test");
    if (url.pathname.endsWith("/events")) return new Response(JSON.stringify(events));
    if (url.pathname === "/api/harnesses/snapshots") return new Response(JSON.stringify([snapshot()]));
    return new Response(JSON.stringify([]));
  };
  const value = state();
  const view = await mount({
    host: host(value),
    projectId: "project-1",
    spaceId: "space-1",
    sessionId: "session-1",
    resolvedHarnessId: "codex",
  });
  try {
    assert.match(view.container.textContent ?? "", /retry safely/i);
    events = [...events, event(4, "user/message", { text: "new request" }), event(5, "turn/started", { turnId: "turn-new", harnessId: "codex" })];
    await act(async () => {
      for (const listener of value.listeners) listener(events.at(-1)!);
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    assert.doesNotMatch(view.container.textContent ?? "", /retry safely/i);
  } finally {
    await view.unmount();
  }
});

test("private bridge authenticationRequired becomes an in-chat reconnect instead of a fake OAuth login", async () => {
  resetRuntimeCatalogMemory(false);
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  fetchHandler = async (input, init) => {
    const url = new URL(String(input), "http://test");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: `${url.pathname}${url.search}`, ...(body ? { body } : {}) });
    if (url.pathname === "/api/harnesses/sessions/session-1" && method === "POST") {
      return new Response(JSON.stringify({ id: "session-1", status: "idle" }));
    }
    if (url.pathname.endsWith("/events")) return new Response(JSON.stringify([]));
    return new Response(JSON.stringify([]));
  };
  const value = state();
  const view = await mount({
    host: host(value),
    projectId: "project-1",
    sessionId: "session-1",
    transition: transition(undefined, "Polyth agent-tools bridge failed to connect (Codex status: authenticationRequired)"),
  });
  try {
    assert.match(view.container.textContent ?? "", /agent tools need to reconnect/i);
    assert.doesNotMatch(view.container.textContent ?? "", /Run sign-in|codex mcp login/i);
    const reconnect = button(view.container, "Reconnect");
    assert.ok(reconnect);
    await act(async () => { reconnect.click(); await Promise.resolve(); });
    const retryRequest = requests.find((request) => request.method === "POST" && request.path === "/api/harnesses/sessions/session-1");
    assert.deepEqual(retryRequest?.body, {
      selection: { mode: "pinned", harnessId: "codex" },
      timing: "after-turn",
    });
    assert.equal(value.projections.length, 1);
  } finally {
    await view.unmount();
  }
});
