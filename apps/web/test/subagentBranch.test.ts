// The open chat's subagents hang from its status line above the composer:
// one island with the agent's own line and, on a thread from its mark, a row
// per active subagent at once: no head, no fold, no Stop all. The one that
// needs the person comes first with Allow / Deny on its mirrored request;
// every other row has its own Stop, and a running one Pause. A paused one
// keeps its place with Continue until it goes on or is stopped, and both show
// their outcome at the click. A row that ends folds away. While the agent
// idles its line says it waits for them.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { Project, SessionEvent, SessionProjection } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  Event: dom.Event,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
Object.defineProperty(globalThis, "HTMLElement", {
  value: (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement,
  configurable: true,
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The server: every request is recorded; a child's log tail names its tool.
const calls: Array<{ method: string; path: string; search: string; body: unknown }> = [];
let failReplies = false;
const TOOL_OF: Record<string, { tool: string; input: Record<string, string> }> = {
  "p-b": { tool: "edit", input: { filePath: "packages/server/src/queue.ts" } },
};
(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: { method?: string; body?: string }) => {
  const parsed = new URL(String(url), "http://localhost:3000");
  const method = init?.method ?? "GET";
  calls.push({ method, path: parsed.pathname, search: parsed.search, body: init?.body ? JSON.parse(init.body) : undefined });
  const respond = (body: unknown, status = 200) => ({
    ok: status < 400, status, statusText: status < 400 ? "OK" : "Error",
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ "content-type": "application/json" }),
  });
  if (parsed.pathname.includes("/permission/") && failReplies) return respond({ error: "boom" }, 500);
  const events = parsed.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (events) {
    const tool = TOOL_OF[decodeURIComponent(events[1]!)];
    return respond(tool ? [
      { id: "t1", sessionId: events[1], seq: 1, time: 1, type: "turn/started", data: { turnId: "t" }, v: 1 },
      { id: "t2", sessionId: events[1], seq: 2, time: 2, type: "tool/call", data: { callId: "k", ...tool }, v: 1 },
    ] : []);
  }
  if (parsed.pathname === "/api/sessions/summaries") return respond({ sessions: [], revision: 0, complete: true });
  if (parsed.pathname === "/api/harnesses/roster") return respond([
    { identity: { id: "claude-work", name: "Claude Code", accountLabel: "work", color: "#7253e8" }, policy: { enabled: true, priority: 1, autoSelect: false } },
  ]);
  return respond(method === "GET" ? [] : { ok: true });
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement, Fragment } = await import("react");
const { createRoot } = await import("react-dom/client");
const store = await import("../src/store.ts");
const { buildModel } = await import("../src/reduce.ts");
const { resolveSessionActivity } = await import("../src/sessionActivity.ts");
const { default: SubagentActivityDock, SubagentBranchScope } = await import("../src/components/SubagentActivityDock.tsx");
const { default: AgentLiveStatusDock } = await import("../src/components/AgentLiveStatusDock.tsx");

const now = Date.now();
const session = (over: Partial<SessionProjection> & { id: string }): SessionProjection => ({
  projectId: "p1", title: over.id, status: "idle", createdAt: now - 60_000, updatedAt: now - 30_000, lastTurnAt: now - 30_000,
  attention: { questions: 0, permissions: 0, unread: 0 },
  ...over,
});
const fixtures = (): SessionProjection[] => [
  session({ id: "p", title: "Parent", model: { providerID: "anthropic", modelID: "opus" } }),
  session({ id: "p-a", parentId: "p", title: "Data migration", status: "working", createdAt: now - 50_000, attention: { questions: 0, permissions: 1, unread: 0 } }),
  session({ id: "p-b", parentId: "p", title: "Schema check", status: "working", createdAt: now - 40_000 }),
  session({ id: "p-c", parentId: "p", title: "Delegating helper", createdAt: now - 30_000 }),
  session({ id: "p-c1", parentId: "p-c", title: "Grandchild run", status: "working" }),
  session({ id: "p-d", parentId: "p", title: "Done helper", createdAt: now - 20_000 }),
];
const settled = { status: "idle", attention: { questions: 0, permissions: 0, unread: 0 } } as const;

let seq = 1;
const event = (sessionId: string, type: string, data: Record<string, unknown>): SessionEvent =>
  ({ id: `e${seq}`, sessionId, seq: seq++, time: now, type, data, v: 1 }) as SessionEvent;
const mirror = (risk: "medium" | "high" = "medium") => event("p", "permission/requested", {
  requestId: "r1", permission: "bash", tool: "bash", patterns: ["npm test"],
  preview: { title: "bash", lines: ["npm test"], risk }, sourceSessionId: "p-a",
});

function seed(sessions = fixtures()) {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [{ id: "p1", path: "/work/p1", name: "p1", createdAt: 1 } satisfies Project]);
  store.activateProject("p1");
  store.setSessions("p1", sessions);
}

