import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type {
  JsonObject,
  TaskTrackerProvider,
  TaskTrackerProviderDto,
  TaskTrackerStatusDto,
  TaskTrackerTaskDto,
  TaskTrackerViewerDto,
} from "@polyth/contracts";
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
const { TaskTrackerBoard, configureTaskTrackerHost } = await import("../widgets/plugin.tsx");
const { TaskTrackersPage } = await import("../widgets/page.tsx");
const store = await import("../widgets/store.ts");
const { DEFAULT_TASK_TRACKER_PREFERENCES } = await import("../src/types.ts");

const statuses: TaskTrackerStatusDto[] = [
  { id: "todo", name: "Todo", category: "todo" },
  { id: "doing", name: "In Progress", category: "in_progress" },
  { id: "done", name: "Done", category: "done" },
];

const iris = { id: "u-iris", name: "Iris Novak" };
const leo = { id: "u-leo", name: "Leo Park" };
const mia = { id: "u-mia", name: "Mia Santos" };

const task = (
  id: string,
  title: string,
  people: Array<{ id: string; name: string }>,
  status = statuses[0]!,
  extra: Partial<TaskTrackerTaskDto> = {},
): TaskTrackerTaskDto => ({
  provider: "jira",
  id,
  key: `POL-${id}`,
  title,
  description: "",
  boardId: "delivery",
  projectId: "polyth",
  status,
  availableStatuses: statuses,
  labels: [],
  assignees: people.map((person) => person.name),
  ...(people.length > 0 ? { assigneePeople: people } : {}),
  ...extra,
});

const TASKS: TaskTrackerTaskDto[] = [
  task("1", "Sync offline edits", [iris], statuses[1], { priority: { level: "urgent", name: "Highest" }, dueAt: "2020-01-02" }),
  task("2", "Swipe between columns", [leo]),
  task("3", "Back off on rate limits", []),
  task("4", "Assignee filter", [iris]),
  task("5", "Dark mode audit", [mia], statuses[2]),
];

const settle = async (turns = 4): Promise<void> => {
  for (let index = 0; index < turns; index++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
};

const titles = (root: ParentNode): string[] =>
  [...root.querySelectorAll(".tt-task-card > strong, .tt-list-title > strong")].map((item) => item.textContent ?? "").sort();

const byLabel = (root: ParentNode, selector: string, label: string): HTMLElement | null =>
  [...root.querySelectorAll<HTMLElement>(selector)].find((item) => item.getAttribute("aria-label") === label) ?? null;

const buttonWithText = (root: ParentNode, text: string): HTMLButtonElement | null =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text) ?? null;

const click = async (element: HTMLElement | null, what: string): Promise<void> => {
  assert.ok(element, `${what} exists`);
  await act(async () => { element.click(); });
  await settle(2);
};

interface Harness {
  configs: JsonObject[];
  viewer: TaskTrackerViewerDto | null;
  connected: Array<{ apiKey: string }>;
  restore(): void;
}

