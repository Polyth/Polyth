// The mounted Apps window against a stubbed transport: what a person sees and
// what reaches the server. Never pass a DOM node to an assert (a failure would
// serialise the whole window); assert on booleans and strings.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { WebPackageHost } from "@polyth/web-sdk";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  getComputedStyle: dom.getComputedStyle.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });

interface Call { method: string; path: string; body: Record<string, unknown> }
const calls: Call[] = [];
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const record = (id: string, title: string, patch: Record<string, unknown> = {}) =>
  ({ id, title, version: 1, hash: "a".repeat(64), bytes: 10, createdAt: 1793970000000, updatedAt: 1793970000000, ...patch });
let apps = [record(A, "Budget", { version: 3, updatedAt: 1793980000000 }), record(B, "Checklist")];
let pages: Record<string, { html: string; storage: Record<string, string> }> = {
  [A]: { html: "<h1>Budget page</h1>", storage: { rows: "[1,2]" } },
  [B]: { html: "<h1>Checklist page</h1>", storage: {} },
};

let saveRefused = false;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://localhost");
  const method = init?.method ?? "GET";
  const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
  calls.push({ method, path: `${url.pathname}${url.search}`, body });
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  if (url.pathname === "/api/page-apps" && method === "GET") return reply({ apps });
  if (url.pathname === "/api/page-apps" && method === "POST") {
    return saveRefused
      ? reply({ error: "too-large", message: "The page is too large" }, 413)
      : reply({ app: record(A, String(body.title), { version: 4 }), outcome: "updated" });
  }
  if (url.pathname === "/api/page-apps/app") {
    const id = url.searchParams.get("id") ?? "";
    const app = apps.find((item) => item.id === id);
    return app && pages[id] ? reply({ app, ...pages[id] }) : reply({ error: "not-found", message: "App not found" }, 404);
  }
  if (url.pathname === "/api/page-apps/storage") return reply({ keys: 1 });
  return reply({ error: "not-found" }, 404);
}) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: AppsPanel } = await import("../widgets/AppsPanel.tsx");
const { refreshApps } = await import("../widgets/client.ts");

const settle = async () => { for (let turn = 0; turn < 6; turn += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); }); };

function hostFor(own: string | null, windowBack?: { steps: Array<(() => void) | null> }) {
  const titles: Array<string | null> = [];
  const windows: Array<[string, string]> = [];
  const host = {
    // The phone window lends its Back; a wide layout has no such seam.
    ui: windowBack ? { useWindowBack: (step: (() => void) | null) => { windowBack.steps.push(step); return true; } } : {},
    navigation: {
      openWorkspacePane: () => true,
      openPaneWindow: (surface: string, resource: string) => { windows.push([surface, resource]); return true; },
      setPaneWindowTitle: (title: string | null) => { titles.push(title); },
      paneWindowResource: () => own,
    },
    notifications: { show: () => {} },
  } as unknown as WebPackageHost;
  return { host, titles, windows };
}

async function mount(own: string | null, resource: string | null = null, windowBack?: { steps: Array<(() => void) | null> }) {
  const { host, titles, windows } = hostFor(own, windowBack);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(AppsPanel, { host, resource, resourceSeq: resource ? 1 : 0 })); });
  await settle();
  const labels = () => [...container.querySelectorAll("button")].map((button) => button.getAttribute("aria-label") ?? button.textContent ?? "");
  const click = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find((item) => (item.getAttribute("aria-label") ?? item.textContent) === label);
    assert.equal(button !== undefined, true, `button "${label}" is there`);
    await act(async () => { (button as unknown as HTMLElement).click(); });
    await settle();
  };
  const frame = () => container.querySelector("iframe") as unknown as { getAttribute(name: string): string | null; contentWindow: unknown } | null;
  const unmount = async () => { await act(async () => { root.unmount(); }); container.remove(); };
  return { container, titles, windows, labels, click, frame, unmount };
}

test("Save as app sends the page the block shows, says the outcome once and offers to open the app", async () => {
  const { savePageAsApp } = await import("../widgets/commands.ts");
  const shown: Array<{ kind: string; title: string; body?: string; actions?: Array<{ run(): void }> }> = [];
  const opened: Array<[string, string]> = [];
  const host = {
    navigation: { openWorkspacePane: (surface: string, resource: string) => { opened.push([surface, resource]); return true; } },
    notifications: { show: (notice: (typeof shown)[number]) => { shown.push(notice); } },
  } as unknown as WebPackageHost;
  const input = {
    lang: "page",
    title: "Budget",
    content: "<h1>Budget page</h1>",
    from: "apps/budget.html",
    context: { projectId: "p1", sessionId: "s1" },
  } as unknown as Parameters<typeof savePageAsApp>[1];

  calls.length = 0;
  await savePageAsApp(host, input);
  const sent = calls.filter((call) => call.method === "POST" && call.path === "/api/page-apps");
  assert.deepEqual(sent.map((call) => call.body), [
    { title: "Budget", html: "<h1>Budget page</h1>", source: { sessionId: "s1", projectId: "p1", from: "apps/budget.html" } },
  ]);
  assert.deepEqual(shown.map((notice) => [notice.kind, notice.title]), [["success", "App updated: Budget (version 4)"]]);
  shown[0]!.actions![0]!.run();
  assert.deepEqual(opened, [["page-apps", A]]);

  // A refusal is said with the server's reason, and nothing opens.
  saveRefused = true;
  try { await savePageAsApp(host, input); } finally { saveRefused = false; }
  assert.deepEqual([shown[1]!.kind, shown[1]!.title, shown[1]!.body], ["error", "Couldn't save the app", "The page is too large"]);
  assert.equal(opened.length, 1);
  // The list other tests read is the server's again.
  await refreshApps();
});

