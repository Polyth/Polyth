// The Custom actions window, mounted for real: starters fill the editor,
// saving creates the action in the chosen scope, a press runs it in the
// selected project and the tile follows the run, Terminal actions hand off to
// a Terminal tab, and a read-only caller is offered nothing it cannot do.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { ActionRunDto, CustomActionDto } from "../src/actionModel.ts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  CustomEvent: dom.CustomEvent,
  getComputedStyle: (elt: Element) =>
    (dom as unknown as { getComputedStyle(el: Element): CSSStyleDeclaration }).getComputedStyle(elt),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
// The library only offers its drag on a fine pointer; the same answer the
// browser gives a desktop shell.
Object.defineProperty(globalThis, "matchMedia", {
  configurable: true,
  value: (query: string) => ({ matches: query.includes("pointer: fine"), media: query, addEventListener() {}, removeEventListener() {} }),
});
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { callback(0); return 1; } });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

// ---- fake server (installed before any module captures fetch) ---------------------------------------------------------------------

interface Call { method: string; path: string; body?: unknown }
let calls: Call[] = [];
let actions: CustomActionDto[] = [];
let runs: ActionRunDto[] = [];
let permissions = { canManage: true, canRun: true, canChat: true, blocked: null as string | null };
let nextId = 0;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

(globalThis as { fetch?: unknown }).fetch = async (input: string, init?: { method?: string; body?: string }) => {
  const url = new URL(String(input), "http://127.0.0.1:4400");
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : undefined;
  calls.push({ method, path: url.pathname + url.search, ...(body ? { body } : {}) });
  const path = url.pathname;
  if (path === "/api/custom-action/actions" && method === "GET") return json({ actions, ...permissions });
  if (path === "/api/custom-action/actions" && method === "POST") {
    const action = { ...(body as object), id: `a${++nextId}`, createdAt: 1, updatedAt: 1 } as CustomActionDto;
    actions = [...actions, action];
    return json({ action });
  }
  const run = path.match(/^\/api\/custom-action\/actions\/([^/]+)\/run$/);
  if (run && method === "POST") {
    const action = actions.find((item) => item.id === run[1])!;
    const dto: ActionRunDto = {
      id: `r${++nextId}`, actionId: action.id, projectId: String(body!.projectId), sessionId: (body!.sessionId as string) ?? null,
      name: action.name, icon: action.icon, color: action.color, mode: action.mode as "background",
      status: "running", phase: "command", exitCode: null, startedAt: Date.now(), finishedAt: null,
      chatSessionId: null, chatSkipped: false, error: null, outputEnd: 0, truncated: false,
    };
    runs = [dto, ...runs];
    return json({ run: dto, joined: false });
  }
  if (path === "/api/custom-action/runs") return json({ runs });
  const output = path.match(/^\/api\/custom-action\/runs\/([^/]+)\/output$/);
  if (output) {
    const run = runs.find((item) => item.id === output[1])!;
    const text = "\u001b[31mFAIL\u001b[0m a.test.ts\r\n";
    const from = Number(url.searchParams.get("from") ?? 0);
    return json({ run, command: "npm test", start: from, end: text.length, text: text.slice(from) });
  }
  if (path === "/api/terminals" && method === "POST") return json({ terminalId: "t-1" });
  if (path.startsWith("/api/terminals/") && method === "PATCH") return json({ ok: true });
  return json({});
};


const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const store = await import("../../../apps/web/src/store.ts");
const { default: ActionLibrary } = await import("../widgets/ActionLibrary.tsx");
const { setActionHost } = await import("../widgets/host.ts");
const { resetActionStore } = await import("../widgets/store.ts");

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = async (ms = 30) => { await act(async () => { await delay(ms); }); };

// ---- host ------------------------------------------------------------------------------

const opened: string[] = [];
const notices: string[] = [];
const host = {
  navigation: { openWorkspacePane: (id: string) => { opened.push(id); return true; } },
  conversation: { openSession: async () => {}, startNewSession: () => {} },
  errors: { friendly: (action: string, cause: unknown) => `${action}: ${String(cause)}`, show: (message: string) => { notices.push(message); } },
  store: { getSnapshot: () => ({ activeProjectId: store.getState().activeProjectId, activeSessionId: store.getState().activeSessionId }) },
  ui: { Slot: () => null },
} as unknown as WebPackageHost;
setActionHost(host);