function harness(options: {
  viewer?: TaskTrackerViewerDto | null;
  providers?: TaskTrackerProviderDto[];
  tasks?: TaskTrackerTaskDto[];
} = {}): Harness {
  const originals = { ...api };
  const state: Harness = {
    configs: [],
    viewer: options.viewer === undefined ? { person: iris, own: true } : options.viewer,
    connected: [],
    restore() {
      Object.assign(api, originals);
      store.resetManagementForTests();
      localStorage.clear();
    },
  };
  const providers = options.providers ?? [
    { provider: "jira", mode: "live", configured: true, requiredEnv: [], enabled: true, source: "personal" },
    { provider: "trello", mode: "demo", configured: false, requiredEnv: [], enabled: true, source: "demo" },
    { provider: "linear", mode: "live", configured: false, requiredEnv: ["LINEAR_API_KEY"], enabled: true, source: "none" },
  ];
  const management: TaskTrackerManagementDto = {
    preferences: DEFAULT_TASK_TRACKER_PREFERENCES,
    connections: [],
    personalConnections: [],
    providers,
    vaultAvailable: true,
    canManage: true,
    canConnect: true,
  };
  api.taskTrackerProviders = async () => providers;
  api.taskTrackerSettings = async () => management;
  api.taskTrackerProjects = async (provider: TaskTrackerProvider) => [{ provider, id: "polyth", key: "POL", name: "Polyth" }];
  api.taskTrackerBoards = async (provider: TaskTrackerProvider) => [{ provider, id: "delivery", name: "Delivery", type: "kanban", projectId: "polyth" }];
  api.taskTrackerTasks = async (provider: TaskTrackerProvider) =>
    (options.tasks ?? TASKS).map((item) => ({ ...item, provider }));
  api.taskTrackerTask = async (provider: TaskTrackerProvider, id: string) =>
    ({ ...(options.tasks ?? TASKS).find((item) => item.id === id)!, provider });
  api.taskTrackerColumns = async () => ({
    columns: statuses.map((item) => ({ id: item.id, name: item.name, category: item.category, statusIds: [item.id] })),
    editable: false,
  });
  api.taskTrackerSessionTasks = async () => [];
  api.taskTrackerLinks = async () => [];
  api.taskTrackerViewer = async () => {
    if (!state.viewer) throw new Error("no viewer");
    return state.viewer;
  };
  api.taskTrackerConnectLinear = async (input) => {
    state.connected.push(input);
    return {
      ...management,
      connections: [{
        provider: "linear",
        method: "api-token",
        account: { name: "Iris Novak", site: "https://linear.app/acme" },
        connectedAt: 1,
        verifiedAt: 1,
        revision: 1,
      }],
    };
  };
  configureTaskTrackerHost({
    ui: { icons: {} },
    errors: { friendly: (action: string, cause: unknown) => `${action}: ${(cause as Error)?.message ?? ""}` },
    store: {
      subscribe: () => () => {},
      getSnapshot: () => ({ activeProjectId: "project-1", activeSessionId: null }),
    },
    executionDraft: { get: () => null },
    sessions: { subscribe: () => () => {}, get: () => undefined },
    conversation: { openSession: async () => {} },
    navigation: { openSettingsPage() {} },
  } as never);
  store.resetManagementForTests();
  return state;
}

