import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import type {
  TaskTrackerSessionTaskDto,
  TaskTrackerStatusDto,
  TaskTrackerTaskDto,
} from "@polyth/contracts";

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
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("../src/api.ts");
const {
  LinkedTaskWidget,
  TaskTrackerBoard,
  defaultViewForBoard,
  groupTasksByStatus,
} = await import("../src/widgets/taskTrackersPlugin.tsx");

const statuses: TaskTrackerStatusDto[] = [
  { id: "todo", name: "To do", category: "todo" },
  { id: "review", name: "Review", category: "in_progress" },
  { id: "done", name: "Done", category: "done" },
];

const taskWith = (status = statuses[0]!): TaskTrackerTaskDto => ({
  provider: "jira",
  id: "10001",
  key: "POL-7",
  title: "Fix mobile overflow",
  description: "Keep every control inside the mobile viewport.",
  url: "https://acme.atlassian.net/browse/POL-7",
  boardId: "delivery",
  projectId: "polyth",
  projectKey: "POL",
  status,
  availableStatuses: statuses,
  labels: ["mobile", "ui"],
  assignees: ["Ada Lovelace"],
  dueAt: "2026-08-28",
});

const linkedTask = (task: TaskTrackerTaskDto): TaskTrackerSessionTaskDto => ({
  provider: task.provider,
  taskId: task.id,
  taskKey: task.key,
  title: task.title,
  statusId: task.status.id,
  statusName: task.status.name,
  completed: task.status.category === "done",
  selectedAtSeq: 1,
  updatedAtSeq: 1,
});

const clickByText = (container: Element, text: string): HTMLButtonElement => {
  const button = [...container.querySelectorAll("button")]
    .find((candidate) => candidate.textContent?.trim().includes(text));
  assert.ok(button, `button containing "${text}" exists`);
  return button as HTMLButtonElement;
};

const setControlValue = (
  control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  event = "input",
): void => {
  const prototype = control instanceof dom.HTMLInputElement
    ? dom.HTMLInputElement.prototype
    : control instanceof dom.HTMLTextAreaElement
      ? dom.HTMLTextAreaElement.prototype
      : dom.HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
  control.dispatchEvent(new Event(event, { bubbles: true }));
};