test("a phone window's own Back returns to the list, so the bar draws no second one", async () => {
  const windowBack = { steps: [] as Array<(() => void) | null> };
  const view = await mount(null, A, windowBack);
  assert.equal(view.frame() !== null, true);
  assert.equal(view.labels().includes("All apps"), false);
  const step = windowBack.steps.at(-1);
  assert.equal(typeof step, "function");
  await act(async () => { step!(); });
  await settle();
  assert.equal(view.frame() === null, true);
  assert.equal(view.container.querySelectorAll(".pa-row").length, 2);
  await view.unmount();
});

test("the list names each app and opens one in the sandboxed frame with its stored data", async () => {
  const view = await mount(null);
  assert.deepEqual([...view.container.querySelectorAll(".pa-row-title")].map((node) => node.textContent), ["Budget", "Checklist"]);
  assert.equal(view.container.querySelector(".pa-row-meta")!.textContent!.startsWith("Version 3 · Updated "), true);
  assert.equal(view.frame() === null, true, "nothing runs until an app is opened");

  await view.click("Open in a window");
  assert.deepEqual(view.windows, [["page-apps", A]]);

  await view.click("Open Budget");
  const frame = view.frame()!;
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
  const doc = frame.getAttribute("srcdoc")!;
  assert.equal(doc.startsWith("<!doctype html><meta charset=utf-8><meta http-equiv=\"Content-Security-Policy\""), true);
  assert.equal(doc.includes("<h1>Budget page</h1>"), true);
  assert.equal(doc.includes("persistent:true"), true);
  assert.equal(doc.includes(JSON.stringify(JSON.stringify({ rows: "[1,2]" }))), true, "seeded with what the app stored");
  assert.equal(view.container.querySelector(".pa-bar-title")!.textContent, "Budget");

  // What the page stores reaches the server; a message from anything else does not.
  calls.length = 0;
  const post = async (source: unknown) => {
    await act(async () => {
      (dom as unknown as { dispatchEvent(event: unknown): boolean }).dispatchEvent(Object.assign(new dom.Event("message"), {
        source,
        data: { channel: "polyth-page-v1", kind: "storage", op: "set", key: "rows", value: "[1,2,3]" },
      }));
    });
  };
  await post({});
  await new Promise((done) => setTimeout(done, 450));
  assert.deepEqual(calls, []);
  await post(frame.contentWindow);
  await new Promise((done) => setTimeout(done, 450));
  await settle();
  assert.deepEqual(calls, [{ method: "POST", path: "/api/page-apps/storage", body: { id: A, set: { rows: "[1,2,3]" } } }]);

  await view.click("All apps");
  assert.equal(view.frame() === null, true);
  assert.equal(view.container.querySelectorAll(".pa-row").length, 2);
  await view.unmount();
});

test("in a window of its own the app is the whole window and names it", async () => {
  const view = await mount(B);
  assert.equal(view.frame()!.getAttribute("srcdoc")!.includes("<h1>Checklist page</h1>"), true);
  assert.equal(view.container.querySelector(".pa-bar") === null, true, "no bar, no way back to a list");
  assert.equal(view.labels().includes("All apps"), false);
  assert.equal(view.titles.at(-1), "Checklist");
  await view.unmount();
  assert.equal(view.titles.at(-1), null, "the window gets its own title back");
});

test("asked to show an app, the window opens it; a newer version reloads it; a removed one says so", async () => {
  const view = await mount(null, A);
  assert.equal(view.frame()!.getAttribute("srcdoc")!.includes("<h1>Budget page</h1>"), true);

  // Saved again elsewhere: the list brings the new hash, the page follows.
  apps = [record(A, "Budget 2", { version: 4, hash: "b".repeat(64) }), record(B, "Checklist")];
  pages = { ...pages, [A]: { html: "<h1>Budget page v4</h1>", storage: { rows: "[1,2,3]" } } };
  await act(async () => { await refreshApps(); });
  await settle();
  assert.equal(view.frame()!.getAttribute("srcdoc")!.includes("<h1>Budget page v4</h1>"), true);
  assert.equal(view.container.querySelector(".pa-bar-title")!.textContent, "Budget 2");

  apps = [record(B, "Checklist")];
  await act(async () => { await refreshApps(); });
  await settle();
  assert.equal(view.frame() === null, true);
  assert.equal(view.container.textContent!.includes("This app is gone"), true);
  await view.unmount();
});

test("no apps yet says how to make one", async () => {
  apps = [];
  await act(async () => { await refreshApps(); });
  const view = await mount(null);
  assert.equal(view.container.textContent!.includes("No apps yet"), true);
  assert.equal(view.container.textContent!.includes("Save as app"), true);
  await view.unmount();
});
