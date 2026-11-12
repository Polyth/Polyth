// The card edge and the column order for an agent stop nobody has looked at
// yet. A card whose linked session stopped carries a marker and sorts to the
// top of its column; opening the task clears it, and nothing is written to the
// tracker for that.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { TaskTrackerStatusDto, TaskTrackerTaskDto } from "@polyth/contracts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  FileReader: dom.FileReader,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return false; },
    }),
  });
}
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameCallback) => {
    callback(0);
    return 1;
  },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => undefined });
Object.defineProperty(globalThis, "getComputedStyle", {
  configurable: true,
  value: (elt: Element) => (window as unknown as Window).getComputedStyle(elt as never),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);
const { hostUi, installTestHost } = await import("./hostUi.ts");
installTestHost();

type FrameCallback = (time: number) => void;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("../widgets/api.ts");
const { TaskTrackerBoard, configureTaskTrackerHost } = await import("../widgets/plugin.tsx");
const { notifications, resetNotifications } = await import("../../../apps/web/src/notify/store.ts");
const store = await import("../widgets/store.ts");
const { DEFAULT_TASK_TRACKER_PREFERENCES } = await import("../src/types.ts");
type TaskTrackerTaskLinkDto = import("../src/types.ts").TaskTrackerTaskLinkDto;

const statuses: TaskTrackerStatusDto[] = [
  { id: "todo", name: "To do", category: "todo" },
  { id: "done", name: "Done", category: "done" },
];

const task = (id: string, title: string): TaskTrackerTaskDto => ({
  provider: "jira",
  id,
  key: `POL-${id}`,
  title,
  description: "",
  boardId: "delivery",
  projectId: "polyth",
  status: statuses[0]!,
  availableStatuses: statuses,
  labels: [],
  assignees: [],
});

const settle = async (turns = 4): Promise<void> => {
  for (let index = 0; index < turns; index++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
};

const link = (taskId: string, extra: Partial<TaskTrackerTaskLinkDto> = {}): TaskTrackerTaskLinkDto => ({
  provider: "jira",
  taskId,
  taskKey: `POL-${taskId}`,
  sessionId: `s-${taskId}`,
  linkedAt: 1,
  ...extra,
});

interface Harness {
  seen: Array<{ provider: string; taskId: string }>;
  links: TaskTrackerTaskLinkDto[];
  restore(): void;
}

function harness(initialLinks: TaskTrackerTaskLinkDto[]): Harness {
  const originals = { ...api };
  const seen: Harness["seen"] = [];
  const state = { links: initialLinks };
  const tasks = [task("1", "Fix mobile overflow"), task("2", "Add retry guidance"), task("3", "Polish layout")];
  api.taskTrackerProviders = async () => [
    { provider: "jira", mode: "live", configured: true, requiredEnv: [] },
    { provider: "trello", mode: "live", configured: false, requiredEnv: [] },
  ];
  api.taskTrackerProjects = async () => [{ provider: "jira", id: "polyth", key: "POL", name: "Polyth" }];
  api.taskTrackerBoards = async () => [{ provider: "jira", id: "delivery", name: "Delivery", type: "kanban", projectId: "polyth" }];
  api.taskTrackerTasks = async () => tasks;
  api.taskTrackerTask = async (_provider, id) => tasks.find((item) => item.id === id)!;
  api.taskTrackerSessionTasks = async () => [];
  api.taskTrackerSettings = async () => ({
    preferences: DEFAULT_TASK_TRACKER_PREFERENCES,
    connections: [],
    personalConnections: [],
    providers: [
      { provider: "jira", mode: "live", configured: true, requiredEnv: [], enabled: true, source: "connection" },
      { provider: "trello", mode: "live", configured: false, requiredEnv: [], enabled: true, source: "none" },
    ],
    vaultAvailable: true,
    canManage: true,
    canConnect: true,
  });
  api.taskTrackerLinks = async () => state.links;
  api.taskTrackerSeen = async (provider, taskId) => {
    seen.push({ provider, taskId });
    state.links = state.links.map((item) =>
      item.provider === provider && item.taskId === taskId ? { ...item, seenAt: 1_000 } : item);
    return { ok: true, marked: 1 };
  };
  api.taskTrackerViewer = async () => undefined as never;
  resetNotifications();
  configureTaskTrackerHost({
    ui: hostUi,
    notifications,
    errors: { friendly: (action: string, cause: unknown) => `${action}: ${(cause as Error)?.message ?? ""}` },
    store: {
      subscribe: () => () => {},
      getSnapshot: () => ({ activeProjectId: "project-1", activeSessionId: null }),
    },
    executionDraft: {
      get: () => ({
        harnessSelection: { mode: "pinned", harnessId: "claude" },
        model: { harnessId: "claude", providerID: "anthropic", modelID: "opus" },
      }),
    },
    sessions: { subscribe: () => () => {}, get: () => undefined },
    conversation: { openSession: async () => undefined },
    navigation: { openSettingsPage() {} },
  } as never);
  store.resetManagementForTests();
  localStorage.removeItem("polyth.task-trackers.start");
  return {
    seen,
    get links() { return state.links; },
    restore() {
      Object.assign(api, originals);
      store.resetManagementForTests();
    },
  } as Harness;
}

async function mountBoard() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(TaskTrackerBoard, { sessionId: null, config: {}, updateConfig: () => {} }));
  });
  await settle(5);
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const cardOrder = (container: ParentNode): string[] =>
  [...container.querySelectorAll<HTMLElement>("[data-task-ref]")].map((card) => card.dataset.taskRef ?? "");

