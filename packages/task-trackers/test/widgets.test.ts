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
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: () => undefined,
});
Object.defineProperty(globalThis, "getComputedStyle", {
  configurable: true,
  value: (elt: Element) =>
    (window as unknown as Window).getComputedStyle(elt as never),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("../widgets/api.ts");
const {
  LinkedTaskWidget,
  TaskTrackerBoard,
  defaultViewForBoard,
  groupTasksByStatus,
} = await import("../widgets/plugin.tsx");
const { providerState } = await import("../widgets/brand.tsx");

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

const pickPickerOption = async (root: ParentNode, optionLabel: string): Promise<void> => {
  const trigger = root.querySelector<HTMLButtonElement>(".picker-chip");
  assert.ok(trigger, "picker trigger exists");
  await act(async () => { trigger.click(); });
  const option = [...document.querySelectorAll(".picker-item")].find((el) =>
    el.querySelector(".palette-label")?.textContent?.trim() === optionLabel);
  assert.ok(option, `picker option "${optionLabel}" exists`);
  await act(async () => { (option as HTMLElement).click(); });
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
  const css = await readFile(new URL("../widgets/styles.css", import.meta.url), "utf8");
  const block = (query: string): string => {
    const start = css.indexOf(`@container task-tracker (max-width: ${query})`);
    assert.ok(start >= 0, `missing ${query} container block`);
    let depth = 0;
    for (let i = css.indexOf("{", start); i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
    }
    return css.slice(start);
  };
  assert.match(css, /\.tt-task-card,\n\.tt-list-row,[\s\S]*?min-height:\s*max\(var\(--control-h-sm\), var\(--hit-min\)\)/);
  assert.match(css, /\.tt-search \.ui-input[\s\S]*width:\s*100%/);
  assert.match(block("480px"), /\.tt-empty[\s\S]*min-height:\s*0/);
  // The board sits on the window's material: no opaque fill of its own.
  assert.match(css, /\.tt-board \{[^}]*background:\s*transparent/);
  // A narrow board shows the open task in normal flow instead of an
  // absolutely positioned overlay with a guessed height, so nothing is cut off.
  const narrow = block("820px");
  assert.match(narrow, /\.tt-board\.has-detail[\s\S]*\.tt-filters[\s\S]*\.tt-task-surface \{\s*display:\s*none/);
  assert.doesNotMatch(narrow, /position:\s*absolute|svh/);
  assert.doesNotMatch(block("1099px"), /position:\s*absolute|svh/);
  // Icon-only view switch keeps its icons; labels hide only when narrow.
  assert.match(block("560px"), /\.tt-view-toggle \.ui-btn-label/);
  assert.match(css, /\.tt-task-surface[\s\S]*overflow:\s*auto/);
  assert.match(css, /\.tt-board-content \{[^}]*overflow:\s*clip/);
  assert.match(css, /env\(safe-area-inset-bottom/);

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
    assert.match(document.querySelector(".tt-detail")?.textContent ?? "", /Hand off to an agent/);
    assert.equal(document.querySelector(".tt-detail")?.getAttribute("role"), "dialog");
    assert.equal(document.activeElement, document.querySelector(".tt-detail"));
    assert.ok(document.querySelector<HTMLAnchorElement>(".tt-detail .tt-external")?.href.includes("/browse/POL-7"));

    const instructions = document.querySelector<HTMLTextAreaElement>('.tt-detail textarea[aria-label="Additional instructions for the agent"]');
    assert.ok(instructions);
    await act(async () => {
      setControlValue(instructions, "Preserve swipe gestures.");
      clickByText(document.body, "Link & start agent").click();
    });
    await settle();
    assert.equal(links.length, 1);
    assert.equal(links[0]?.startAgent, true);
    assert.equal(links[0]?.instructions, "Preserve swipe gestures.");
    assert.match(document.querySelector(".tt-detail")?.textContent ?? "", /Linked to session/);

    await act(async () => { clickByText(document.body, "Refresh link").click(); });
    await settle();
    assert.equal(links.length, 2);
    assert.equal(links[1]?.startAgent, false);

    const statusRow = document.querySelector(".tt-detail .tt-status-row");
    assert.ok(statusRow);
    await pickPickerOption(statusRow, "Review");
    await act(async () => { clickByText(document.body, "Update status").click(); });
    await settle();
    assert.deepEqual(updates, ["review"]);
    assert.match(document.querySelector(".tt-detail")?.textContent ?? "", /Moved to Review/);

    await act(async () => { clickByText(document.body, "Mark complete").click(); });
    await settle();
    assert.deepEqual(updates, ["review", "done"]);
    assert.match(document.querySelector(".tt-detail")?.textContent ?? "", /Task marked complete/);

    await act(async () => {
      document.querySelector<HTMLButtonElement>('.tt-detail button[aria-label="Close task details"]')?.click();
    });
    await settle();
    // The status changes moved the row into another section of the grouped
    // list, so focus lands on the task's row wherever it is now.
    const focused = document.activeElement as HTMLElement | null;
    assert.equal(focused?.classList.contains("tt-list-row") ?? false, true, "closing details restores focus to the selected task");
    assert.equal(focused?.dataset.taskRef ?? null, "jira:10001");
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

test("a member's own tracker account counts as connected", () => {
  const info = { provider: "trello" as const, mode: "live" as const, configured: true, requiredEnv: [] as string[], enabled: true };
  assert.equal(providerState({ ...info, source: "personal" }), "connected");
  assert.equal(providerState({ ...info, source: "connection" }), "connected");
  assert.equal(providerState({ ...info, source: "personal", enabled: false }), "off");
  assert.equal(providerState({ ...info, configured: false, source: "none" }), "disconnected");
});
