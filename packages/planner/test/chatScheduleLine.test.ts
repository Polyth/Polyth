// A chat's own schedule, mounted for real: the line above the composer, its
// list and actions, how it follows the session's events, and the run fact.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionEvent } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { PlannerTask } from "../src/model.ts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  getComputedStyle: (elt: Element) =>
    (dom as unknown as { getComputedStyle(el: Element): CSSStyleDeclaration }).getComputedStyle(elt),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ChatScheduleLine, PlannedRunFact } = await import("../widgets/ChatSchedule.tsx");
const { connectPlannerTasks, resetPlannerTasksForTest } = await import("../widgets/plannerTasks.ts");
const { takePlannerTaskRequest } = await import("../widgets/plannerOpen.ts");

const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => act(async () => { await delay(10); });
const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const NOW = Date.now();
const HOUR = 60 * 60_000;

function task(id: string, over: Partial<PlannerTask> = {}): PlannerTask {
  return {
    id,
    projectId: "p1",
    spaceId: "space-1",
    prompt: `Prompt ${id}`,
    title: `Task ${id}`,
    kind: "every",
    everyMinutes: 360,
    cadence: { kind: "every", everyMinutes: 360 },
    target: { mode: "existing-session", sessionId: "s1" },
    sessionId: "s1",
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    nextRunAt: NOW + 5 * HOUR,
    runs: 0,
    ...over,
  };
}

let tasks: PlannerTask[] = [];
const calls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  calls.push(`${method} ${url}`);
  if (url === "/api/planner" && method === "GET") return response({ tasks });
  const action = /^\/api\/planner\/([^/]+)\/(run|pause|resume)$/.exec(url);
  if (action && method === "POST") {
    const found = tasks.find((item) => item.id === decodeURIComponent(action[1]!));
    if (!found) return response({ error: "not-found" }, 404);
    if (action[2] !== "run") {
      found.enabled = action[2] === "resume";
      found.nextRunAt = found.enabled ? NOW + 5 * HOUR : null;
    }
    return response(found);
  }
  return response({ error: "not-found" }, 404);
}) as typeof fetch;

const listeners = new Set<(event: SessionEvent) => void>();
const opened: string[] = [];
const host = {
  sessions: {
    subscribeEvents: (listener: (event: SessionEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  },
  navigation: { openWorkspacePane: (id: string) => { opened.push(id); return true; } },
  ui: { components: {} },
} as unknown as WebPackageHost;

const emit = async (type: string, data: Record<string, unknown>) => {
  await act(async () => {
    for (const listener of listeners) listener({ id: `e-${type}`, sessionId: "s1", seq: 1, time: NOW, type, data, v: 1 } as SessionEvent);
    await delay(10);
  });
};

async function mounted(sessionId: string | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(ChatScheduleLine, { host, sessionId })); await delay(20); });
  return {
    container,
    rerender: async (next: string | null) => {
      await act(async () => { root.render(createElement(ChatScheduleLine, { key: next ?? "none", host, sessionId: next })); await delay(20); });
    },
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

const gets = () => calls.filter((call) => call === "GET /api/planner").length;

test("the line names the next run of this chat and how many more there are", async (t) => {
  resetPlannerTasksForTest();
  const disconnect = connectPlannerTasks(host);
  t.after(disconnect);
  tasks = [
    task("later", { nextRunAt: NOW + 30 * HOUR }),
    task("soon", { nextRunAt: NOW + 2 * HOUR }),
    task("paused", { enabled: false, nextRunAt: null }),
    task("other-chat", { target: { mode: "existing-session", sessionId: "s2" }, sessionId: "s2", nextRunAt: NOW + HOUR }),
  ];
  const view = await mounted("s1");
  t.after(view.unmount);
  const toggle = view.container.querySelector<HTMLButtonElement>(".planner-chat-toggle");
  assert.ok(toggle, "the chat has planned runs, so the line shows");
  assert.equal(view.container.querySelector(".planner-chat-title")?.textContent, "Task soon");
  assert.equal(view.container.querySelector(".planner-chat-more")?.textContent, "+2");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(view.container.querySelector(".planner-chat-panel"), null);

  await act(async () => { toggle.click(); await delay(10); });
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  const rows = [...view.container.querySelectorAll(".planner-chat-task")];
  assert.deepEqual(rows.map((row) => row.querySelector(".planner-chat-task-title")?.textContent), ["Task soon", "Task later", "Task paused"]);
  assert.deepEqual(rows.map((row) => row.getAttribute("data-state")), ["upcoming", "upcoming", "idle"]);
  assert.equal(rows[2]!.querySelector(".planner-chat-task-run"), null, "a paused task has no Run now shortcut");

  // Escape folds the list and hands focus back to the line.
  const panel = view.container.querySelector(".planner-chat")!;
  await act(async () => {
    panel.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
    await delay(10);
  });
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement, toggle);
});