test("a card whose agent stopped sorts to the top of its column and carries the edge", async () => {
  const run = harness([link("2", { agentStop: { at: 500, kind: "finished" } })]);
  const view = await mountBoard();
  try {
    assert.deepEqual(cardOrder(view.container), ["jira:2", "jira:1", "jira:3"], "the newest agent stop leads, the rest keep the tracker's order");
    const attended = view.container.querySelector<HTMLElement>('[data-task-ref="jira:2"]');
    assert.ok(attended?.classList.contains("agent-attention"), "the card carries the marker class");
    assert.equal(attended?.dataset.attention, "finished", "and says what kind of stop it was");
    assert.match(attended?.textContent ?? "", /Needs a look/, "the chip names the state");
    assert.equal(
      view.container.querySelector<HTMLElement>('[data-task-ref="jira:1"]')?.classList.contains("agent-attention"),
      false,
    );
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("two unseen stops order by the newest, and a seen one stops leading", async () => {
  const run = harness([
    link("3", { agentStop: { at: 200, kind: "error" } }),
    link("2", { agentStop: { at: 800, kind: "needs-input" } }),
    link("1", { agentStop: { at: 900, kind: "finished" }, seenAt: 950 }),
  ]);
  const view = await mountBoard();
  try {
    assert.deepEqual(cardOrder(view.container), ["jira:2", "jira:3", "jira:1"], "newest unseen first, looked-at last within its place");
    assert.equal(
      view.container.querySelector<HTMLElement>('[data-task-ref="jira:1"]')?.classList.contains("agent-attention"),
      false,
      "a stop newer than the sighting only",
    );
    assert.equal(view.container.querySelector<HTMLElement>('[data-task-ref="jira:3"]')?.dataset.attention, "error");
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("opening a task clears its edge without writing to the tracker", async () => {
  const run = harness([link("2", { agentStop: { at: 500, kind: "finished" } })]);
  const view = await mountBoard();
  try {
    const card = view.container.querySelector<HTMLButtonElement>('[aria-label^="Open POL-2:"]')!;
    await act(async () => { card.click(); });
    await settle(5);
    assert.deepEqual(run.seen, [{ provider: "jira", taskId: "2" }], "the sighting is recorded once");
    assert.deepEqual(cardOrder(view.container), ["jira:1", "jira:2", "jira:3"], "the card goes back to its own place");
    assert.equal(
      view.container.querySelector<HTMLElement>('[data-task-ref="jira:2"]')?.classList.contains("agent-attention"),
      false,
    );
  } finally {
    await view.unmount();
    run.restore();
  }
});