const settle = async (turns = 2): Promise<void> => {
  for (let index = 0; index < turns; index++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

test("task board utilities choose sensible views and stable status columns", () => {
  assert.equal(defaultViewForBoard("scrum"), "kanban");
  assert.equal(defaultViewForBoard("kanban"), "kanban");
  assert.equal(defaultViewForBoard("simple"), "list");
  assert.deepEqual(
    groupTasksByStatus([
      taskWith(statuses[2]),
      taskWith(statuses[0]),
      { ...taskWith(statuses[1]), id: "10002", key: "POL-8" },
    ]).map((group) => [group.name, group.tasks.length]),
    [["To do", 1], ["Review", 1], ["Done", 1]],
  );
});

test("task tracker surfaces enforce mobile containment, touch, zoom, and safe-area rules", async () => {
  const css = await readFile(new URL("../src/widgets/taskTrackers.css", import.meta.url), "utf8");
  assert.match(css, /\.tt-board button,[\s\S]*min-height:\s*44px/);
  assert.match(css, /@container task-tracker \(max-width: 480px\)[\s\S]*font-size:\s*16px/);
  assert.match(css, /@container task-tracker \(max-width: 480px\)[\s\S]*\.tt-empty[\s\S]*min-height:\s*0/);
  assert.match(css, /@container task-tracker \(max-width: 820px\)[\s\S]*\.tt-detail[\s\S]*position:\s*absolute/);
  assert.match(css, /@container task-tracker \(max-width: 820px\)[\s\S]*\.tt-board\.has-detail[\s\S]*\.tt-filters[\s\S]*display:\s*none/);
  assert.match(css, /@container task-tracker \(max-width: 560px\)[\s\S]*\.tt-board-header[\s\S]*flex-direction:\s*column/);
  assert.match(css, /\.tt-task-surface[\s\S]*overflow:\s*auto/);
  assert.match(css, /\.tt-board-content[\s\S]*overflow:\s*hidden/);
  assert.match(css, /env\(safe-area-inset-bottom/);

  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  assert.match(html, /width=device-width, initial-scale=1, viewport-fit=cover/);

  const globalCss = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(
    globalCss,
    /@media \(max-width: 760px\)[\s\S]*\.widget-canvas-grid[\s\S]*padding:[^;]*env\(safe-area-inset-bottom/,
  );
});

test("provider failures stay explicit and offer recovery instead of masquerading as setup", async () => {
  const original = api.taskTrackerProviders;
  let attempts = 0;
  api.taskTrackerProviders = async () => {
    attempts++;
    if (attempts === 1) throw new Error("gateway unavailable");
    return [
      { provider: "jira", mode: "live", configured: false, requiredEnv: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"] },
      { provider: "trello", mode: "live", configured: false, requiredEnv: ["TRELLO_API_KEY", "TRELLO_API_TOKEN"] },
    ];
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(TaskTrackerBoard, {
        sessionId: "session-1",
        config: {},
        updateConfig: () => undefined,
      }));
    });
    await settle(3);
    assert.match(container.textContent ?? "", /Task trackers didn’t load/);
    assert.doesNotMatch(container.textContent ?? "", /Connect Jira/);
    await act(async () => { clickByText(container, "Try again").click(); });
    await settle(3);
    assert.equal(attempts, 2);
    assert.match(container.textContent ?? "", /Connect Jira/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    api.taskTrackerProviders = original;
  }
});

test("credential-free demo providers render populated, switchable sandbox boards", async () => {
  const originals = {
    providers: api.taskTrackerProviders,
    projects: api.taskTrackerProjects,
    boards: api.taskTrackerBoards,
    tasks: api.taskTrackerTasks,
    task: api.taskTrackerTask,
  };
  const taskLoads: string[] = [];
  api.taskTrackerProviders = async () => [
    { provider: "jira", mode: "demo", configured: false, requiredEnv: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"] },
    { provider: "trello", mode: "demo", configured: false, requiredEnv: ["TRELLO_API_KEY", "TRELLO_API_TOKEN"] },
  ];
  api.taskTrackerProjects = async (provider) => [
    { provider, id: `${provider}-workspace`, key: "DEMO", name: `${provider} sandbox` },
  ];
  api.taskTrackerBoards = async (provider) => [
    { provider, id: `${provider}-board`, name: `${provider} planning`, type: "kanban" },
  ];
  api.taskTrackerTasks = async (provider) => {
    taskLoads.push(provider);
    return [{
      ...taskWith(),
      provider,
      id: `${provider}-task`,
      key: provider === "jira" ? "POL-101" : "TR-21",
      title: provider === "jira" ? "Refine the command palette" : "Collect launch feedback",
    }];
  };
  api.taskTrackerTask = async (provider) => ({
    ...taskWith(),
    provider,
    id: `${provider}-task`,
    key: provider === "jira" ? "POL-101" : "TR-21",
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(TaskTrackerBoard, {
        sessionId: null,
        config: {},
        updateConfig: () => undefined,
      }));
    });
    await settle(5);
    assert.match(container.textContent ?? "", /Demo sandbox/);
    assert.match(container.textContent ?? "", /Changes stay in memory/);
    assert.match(container.textContent ?? "", /Refine the command palette/);
    assert.doesNotMatch(container.textContent ?? "", /Connect Jira/);
    assert.equal(container.querySelector('[data-provider="jira"] i')?.className, "demo");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-provider="trello"]')?.click();
    });
    await settle(5);
    assert.match(container.textContent ?? "", /Collect launch feedback/);
    assert.deepEqual(taskLoads, ["jira", "trello"]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    api.taskTrackerProviders = originals.providers;
    api.taskTrackerProjects = originals.projects;
    api.taskTrackerBoards = originals.boards;
    api.taskTrackerTasks = originals.tasks;
    api.taskTrackerTask = originals.task;
  }
});