function seed(): void {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [
    { id: "p1", name: "Polyth", path: "/repo/polyth", createdAt: 1 },
    { id: "p2", name: "Site", path: "/repo/site", createdAt: 1 },
  ] as never);
  store.activateProject("p1");
}

async function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(node); await delay(30); });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

const click = async (element: Element | null | undefined) => {
  assert.ok(element, "element to click exists");
  await act(async () => {
    element!.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
    await delay(20);
  });
};

const byText = (root: ParentNode, selector: string, text: string | RegExp): HTMLElement | undefined =>
  Array.from(root.querySelectorAll<HTMLElement>(selector)).find((element) =>
    typeof text === "string" ? element.textContent?.trim() === text : text.test(element.textContent ?? ""));

function reset(): void {
  calls = [];
  actions = [];
  runs = [];
  opened.length = 0;
  notices.length = 0;
  permissions = { canManage: true, canRun: true, canChat: true, blocked: null };
  resetActionStore();
  seed();
}

// The store keeps a BroadcastChannel open, and Node keeps a process alive while
// one is open: release it after the last case, or the file never exits.
test.after(async () => {
  resetActionStore();
  await dom.happyDOM.close();
});

const action = (patch: Partial<CustomActionDto>): CustomActionDto => ({
  id: `a${++nextId}`, name: "Run tests", icon: "flask", color: "green", command: "npm test",
  mode: "background", projectId: null, createdAt: 1, updatedAt: 1, ...patch,
});

test("an empty library offers starters that fill the editor, and Create saves to this project", async () => {
  reset();
  const view = await mount(createElement(ActionLibrary, { variant: "window" }));
  try {
    assert.match(view.container.textContent ?? "", /Turn any command into a button/);
    await click(byText(view.container, ".ca-template", /Run tests/));
    const editor = document.querySelector(".ca-editor");
    assert.ok(editor, "the starter opens the editor");
    assert.equal((document.querySelector(".ca-name-input") as HTMLInputElement).value, "Run tests");
    assert.equal((document.querySelector(".ca-command-input") as HTMLTextAreaElement).value, "npm test");
    assert.equal(document.querySelector('.ca-mode[aria-checked="true"]')?.getAttribute("data-mode"), "background");
    assert.match(document.querySelector('.ca-scope [aria-checked="true"]')?.textContent ?? "", /Polyth/, "a new action belongs to the chosen project");

    await click(byText(document.body, "button", "Create"));
    const created = calls.find((call) => call.method === "POST" && call.path === "/api/custom-action/actions");
    assert.deepEqual(created?.body, {
      name: "Run tests", icon: "flask", color: "green", command: "npm test", mode: "background", projectId: "p1",
      chat: { prompt: "", when: "always" },
    });
    await settle();
    assert.equal(document.querySelector(".ca-editor"), null, "the editor closes after saving");
    const tile = view.container.querySelector(".ca-item .ca-press");
    assert.match(tile?.getAttribute("aria-label") ?? "", /Run tests — Result card/);
    assert.doesNotMatch(view.container.textContent ?? "", /In Polyth/, "a lone section carries no heading");
  } finally {
    await view.unmount();
  }
});

test("a press runs in the selected project and the tile follows the run to its end", async () => {
  reset();
  actions = [action({ projectId: null })];
  const view = await mount(createElement(ActionLibrary, { variant: "window" }));
  try {
    const press = view.container.querySelector<HTMLElement>(".ca-item .ca-press");
    await click(press);
    const run = calls.find((call) => call.method === "POST" && /\/run$/.test(call.path));
    assert.deepEqual(run?.body, { projectId: "p1" });
    assert.equal(view.container.querySelector(".ca-item")?.getAttribute("data-state"), "running");
    assert.equal(press?.getAttribute("aria-busy"), "true");
    assert.ok(view.container.querySelector(".ca-glyph-ring"), "a running tile draws its progress ring");

    runs = runs.map((item) => ({ ...item, status: "succeeded", phase: "done", exitCode: 0, finishedAt: Date.now() }));
    await settle(1_100);
    assert.equal(view.container.querySelector(".ca-item")?.getAttribute("data-state"), "done");
    assert.ok(view.container.querySelector('.ca-glyph-badge[data-tone="success"]'), "success shows a check on the icon");
    assert.deepEqual(notices, [], "a success is not announced as an error");
  } finally {
    await view.unmount();
  }
});

