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
const { HarnessTabs } = await import("../widgets/runtime.tsx");

const snapshot = (id: string, modelID?: string, availability?: Partial<{ state: string; installed: boolean; healthy: boolean; authenticated: boolean }>) => ({
  identity: { id, name: id === "cursor" ? "Cursor" : "Codex" },
  policy: { enabled: true, priority: id === "cursor" ? 20 : 10 },
  availability: {
    state: "ready",
    installed: true,
    healthy: true,
    authenticated: true,
    ...availability,
  },
  ...(modelID ? { catalog: { models: [{ harnessId: id, providerID: id, modelID, name: modelID }] } } : {}),
});

function host(updateCount: { value: number }) {
  return {
    executionDraft: {
      get: () => ({ harnessSelection: { mode: "auto" as const }, harnessSelectionExplicit: false }),
      update: (_projectId: string, value: { harnessSelection: { mode: "pinned"; harnessId: string } }) => {
        updateCount.value++;
        return { ...value, harnessSelectionExplicit: true };
      },
      subscribe: () => () => {},
    },
    errors: { friendly: (_action: string, cause: unknown) => cause instanceof Error ? cause.message : String(cause) },
    sessions: { upsert: () => {} },
  } as never;
}

const props = (h: ReturnType<typeof host>, projectId: string) => ({
  host: h,
  projectId,
  spaceId: "space-a",
  resolvedHarnessId: "codex",
  projectHarnessDefault: null,
});

const tabProviders = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[role=tab] .provider-logo")].map((logo) => logo.dataset.provider);

test("draft harness selection is synchronous and does not commit a session route", async () => {
  const requests: string[] = [];
  fetchHandler = async (input, init) => {
    const url = new URL(String(input), "http://test");
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    return new Response(JSON.stringify([snapshot("codex"), snapshot("cursor")]));
  };
  const updates = { value: 0 };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host(updates), "session-gate-success"),
      harnessSelection: { mode: "pinned", harnessId: "codex" },
    })); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { container.querySelector<HTMLButtonElement>("[role=tab][id$='-cursor']")?.click(); });
    assert.equal(updates.value, 1);
    assert.equal(requests.some((request) => request.includes("detail=1")), false,
      "the catalog owner, not the tab header, starts metadata discovery after selection rerenders");
    assert.equal(requests.some((request) => request.includes("harnessId=cursor")), false);
    assert.equal(requests.some((request) => request.startsWith("POST /api/harnesses/sessions/")), false);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("active-session tab changes stay local until a message is submitted", async () => {
  const requests: string[] = [];
  fetchHandler = async (input, init) => {
    const url = new URL(String(input), "http://test");
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    return new Response(JSON.stringify([snapshot("codex"), snapshot("cursor")]));
  };
  const updates = { value: 0 };
  const selected: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host(updates), "session-gate"),
      sessionId: "session-1",
      harnessSelection: { mode: "pinned", harnessId: "codex" },
      onSelectHarness: (selection: { mode: "auto" } | { mode: "pinned"; harnessId: string }) => {
        if (selection.mode === "pinned") selected.push(selection.harnessId);
      },
    })); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { container.querySelector<HTMLButtonElement>("[role=tab][id$='-cursor']")?.click(); });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(selected, ["cursor"]);
    assert.equal(requests.some((request) => request.startsWith("POST /api/harnesses/sessions/")), false);
    assert.doesNotMatch(container.textContent ?? "", /Starting Cursor/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("roster-only harnesses stay hidden until snapshots prove they can execute", async () => {
  let finishSnapshots!: (value: unknown) => void;
  fetchHandler = async (input) => {
    const url = new URL(String(input), "http://test");
    if (url.pathname === "/api/harnesses/roster") {
      return new Response(JSON.stringify([
        { identity: { id: "codex", name: "Codex", integration: "App Server" }, policy: { enabled: true, priority: 10, autoSelect: true } },
        { identity: { id: "cursor", name: "Cursor", integration: "ACP v1" }, policy: { enabled: true, priority: 20, autoSelect: false } },
      ]));
    }
    return new Response(JSON.stringify(await new Promise((resolve) => { finishSnapshots = resolve; })));
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host({ value: 0 }), "instant-roster"),
      harnessSelection: { mode: "pinned", harnessId: "codex" },
    })); });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(tabProviders(container), ["openai"],
      "unconfigured roster entries must not render before availability snapshots arrive");
  } finally {
    await act(async () => { finishSnapshots([]); });
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("only executable harnesses remain after availability snapshots load", async () => {
  let finishSnapshots!: (value: unknown) => void;
  fetchHandler = async (input) => {
    const url = new URL(String(input), "http://test");
    if (url.pathname === "/api/harnesses/roster") {
      return new Response(JSON.stringify([
        { identity: { id: "codex", name: "Codex", integration: "App Server" }, policy: { enabled: true, priority: 10, autoSelect: true } },
        { identity: { id: "cursor", name: "Cursor", integration: "ACP v1" }, policy: { enabled: true, priority: 20, autoSelect: false } },
        { identity: { id: "claude", name: "Claude", integration: "ACP v1" }, policy: { enabled: false, priority: 30, autoSelect: false } },
        { identity: { id: "gemini", name: "Gemini", integration: "ACP v1" }, policy: { enabled: false, priority: 40, autoSelect: false } },
      ]));
    }
    return new Response(JSON.stringify(await new Promise((resolve) => { finishSnapshots = resolve; })));
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host({ value: 0 }), "snapshot-filter"),
      harnessSelection: { mode: "auto" },
    })); });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(tabProviders(container), ["openai"]);
    await act(async () => {
      finishSnapshots([
        snapshot("codex"),
        snapshot("cursor", undefined, { state: "setup-required", installed: true, healthy: false }),
        snapshot("claude", undefined, { state: "not-installed", installed: false, healthy: false }),
        { ...snapshot("gemini"), identity: { id: "gemini", name: "Gemini" }, policy: { enabled: false, priority: 40 } },
      ]);
      await Promise.resolve();
    });
    assert.deepEqual(tabProviders(container), ["openai"],
      "setup-required, not-installed and policy-disabled harnesses stay hidden");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("selected non-executable harness stays visible with setup guidance", async () => {
  fetchHandler = async (input) => {
    const url = new URL(String(input), "http://test");
    if (url.pathname === "/api/harnesses/roster") {
      return new Response(JSON.stringify([
        { identity: { id: "codex", name: "Codex", integration: "App Server" }, policy: { enabled: true, priority: 10, autoSelect: true } },
        { identity: { id: "cursor", name: "Cursor", integration: "ACP v1" }, policy: { enabled: true, priority: 20, autoSelect: false } },
      ]));
    }
    return new Response(JSON.stringify([
      snapshot("codex"),
      snapshot("cursor", undefined, { state: "setup-required", installed: true, healthy: false }),
    ]));
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host({ value: 0 }), "selected-setup-required"),
      resolvedHarnessId: "cursor",
      harnessSelection: { mode: "pinned", harnessId: "cursor" },
    })); });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(tabProviders(container).sort(), ["cursor", "openai"].sort());
    assert.match(container.textContent ?? "", /Setup incomplete\. Open Harnesses in Settings to finish setup\./);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
