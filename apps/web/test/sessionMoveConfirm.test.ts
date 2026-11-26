// Moving a chat the agent read personal notes in (Spaces §14.6): the move is
// asked for, not refused. The confirmation carries a checkbox, the confirm
// button waits for it, and only a confirmed move sends
// `acknowledgePersonalContext`.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { Project, SessionMovePreview, SessionProjection } from "@polyth/contracts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: query.includes("hover: hover") && query.includes("pointer: fine"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
  }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Call { url: string; method: string; body?: Record<string, unknown> }
const calls: Call[] = [];
(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: { method?: string; body?: string }) => {
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : undefined;
  calls.push({ url: String(url), method, ...(body ? { body } : {}) });
  const preview: SessionMovePreview = {
    sessionId: "s1",
    fromProjectId: "one",
    toProjectId: "two",
    sessionIds: ["s1"],
    restartsAgent: false,
    gains: [{ userId: "u-bo", name: "Bo" }],
    loses: [],
    blocked: { reason: "personal-context", message: "The agent has read your personal notes in this chat." },
  };
  const moved: SessionProjection = {
    id: "s1", projectId: "two", title: "Chat", status: "idle", createdAt: 1, updatedAt: 2,
  };
  const payload = String(url).endsWith("/move") && method === "POST"
    ? body?.dryRun === true ? preview : { session: moved, sessionIds: ["s1"] }
    : [];
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Map(),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const store = await import("../src/store.ts");
const { requestSessionMove } = await import("../src/sessionMove.ts");
const { default: AlertDialog } = await import("../src/components/AlertDialog.tsx");

const project = (id: string): Project => ({ id, path: `/work/${id}`, name: id.toUpperCase(), createdAt: 1 });

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await settle();
  return {
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const buttonByText = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => (button.textContent ?? "").trim() === text);
const click = async (element: Element | null | undefined) => {
  assert.ok(element, "clickable element exists");
  await act(async () => { (element as HTMLElement).click(); });
  await settle();
};

test("a chat with personal notes moves only after the person confirms", async () => {
  calls.length = 0;
  store.applyProjectUpsert(project("one"));
  store.applyProjectUpsert(project("two"));
  store.activateProject("one");
  const view = await mount(createElement(AlertDialog));
  try {
    let moved: boolean | undefined;
    await act(async () => {
      void requestSessionMove({ id: "s1", projectId: "one", title: "Chat" }, project("two")).then((value) => { moved = value; });
    });
    await settle();
    assert.equal(document.querySelector('[role="dialog"]') !== null, true, "the move is confirmed, not refused");
    const confirm = document.querySelector<HTMLElement>('[role="checkbox"]');
    assert.ok(confirm, "the confirmation carries a checkbox");
    assert.equal(confirm.getAttribute("aria-checked"), "false");
    assert.equal(buttonByText("Move")?.disabled, true, "and the move waits for it");

    await click(confirm);
    assert.equal(confirm.getAttribute("aria-checked"), "true");
    const move = buttonByText("Move");
    assert.equal(move?.disabled, false);
    await click(move);

    const request = calls.find((call) => call.method === "POST" && call.url.endsWith("/move") && call.body?.dryRun !== true);
    assert.equal(request?.body?.acknowledgePersonalContext, true);
    assert.equal(request?.body?.projectId, "two");
    assert.equal(moved, true);
  } finally {
    await view.unmount();
  }
});
