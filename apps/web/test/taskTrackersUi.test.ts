import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
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
    { provider: "jira", configured: true, requiredEnv: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"] },
    { provider: "trello", configured: false, requiredEnv: ["TRELLO_API_KEY", "TRELLO_API_TOKEN"] },
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

    await act(async () => { clickByText(container, "Trello").click(); });
    await settle();
    assert.match(container.textContent ?? "", /TRELLO_API_KEY, TRELLO_API_TOKEN/);
    await act(async () => { clickByText(container, "Jira").click(); });
    await settle(4);

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

    await act(async () => { container.querySelector<HTMLButtonElement>(".tt-list-row")?.click(); });
    await settle();
    assert.match(container.querySelector(".tt-detail")?.textContent ?? "", /Hand off to the agent/);
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