async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    rerender: async (next: ReturnType<typeof createElement>) => { await act(async () => { root.render(next); }); },
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const text = (node: Element | null | undefined) => node?.textContent ?? "";
const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.getAttribute("aria-label") === label);

test("an idle agent's subagents hang from its still line, the waiting one first with its decision", async () => {
  seed();
  const model = buildModel([mirror()]);
  const view = await mount(createElement(SubagentBranchScope, { sessionId: "p", model }, createElement(SubagentActivityDock)));
  try {
    const island = view.container.querySelector<HTMLElement>(".subagent-island");
    assert.ok(island, "one island holds the line and its branch");
    assert.equal(island!.dataset.tone, "waiting", "a person's turn outranks running work");
    const line = island!.querySelector<HTMLElement>(".subagent-island-line > .agent-status-dock");
    assert.ok(line?.classList.contains("agent-status-dock--idle"), "the agent's own line holds still");
    assert.equal(line!.querySelector(".agent-status-dock-icon > i"), null, "no live dot on an idle mark");
    assert.match(text(line), /Waiting for subagents/);
    assert.equal(line!.getAttribute("aria-busy"), "false");

    // The list shows at once, straight under the agent's line.
    assert.equal(island!.querySelector(".subagent-branch-head, .subagent-branch-toggle, .subagent-cluster"), null,
      "no head row, fold or cluster over the list");
    assert.equal([...island!.querySelectorAll("button")].some((node) => /Stop all/.test(node.getAttribute("aria-label") ?? text(node))), false,
      "no Stop all");
    const list = island!.querySelector<HTMLElement>(".subagent-island-line + .subagent-branch-list")!;
    assert.equal(list.getAttribute("aria-label"), "Subagents: 3, Working: 2, Waiting for you: 1");
    const first = list.querySelector<HTMLElement>(".subagent-branch-item")!;
    assert.equal(text(first.querySelector(".subagent-branch-title")), "Data migration");
    assert.equal(text(first.querySelector(".subagent-branch-ask")), "Bash · npm test", "the ask in one line");
    assert.ok(button(first, "Allow: Data migration"), "Allow sits on the waiting row");
    assert.ok(button(first, "Deny: Data migration"));
    assert.equal(list.querySelectorAll(".subagent-branch-row").length, 3, "a finished child is not listed");
  } finally {
    await view.unmount();
  }
});