test("a failed run is announced once and its tile opens the output instead of re-running", async () => {
  reset();
  actions = [action({ projectId: "p1" })];
  const view = await mount(createElement(ActionLibrary, { variant: "window" }));
  try {
    await click(view.container.querySelector(".ca-item .ca-press"));
    runs = runs.map((item) => ({ ...item, status: "failed", phase: "done", exitCode: 2, finishedAt: Date.now() }));
    await settle(1_100);
    assert.equal(view.container.querySelector(".ca-item")?.getAttribute("data-state"), "failed");
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /“Run tests” failed with exit code 2/);
    const before = calls.filter((call) => /\/run$/.test(call.path)).length;
    await click(view.container.querySelector(".ca-item .ca-press"));
    assert.equal(calls.filter((call) => /\/run$/.test(call.path)).length, before, "the failed tile does not run again");
    assert.ok(document.querySelector(".ca-run"), "it opens the run instead");
    assert.ok(calls.some((call) => call.path.startsWith("/api/custom-action/runs/") && call.path.includes("/output?from=0")));
    await settle(60);
    const failure = document.querySelector(".ca-run .ca-term .ca-fg-1");
    assert.equal(failure?.textContent, "FAIL", "terminal colours survive into the output view");
    assert.match(document.querySelector(".ca-run .ca-pill")?.textContent ?? "", /Exit code 2/);
    assert.ok(byText(document.body, ".ca-run-actions button", "Run again"));
    assert.ok(byText(document.body, ".ca-run-actions button", "Ask an agent"));
  } finally {
    await view.unmount();
  }
});

test("a Terminal action opens a named Terminal tab in the selected project", async () => {
  reset();
  actions = [action({ name: "Dev server", command: "npm run dev", mode: "terminal" })];
  const announced: unknown[] = [];
  const listener = (event: Event) => announced.push((event as CustomEvent).detail);
  window.addEventListener("polyth:terminal-created", listener);
  const view = await mount(createElement(ActionLibrary, { variant: "window" }));
  try {
    await click(view.container.querySelector(".ca-item .ca-press"));
    assert.deepEqual(calls.find((call) => call.path === "/api/terminals")?.body, { projectId: "p1", cmd: "npm run dev" });
    assert.deepEqual(calls.find((call) => call.method === "PATCH")?.body, { title: "Dev server" });
    assert.deepEqual(opened, ["terminal"]);
    assert.deepEqual(announced[0], { terminalId: "t-1", projectId: "p1", title: "Dev server" });
    assert.equal(view.container.querySelector(".ca-item")?.getAttribute("data-state"), "opened");
    assert.equal(calls.some((call) => /\/run$/.test(call.path)), false, "Terminal actions never use the background runner");
  } finally {
    window.removeEventListener("polyth:terminal-created", listener);
    await view.unmount();
  }
});

test("project actions stay in their project and Space-wide ones show everywhere", async () => {
  reset();
  actions = [
    action({ name: "Polyth only", projectId: "p1" }),
    action({ name: "Site only", projectId: "p2" }),
    action({ name: "Everywhere", projectId: null }),
  ];
  const view = await mount(createElement(ActionLibrary, { variant: "window" }));
  try {
    const names = () => Array.from(view.container.querySelectorAll(".ca-item-name")).map((element) => element.textContent);
    assert.deepEqual(names(), ["Polyth only", "Everywhere"]);
  } finally {
    await view.unmount();
  }
});

