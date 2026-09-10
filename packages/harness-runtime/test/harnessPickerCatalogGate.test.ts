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

const snapshot = (id: string, modelID?: string) => ({
  identity: { id, name: id === "cursor" ? "Cursor" : "Codex" },
  policy: { enabled: true, priority: id === "cursor" ? 20 : 10 },
  availability: { state: "ready", installed: true, healthy: true, authenticated: true },
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

test("Cursor selection waits for its catalog before updating a draft", async () => {
  const requests: string[] = [];
  let resolveDetail!: (value: unknown) => void;
  fetchHandler = async (input, init) => {
    const url = new URL(String(input), "http://test");
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (init?.method === "POST") return new Response(JSON.stringify({ resolvedHarnessId: "cursor" }));
    if (!url.searchParams.has("harnessId")) return new Response(JSON.stringify([snapshot("codex"), snapshot("cursor")]));
    return new Response(JSON.stringify(await new Promise((resolve) => { resolveDetail = resolve; })));
  };
  const updates = { value: 0 };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host(updates), "session-gate-success"),
      harnessSelection: { mode: "pinned", harnessId: "codex" },
      sessionStatus: "idle",
    })); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { container.querySelector<HTMLButtonElement>("[role=tab][id$='-cursor']")?.click(); });
    assert.equal(updates.value, 0);
    assert.equal(requests.some((request) => request.includes("harnessId=cursor")), true);
    await act(async () => { resolveDetail([snapshot("cursor", "auto")]); });
    assert.equal(updates.value, 1);
    assert.equal(requests.some((request) => request.startsWith("POST /api/harnesses/sessions/")), false);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("failed target catalog leaves an active session unswitched and reports the error", async () => {
  const requests: string[] = [];
  fetchHandler = async (input, init) => {
    const url = new URL(String(input), "http://test");
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (!url.searchParams.has("harnessId")) return new Response(JSON.stringify([snapshot("codex"), snapshot("cursor")]));
    return new Response(JSON.stringify({ message: "ACP discovery timed out" }), { status: 503 });
  };
  const updates = { value: 0 };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host(updates), "session-gate"),
      sessionId: "session-1",
      harnessSelection: { mode: "pinned", harnessId: "codex" },
      sessionStatus: "idle",
    })); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { container.querySelector<HTMLButtonElement>("[role=tab][id$='-cursor']")?.click(); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(requests.some((request) => request.startsWith("POST /api/harnesses/sessions/")), false);
    assert.match(container.textContent ?? "", /ACP discovery timed out/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
