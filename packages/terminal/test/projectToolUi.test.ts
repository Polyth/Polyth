import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { ToolCommandPreview } from "../src/projectToolTypes.ts";

const dom = new Window({ url: "http://test/" });
Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement });
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);
let fetcher: typeof fetch;
const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => fetcher(...args);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ToolCommandDialog, useToolSnapshot } = await import("../widgets/tools.tsx");
test.after(() => { globalThis.fetch = originalFetch; });

function host() {
  const opened: string[] = [];
  return { opened, value: {
    ui: { icons: {}, components: { Button: ({ children, onClick, disabled, busy }: { children: unknown; onClick(): void; disabled?: boolean; busy?: boolean }) => createElement("button", { onClick, disabled: disabled || busy }, children as never) }, Dialog: ({ title, children }: { title: string; children: unknown }) => createElement("div", { role: "dialog" }, title, children as never) },
    navigation: { openWorkspacePane: (id: string) => { opened.push(id); } },
    errors: { friendly: (label: string) => `${label} failed.` },
  } as unknown as WebPackageHost };
}

test("late workspace responses never replace the newly selected scope", async () => {
  const h = host();
  const pending = new Map<string, (response: Response) => void>();
  const signals = new Map<string, AbortSignal | null | undefined>();
  fetcher = async (input, init) => new Promise<Response>((done) => { pending.set(String(input), done); signals.set(String(input), init?.signal); });
  function Probe({ path }: { path: string }) {
    const { data } = useToolSnapshot<{ label: string }>(h.value, path);
    return createElement("span", null, data?.label ?? "loading");
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Probe, { path: "/old" })));
    await act(async () => root.render(createElement(Probe, { path: "/new" })));
    assert.equal(signals.get("/old")?.aborted, true);
    await act(async () => { pending.get("/new")!(Response.json({ label: "New project" })); });
    assert.equal(container.textContent, "New project");
    await act(async () => { pending.get("/old")!(Response.json({ label: "Foreign old project" })); });
    assert.equal(container.textContent, "New project");
  } finally { await act(async () => root.unmount()); }
});

test("command review dispatches once and exposes Terminal recovery after a lost response", async () => {
  const h = host();
  let calls = 0;
  let reply!: (response: Response) => void;
  let inputBody: unknown;
  fetcher = async (_input, init) => { calls++; inputBody = JSON.parse(String(init?.body)); return new Promise<Response>((done) => { reply = done; }); };
  const preview: ToolCommandPreview = { title: "Stop services", explanation: "Stop the selected stack.", projectId: "p1", sessionId: "s1", repositoryId: "r1", cwd: "/checkout", cmd: "docker compose stop" };
  const container = document.createElement("div");
  const root = createRoot(container);
  let closed = 0;
  try {
    await act(async () => root.render(createElement(ToolCommandDialog, { host: h.value, preview, onClose: () => { closed++; } })));
    assert.equal(calls, 0, "opening a preview does not execute anything");
    const run = [...container.querySelectorAll("button")].find((button) => button.textContent === "Run in Terminal")!;
    await act(async () => { run.click(); run.click(); });
    assert.equal(calls, 1);
    assert.deepEqual(inputBody, { projectId: "p1", sessionId: "s1", repositoryId: "r1", cwd: "/checkout", cmd: preview.cmd });
    await act(async () => { reply(Response.json({ error: "outcome-unknown" }, { status: 500 })); });
    assert.match(container.textContent!, /Check Terminal before starting/);
    assert.equal([...container.querySelectorAll("button")].some((button) => button.textContent === "Run in Terminal"), false);
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Check Terminal")!.click());
    assert.deepEqual(h.opened, ["terminal"]);
    assert.equal(closed, 1);
    assert.equal(calls, 1);
  } finally { await act(async () => root.unmount()); }
});