test("task board completes browse, filter, link, status, complete, and refresh journey", async () => {
  const originals = {
    providers: api.taskTrackerProviders,
    projects: api.taskTrackerProjects,
    boards: api.taskTrackerBoards,
    tasks: api.taskTrackerTasks,
    task: api.taskTrackerTask,
    sessionTasks: api.taskTrackerSessionTasks,
    link: api.taskTrackerLink,
    update: api.taskTrackerUpdateStatus,
  };
  let currentTask = taskWith();
  let linked = false;
  let taskLoads = 0;
  const links: Array<{ startAgent?: boolean; instructions?: string }> = [];
  const updates: string[] = [];
  const configs: Array<Record<string, unknown>> = [];

  api.taskTrackerProviders = async () => [
    { provider: "jira", mode: "live", configured: true, requiredEnv: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"] },
    { provider: "trello", mode: "live", configured: false, requiredEnv: ["TRELLO_API_KEY", "TRELLO_API_TOKEN"] },
  ];
  api.taskTrackerProjects = async () => [
    { provider: "jira", id: "polyth", key: "POL", name: "Polyth" },
  ];
  api.taskTrackerBoards = async () => [
    { provider: "jira", id: "delivery", name: "Delivery", type: "scrum" },
  ];
  api.taskTrackerTasks = async () => {
    taskLoads++;
    return [currentTask];
  };
  api.taskTrackerTask = async () => currentTask;
  api.taskTrackerSessionTasks = async () => linked ? [linkedTask(currentTask)] : [];
  api.taskTrackerLink = async (_provider, _taskId, input) => {
    links.push(input);
    linked = true;
    return { ok: true, task: currentTask, sessionId: input.sessionId };
  };
  api.taskTrackerUpdateStatus = async (_provider, _taskId, input) => {
    updates.push(input.statusId);
    currentTask = taskWith(statuses.find((status) => status.id === input.statusId)!);
    return currentTask;
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(TaskTrackerBoard, {
        sessionId: "session-1",
        config: {},
        updateConfig: (next) => configs.push(next),
      }));
    });
    await settle(5);

    assert.match(container.textContent ?? "", /Delivery/);
    assert.match(container.textContent ?? "", /Fix mobile overflow/);
    assert.ok(container.querySelector(".tt-kanban"), "scrum board starts in kanban view");

    const jiraTab = container.querySelector<HTMLButtonElement>('[role="tab"][data-provider="jira"]');
    const trelloTab = container.querySelector<HTMLButtonElement>('[role="tab"][data-provider="trello"]');
    assert.ok(jiraTab);
    assert.ok(trelloTab);
    assert.equal(jiraTab.tabIndex, 0);
    assert.equal(trelloTab.tabIndex, -1);
    await act(async () => {
      jiraTab.dispatchEvent(
        new dom.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as unknown as Event,
      );
    });
    await settle();
    assert.equal(trelloTab.getAttribute("aria-selected"), "true");
    assert.equal(document.activeElement, trelloTab);
    assert.match(container.textContent ?? "", /TRELLO_API_KEY, TRELLO_API_TOKEN/);
    await act(async () => {
      trelloTab.dispatchEvent(
        new dom.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }) as unknown as Event,
      );
    });
    await settle(4);
    assert.equal(jiraTab.getAttribute("aria-selected"), "true");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="List view"]')?.click();
    });
    assert.ok(container.querySelector(".tt-list"));
    assert.equal(configs.at(-1)?.defaultView, "list");

    const search = container.querySelector<HTMLInputElement>('input[type="search"]');
    assert.ok(search);
    await act(async () => {
      setControlValue(search, "no match");
    });
    assert.match(container.textContent ?? "", /No matching tasks/);
    await act(async () => { clickByText(container, "Clear filters").click(); });
    assert.ok(container.querySelector(".tt-list-row"));

    const selectedRow = container.querySelector<HTMLButtonElement>(".tt-list-row");
    assert.ok(selectedRow);
    await act(async () => { selectedRow.click(); });
    await settle();
    assert.match(container.querySelector(".tt-detail")?.textContent ?? "", /Hand off to the agent/);
    assert.equal(container.querySelector(".tt-detail")?.getAttribute("role"), "dialog");
    assert.equal(document.activeElement, container.querySelector(".tt-detail"));
    assert.ok(container.querySelector<HTMLAnchorElement>(".tt-external")?.href.includes("/browse/POL-7"));

    const instructions = container.querySelector<HTMLTextAreaElement>(".tt-detail textarea");
    assert.ok(instructions);
    await act(async () => {
      setControlValue(instructions, "Preserve swipe gestures.");
      clickByText(container, "Link & start agent").click();
    });
    await settle();
    assert.equal(links.length, 1);
    assert.equal(links[0]?.startAgent, true);
    assert.equal(links[0]?.instructions, "Preserve swipe gestures.");
    assert.match(container.textContent ?? "", /Linked to session/);

    await act(async () => { clickByText(container, "Refresh link").click(); });
    await settle();
    assert.equal(links.length, 2);
    assert.equal(links[1]?.startAgent, false);

    const status = container.querySelector<HTMLSelectElement>(".tt-status-row select");
    assert.ok(status);
    await act(async () => {
      setControlValue(status, "review", "change");
    });
    await act(async () => { clickByText(container, "Update status").click(); });
    await settle();
    assert.deepEqual(updates, ["review"]);
    assert.match(container.querySelector(".tt-detail")?.textContent ?? "", /Moved to Review/);

    await act(async () => { clickByText(container, "Mark complete").click(); });
    await settle();
    assert.deepEqual(updates, ["review", "done"]);
    assert.match(container.querySelector(".tt-detail")?.textContent ?? "", /Task marked complete/);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Close task details"]')?.click();
    });
    await settle();
    assert.equal(document.activeElement, selectedRow, "closing details restores focus to the selected task");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Refresh tasks"]')?.click();
    });
    await settle();
    assert.ok(taskLoads >= 3, "initial loads plus explicit refresh reach the task route");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    api.taskTrackerProviders = originals.providers;
    api.taskTrackerProjects = originals.projects;
    api.taskTrackerBoards = originals.boards;
    api.taskTrackerTasks = originals.tasks;
    api.taskTrackerTask = originals.task;
    api.taskTrackerSessionTasks = originals.sessionTasks;
    api.taskTrackerLink = originals.link;
    api.taskTrackerUpdateStatus = originals.update;
  }
});