test("Allow answers the mirrored request on the parent; a failed reply brings the decision back", async () => {
  seed();
  const model = buildModel([mirror()]);
  const view = await mount(createElement(SubagentBranchScope, { sessionId: "p", model }, createElement(SubagentActivityDock)));
  try {
    calls.length = 0;
    await act(async () => { button(view.container, "Allow: Data migration")!.click(); });
    const reply = calls.find((call) => call.path === "/api/sessions/p/permission/r1");
    assert.deepEqual(reply && { method: reply.method, body: reply.body }, { method: "POST", body: { reply: "once" } },
      "the parent's mirror is answered; the server forwards it to the child");
    assert.equal(button(view.container, "Allow: Data migration"), undefined, "the decision leaves at the click");

    failReplies = true;
    await view.rerender(createElement(SubagentBranchScope, { sessionId: "p", model: buildModel([mirror()]) }, createElement(SubagentActivityDock)));
    // The same request id stays answered for this scope; a new one can fail.
    const fresh = buildModel([event("p", "permission/requested", {
      requestId: "r2", permission: "bash", tool: "bash", patterns: ["npm run build"],
      preview: { title: "bash", lines: ["npm run build"], risk: "medium" }, sourceSessionId: "p-a",
    })]);
    await view.rerender(createElement(SubagentBranchScope, { sessionId: "p", model: fresh }, createElement(SubagentActivityDock)));
    await act(async () => { button(view.container, "Deny: Data migration")!.click(); });
    await settle();
    assert.ok(calls.some((call) => call.path === "/api/sessions/p/permission/r2" && (call.body as { reply?: string }).reply === "reject"));
    assert.ok(button(view.container, "Deny: Data migration"), "a failed reply is decided again");
  } finally {
    failReplies = false;
    await view.unmount();
  }
});

test("a high-risk request is reviewed in its chat, never allowed from one line", async () => {
  seed();
  const view = await mount(createElement(SubagentBranchScope, { sessionId: "p", model: buildModel([mirror("high")]) }, createElement(SubagentActivityDock)));
  try {
    assert.equal(button(view.container, "Allow: Data migration"), undefined);
    assert.ok(button(view.container, "Review: Data migration"));
  } finally {
    await view.unmount();
  }
});

test("the branch lists every active subagent with its action, nested runs and Stop", async () => {
  seed();
  calls.length = 0;
  const view = await mount(createElement(SubagentBranchScope, { sessionId: "p", model: buildModel([mirror()]) }, createElement(SubagentActivityDock)));
  try {
    await settle();
    const rows = [...view.container.querySelectorAll<HTMLElement>(".subagent-branch-item")];
    assert.deepEqual(rows.map((row) => text(row.querySelector(".subagent-branch-title"))), ["Data migration", "Schema check", "Delegating helper"],
      "waiting first, then in delegation order");
    assert.equal(rows[0]!.dataset.state, "waiting");
    assert.match(text(rows[1]!.querySelector(".subagent-branch-detail")), /^Edit · queue\.ts/, "a working child's action is read from its log");
    assert.match(text(rows[2]!.querySelector(".subagent-branch-detail")), /Nested: 1$/, "a grandchild folds into its parent's row");
    // The action read is passive: it never wakes the child's runtime.
    const peek = calls.find((call) => call.path === "/api/sessions/p-b/events");
    assert.ok(peek, "the visible working row is read");
    assert.match(peek!.search, /limit=40/);
    assert.match(peek!.search, /prefetch=1/);
    assert.equal(calls.some((call) => call.path === "/api/sessions/p-c/events"), false, "a row whose own turn is idle is not read");

    assert.ok(button(rows[2]!, "Stop: Delegating helper"), "a row whose subagents work stops too");
    calls.length = 0;
    await act(async () => { button(view.container, "Stop: Schema check")!.click(); });
    assert.deepEqual(calls.filter((call) => call.path.endsWith("/abort")).map((call) => `${call.method} ${call.path}`),
      ["POST /api/sessions/p-b/abort"], "Stop stops that one subagent only");
  } finally {
    await view.unmount();
  }
});

test("more than four subagents fold behind +n more", async () => {
  const many = [session({ id: "m", title: "Many" }), ...Array.from({ length: 6 }, (_, index) =>
    session({ id: `m-${index}`, parentId: "m", title: `Worker ${index}`, status: "working", createdAt: now - 60_000 + index }))];
  seed(many);
  const view = await mount(createElement(SubagentBranchScope, { sessionId: "m", model: buildModel([]) }, createElement(SubagentActivityDock)));
  try {
    assert.equal(view.container.querySelectorAll(".subagent-branch-row").length, 4);
    const more = view.container.querySelector<HTMLButtonElement>(".subagent-branch-show-all")!;
    assert.equal(text(more), "+2 more");
    await act(async () => { more.click(); });
    assert.equal(view.container.querySelectorAll(".subagent-branch-row").length, 6);
    assert.equal(view.container.querySelector(".subagent-branch-show-all"), null);
  } finally {
    await view.unmount();
  }
});