async function mount(run: Harness, config: JsonObject = {}, memoryKey = "test.assignee.memory") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let current = config;
  const render = () => root.render(createElement(TaskTrackerBoard, {
    sessionId: null,
    config: current,
    memoryKey,
    updateConfig: (next: JsonObject) => {
      run.configs.push(next);
      current = next;
      render();
    },
  }));
  await act(async () => { render(); });
  await settle(6);
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("the assignee filter narrows the board to mine, unassigned or a teammate and remembers it per tracker", async () => {
  const run = harness();
  let view = await mount(run);
  try {
    const strip = view.container.querySelector(".tt-people");
    assert.ok(strip, "the board offers an assignee filter");
    assert.equal(strip.getAttribute("role"), "group");
    assert.ok(byLabel(strip, ".tt-people-chip", "Mine, 2 tasks"), "Mine counts my tasks");
    assert.ok(byLabel(strip, ".tt-people-chip", "Leo Park, 1 task"));
    assert.ok(byLabel(strip, ".tt-people-chip", "Unassigned, 1 task"));
    assert.equal(titles(view.container).length, 5);

    await click(byLabel(view.container, ".tt-people-chip", "Mine, 2 tasks"), "Mine");
    assert.deepEqual(titles(view.container), ["Assignee filter", "Sync offline edits"]);
    assert.match(view.container.querySelector(".tt-filter-summary")?.textContent ?? "", /2 of 5/);
    assert.equal(byLabel(view.container, ".tt-people-chip", "Mine, 2 tasks")?.getAttribute("aria-pressed"), "true");
    assert.deepEqual(JSON.parse(localStorage.getItem("test.assignee.memory:project-1") ?? "{}").assignees, { jira: ["me"] },
      "the window remembers per Polyth project");
    // Empty columns stay, so a card can still be moved into them.
    assert.equal(view.container.querySelectorAll(".tt-column").length, 3);

    await click(byLabel(view.container, ".tt-people-chip", "Unassigned, 1 task"), "Unassigned");
    assert.deepEqual(titles(view.container), ["Assignee filter", "Back off on rate limits", "Sync offline edits"], "chips add up");

    await click(byLabel(view.container, "button", "Show everyone’s tasks"), "clear");
    assert.equal(titles(view.container).length, 5);
    assert.equal(view.container.querySelector(".tt-filter-summary"), null, "nothing filtered, no summary");

    // The full list picks anyone; picking yourself there is the same as Mine.
    const trigger = view.container.querySelector<HTMLButtonElement>(".tt-people .picker-chip");
    await click(trigger, "assignee picker");
    const option = (label: string) => [...document.querySelectorAll<HTMLElement>(".picker-item")]
      .find((item) => item.querySelector(".palette-label")?.textContent === label) ?? null;
    assert.ok(option("Iris Novak (you)"));
    await click(option("Mia Santos"), "Mia in the list");
    assert.deepEqual(titles(view.container), ["Dark mode audit"]);
    assert.match(trigger!.textContent ?? "", /Mia Santos/);
    assert.ok(byLabel(view.container, ".tt-people-chip", "Mia Santos, 1 task")?.getAttribute("aria-pressed") === "true",
      "a person chosen in the list shows as a pressed chip");
    await act(async () => { document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event); });

    // The window remembers it for this tracker only.
    await view.unmount();
    view = await mount(run);
    assert.deepEqual(titles(view.container), ["Dark mode audit"], "the filter survives reopening the board");
    await click(view.container.querySelector<HTMLButtonElement>('[data-provider="trello"]'), "Trello tab");
    assert.equal(titles(view.container).length, 5, "another tracker starts unfiltered");
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("an empty filter says why and how back; Mine waits for a shared account that isn't yours", async () => {
  localStorage.setItem("test.assignee.shared", JSON.stringify({ provider: "jira", selections: {}, assignees: { jira: ["me"] } }));
  const run = harness({ viewer: { person: iris, own: false } });
  const view = await mount(run, {}, "test.assignee.shared");
  try {
    assert.match(view.container.textContent ?? "", /Polyth can’t tell which account is yours/);
    assert.equal(byLabel(view.container, ".tt-people-chip", "Mine, 2 tasks"), null, "no Mine chip for someone else's account");
    // The shared account is just a person here.
    assert.ok(byLabel(view.container, ".tt-people-chip", "Iris Novak, 2 tasks"));
    await click(buttonWithText(view.container, "Show everyone"), "Show everyone");
    assert.equal(titles(view.container).length, 5);

    await click(byLabel(view.container, ".tt-people-chip", "Leo Park, 1 task"), "Leo");
    const search = view.container.querySelector<HTMLInputElement>('input[type="search"]');
    assert.ok(search);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")?.set?.call(search, "audit");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle(2);
    assert.match(view.container.textContent ?? "", /No matching tasks/);
    await click(buttonWithText(view.container.querySelector(".tt-empty")!, "Clear filters"), "Clear filters");
    assert.equal(titles(view.container).length, 5, "Clear filters also clears the assignee filter");
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("the list groups by status, assignee or nothing, its sections collapse, and completed work can hide", async () => {
  const run = harness();
  const view = await mount(run, { defaultView: "list" });
  try {
    const heads = () => [...view.container.querySelectorAll(".tt-list-group-head")]
      .map((item) => `${item.querySelector("strong")?.textContent}:${item.querySelector(".tt-column-count")?.textContent}`);
    assert.deepEqual(heads(), ["Todo:3", "In Progress:1", "Done:1"], "status sections follow the board's columns");
    assert.equal(view.container.querySelector(".tt-list")?.classList.contains("group-status"), true);
    assert.equal(view.container.querySelector(".tt-list-row .tt-status"), null, "a status section doesn't repeat the status");

    const todo = view.container.querySelector<HTMLButtonElement>(".tt-list-group-head");
    await click(todo, "Todo section");
    assert.equal(todo!.getAttribute("aria-expanded"), "false");
    assert.equal(titles(view.container).length, 2, "a collapsed section hides its rows");
    await click(todo, "Todo section");
    assert.equal(titles(view.container).length, 5);

    const display = () => byLabel(view.container, "button", "Display options");
    const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menu"] button')]
      .find((item) => item.textContent?.includes(label)) ?? null;
    await click(display(), "Display options");
    await click(menuItem("Assignee"), "group by assignee");
    assert.equal(run.configs.at(-1)?.listGroup, "assignee");
    assert.deepEqual(heads(), ["Iris Novak (you):2", "Leo Park:1", "Mia Santos:1", "Unassigned:1"], "me first, Unassigned last");
    assert.ok(view.container.querySelector(".tt-list-row .tt-status"), "an assignee section shows each row's status");

    await click(display(), "Display options");
    await click(menuItem("Show completed tasks"), "hide completed");
    assert.equal(run.configs.at(-1)?.hideCompleted, true);
    assert.equal(titles(view.container).includes("Dark mode audit"), false);

    // A switch leaves the menu open for the next choice.
    await click(menuItem("No grouping"), "flat list");
    assert.equal(view.container.querySelectorAll(".tt-list-group-head").length, 0);
    assert.equal(titles(view.container).length, 4);
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("cards show priority, faces and overdue dates; a narrow board pages through its columns", async () => {
  const run = harness();
  const view = await mount(run);
  try {
    const card = [...view.container.querySelectorAll(".tt-task-card")].find((item) => item.textContent?.includes("Sync offline edits"));
    assert.ok(card);
    assert.equal(card.querySelector(".tt-priority.urgent")?.getAttribute("aria-label"), "Urgent (Highest)");
    assert.equal(card.querySelector(".tt-avatar-stack")?.getAttribute("aria-label"), "Assigned to Iris Novak");
    assert.equal(card.querySelector(".tt-due")?.classList.contains("overdue"), true, "past due and not done");
    assert.equal(card.getAttribute("data-task-ref"), "jira:1");

    const pager = view.container.querySelector('nav.tt-pager[aria-label="Board columns"]');
    assert.ok(pager, "the kanban carries its column pager (CSS shows it on narrow boards)");
    const items = [...pager.querySelectorAll<HTMLButtonElement>(".tt-pager-item")];
    assert.deepEqual(items.map((item) => item.getAttribute("aria-label")), ["Todo, 3 tasks", "In Progress, 1 task", "Done, 1 task"]);
    assert.equal(items[0]!.getAttribute("aria-current"), "true");
    await click(items[2]!, "Done in the pager");
    assert.equal(items[2]!.getAttribute("aria-current"), "true");
    assert.equal(items[0]!.getAttribute("aria-current"), null);
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("Linear connects with a personal API key and speaks in teams, projects and statuses", async () => {
  const run = harness();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(TaskTrackerBoard, { sessionId: null, config: {}, updateConfig: () => {} }));
    });
    await settle(6);
    const tab = container.querySelector<HTMLButtonElement>('[role="tab"][data-provider="linear"]');
    assert.ok(tab, "Linear has its own tab");
    assert.equal(tab.querySelector(".tt-provider-name")?.textContent, "Linear");
    await click(tab, "Linear tab");
    assert.match(container.textContent ?? "", /Connect Linear/);
    assert.match(container.textContent ?? "", /personal API key/);
    assert.match(container.textContent ?? "", /LINEAR_API_KEY/);

    await click(buttonWithText(container, "Connect Linear"), "Connect Linear");
    const dialog = document.querySelector(".tt-connect-dialog");
    assert.ok(dialog);
    assert.deepEqual([...dialog.querySelectorAll(".tt-stepper-label")].map((item) => item.textContent), ["Create key", "Paste key", "Verify"]);
    assert.match(dialog.textContent ?? "", /Security & access/);
    await click(buttonWithText(document.body, "Continue"), "Continue");
    const key = dialog.querySelector<HTMLInputElement>('input[type="password"]');
    assert.ok(key);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")?.set?.call(key, "not-a-key-but-long");
      key.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.match(dialog.textContent ?? "", /start with lin_api_/, "an unusual key gets a hint, not a block");
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")?.set?.call(key, "lin_api_0123456789abcdefghij");
      key.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(buttonWithText(document.body, "Connect"), "Connect");
    assert.deepEqual(run.connected, [{ apiKey: "lin_api_0123456789abcdefghij" }]);
    assert.match(document.querySelector(".tt-connect-dialog")?.textContent ?? "", /Linear is connected/);
    assert.equal(document.querySelector('.tt-wizard input[type="password"]'), null, "the key field is gone once sent");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    for (const dialog of document.querySelectorAll(".dialog-backdrop")) dialog.remove();
    run.restore();
  }

  // On the page's onboarding, Linear is one of the first choices.
  const onboarding = harness({
    providers: [
      { provider: "jira", mode: "live", configured: false, requiredEnv: [], enabled: true, source: "none" },
      { provider: "trello", mode: "live", configured: false, requiredEnv: [], enabled: true, source: "none" },
      { provider: "linear", mode: "live", configured: false, requiredEnv: [], enabled: true, source: "none" },
    ],
  });
  const page = document.createElement("div");
  document.body.appendChild(page);
  const pageRoot = createRoot(page);
  try {
    await act(async () => {
      pageRoot.render(createElement(TaskTrackersPage, {
        host: { store: { subscribe: () => () => {}, getSnapshot: () => ({ activeSessionId: null }) } },
      } as never));
    });
    await settle(6);
    assert.ok(buttonWithText(page, "Connect LinearTeam issues, projects and workflow statuses from Linear.API key · 1 min"),
      "the onboarding offers Linear with its own wording");
  } finally {
    await act(async () => pageRoot.unmount());
    page.remove();
    onboarding.restore();
  }
});