test("linked-task mini widget updates and completes the active session task", async () => {
  const originals = {
    task: api.taskTrackerTask,
    sessionTasks: api.taskTrackerSessionTasks,
    update: api.taskTrackerUpdateStatus,
  };
  let currentTask = taskWith(statuses[1]);
  const updates: string[] = [];
  api.taskTrackerSessionTasks = async () => [linkedTask(currentTask)];
  api.taskTrackerTask = async () => currentTask;
  api.taskTrackerUpdateStatus = async (_provider, _taskId, input) => {
    updates.push(input.statusId);
    currentTask = taskWith(statuses.find((status) => status.id === input.statusId)!);
    return currentTask;
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(LinkedTaskWidget, { sessionId: "session-1" }));
    });
    await settle(3);
    assert.match(container.textContent ?? "", /POL-7/);
    assert.match(container.textContent ?? "", /Fix mobile overflow/);
    assert.ok(container.querySelector<HTMLAnchorElement>('a[href*="/browse/POL-7"]'));

    await act(async () => { clickByText(container, "Complete").click(); });
    await settle();
    assert.deepEqual(updates, ["done"]);
    assert.match(container.textContent ?? "", /Completed/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    api.taskTrackerTask = originals.task;
    api.taskTrackerSessionTasks = originals.sessionTasks;
    api.taskTrackerUpdateStatus = originals.update;
  }
});
