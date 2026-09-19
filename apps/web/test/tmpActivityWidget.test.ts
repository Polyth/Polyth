import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionProjection, SessionEvent } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement,
  Element: (dom as unknown as { Element: typeof Element }).Element,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.fetch = (() => Promise.reject(new Error("offline"))) as typeof fetch;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { activateSession, upsertSessions, applyEvents, ensureEventCache } = await import("../src/store.ts");
const { BUILTIN_WIDGET_PLUGINS } = await import("../src/widgets/builtinWidgets.tsx");

const PROJECT = "p-widget";
const SESSION = "s-widget";

const projection = {
  id: SESSION,
  projectId: PROJECT,
  title: "Widget session",
  status: "working",
  createdAt: 1,
  updatedAt: 2,
} as SessionProjection;

let seq = 0;
const ev = (type: string, data: Record<string, unknown>): SessionEvent => ({
  id: `e${++seq}`,
  sessionId: SESSION,
  seq,
  time: 1_000 + seq,
  type,
  data,
}) as SessionEvent;

test("canvas conversation widget renders the agent activity block", async () => {
  upsertSessions([projection]);
  ensureEventCache(SESSION);
  applyEvents([
    ev("user/message", { text: "hello" }),
    ev("turn/started", { turnId: "t1", harnessId: "pi" }),
    ev("tool/started", { callId: "c1", tool: "bash", input: { command: "ls" } }),
    ev("tool/result", { callId: "c1", tool: "bash", output: "ok" }),
  ], { notifySessionEvents: false });
  activateSession(SESSION);

  const def = BUILTIN_WIDGET_PLUGINS
    .flatMap((plugin) => plugin.widgets)
    .find((widget) => widget.id === "core.chat");
  assert.ok(def, "core.chat widget exists");

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(def!.render!, {
      projectId: PROJECT,
      sessionId: SESSION,
      editing: false,
      instanceId: "core.chat",
      config: {},
      updateConfig: () => {},
    }) as never);
  });
  const html = host.innerHTML;
  assert.ok(html.includes("timeline"), `timeline rendered: ${html.slice(0, 400)}`);
  assert.ok(host.querySelector(".activity-group"), `activity group: ${html.slice(0, 1500)}`);
  await act(async () => { root.unmount(); });
  host.remove();
});