test("a live status line hangs the branch only inside the status zone, and lets it go when the work ends", async () => {
  seed();
  const model = buildModel([event("p", "turn/started", { turnId: "t", model: { providerID: "anthropic", modelID: "opus" } })]);
  const parent = { ...fixtures()[0]!, status: "working" as const };
  const activity = resolveSessionActivity(parent, model.turn, []);
  const live = createElement(AgentLiveStatusDock, { activity, model });

  const outside = await mount(createElement(Fragment, null, live));
  try {
    assert.equal(outside.container.querySelector(".subagent-island"), null, "a dock placed elsewhere stays one line");
    assert.ok(outside.container.querySelector("button.agent-status-dock"));
  } finally {
    await outside.unmount();
  }

  const inside = await mount(createElement(SubagentBranchScope, { sessionId: "p", model }, live));
  try {
    const dock = inside.container.querySelector(".subagent-island > .subagent-island-line > button.agent-status-dock");
    assert.ok(dock, "the live line heads the island");
    assert.equal(dock!.getAttribute("aria-busy"), "true");
    assert.equal(inside.container.querySelectorAll(".subagent-island .subagent-branch-row").length, 3, "the rows hang from the live line");

    await act(async () => {
      store.setSessions("p1", fixtures().map((row) => row.parentId || row.id === "p-c1" ? { ...row, ...settled } : row));
    });
    assert.equal(inside.container.querySelector(".subagent-island"), null, "finished work leaves the bare line");
    assert.ok(inside.container.querySelector("button.agent-status-dock"));
  } finally {
    await inside.unmount();
  }

  seed(fixtures().map((row) => row.parentId || row.id === "p-c1" ? { ...row, ...settled } : row));
  const idle = await mount(createElement(SubagentBranchScope, { sessionId: "p", model: buildModel([]) }, createElement(SubagentActivityDock)));
  try {
    assert.equal(idle.container.innerHTML, "", "idle subagents take no room");
  } finally {
    await idle.unmount();
  }
});

test("the agent line wears its running harness profile color", async () => {
  seed([
    session({ id: "p", title: "Parent", model: { providerID: "anthropic", modelID: "opus" }, resolvedHarnessId: "claude-work" }),
    session({ id: "p-a", parentId: "p", status: "working", createdAt: now - 50_000 }),
  ]);
  const view = await mount(createElement(SubagentBranchScope, { sessionId: "p", model: buildModel([]) }, createElement(SubagentActivityDock)));
  try {
    await settle();
    const agent = view.container.querySelector<HTMLElement>(".agent-status-dock .provider-logo");
    assert.equal(agent?.style.getPropertyValue("--provider-logo-tint"), "#7253e8", "the agent's own line wears its profile color");
  } finally {
    await view.unmount();
  }
});

test("a running row pauses its own turn; a row whose subagents run has no Pause", async () => {
  seed();
  const view = await mount(createElement(SubagentBranchScope, { sessionId: "p", model: buildModel([mirror()]) }, createElement(SubagentActivityDock)));
  try {
    assert.equal(button(view.container, "Pause: Delegating helper") === undefined, true, "its own turn is idle: nothing of its own to pause");
    assert.equal(button(view.container, "Pause: Data migration") === undefined, true, "a waiting row carries its decision instead");
    calls.length = 0;
    await act(async () => { button(view.container, "Pause: Schema check")!.click(); });
    await settle();
    assert.deepEqual(calls.filter((call) => call.method === "POST").map((call) => ({ path: call.path, body: call.body })),
      [{ path: "/api/sessions/p-b/pause", body: { source: "subagent-dock" } }]);
    // The row shows the pause at the click, before the server confirms it.
    const row = [...view.container.querySelectorAll<HTMLElement>(".subagent-branch-item")]
      .find((item) => text(item.querySelector(".subagent-branch-title")) === "Schema check")!;
    assert.equal(row.dataset.state, "paused");
    assert.match(text(row.querySelector(".subagent-branch-detail")), /^Pausing…/);
    assert.equal(button(row, "Continue: Schema check")?.disabled, true, "nothing to continue until the pause lands");
    assert.equal(row.querySelector(".subagent-branch-mark .paused-mark") !== null, true, "the ring comes to rest");
  } finally {
    await view.unmount();
  }
});