test("Run now posts the run and reads the list again", async (t) => {
  resetPlannerTasksForTest();
  const disconnect = connectPlannerTasks(host);
  t.after(disconnect);
  tasks = [task("soon", { nextRunAt: NOW + 2 * HOUR })];
  const view = await mounted("s1");
  t.after(view.unmount);
  await act(async () => { view.container.querySelector<HTMLButtonElement>(".planner-chat-toggle")!.click(); await delay(10); });
  const before = gets();
  await act(async () => { view.container.querySelector<HTMLButtonElement>(".planner-chat-task-run")!.click(); await delay(30); });
  assert.ok(calls.includes("POST /api/planner/soon/run"));
  assert.ok(gets() > before, "the schedule is read again after the run");
});

test("the line follows the chat: a planner call or a planned run refreshes it, and it folds away when nothing is left", async (t) => {
  resetPlannerTasksForTest();
  const disconnect = connectPlannerTasks(host);
  t.after(disconnect);
  tasks = [];
  const view = await mounted("s1");
  t.after(view.unmount);
  assert.equal(view.container.querySelector(".planner-chat"), null, "nothing planned: no line");

  // The agent schedules: its call settles and the new task shows.
  tasks = [task("new", { nextRunAt: NOW + HOUR })];
  await emit("tool/call", { callId: "c1", tool: "mcp__polyth-agent-tools__polyth_planner", input: {} });
  assert.equal(view.container.querySelector(".planner-chat"), null, "the call alone changes nothing yet");
  await emit("tool/result", { callId: "c1", tool: "tool", output: "Scheduled" });
  await flush();
  assert.equal(view.container.querySelector(".planner-chat-title")?.textContent, "Task new");

  // The one-time run fired; the task left the schedule.
  tasks = [task("new", { kind: "at", cadence: { kind: "at", at: NOW - 1000 }, enabled: false, nextRunAt: null, runs: 1 })];
  await emit("planner/run-started", { taskId: "new", runId: "r1" });
  await flush();
  assert.equal(view.container.querySelector(".planner-chat"), null);
});

test("another chat shows only its own tasks", async (t) => {
  resetPlannerTasksForTest();
  const disconnect = connectPlannerTasks(host);
  t.after(disconnect);
  tasks = [task("mine", { nextRunAt: NOW + HOUR })];
  const view = await mounted("s1");
  t.after(view.unmount);
  assert.ok(view.container.querySelector(".planner-chat"));
  await view.rerender("s2");
  assert.equal(view.container.querySelector(".planner-chat"), null);
  await view.rerender(null);
  assert.equal(view.container.querySelector(".planner-chat"), null);
});

test("the run fact names its task and opens it in the Planner", async (t) => {
  resetPlannerTasksForTest();
  const disconnect = connectPlannerTasks(host);
  t.after(disconnect);
  tasks = [task("morning", { title: "Morning review" })];
  // A schedule line loads the shared list, as it does in a chat.
  const line = await mounted("s1");
  t.after(line.unmount);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => { root.unmount(); }); container.remove(); });
  const event = (data: Record<string, unknown>): SessionEvent =>
    ({ id: "fact-1", sessionId: "s1", seq: 9, time: NOW, type: "planner/run-started", data, v: 1 }) as SessionEvent;

  await act(async () => { root.render(createElement(PlannedRunFact, { host, event: event({ taskId: "morning", runId: "r1", taskTitle: "Morning review" }) })); await delay(10); });
  const fact = container.querySelector(".planner-run-fact");
  assert.equal(fact?.getAttribute("data-kind"), "planned");
  const title = container.querySelector<HTMLButtonElement>("button.planner-run-fact-title");
  assert.equal(title?.textContent, "Morning review");
  await act(async () => { title!.click(); await delay(10); });
  assert.equal(opened.at(-1), "planner");
  assert.equal(takePlannerTaskRequest(), "morning");

  await act(async () => { root.render(createElement(PlannedRunFact, { host, event: event({ taskId: "gone", runId: "r2", manual: true, taskTitle: "Removed task" }) })); await delay(10); });
  assert.equal(container.querySelector(".planner-run-fact")?.getAttribute("data-kind"), "manual");
  assert.equal(container.querySelector("button.planner-run-fact-title"), null, "a task that is gone is not a link");
  assert.equal(container.querySelector(".planner-run-fact-title")?.textContent, "Removed task");

  await act(async () => { root.render(createElement(PlannedRunFact, { host, event: event({ runId: "r3" }) })); await delay(10); });
  assert.equal(container.querySelector(".planner-run-fact"), null, "a malformed event renders nothing");
});
