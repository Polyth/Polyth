import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { TaskTrackerBoardDto, TaskTrackerTaskDto } from "@polyth/contracts";
import type { WebPackageHost, WebUiPreferenceAdapter, WidgetPlugin } from "@polyth/web-sdk";
import type { TaskTrackerManagementDto } from "../src/types.ts";

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
  value: (callback: FrameRequestCallback) => {
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

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("../widgets/api.ts");
const { TaskTrackerBoard, configureTaskTrackerHost, createTaskTrackerInstaller } = await import("../widgets/plugin.tsx");
const { notifications, getNotifications, resetNotifications } = await import("../../../apps/web/src/notify/store.ts");
/** The board's latest outcome notice, as the host stack holds it. */
const boardNotice = () => getNotifications().items.find((item) => item.id === "task-trackers.board-notice")?.title ?? "";
const scope = await import("../widgets/scope.ts");
const store = await import("../widgets/store.ts");
const { DEFAULT_TASK_TRACKER_PREFERENCES } = await import("../src/types.ts");

const management = (): TaskTrackerManagementDto => ({
  preferences: DEFAULT_TASK_TRACKER_PREFERENCES,
  connections: [],
  personalConnections: [],
  providers: [
    { provider: "jira", mode: "live", configured: true, requiredEnv: [], enabled: true, source: "connection" },
    { provider: "trello", mode: "live", configured: false, requiredEnv: [], enabled: true, source: "none" },
  ],
  vaultAvailable: true,
  canManage: false,
  canConnect: true,
});

const board = (id: string, name: string, projectId: string): TaskTrackerBoardDto =>
  ({ provider: "jira", id, name, type: "kanban", projectId });

const task = (id: string, boardId: string): TaskTrackerTaskDto => ({
  provider: "jira",
  id,
  key: `POL-${id}`,
  title: `Task ${id} on ${boardId}`,
  description: "",
  boardId,
  projectId: "polyth",
  status: { id: "todo", name: "To do", category: "todo" },
  availableStatuses: [],
  labels: [],
  assignees: [],
});

const settle = async (turns = 3): Promise<void> => {
  for (let index = 0; index < turns; index++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
};

const button = (root: ParentNode, text: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll("button")].find((item) => item.textContent?.trim() === text) as HTMLButtonElement | undefined;

const typeInto = (control: HTMLInputElement, value: string): void => {
  Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")?.set?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
};

const boardTitle = (root: ParentNode): string | null =>
  root.querySelector(".tt-kanban, .tt-list")?.getAttribute("aria-label") ?? null;

function harness() {
  const originals = { ...api };
  let boards = [board("delivery", "Delivery", "polyth"), board("roadmap", "Roadmap", "polyth"), board("oncall", "On-call", "ops")];
  const boardRequests: Array<string | undefined> = [];
  const createdBoards: Array<Parameters<typeof api.taskTrackerCreateBoard>[1]> = [];
  api.taskTrackerProviders = async () => [
    { provider: "jira", mode: "live", configured: true, requiredEnv: [] },
    { provider: "trello", mode: "live", configured: false, requiredEnv: [] },
  ];
  api.taskTrackerProjects = async () => [
    { provider: "jira", id: "polyth", key: "POL", name: "Polyth" },
    { provider: "jira", id: "ops", key: "OPS", name: "Operations" },
  ];
  api.taskTrackerBoards = async (_provider, projectId) => {
    boardRequests.push(projectId);
    return boards.filter((item) => !projectId || item.projectId === projectId);
  };
  api.taskTrackerTasks = async (_provider, input) => [task("1", input.boardId ?? "")];
  api.taskTrackerTask = async (_provider, id) => task(id, "delivery");
  api.taskTrackerSessionTasks = async () => [];
  api.taskTrackerSettings = async () => management();
  api.taskTrackerLinks = async () => [];
  api.taskTrackerCreateBoard = async (_provider, input) => {
    createdBoards.push(input);
    const next = board("q4", input.name, input.projectId ?? "");
    boards = [...boards, next];
    return next;
  };
  resetNotifications();
  configureTaskTrackerHost({
    ui: { icons: {} },
    notifications,
    errors: { friendly: (action: string, cause: unknown) => `${action}: ${(cause as Error)?.message ?? ""}` },
    store: { subscribe: () => () => {}, getSnapshot: () => ({ activeProjectId: "project-1", activeSessionId: null }) },
    executionDraft: { get: () => ({ harnessSelection: { mode: "auto" } }) },
    sessions: { subscribe: () => () => {}, get: () => undefined },
    conversation: { openSession: async () => {} },
    navigation: { openSettingsPage() {} },
  } as never);
  store.resetManagementForTests();
  scope.resetBoardScopeForTests();
  localStorage.clear();
  return {
    boardRequests,
    createdBoards,
    restore() {
      Object.assign(api, originals);
      store.resetManagementForTests();
      scope.resetBoardScopeForTests();
      localStorage.clear();
    },
  };
}

/** Without `activeProjectId` the board shows the host's active project ("project-1"). */
async function mountBoard(memoryKey?: string, activeProjectId?: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(TaskTrackerBoard, {
      sessionId: null,
      config: {},
      updateConfig: () => {},
      ...(memoryKey ? { memoryKey } : {}),
      ...(activeProjectId ? { activeProjectId } : {}),
    }));
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

test("board scope helpers normalize stored values and resolve what opens", () => {
  const normalized = scope.normalizeBoardScope({
    jira: { hiddenBoards: ["a", "a", 3, ""], defaultBoardId: "a", junk: true },
    linear: { hiddenBoards: ["x"] },
  });
  assert.deepEqual(normalized.jira, { hiddenProjects: [], hiddenBoards: ["a"], defaultProjectId: "", defaultBoardId: "a" });
  assert.deepEqual(normalized.trello, scope.EMPTY_PROVIDER_SCOPE);

  const boards = [board("a", "A", "p1"), board("b", "B", "p1"), board("c", "C", "p2")];
  const projects = [{ id: "p1" }, { id: "p2" }];
  const empty = scope.EMPTY_PROVIDER_SCOPE;
  assert.equal(scope.resolveBoard(boards, empty), "a", "first visible board by default");
  assert.equal(scope.resolveBoard(boards, { ...empty, defaultBoardId: "c" }), "c");
  assert.equal(scope.resolveBoard(boards, { ...empty, defaultBoardId: "c" }, ["b"]), "b", "what the device remembers wins");
  assert.equal(scope.resolveBoard(boards, { ...empty, defaultBoardId: "c", hiddenProjects: ["p2"] }, ["zzz"]), "a", "a hidden project hides its boards");
  assert.equal(scope.resolveBoard(boards, { ...empty, hiddenBoards: ["a", "b", "c"] }), "");
  assert.equal(scope.resolveProject(projects, { ...empty, defaultProjectId: "p2" }), "p2");
  assert.equal(scope.resolveProject(projects, { ...empty, defaultProjectId: "p2", hiddenProjects: ["p2"] }), "");
  assert.equal(scope.resolveProject(projects, empty, ["gone", "p1"]), "p1");

  scope.resetBoardScopeForTests();
  scope.updateProviderScope(null, "jira", { defaultBoardId: "b", defaultProjectId: "p1" });
  scope.updateProviderScope(null, "jira", { hiddenBoards: ["b"], hiddenProjects: ["p1"] });
  assert.deepEqual(scope.providerScope(null, "jira"), { hiddenProjects: ["p1"], hiddenBoards: ["b"], defaultProjectId: "", defaultBoardId: "" }, "hiding the default clears it");
  assert.deepEqual(JSON.parse(localStorage.getItem("polyth.task-trackers.boards") ?? "{}").jira.hiddenBoards, ["b"]);
  assert.equal(scope.boardScopeAdapter.read(), scope.boardScope());
  scope.resetBoardScopeForTests();
  assert.equal(scope.boardScopeAdapter.read(), null, "an untouched selection is not mirrored");

  const memory = scope.localBoardMemory("tt-test-memory");
  memory.write({ provider: "trello", selections: { trello: { projectId: "", boardId: "t1" } } });
  memory.write({ selections: { jira: { projectId: "p1", boardId: "a" } } });
  const { at, ...remembered } = memory.read();
  assert.deepEqual(remembered, { provider: "trello", selections: { trello: { projectId: "", boardId: "t1" }, jira: { projectId: "p1", boardId: "a" } } });
  assert.equal(typeof at, "number", "the memory knows when it last chose");
  localStorage.setItem("tt-test-memory", "{not json");
  assert.deepEqual(memory.read(), { selections: {} });
  localStorage.clear();
});

test("choosing boards to show hides them from the window and sets what opens by default", async () => {
  const run = harness();
  const view = await mountBoard();
  try {
    assert.equal(boardTitle(view.container), "Delivery kanban board");
    assert.match(view.container.textContent ?? "", /Project/, "Jira groups boards by project");

    await act(async () => { view.container.querySelector<HTMLButtonElement>('[aria-label="Choose boards to show"]')!.click(); });
    await settle(4);
    const dialog = document.querySelector(".tt-scope-dialog");
    assert.ok(dialog, "the scope dialog opens");
    assert.match(dialog.textContent ?? "", /Polyth.*Operations/s);
    assert.match(dialog.textContent ?? "", /Delivery.*Roadmap.*On-call/s);

    const checkbox = (name: string): HTMLInputElement => {
      const row = [...dialog.querySelectorAll(".tt-scope-row")].find((item) => item.querySelector(".tt-scope-name strong")?.textContent === name);
      assert.ok(row, `${name} row exists`);
      return row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    };
    await act(async () => { checkbox("Delivery").click(); });
    await settle(3);
    assert.equal(boardTitle(view.container), "Roadmap kanban board", "hiding the open board moves to the next visible one");
    assert.deepEqual(scope.providerScope("project-1", "jira").hiddenBoards, ["delivery"]);
    assert.deepEqual(scope.providerScope(null, "jira"), scope.EMPTY_PROVIDER_SCOPE, "the account-wide selection stays");
    assert.deepEqual(scope.providerScope("project-2", "jira"), scope.EMPTY_PROVIDER_SCOPE, "another project keeps its own");

    await act(async () => { dialog.querySelector<HTMLInputElement>('input[aria-label="Open On-call by default"]')!.click(); });
    await settle();
    assert.equal(scope.providerScope("project-1", "jira").defaultBoardId, "oncall");
    await act(async () => { checkbox("Operations").click(); });
    await settle(3);
    assert.equal(scope.providerScope("project-1", "jira").defaultBoardId, "", "hiding the default's project clears the default");
    assert.deepEqual(scope.providerScope("project-1", "jira").hiddenProjects, ["ops"]);
    assert.equal(dialog.querySelector<HTMLInputElement>('input[aria-label="Open On-call by default"]')!.disabled, true);

    await act(async () => { dialog.querySelector<HTMLInputElement>('input[aria-label="Open Roadmap by default"]')!.click(); });
    await act(async () => { button(dialog, "Done")!.click(); });
    await settle();
    assert.equal(document.querySelector(".tt-scope-dialog"), null);
    assert.equal(scope.providerScope("project-1", "jira").defaultBoardId, "roadmap");
  } finally {
    await view.unmount();
  }

  // A fresh window with no memory opens the default board.
  scope.updateProviderScope("project-1", "jira", { hiddenBoards: [], hiddenProjects: [], defaultBoardId: "roadmap", defaultProjectId: "polyth" });
  const fresh = await mountBoard();
  try {
    assert.equal(boardTitle(fresh.container), "Roadmap kanban board");
    assert.equal(run.boardRequests.at(-1), "polyth", "the default project is requested right away");
  } finally {
    await fresh.unmount();
    run.restore();
  }
});

test("a window remembers what it last showed on this device and a new board opens right away", async () => {
  const run = harness();
  const key = "polyth.task-trackers.test-window";
  // Both from before choices were kept per project: every project starts from them.
  scope.updateProviderScope(null, "jira", { defaultBoardId: "oncall" });
  const legacy = JSON.stringify({ provider: "jira", selections: { jira: { projectId: "polyth", boardId: "roadmap" } } });
  localStorage.setItem(key, legacy);
  const view = await mountBoard(key);
  try {
    assert.equal(boardTitle(view.container), "Roadmap kanban board", "what the device remembers beats the default");
    assert.deepEqual(run.boardRequests, ["polyth"], "one board request, for the remembered project");

    await act(async () => { button(view.container, "New board")!.click(); });
    await settle(3);
    const dialog = document.querySelector(".tt-compose-dialog");
    assert.ok(dialog, "the board composer opens");
    assert.equal(button(dialog, "Create board")?.disabled, true, "a name is required");
    typeInto(dialog.querySelector<HTMLInputElement>('input[placeholder="Board name"]')!, "Q4 launch");
    await act(async () => { button(dialog, "Create board")!.click(); });
    await settle(5);
    assert.deepEqual(run.createdBoards, [{ name: "Q4 launch", projectId: "polyth", type: "kanban" }]);
    assert.equal(document.querySelector(".tt-compose-dialog"), null);
    assert.equal(boardTitle(view.container), "Q4 launch kanban board", "the new board is selected");
    assert.match(boardNotice(), /Q4 launch created/);
    const { at, ...remembered } = JSON.parse(localStorage.getItem(`${key}:project-1`) ?? "{}");
    assert.deepEqual(remembered, {
      provider: "jira",
      selections: { jira: { projectId: "polyth", boardId: "q4" } },
    }, "the window remembers the board it now shows in this project");
    assert.equal(typeof at, "number");
    assert.equal(localStorage.getItem(key), legacy, "the older memory stays for projects not opened yet");
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("the installer mirrors the board selection through the host preference seam", async () => {
  const run = harness();
  const registered: Array<{ id: string; adapter: WebUiPreferenceAdapter }> = [];
  let unregistered = 0;
  const host = {
    widgets: { registerPlugin: (_plugin: WidgetPlugin) => () => {} },
    preferences: {
      register: (id: string, adapter: WebUiPreferenceAdapter) => {
        registered.push({ id, adapter });
        return () => { unregistered++; };
      },
    },
    ui: { icons: {} },
    errors: { friendly: (action: string) => action },
  } as unknown as WebPackageHost;
  try {
    const dispose = createTaskTrackerInstaller(host)();
    assert.deepEqual(registered.map((item) => item.id), ["package.task-trackers.boards", "package.task-trackers.project-boards"]);
    const adapter = registered[0]!.adapter;
    let notified = 0;
    const off = adapter.subscribe(() => { notified++; });
    adapter.write({ jira: { hiddenBoards: ["delivery"], defaultBoardId: "roadmap" }, bogus: 1 });
    assert.deepEqual(scope.providerScope(null, "jira"), { hiddenProjects: [], hiddenBoards: ["delivery"], defaultProjectId: "", defaultBoardId: "roadmap" });
    assert.equal(notified, 1);
    scope.updateProviderScope(null, "trello", { defaultProjectId: "org-1" });
    assert.equal(notified, 2, "local changes reach the host mirror");
    assert.deepEqual((adapter.read() as Record<string, unknown>).trello, { hiddenProjects: [], hiddenBoards: [], defaultProjectId: "org-1", defaultBoardId: "" });

    // Each project's own choice is mirrored under its own id.
    const projects = registered[1]!.adapter;
    assert.equal(projects.read(), null, "no project chose anything yet");
    projects.write({ projects: { "project-a": { provider: "trello", trackers: { trello: { hiddenBoards: ["t1"] } } } } });
    assert.equal(scope.projectTracker("project-a"), "trello");
    assert.deepEqual(scope.providerScope("project-a", "trello").hiddenBoards, ["t1"]);
    assert.deepEqual(scope.providerScope("project-a", "jira").hiddenBoards, ["delivery"], "an untouched tracker follows the account");
    scope.updateProviderScope("project-b", "jira", { hiddenBoards: [] });
    assert.deepEqual(Object.keys((projects.read() as { projects: object }).projects), ["project-a", "project-b"]);
    assert.deepEqual(scope.providerScope(null, "jira").hiddenBoards, ["delivery"], "a project's change leaves the account's");
    off();
    dispose();
    assert.equal(unregistered, 2);
  } finally {
    run.restore();
  }
});

test("each Polyth project keeps its own boards and tracker, starting from the account-wide choice", () => {
  scope.resetBoardScopeForTests();
  scope.updateProviderScope(null, "trello", { hiddenBoards: ["t1"], defaultBoardId: "t2" });
  assert.deepEqual(scope.providerScope("alpha", "trello"), scope.providerScope(null, "trello"), "a project starts from the account-wide choice");
  assert.equal(scope.projectChangedAt("alpha"), 0);

  scope.updateProviderScope("alpha", "trello", { hiddenBoards: [] });
  assert.deepEqual(scope.providerScope("alpha", "trello"), { hiddenProjects: [], hiddenBoards: [], defaultProjectId: "", defaultBoardId: "t2" });
  assert.deepEqual(scope.providerScope("beta", "trello").hiddenBoards, ["t1"], "another project is untouched");
  assert.deepEqual(scope.providerScope(null, "trello").hiddenBoards, ["t1"], "so is the account-wide choice");
  assert.equal(scope.projectChangedAt("alpha"), 0, "showing or hiding is not a choice of what opens");
  scope.updateProviderScope(null, "trello", { hiddenBoards: ["t3"] });
  assert.deepEqual(scope.providerScope("alpha", "trello").hiddenBoards, [], "once changed, a project keeps its own");

  scope.updateProviderScope("alpha", "trello", { defaultBoardId: "t9" });
  const chosen = scope.projectChangedAt("alpha");
  assert.ok(chosen > 0, "choosing a default is a choice of what opens");
  scope.setProjectTracker("beta", "linear");
  assert.equal(scope.projectTracker("beta"), "linear");
  assert.equal(scope.projectTracker("alpha"), "");
  assert.equal(scope.projectTracker(null), "");
  scope.setProjectTracker("beta", "");
  assert.equal(scope.boardScope().trello.defaultBoardId, "t2");
  assert.deepEqual(Object.keys(JSON.parse(localStorage.getItem("polyth.task-trackers.project-boards") ?? "{}")), ["alpha"],
    "clearing a project's only choice forgets it");

  assert.deepEqual(scope.normalizeProjectBoardScopes({
    projects: {
      good: { provider: "jira", trackers: { jira: { hiddenBoards: ["a", 1] } }, changedAt: 5 },
      odd: { provider: "asana", trackers: [], changedAt: -1 },
      "": { provider: "jira" },
    },
  }), {
    good: { provider: "jira", trackers: { jira: { hiddenProjects: [], hiddenBoards: ["a"], defaultProjectId: "", defaultBoardId: "" } }, changedAt: 5 },
    odd: { provider: "", trackers: {} },
  });
  assert.deepEqual(scope.normalizeProjectBoardScopes("junk"), {});

  // A window forgets the tracker and board it showed before the project's
  // choice of what opens, but keeps its assignee filter.
  const key = "tt-test-project-memory";
  localStorage.setItem(key, JSON.stringify({ provider: "jira", selections: { jira: { projectId: "p", boardId: "b" } }, assignees: { jira: ["me"] }, at: chosen - 1 }));
  assert.deepEqual(scope.localBoardMemory(key, { since: chosen }).read(), { selections: {}, assignees: { jira: ["me"] } });
  assert.equal(scope.localBoardMemory(key, { since: chosen - 1 }).read().provider, "jira");
  assert.equal(scope.localBoardMemory(`${key}:alpha`, { legacyKey: key }).read().provider, "jira", "a window starts from its older memory");
  scope.resetBoardScopeForTests();
  localStorage.clear();
});

test("the board of one project opens its own boards and tracker; another project still opens the account-wide ones", async () => {
  const run = harness();
  const key = "polyth.task-trackers.test-projects";
  scope.updateProviderScope(null, "jira", { defaultBoardId: "roadmap" });
  let view = await mountBoard(key, "alpha");
  try {
    assert.equal(boardTitle(view.container), "Roadmap kanban board", "a project starts from the account-wide default");
    await act(async () => { view.container.querySelector<HTMLButtonElement>('[aria-label="Choose boards to show"]')!.click(); });
    await settle(4);
    const dialog = document.querySelector(".tt-scope-dialog")!;
    assert.match(dialog.textContent ?? "", /other projects keep their own/);
    await act(async () => { dialog.querySelector<HTMLInputElement>('input[aria-label="Open On-call by default"]')!.click(); });
    const opensFirst = dialog.querySelector<HTMLButtonElement>('[role="switch"]')!;
    assert.match(dialog.textContent ?? "", /Open Jira first in this project/);
    assert.equal(opensFirst.getAttribute("aria-checked"), "false");
    await act(async () => { opensFirst.click(); });
    assert.equal(opensFirst.getAttribute("aria-checked"), "true");
    assert.equal(scope.projectTracker("alpha"), "jira");
    await act(async () => { button(dialog, "Done")!.click(); });
    await settle();
    assert.equal(boardTitle(view.container), "Roadmap kanban board", "the open window keeps what it shows");
  } finally {
    await view.unmount();
  }

  try {
    view = await mountBoard(key, "alpha");
    assert.equal(boardTitle(view.container), "On-call kanban board", "the default chosen since opens in this project");
    await view.unmount();

    view = await mountBoard(key, "beta");
    assert.equal(boardTitle(view.container), "Roadmap kanban board", "another project keeps the account-wide default");
    assert.equal(scope.providerScope(null, "jira").defaultBoardId, "roadmap");

    // A project that opens with Trello starts there, in every window that
    // has not switched since.
    scope.setProjectTracker("beta", "trello");
    await view.unmount();
    view = await mountBoard(key, "beta");
    assert.equal(view.container.querySelector('[data-provider="trello"]')?.getAttribute("aria-selected"), "true");
  } finally {
    await view.unmount();
    run.restore();
  }
});