test("a paused subagent stays listed with Continue and Stop until it goes on", async () => {
  const pausedAt = { at: now - 5_000, stopSeq: 7 };
  seed(fixtures().map((row) => row.id === "p-d" ? { ...row, paused: pausedAt } : row));
  const view = await mount(createElement(SubagentBranchScope, { sessionId: "p", model: buildModel([mirror()]) }, createElement(SubagentActivityDock)));
  try {
    const rows = [...view.container.querySelectorAll<HTMLElement>(".subagent-branch-item")];
    assert.deepEqual(rows.map((row) => text(row.querySelector(".subagent-branch-title"))),
      ["Data migration", "Schema check", "Delegating helper", "Done helper"], "the ask first; a pause keeps its place");
    const paused = rows[3]!;
    assert.equal(paused.dataset.state, "paused");
    assert.match(text(paused.querySelector(".subagent-branch-detail")), /^Paused/);
    assert.equal(button(paused, "Pause: Done helper") === undefined, true);
    assert.ok(button(paused, "Stop: Done helper"), "Stop ends the paused work");
    assert.equal(paused.querySelector(".subagent-branch-actions--paused") !== null, true, "its controls stay in view");
    calls.length = 0;
    await act(async () => { button(paused, "Continue: Done helper")!.click(); });
    await settle();
    assert.deepEqual(calls.filter((call) => call.method === "POST").map((call) => ({ path: call.path, body: call.body })),
      [{ path: "/api/sessions/p-d/continue", body: { source: "subagent-dock" } }]);
    // It runs again at the click; the projection confirms it later.
    assert.equal(paused.dataset.state, "working");
    assert.match(text(paused.querySelector(".subagent-branch-detail")), /^Continuing…/);
  } finally {
    await view.unmount();
  }

  // Only a paused subagent left: the branch stays, quiet, and says so.
  seed(fixtures().map((row) => row.parentId || row.id === "p-c1"
    ? { ...row, ...settled, ...(row.id === "p-d" ? { paused: pausedAt } : {}) }
    : row));
  const quiet = await mount(createElement(SubagentBranchScope, { sessionId: "p", model: buildModel([]) }, createElement(SubagentActivityDock)));
  try {
    const island = quiet.container.querySelector<HTMLElement>(".subagent-island");
    assert.equal(island?.dataset.tone, "paused");
    assert.match(text(island!.querySelector(".subagent-island-line")), /Subagents paused/);
    assert.equal(quiet.container.querySelectorAll(".subagent-branch-row").length, 1);
  } finally {
    await quiet.unmount();
  }
});

test("a subagent that ends folds away at its place instead of vanishing", async () => {
  seed();
  const view = await mount(createElement(SubagentBranchScope, { sessionId: "p", model: buildModel([mirror()]) }, createElement(SubagentActivityDock)));
  try {
    assert.equal(view.container.querySelector(".subagent-branch-list")?.hasAttribute("data-settled"), true);
    await act(async () => {
      store.setSessions("p1", fixtures().map((row) => row.id === "p-b" ? { ...row, ...settled } : row));
    });
    const titles = () => [...view.container.querySelectorAll<HTMLElement>(".subagent-branch-item")]
      .map((item) => `${text(item.querySelector(".subagent-branch-title"))}${item.hasAttribute("data-leaving") ? " (leaving)" : ""}`);
    assert.deepEqual(titles(), ["Data migration", "Schema check (leaving)", "Delegating helper"]);
    const leaving = view.container.querySelector<HTMLElement>("[data-leaving]")!;
    assert.equal(leaving.getAttribute("aria-hidden"), "true", "a leaving row is out of reach");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)); });
    assert.deepEqual(titles(), ["Data migration", "Delegating helper"]);
  } finally {
    await view.unmount();
  }
});