test("a chat action reveals the hand-off options and saves its start condition", async () => {
  reset();
  const view = await mount(createElement(ActionLibrary, { variant: "window" }));
  try {
    assert.equal(byText(view.container, ".ca-toolbar button", "New action"), undefined, "an empty library offers one primary action, not two");
    await click(byText(view.container, ".ca-empty button", "New action"));
    const reveal = document.querySelector(".ca-reveal");
    assert.equal(reveal?.hasAttribute("data-open"), false, "chat options stay folded for a background action");
    await act(async () => {
      const textarea = document.querySelector(".ca-command-input") as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")!.set!;
      setter.call(textarea, "npm run build");
      textarea.dispatchEvent(new (dom as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
      await delay(10);
    });
    await click(document.querySelector('.ca-mode[data-mode="chat"]'));
    assert.equal(document.querySelector(".ca-reveal")?.hasAttribute("data-open"), true);
    await click(byText(document.body, ".ca-seg-option", "If it fails"));
    await click(byText(document.body, ".ca-scope .ca-seg-option", /All projects/));
    await click(byText(document.body, "button", "Create"));
    const created = calls.find((call) => call.method === "POST" && call.path === "/api/custom-action/actions");
    assert.deepEqual(created?.body, {
      name: "npm run build", icon: "zap", color: "accent", command: "npm run build", mode: "chat", projectId: null,
      chat: { prompt: "", when: "failure" },
    }, "an unnamed action is named after its command");
  } finally {
    await view.unmount();
  }
});

test("a caller who may not manage actions is offered no authoring", async () => {
  reset();
  permissions = { canManage: false, canRun: true, canChat: false, blocked: null };
  actions = [action({})];
  const view = await mount(createElement(ActionLibrary, { variant: "window" }));
  try {
    assert.equal(byText(view.container, "button", "New action"), undefined);
    assert.equal(view.container.querySelector(".ca-item")?.getAttribute("draggable"), null, "nothing can be dragged");
  } finally {
    await view.unmount();
  }
});

test("a blocked deployment explains itself and disables presses", async () => {
  reset();
  permissions = { canManage: false, canRun: false, canChat: false, blocked: "Custom actions run commands on the Polyth host, which this deployment does not allow." };
  actions = [action({})];
  const view = await mount(createElement(ActionLibrary, { variant: "window" }));
  try {
    assert.match(view.container.textContent ?? "", /this deployment does not allow/);
    const press = view.container.querySelector(".ca-item .ca-press");
    assert.equal(press?.getAttribute("aria-disabled"), "true");
    await click(press);
    assert.equal(calls.some((call) => /\/run$/.test(call.path)), false);
  } finally {
    await view.unmount();
  }
});

test("in edit mode a press edits the action instead of running it", async () => {
  reset();
  actions = [action({ name: "Deploy", projectId: "p1" })];
  const view = await mount(createElement(ActionLibrary, { variant: "window" }));
  try {
    await click(byText(view.container, ".ca-toolbar button", "Edit"));
    assert.equal(view.container.querySelector(".ca-item")?.getAttribute("data-editing"), "true");
    assert.match(view.container.querySelector(".ca-item .ca-press")?.getAttribute("aria-label") ?? "", /^Edit Deploy$/);
    await click(view.container.querySelector(".ca-item .ca-press"));
    assert.ok(document.querySelector(".ca-editor"), "the editor opens");
    assert.equal((document.querySelector(".ca-name-input") as HTMLInputElement).value, "Deploy");
    assert.equal(calls.some((call) => /\/run$/.test(call.path)), false, "nothing ran");
    await click(byText(document.body, "button", "Cancel"));
    await click(byText(view.container, ".ca-toolbar button", "Done"));
    assert.equal(view.container.querySelector(".ca-item")?.getAttribute("data-editing"), null);
  } finally {
    await view.unmount();
  }
});

test("a tile dragged out of the window carries its launcher capability, so a rail can take it", async () => {
  reset();
  actions = [action({ name: "Deploy", projectId: "p1" })];
  const view = await mount(createElement(ActionLibrary, { variant: "window" }));
  const railDrag = await import("../../../apps/web/src/railDrag.ts");
  try {
    const item = view.container.querySelector(".ca-item")!;
    assert.ok(item.hasAttribute("draggable"), "the tile is a drag source for a fine pointer");
    // The host owns the bridge from a window drag to the rails.
    const dnd = await import("../../../apps/web/src/dnd.ts");
    const stop = dnd.installExternalCapabilityDrag();
    const carried = new Map<string, string>();
    const transfer = {
      get types() { return [...carried.keys(), "text/plain"]; },
      dropEffect: "none",
      effectAllowed: "none",
      setData: (type: string, value: string) => carried.set(type, value),
      getData: (type: string) => carried.get(type) ?? "",
    };
    const dragStart = new (dom as unknown as { Event: typeof Event }).Event("dragstart", { bubbles: true, cancelable: true });
    Object.assign(dragStart, { dataTransfer: transfer });
    await act(async () => { item.dispatchEvent(dragStart); await delay(10); });

    const capabilityId = carried.get("application/x-polyth-capability");
    assert.ok(capabilityId, "the drag carries the capability MIME");
    assert.match(capabilityId!, /^custom-action\.run\./, "it is the action's own launcher id");
    const drag = railDrag.getRailDrag();
    assert.equal(drag?.id, capabilityId, "the rail drag is holding that launcher");
    assert.equal(document.body.dataset.railDragging, "true", "the rails stand ready to receive it");
    assert.equal(carried.get("text/plain"), "Deploy", "the library's own reorder payload is untouched");

    // Releasing anywhere but a rail leaves the rails as they were.
    await act(async () => {
      item.dispatchEvent(new (dom as unknown as { Event: typeof Event }).Event("dragend", { bubbles: true }));
      await delay(10);
    });
    assert.equal(railDrag.getRailDrag(), null);
    assert.equal(document.body.dataset.railDragging, undefined);
    stop();
  } finally {
    await view.unmount();
  }
});

test("tiles carry no mode subtitle, an empty Space-wide section stays hidden and an add tile ends the grid", async () => {
  reset();
  actions = [action({ name: "Polyth only", projectId: "p1" })];
  const view = await mount(createElement(ActionLibrary, { variant: "window" }));
  try {
    assert.equal(view.container.querySelector(".ca-item-meta"), null, "an idle tile shows its name only");
    assert.equal(view.container.querySelector(".ca-section-title"), null, "a lone section needs no heading");
    assert.equal(view.container.querySelectorAll(".ca-section").length, 1, "the empty All projects section is not drawn");
    const add = view.container.querySelector<HTMLElement>(".ca-add-tile");
    assert.ok(add, "the grid ends with an add tile");
    await click(add);
    assert.ok(byText(document.body, "button", "Create"), "the add tile opens the editor");
  } finally {
    await view.unmount();
  }
});

test("both scopes get headings once each has actions", async () => {
  reset();
  actions = [action({ name: "Polyth only", projectId: "p1" }), action({ name: "Everywhere", projectId: null })];
  const view = await mount(createElement(ActionLibrary, { variant: "window" }));
  try {
    assert.equal(view.container.querySelectorAll(".ca-section-title").length, 2);
    assert.equal(view.container.querySelectorAll(".ca-add-tile").length, 1, "one add tile, in the project grid");
  } finally {
    await view.unmount();
  }
});

test("Recent runs is an accordion: closed by default, count and latest status in the header", async () => {
  reset();
  actions = [action({ name: "Run tests" })];
  runs = [{
    id: "old", actionId: actions[0]!.id, projectId: "p1", sessionId: null, name: "Run tests", icon: "flask", color: "green",
    mode: "background", status: "failed", phase: "done", exitCode: 2, startedAt: Date.now() - 5_000, finishedAt: Date.now() - 1_000,
    chatSessionId: null, chatSkipped: false, error: null, outputEnd: 0, truncated: false,
  } as unknown as ActionRunDto];
  localStorage.removeItem("custom-action.recentRunsOpen");
  const view = await mount(createElement(ActionLibrary, { variant: "window" }));
  try {
    const head = view.container.querySelector<HTMLElement>(".ca-recent-head");
    assert.ok(head);
    assert.equal(head!.getAttribute("aria-expanded"), "false");
    assert.match(head!.textContent ?? "", /Recent runs/);
    assert.match(head!.textContent ?? "", /Run tests · Exit code 2|Run tests · /, "the header summarises the latest run");
    assert.equal(view.container.querySelector(".ca-recent-body")?.hasAttribute("inert"), true, "closed rows are out of the tab order");
    await click(head);
    assert.equal(head!.getAttribute("aria-expanded"), "true");
    assert.equal(view.container.querySelector(".ca-recent-body")?.hasAttribute("inert"), false);
    assert.equal(localStorage.getItem("custom-action.recentRunsOpen"), "1", "the choice is remembered");
  } finally {
    localStorage.removeItem("custom-action.recentRunsOpen");
    await view.unmount();
  }
});
