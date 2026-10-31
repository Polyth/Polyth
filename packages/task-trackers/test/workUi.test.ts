import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type {
  SessionProjection,
  TaskTrackerStatusDto,
  TaskTrackerTaskDto,
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
const { TaskTrackerBoard, configureTaskTrackerHost } = await import("../widgets/plugin.tsx");
const { notifications, getNotifications, resetNotifications } = await import("../../../apps/web/src/notify/store.ts");
/** The board's latest outcome notice, as the host stack holds it. */
const boardNotice = () => getNotifications().items.find((item) => item.id === "task-trackers.board-notice")?.title ?? "";
const boardNoticeAction = (label: string) => getNotifications().items
  .find((item) => item.id === "task-trackers.board-notice")?.actions?.find((action) => action.label === label);
const store = await import("../widgets/store.ts");
const { DEFAULT_TASK_TRACKER_PREFERENCES } = await import("../src/types.ts");

const managementFor = (role: "admin" | "member" | "viewer"): TaskTrackerManagementDto => ({
  preferences: DEFAULT_TASK_TRACKER_PREFERENCES,
  connections: [],
  personalConnections: [],
  providers: [
    { provider: "jira", mode: "live", configured: true, requiredEnv: [], enabled: true, source: "connection" },
    { provider: "trello", mode: "live", configured: false, requiredEnv: [], enabled: true, source: "none" },
  ],
  vaultAvailable: true,
  canManage: role === "admin",
  canConnect: role !== "viewer",
});

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

const settle = async (turns = 3): Promise<void> => {
  for (let index = 0; index < turns; index++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
};

const button = (root: ParentNode, text: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll("button")].find((item) => item.textContent?.trim() === text) as HTMLButtonElement | undefined;

const typeInto = (control: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
  const prototype = control instanceof dom.HTMLTextAreaElement ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
};

interface Harness {
  dispatches: Array<Parameters<typeof api.taskTrackerDispatch>[0]>;
  created: Array<Parameters<typeof api.taskTrackerCreate>[1]>;
  attached: Array<{ taskId: string; files: Parameters<typeof api.taskTrackerAttach>[2] }>;
  opened: string[];
  restore(): void;
}

function harness(options: { role?: "admin" | "member" | "viewer" } = {}): Harness {
  const originals = { ...api };
  const dispatches: Harness["dispatches"] = [];
  const created: Harness["created"] = [];
  const attached: Harness["attached"] = [];
  const opened: string[] = [];
  let tasks = [task("1", "Fix mobile overflow"), task("2", "Add retry guidance"), task("3", "Polish layout")];
  let links: Array<{ provider: "jira"; taskId: string; taskKey: string; sessionId: string; linkedAt: number }> = [];
  api.taskTrackerProviders = async () => [
    { provider: "jira", mode: "live", configured: true, requiredEnv: [] },
    { provider: "trello", mode: "live", configured: false, requiredEnv: [] },
  ];
  api.taskTrackerProjects = async () => [{ provider: "jira", id: "polyth", key: "POL", name: "Polyth" }];
  api.taskTrackerBoards = async () => [{ provider: "jira", id: "delivery", name: "Delivery", type: "kanban", projectId: "polyth" }];
  api.taskTrackerTasks = async () => tasks;
  api.taskTrackerTask = async (_provider, id) => tasks.find((item) => item.id === id)!;
  api.taskTrackerSessionTasks = async () => [];
  api.taskTrackerSettings = async () => managementFor(options.role ?? "member");
  api.taskTrackerLinks = async () => links;
  api.taskTrackerCreate = async (_provider, input) => {
    created.push(input);
    const next = task("9", input.title);
    tasks = [next, ...tasks];
    return next;
  };
  api.taskTrackerUpdateTask = async (_provider, id, input) => {
    const current = tasks.find((item) => item.id === id)!;
    const updated = {
      ...current,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    };
    tasks = tasks.map((item) => item.id === id ? updated : item);
    return updated;
  };
  api.taskTrackerAddComment = async (_provider, id, text) => {
    const current = tasks.find((item) => item.id === id)!;
    const newComment = {
      id: `c-${Date.now()}`,
      text,
      author: "Max",
      createdAt: new Date().toISOString(),
    };
    const updated = {
      ...current,
      comments: [...(current.comments ?? []), newComment],
    };
    tasks = tasks.map((item) => item.id === id ? updated : item);
    return { ok: true as const, task: updated };
  };
  api.taskTrackerAttach = async (_provider, taskId, files) => {
    attached.push({ taskId, files });
    const current = tasks.find((item) => item.id === taskId)!;
    const newAttachments = files.map((f, i) => ({
      id: `att-${Date.now()}-${i}`,
      name: f.name,
      mimeType: f.mimeType,
      url: `https://example.com/${encodeURIComponent(f.name)}`,
      size: 1024,
    }));
    const updated = {
      ...current,
      attachments: [...(current.attachments ?? []), ...newAttachments],
    };
    tasks = tasks.map((item) => item.id === taskId ? updated : item);
    return { ok: true, task: updated };
  };
  api.taskTrackerDispatch = async (input) => {
    dispatches.push(input);
    const results = input.tasks.map((item, index) => ({
      provider: item.provider,
      taskId: item.taskId,
      taskKey: `POL-${item.taskId}`,
      sessionId: `s-${item.taskId}`,
      ...(index === 2 ? { error: "Jira is unreachable" } : {}),
    }));
    links = results.filter((item) => !item.error).map((item) => ({
      provider: "jira" as const,
      taskId: item.taskId,
      taskKey: item.taskKey,
      sessionId: item.sessionId,
      linkedAt: 1,
    }));
    return { results: results.map(({ sessionId, ...rest }) => rest.error ? rest : { ...rest, sessionId }) };
  };
  const sessions = new Map<string, SessionProjection>([
    ["s-1", { id: "s-1", title: "POL-1 · Fix mobile overflow", status: "working" } as SessionProjection],
  ]);
  resetNotifications();
  configureTaskTrackerHost({
    ui: { icons: {} },
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
    sessions: { subscribe: () => () => {}, get: (id: string) => sessions.get(id) },
    conversation: { openSession: async (id: string) => { opened.push(id); } },
    navigation: { openSettingsPage() {} },
  } as never);
  store.resetManagementForTests();
  return {
    dispatches,
    created,
    attached,
    opened,
    restore() {
      Object.assign(api, originals);
      store.resetManagementForTests();
    },
  };
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

test("select mode sends several tasks to agents, one session each, with the composer's agent", async () => {
  const run = harness();
  const view = await mountBoard();
  try {
    const select = button(view.container, "Select");
    assert.ok(select, "members get a Select action");
    await act(async () => { select.click(); });
    for (const key of ["POL-1", "POL-2", "POL-3"]) {
      const card = view.container.querySelector<HTMLButtonElement>(`[aria-label^="Select ${key}:"]`);
      assert.ok(card, `${key} is selectable`);
      await act(async () => { card.click(); });
    }
    assert.match(view.container.querySelector(".tt-dispatch-bar")?.textContent ?? "", /3 selected/);
    typeInto(view.container.querySelector<HTMLInputElement>('[aria-label="Instructions for every agent"]')!, "Keep diffs small");
    await act(async () => { button(view.container, "Start 3 agents")!.click(); });
    await settle(4);

    assert.deepEqual(run.dispatches, [{
      projectId: "project-1",
      tasks: [{ provider: "jira", taskId: "1" }, { provider: "jira", taskId: "2" }, { provider: "jira", taskId: "3" }],
      instructions: "Keep diffs small",
      harness: { mode: "pinned", harnessId: "claude" },
      model: { providerID: "anthropic", modelID: "opus" },
    }]);
    const toast = boardNotice();
    assert.match(toast, /2 started · 1 failed: POL-3 \(Jira is unreachable\)/);
    assert.equal(view.container.querySelector(".tt-dispatch-bar"), null, "select mode ends after sending");
    assert.match(view.container.querySelector('[aria-label^="Open POL-1:"]')?.textContent ?? "", /1/, "card shows its agent session");
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("new task composer opens in the board, attaches images and can start an agent right away", async () => {
  const run = harness();
  const view = await mountBoard();
  try {
    await act(async () => { button(view.container, "New task")!.click(); });
    const pane = view.container.querySelector(".tt-board-content.has-detail > .tt-compose-pane");
    assert.ok(pane, "the composer opens inline in the board's detail pane");
    assert.equal(document.querySelector('.ui-dialog, [role="dialog"][aria-modal="true"]'), null, "no popup");
    typeInto(pane.querySelector<HTMLInputElement>('input[placeholder="What needs to happen?"]')!, "Write release notes");
    typeInto(pane.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task details"]')!, "For 2.4");

    const picker = pane.querySelector<HTMLInputElement>('input[type="file"]')!;
    const files = [
      new dom.File(["png-bytes"], "shot.png", { type: "image/png" }),
      new dom.File(["not an image"], "notes.txt", { type: "text/plain" }),
    ];
    Object.defineProperty(picker, "files", { configurable: true, value: files });
    await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle(4);
    assert.deepEqual([...pane.querySelectorAll(".tt-compose-images img")].map((img) => img.getAttribute("alt")), ["shot.png"]);

    const agent = pane.querySelector<HTMLButtonElement>('[role="switch"]');
    assert.ok(agent);
    await act(async () => { agent.click(); });
    await act(async () => { button(pane, "Create & start agent")!.click(); });
    await settle(4);

    assert.deepEqual(run.created, [{ title: "Write release notes", description: "For 2.4", boardId: "delivery", projectId: "polyth" }]);
    assert.deepEqual(run.attached, [{
      taskId: "9",
      files: [{ name: "shot.png", mimeType: "image/png", data: Buffer.from("png-bytes").toString("base64") }],
    }]);
    assert.equal(view.container.querySelector(".tt-compose-pane"), null, "the pane closes after creating");
    assert.deepEqual(run.dispatches.map((item) => item.tasks), [[{ provider: "jira", taskId: "9" }]]);
    assert.ok(view.container.querySelector('[aria-label^="Open POL-9:"]'), "the new task appears on the board");
    assert.match(boardNotice(), /POL-9 created · agent started/);
    await act(async () => { await boardNoticeAction("Open session")!.run(); });
    assert.deepEqual(run.opened, ["s-9"]);
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("a refused create shows the tracker's reason and keeps the draft; a lost answer says to check the board", async () => {
  const run = harness();
  const view = await mountBoard();
  try {
    await act(async () => { button(view.container, "New task")!.click(); });
    const pane = view.container.querySelector(".tt-compose-pane")!;
    typeInto(pane.querySelector<HTMLInputElement>('input[placeholder="What needs to happen?"]')!, "Write release notes");
    api.taskTrackerCreate = async () => {
      throw Object.assign(new Error("The connected Jira account can’t create issues in this project (403: Forbidden)."), { mutationOutcome: "rejected" });
    };
    await act(async () => { button(pane, "Create task")!.click(); });
    await settle(3);
    assert.match(pane.textContent ?? "", /Couldn’t create the task: The connected Jira account can’t create issues/);
    assert.equal(pane.querySelector<HTMLInputElement>('input[placeholder="What needs to happen?"]')!.value, "Write release notes");

    api.taskTrackerCreate = async () => {
      throw Object.assign(new Error("Jira request failed (502 Bad Gateway)"), { mutationOutcome: "unknown" });
    };
    await act(async () => { button(pane, "Create task")!.click(); });
    await settle(3);
    assert.equal(
      pane.querySelector(".tt-task-form")?.textContent?.match(/Jira didn’t confirm[^.]*\.[^.]*\./)?.[0],
      "Jira didn’t confirm whether the issue was created. Check the board before creating it again.",
    );
    assert.doesNotMatch(pane.textContent ?? "", /not confirmed|your draft/i);
    await act(async () => { button(pane, "Cancel")!.click(); });
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("unsent text survives the package window closing; only Cancel or creating discards it", async () => {
  const run = harness();
  let view = await mountBoard();
  try {
    await act(async () => { button(view.container, "New task")!.click(); });
    let pane = view.container.querySelector(".tt-compose-pane")!;
    typeInto(pane.querySelector<HTMLInputElement>('input[placeholder="What needs to happen?"]')!, "Fix login");
    typeInto(pane.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task details"]')!, "Grammarly fixed this");
    // The window closes under the composer (an outside click unmounts the package).
    await view.unmount();
    view = await mountBoard();
    pane = view.container.querySelector(".tt-compose-pane")!;
    assert.ok(pane, "reopening the board brings the composer back");
    assert.equal(pane.querySelector<HTMLInputElement>('input[placeholder="What needs to happen?"]')!.value, "Fix login");
    assert.equal(pane.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task details"]')!.value, "Grammarly fixed this");

    await act(async () => { button(pane, "Cancel")!.click(); });
    await view.unmount();
    view = await mountBoard();
    assert.equal(view.container.querySelector(".tt-compose-pane"), null, "Cancel discards the draft");

    await act(async () => { view.container.querySelector<HTMLElement>('[aria-label^="Open POL-1:"]')!.click(); });
    await settle(3);
    typeInto(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Additional instructions for the agent"]')!, "Use the new API");
    await view.unmount();
    view = await mountBoard();
    await act(async () => { view.container.querySelector<HTMLElement>('[aria-label^="Open POL-1:"]')!.click(); });
    await settle(3);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Additional instructions for the agent"]')!.value,
      "Use the new API",
      "agent instructions typed into a task survive too",
    );
    typeInto(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Additional instructions for the agent"]')!, "");
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("task detail starts an agent in a new session and lists the task's agent sessions", async () => {
  const run = harness();
  const view = await mountBoard();
  try {
    await act(async () => { view.container.querySelector<HTMLButtonElement>('[aria-label^="Open POL-1:"]')!.click(); });
    await settle();
    const detail = document.querySelector(".tt-detail")!;
    assert.equal(detail.querySelector('[role="radio"][aria-checked="true"]')?.textContent, "New session", "no open session defaults to a new one");
    assert.equal(button(detail, "This session")?.disabled, true);
    await act(async () => { button(detail, "Start agent in new session")!.click(); });
    await settle(4);
    assert.deepEqual(run.dispatches.map((item) => item.tasks), [[{ provider: "jira", taskId: "1" }]]);
    assert.match(detail.textContent ?? "", /Agent started in a new session/);
    const sessions = document.querySelector(".tt-agent-sessions");
    assert.match(sessions?.textContent ?? "", /POL-1 · Fix mobile overflow.*Agent working/);
    await act(async () => { (sessions!.querySelector("button") as HTMLButtonElement).click(); });
    assert.deepEqual(run.opened, ["s-1"]);
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("viewers browse without write actions", async () => {
  const run = harness({ role: "viewer" });
  const view = await mountBoard();
  try {
    assert.equal(button(view.container, "New task"), undefined);
    assert.equal(button(view.container, "Select"), undefined);
    await act(async () => { view.container.querySelector<HTMLButtonElement>('[aria-label^="Open POL-1:"]')!.click(); });
    await settle();
    const detail = document.querySelector(".tt-detail")?.textContent ?? "";
    assert.doesNotMatch(detail, /Hand off|Update the tracker/);
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("the kanban shows the board's columns in order, empty ones too, and adds a column in place", async () => {
  const run = harness();
  const added: Array<Parameters<typeof api.taskTrackerCreateColumn>[2]> = [];
  api.taskTrackerColumns = async () => ({
    columns: [
      { id: "todo", name: "To do", category: "todo", statusIds: ["todo"] },
      { id: "review", name: "Review", category: "in_progress", statusIds: ["review"] },
      { id: "done", name: "Done", category: "done", statusIds: ["done"] },
    ],
    editable: true,
    removal: "archive",
  });
  api.taskTrackerCreateColumn = async (_provider, _board, input) => {
    added.push(input);
    return { id: "qa", name: input.name ?? "", category: "unknown", statusIds: ["qa"] };
  };
  const view = await mountBoard();
  try {
    const names = () => [...view.container.querySelectorAll(".tt-column > header strong")].map((item) => item.textContent);
    assert.deepEqual(names(), ["To do", "Review", "Done"]);
    const review = [...view.container.querySelectorAll(".tt-column")][1]!;
    assert.match(review.textContent ?? "", /No tasks/);
    assert.ok(view.container.querySelector('[aria-label="Review column actions"]'), "editable columns have a menu");

    await act(async () => { button(view.container, "Add column")!.click(); });
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="New column name"]')!;
    await act(async () => { typeInto(input, "QA"); });
    await act(async () => {
      input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
    });
    await settle();
    assert.deepEqual(added, [{ name: "QA", position: 3 }]);
    assert.deepEqual(names(), ["To do", "Review", "Done", "QA"]);
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("columns the tracker manages itself link out instead of offering edits", async () => {
  const run = harness();
  api.taskTrackerColumns = async () => ({
    columns: [{ id: "To do", name: "To do", category: "todo", statusIds: ["todo"] }],
    editable: false,
    manageUrl: "https://acme.atlassian.net/secure/RapidView.jspa?rapidView=1&tab=columns",
  });
  const view = await mountBoard();
  try {
    assert.equal(button(view.container, "Add column"), undefined);
    assert.equal(view.container.querySelector('[aria-label="To do column actions"]'), null);
    const link = view.container.querySelector<HTMLAnchorElement>(".tt-column-add a");
    assert.equal(link?.textContent, "Edit columns in Jira");
    assert.match(link?.href ?? "", /tab=columns/);
  } finally {
    await view.unmount();
    run.restore();
  }
});

const { setSessions } = await import("../../../apps/web/src/store.ts");

const menuItem = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('.tt-card-menu [role^="menuitem"]')]
    .find((item) => item.querySelector(".ui-menu-item-label")?.textContent === label);

const menuLabels = (): string[] =>
  [...document.querySelectorAll('.tt-card-menu [role^="menuitem"] .ui-menu-item-label')].map((item) => item.textContent ?? "");

const rightClick = async (target: Element): Promise<void> => {
  await act(async () => {
    target.dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event);
  });
  await settle(1);
};

test("right-clicking a card opens its actions and Move to drills into the board's columns", async () => {
  const run = harness();
  const moves: Array<Parameters<typeof api.taskTrackerMoveTask>[2]> = [];
  api.taskTrackerColumns = async () => ({
    columns: [
      { id: "todo", name: "To do", category: "todo", statusIds: ["todo"] },
      { id: "review", name: "Review", category: "in_progress", statusIds: ["review"] },
    ],
    editable: true,
    removal: "archive",
  });
  api.taskTrackerMoveTask = async (_provider, id, input) => {
    moves.push(input);
    return { ...task(id, "Fix mobile overflow"), status: { id: "review", name: "Review", category: "in_progress" } };
  };
  const view = await mountBoard();
  try {
    const card = view.container.querySelector<HTMLButtonElement>('[aria-label^="Open POL-1:"]')!;
    await rightClick(card);
    assert.equal(document.querySelector('[role="menu"]')?.getAttribute("aria-label"), "POL-1 actions");
    assert.deepEqual(menuLabels(), [
      "Open details", "Edit title & description", "Copy POL-1", "Move to", "Start agent in new session", "Sessions", "Select for agents",
      "Archive", "Delete",
    ]);
    assert.equal(document.querySelector(".tt-detail"), null, "a right-click doesn't open the task");

    await act(async () => { menuItem("Move to")!.click(); });
    assert.deepEqual(menuLabels(), ["Move to", "To do", "Review"], "the submenu replaces the list, with a way back");
    assert.equal(menuItem("To do")!.getAttribute("aria-checked"), "true");
    await act(async () => { menuItem("Review")!.click(); });
    await settle();
    assert.deepEqual(moves, [{ boardId: "delivery", columnId: "review" }]);
    assert.equal(document.querySelector(".tt-card-menu"), null, "choosing an action closes the menu");

    // Shift+F10 opens the same menu from the keyboard (the moved card is a
    // new element in its new column).
    const moved = view.container.querySelector<HTMLButtonElement>('[aria-label^="Open POL-1:"]')!;
    assert.match(moved.closest(".tt-column")?.querySelector("header strong")?.textContent ?? "", /Review/);
    await act(async () => {
      moved.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }) as unknown as Event);
    });
    assert.ok(menuItem("Open details"));
    await act(async () => { menuItem("Open details")!.click(); });
    await settle();
    assert.ok(document.querySelector(".tt-detail"), "Open details opens the task");

    // A column header's right-click opens that column's menu.
    const header = [...view.container.querySelectorAll(".tt-column > header")][1]!;
    await act(async () => {
      header.dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event);
    });
    assert.equal(document.querySelector('[role="menu"]')?.getAttribute("aria-label"), "Review column actions");
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("the card menu's Sessions submenu lists sessions and hands the card to one of them", async () => {
  const run = harness();
  const linkCalls: Array<{ taskId: string; input: Parameters<typeof api.taskTrackerLink>[2] }> = [];
  api.taskTrackerLink = async (_provider, taskId, input) => {
    linkCalls.push({ taskId, input });
    return { ok: true, task: task(taskId, "Add retry guidance"), sessionId: input.sessionId };
  };
  const base = { projectId: "project-1", createdAt: 1 } as const;
  setSessions("project-1", [
    { ...base, id: "s-a", title: "Refactor auth", status: "idle", updatedAt: 5 },
    { ...base, id: "s-b", title: "Old work", status: "archived", updatedAt: 9 },
    { ...base, id: "s-c", title: "Workflow parent", status: "idle", purpose: "workflow", updatedAt: 8 },
    { ...base, id: "s-d", title: "Delegated child", status: "idle", parentId: "s-a", updatedAt: 7 },
    { ...base, id: "s-e", title: "Write docs", status: "working", updatedAt: 6 },
  ] as SessionProjection[]);
  const view = await mountBoard();
  try {
    await rightClick(view.container.querySelector('[aria-label^="Open POL-2:"]')!);
    await act(async () => { menuItem("Sessions")!.click(); });
    assert.deepEqual(menuLabels(), ["Sessions", "New session", "Write docs", "Refactor auth"],
      "recent project chats only: no archived, package-owned or delegated sessions");

    await act(async () => { menuItem("Refactor auth")!.click(); });
    assert.deepEqual(menuLabels(), ["Refactor auth", "Link & start agent", "Link only", "Open session"]);
    await act(async () => {
      document.querySelector(".tt-card-menu")!.dispatchEvent(
        new dom.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }) as unknown as Event);
    });
    assert.equal(menuLabels()[0], "Sessions", "ArrowLeft steps back one level");
    await act(async () => { menuItem("Refactor auth")!.click(); });
    await act(async () => { menuItem("Link & start agent")!.click(); });
    await settle();

    assert.deepEqual(linkCalls, [{ taskId: "2", input: { sessionId: "s-a", startAgent: true } }]);
    assert.match(boardNotice(), /POL-2 sent to Refactor auth/);
    await act(async () => { await boardNoticeAction("Open session")!.run(); });
    assert.deepEqual(run.opened, ["s-a"]);

    await rightClick(view.container.querySelector('[aria-label^="Open POL-3:"]')!);
    await act(async () => { menuItem("Sessions")!.click(); });
    await act(async () => { menuItem("New session")!.click(); });
    await settle(4);
    assert.deepEqual(run.dispatches.map((item) => item.tasks), [[{ provider: "jira", taskId: "3" }]]);
  } finally {
    setSessions("project-1", []);
    await view.unmount();
    run.restore();
  }
});

const { resolveAlert } = await import("../../../apps/web/src/alerts.ts");

const leftPress = async (target: Element): Promise<void> => {
  await act(async () => {
    target.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event);
  });
};

test("a left press anywhere closes the card menu, even on the card that opened it", async () => {
  const run = harness();
  const view = await mountBoard();
  try {
    const card = view.container.querySelector<HTMLButtonElement>('[aria-label^="Open POL-1:"]')!;
    await rightClick(card);
    await leftPress(menuItem("Copy POL-1")!);
    assert.ok(document.querySelector(".tt-card-menu"), "a press inside the menu keeps it open");
    await leftPress(card);
    assert.equal(document.querySelector(".tt-card-menu"), null, "the card that opened it");

    await rightClick(card);
    await act(async () => {
      card.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, button: 2 }) as unknown as Event);
    });
    assert.ok(document.querySelector(".tt-card-menu"), "a right press is not a dismissal of its own");
    await leftPress(view.container.querySelector(".tt-column > header")!);
    assert.equal(document.querySelector(".tt-card-menu"), null, "anywhere on the board");
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("the card menu archives or deletes a task after confirmation", async () => {
  const run = harness();
  const calls: string[] = [];
  api.taskTrackerArchiveTask = async (_provider, id) => { calls.push(`archive:${id}`); return { ok: true }; };
  api.taskTrackerDeleteTask = async (_provider, id) => { calls.push(`delete:${id}`); return { ok: true }; };
  const view = await mountBoard();
  const has = (key: string) => Boolean(view.container.querySelector(`[aria-label^="Open ${key}:"]`));
  try {
    await rightClick(view.container.querySelector('[aria-label^="Open POL-1:"]')!);
    await act(async () => { menuItem("Delete")!.click(); });
    await act(async () => { resolveAlert(false); });
    await settle();
    assert.deepEqual(calls, [], "cancelling the confirmation changes nothing");
    assert.ok(has("POL-1"));

    await rightClick(view.container.querySelector('[aria-label^="Open POL-1:"]')!);
    await act(async () => { menuItem("Archive")!.click(); });
    await act(async () => { resolveAlert(true); });
    await settle();
    await rightClick(view.container.querySelector('[aria-label^="Open POL-2:"]')!);
    await act(async () => { menuItem("Delete")!.click(); });
    await act(async () => { resolveAlert(true); });
    await settle();

    assert.deepEqual(calls, ["archive:1", "delete:2"]);
    assert.equal(has("POL-1") || has("POL-2"), false, "both cards leave the board");
    assert.match(boardNotice(), /POL-2 deleted/);
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("a deleted card leaves before the tracker answers and returns in place when it refuses", async () => {
  const run = harness();
  let calls = 0;
  let refuse!: (error: Error) => void;
  api.taskTrackerDeleteTask = (() => {
    calls += 1;
    return new Promise((_resolve, reject) => { refuse = reject; });
  }) as typeof api.taskTrackerDeleteTask;
  const view = await mountBoard();
  const keys = () => [...view.container.querySelectorAll('[aria-label^="Open POL-"]')]
    .map((item) => item.getAttribute("aria-label")?.match(/POL-\d+/)?.[0]);
  try {
    assert.deepEqual(keys(), ["POL-1", "POL-2", "POL-3"]);
    await rightClick(view.container.querySelector('[aria-label^="Open POL-2:"]')!);
    await act(async () => { menuItem("Delete")!.click(); });
    await act(async () => { resolveAlert(true); });
    await settle(1);
    assert.deepEqual(keys(), ["POL-1", "POL-3"], "the card leaves at once");
    await act(async () => { refuse(new Error("Jira said no")); });
    await settle();
    assert.equal(calls, 1, "the request is sent once and not retried");
    assert.deepEqual(keys(), ["POL-1", "POL-2", "POL-3"], "the card returns to its place");
    assert.match(view.container.textContent ?? "", /Couldn’t delete POL-2/);
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("a column rename shows the new name at once and restores it when the tracker refuses", async () => {
  const run = harness();
  let refuse!: (error: Error) => void;
  const renames: string[] = [];
  api.taskTrackerColumns = async () => ({
    columns: [
      { id: "todo", name: "To do", category: "todo", statusIds: ["todo"] },
      { id: "done", name: "Done", category: "done", statusIds: ["done"] },
    ],
    editable: true,
    removal: "archive",
  });
  api.taskTrackerUpdateColumn = ((_provider: string, _board: string, _column: string, input: { name?: string }) => {
    renames.push(input.name ?? "");
    return new Promise((_resolve, reject) => { refuse = reject; });
  }) as unknown as typeof api.taskTrackerUpdateColumn;
  const view = await mountBoard();
  const names = () => [...view.container.querySelectorAll(".tt-column > header strong")].map((item) => item.textContent);
  try {
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('[aria-label="To do column actions"]')!.click();
    });
    const rename = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
      .find((item) => item.textContent?.includes("Rename"))!;
    await act(async () => { rename.click(); });
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Rename To do"]')!;
    await act(async () => { typeInto(input, "Backlog"); });
    await act(async () => {
      input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
    });
    await settle(1);
    assert.deepEqual(names(), ["Backlog", "Done"], "the new name shows before the tracker answers");
    assert.equal(view.container.querySelector('input[aria-label="Rename To do"]'), null, "the editor closes at once");
    await act(async () => { refuse(new Error("Jira said no")); });
    await settle();
    assert.deepEqual(renames, ["Backlog"]);
    assert.deepEqual(names(), ["To do", "Done"]);
    assert.match(view.container.textContent ?? "", /Couldn’t rename the column/);
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("viewers get no archive or delete in the card menu", async () => {
  const run = harness({ role: "viewer" });
  const view = await mountBoard();
  try {
    await rightClick(view.container.querySelector('[aria-label^="Open POL-1:"]')!);
    assert.ok(menuItem("Open details"));
    assert.equal(menuItem("Archive") ?? menuItem("Delete") ?? null, null);
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("task cards lead with a Trello-style cover that opens the task; the task's cover band previews the image", async () => {
  const run = harness();
  const taskWithMedia: TaskTrackerTaskDto = {
    ...task("1", "Task with media"),
    attachments: [
      { id: "att-0", name: "first.png", mimeType: "image/png", url: "https://example.com/first.png", thumbnailUrl: "https://example.com/first-thumb.png", size: 2048 },
      { id: "att-1", name: "diagram.png", mimeType: "image/png", url: "https://example.com/diagram.png", thumbnailUrl: "https://example.com/thumb.png", size: 1024 },
      { id: "att-2", name: "notes.txt", mimeType: "text/plain", url: "https://example.com/notes.txt", size: 512 },
    ],
    // The tracker's chosen cover wins over the first image.
    coverAttachmentId: "att-1",
    comments: [
      { id: "c-1", text: "First comment", author: "Alice", createdAt: new Date().toISOString() },
    ],
  };
  api.taskTrackerTasks = async () => [taskWithMedia];
  api.taskTrackerTask = async () => taskWithMedia;

  const view = await mountBoard();
  try {
    const card = view.container.querySelector<HTMLButtonElement>('[aria-label^="Open POL-1:"]')!;
    assert.ok(card.classList.contains("has-cover"), "card has cover class");
    const cover = card.querySelector(".tt-card-cover");
    assert.ok(cover, "card has cover thumbnail");
    assert.equal(cover.querySelector("img")?.getAttribute("src"), "https://example.com/thumb.png");
    assert.match(cover.textContent ?? "", /2/, "the cover counts the card's images");

    const badges = [...card.querySelectorAll(".tt-meta-badge")].map((b) => b.textContent?.trim());
    assert.ok(badges.some((b) => b?.includes("3")), "shows 3 attachments");
    assert.ok(badges.some((b) => b?.includes("1")), "shows 1 comment");

    // Like Trello, the cover is part of the card: it opens the task.
    await act(async () => { (cover as HTMLElement).click(); });
    await settle();
    assert.ok(!document.querySelector(".tt-lightbox-overlay"), "the card cover does not jump to a preview");
    const detail = document.querySelector(".tt-detail")!;
    assert.ok(detail, "the cover opened the task");
    assert.equal(detail.closest(".dialog-backdrop")?.parentElement, document.body, "the task opens as a modal over the board");
    const band = detail.querySelector<HTMLButtonElement>('.tt-modal-cover[aria-label="View cover image: diagram.png"]');
    assert.ok(band, "the task leads with its cover");
    await act(async () => { band!.click(); });
    await settle();

    const lightbox = document.querySelector(".tt-lightbox-overlay");
    assert.ok(lightbox, "lightbox opened");
    assert.equal(lightbox.querySelector<HTMLImageElement>(".tt-lightbox-image img")?.src, "https://example.com/diagram.png");
    assert.equal(lightbox.parentElement, document.body, "the overlay escapes the board's layout");
    assert.match(lightbox.textContent ?? "", /2 of 2/, "the preview pages through the task's images");

    await act(async () => {
      lightbox.querySelector<HTMLButtonElement>('button[aria-label="Close preview"]')!.click();
    });
    await settle();
    assert.equal(document.querySelector(".tt-lightbox-overlay"), null, "lightbox closed");
    assert.ok(document.querySelector(".tt-detail"), "closing the preview keeps the task open");

    // Escape in the preview closes only the preview, not the open task.
    const thumb = document.querySelector<HTMLButtonElement>('.tt-detail button[aria-label="Preview image: diagram.png"]')!;
    assert.ok(thumb, "detail shows the image thumbnail");
    assert.match(thumb.textContent ?? "", /Cover/, "the thumbnail that is the cover says so");
    await act(async () => { thumb.click(); });
    await settle();
    assert.ok(document.querySelector(".tt-lightbox-overlay"));
    await act(async () => {
      document.querySelector(".tt-lightbox-overlay")!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    assert.equal(document.querySelector(".tt-lightbox-overlay"), null, "preview closed");
    assert.ok(document.querySelector(".tt-detail"), "task detail stays open");
    assert.match(document.querySelector(".tt-detail")!.textContent ?? "", /notes\.txt/, "other files are listed");

    await act(async () => {
      document.querySelector<HTMLButtonElement>('.tt-detail button[aria-label="Close task details"]')!.click();
    });
    await settle();
    assert.ok(!document.querySelector(".tt-detail"), "the task closes");

    // A picture the tracker refuses falls back to a file glyph.
    const coverImage = card.querySelector<HTMLImageElement>(".tt-card-cover img")!;
    await act(async () => { coverImage.dispatchEvent(new window.Event("error")); });
    await settle();
    assert.ok(card.querySelector(".tt-card-cover .tt-image-fallback"), "broken cover shows a fallback");
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("task detail allows inline editing of title and description", async () => {
  const run = harness();
  const calls: Array<{ id: string; input: { title?: string; description?: string } }> = [];
  api.taskTrackerUpdateTask = async (_provider, id, input) => {
    calls.push({ id, input });
    const current = (await api.taskTrackerTasks("jira", { boardId: "delivery" })).find((item) => item.id === id)!;
    return { ...current, ...input };
  };

  const view = await mountBoard();
  try {
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('[aria-label^="Open POL-1:"]')!.click();
    });
    await settle();

    const detail = document.querySelector(".tt-detail")!;
    assert.ok(detail, "detail opened");

    const editBtn = detail.querySelector<HTMLButtonElement>('.tt-detail-title-row button[aria-label="Edit task"]')!;
    assert.ok(editBtn, "found edit task button");
    await act(async () => { editBtn.click(); });
    await settle();

    const titleInput = detail.querySelector<HTMLInputElement>('.tt-detail-edit-form input[aria-label="Task title"]')!;
    const descInput = detail.querySelector<HTMLTextAreaElement>('.tt-detail-edit-form textarea[aria-label="Task description"]')!;
    assert.ok(titleInput && descInput, "title and description inputs present");
    assert.equal(titleInput.value, "Fix mobile overflow");

    await act(async () => {
      typeInto(titleInput, "Fix mobile overflow updated");
      typeInto(descInput, "Updated description content");
    });
    await settle();

    const saveBtn = button(detail.querySelector(".tt-edit-actions")!, "Save")!;
    await act(async () => { saveBtn.click(); });
    await settle();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.id, "1");
    assert.equal(calls[0]!.input.title, "Fix mobile overflow updated");
    assert.equal(calls[0]!.input.description, "Updated description content");
    assert.match(detail.textContent ?? "", /Fix mobile overflow updated/);
    assert.match(detail.textContent ?? "", /Updated description content/);
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("task detail allows viewing comments and adding a new comment", async () => {
  const run = harness();
  const addedComments: string[] = [];
  const testTask: TaskTrackerTaskDto = {
    ...task("1", "Fix mobile overflow"),
    comments: [
      { id: "c-1", text: "Existing comment from team", author: "Sarah", createdAt: new Date(Date.now() - 3600000).toISOString() },
    ],
  };
  api.taskTrackerTasks = async () => [testTask];
  api.taskTrackerTask = async () => testTask;
  api.taskTrackerAddComment = async (_provider, _id, text) => {
    addedComments.push(text);
    return {
      ok: true as const,
      task: {
        ...testTask,
        comments: [
          ...(testTask.comments ?? []),
          { id: "c-2", text, author: "Max", createdAt: new Date().toISOString() },
        ],
      },
    };
  };

  const view = await mountBoard();
  try {
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('[aria-label^="Open POL-1:"]')!.click();
    });
    await settle();

    const detail = document.querySelector(".tt-detail")!;
    assert.ok(detail.querySelector(".tt-comments-section"), "comments section rendered");
    assert.match(detail.textContent ?? "", /Existing comment from team/);
    assert.match(detail.textContent ?? "", /Sarah/);

    const commentInput = detail.querySelector<HTMLTextAreaElement>('.tt-comment-form textarea')!;
    assert.ok(commentInput, "comment textarea rendered");

    await act(async () => {
      typeInto(commentInput, "This is a new test comment");
    });
    await settle();

    const addBtn = button(detail.querySelector(".tt-comment-form")!, "Add comment")!;
    await act(async () => { addBtn.click(); });
    await settle();

    assert.deepEqual(addedComments, ["This is a new test comment"]);
    assert.match(detail.textContent ?? "", /This is a new test comment/);
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("list responses with only a comment total still show the count", async () => {
  const run = harness();
  const listed: TaskTrackerTaskDto = { ...task("1", "Counted"), commentCount: 4 };
  api.taskTrackerTasks = async () => [listed];
  api.taskTrackerTask = async () => ({
    ...listed,
    comments: [{ id: "c-1", text: "Newest", author: "Ada", createdAt: new Date().toISOString() }],
  });
  const view = await mountBoard();
  try {
    const card = view.container.querySelector<HTMLButtonElement>('[aria-label^="Open POL-1:"]')!;
    assert.ok([...card.querySelectorAll(".tt-meta-badge")].some((badge) => badge.textContent?.trim() === "4"));
    await act(async () => { card.click(); });
    await settle();
    assert.match(document.querySelector(".tt-comments-section")!.textContent ?? "", /4 comments · showing the latest 1/);
    assert.match(document.querySelector(".tt-comments-section")!.textContent ?? "", /Newest/);
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("a task edit shows at once and returns to the editor with the typed text when the tracker refuses", async () => {
  const run = harness();
  let calls = 0;
  let refuse!: (error: Error) => void;
  api.taskTrackerUpdateTask = (() => {
    calls += 1;
    return new Promise((_resolve, reject) => { refuse = reject; });
  }) as typeof api.taskTrackerUpdateTask;
  const view = await mountBoard();
  try {
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('[aria-label^="Open POL-1:"]')!.click();
    });
    await settle();
    const detail = document.querySelector(".tt-detail")!;
    await act(async () => {
      detail.querySelector<HTMLButtonElement>('.tt-detail-title-row button[aria-label="Edit task"]')!.click();
    });
    const titleInput = detail.querySelector<HTMLInputElement>('input[aria-label="Task title"]')!;
    const descInput = detail.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task description"]')!;
    await act(async () => {
      typeInto(titleInput, "Renamed task");
      typeInto(descInput, "New words");
    });
    await act(async () => { button(detail.querySelector(".tt-edit-actions")!, "Save")!.click(); });
    await settle(1);
    assert.equal(detail.querySelector(".tt-detail-edit-form"), null, "the editor closes before the tracker answers");
    assert.equal(detail.querySelector("h3")?.textContent, "Renamed task");
    assert.ok(view.container.querySelector('[aria-label^="Open POL-1: Renamed task"]'), "the card shows the new title");

    await act(async () => { refuse(new Error("Jira said no")); });
    await settle();
    assert.equal(calls, 1, "sent once, not retried");
    assert.equal(detail.querySelector("h3")?.textContent, "Fix mobile overflow", "the task shows its old title again");
    assert.equal(detail.querySelector<HTMLInputElement>('input[aria-label="Task title"]')?.value, "Renamed task");
    assert.equal(detail.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task description"]')?.value, "New words");
    assert.match(detail.textContent ?? "", /Couldn’t update POL-1/);
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("a comment shows as pending at once and keeps its text when the tracker refuses", async () => {
  const run = harness();
  const sent: string[] = [];
  let refuse!: (error: Error) => void;
  api.taskTrackerAddComment = ((_provider: string, _id: string, text: string) => {
    sent.push(text);
    return new Promise((_resolve, reject) => { refuse = reject; });
  }) as unknown as typeof api.taskTrackerAddComment;
  const view = await mountBoard();
  try {
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('[aria-label^="Open POL-1:"]')!.click();
    });
    await settle();
    const detail = document.querySelector(".tt-detail")!;
    const field = () => detail.querySelector<HTMLTextAreaElement>(".tt-comment-form textarea")!;
    await act(async () => { typeInto(field(), "Looks good to me"); });
    await act(async () => { button(detail.querySelector(".tt-comment-form")!, "Add comment")!.click(); });
    await settle(1);
    assert.equal(field().value, "", "the field clears at once");
    assert.equal(field().disabled, false, "the field stays usable");
    const pending = detail.querySelector(".tt-comment-item.pending");
    assert.match(pending?.textContent ?? "", /Looks good to me/);
    assert.match(pending?.textContent ?? "", /Sending…/);

    await act(async () => { refuse(new Error("Jira said no")); });
    await settle();
    assert.deepEqual(sent, ["Looks good to me"], "sent once");
    const failed = detail.querySelector(".tt-comment-item.failed")!;
    assert.match(failed.textContent ?? "", /Not sent/);
    assert.match(detail.textContent ?? "", /Couldn’t add comment/);
    await act(async () => { button(failed as HTMLElement, "Edit and resend")!.click(); });
    assert.equal(field().value, "Looks good to me", "the text goes back to the field");
    assert.equal(detail.querySelector(".tt-comment-item.failed"), null);
    assert.deepEqual(sent, ["Looks good to me"], "not resent by itself");
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("a new column shows at once as pending and leaves, named in the error, when the tracker refuses", async () => {
  const run = harness();
  let refuse!: (error: Error) => void;
  let calls = 0;
  api.taskTrackerColumns = async () => ({
    columns: [
      { id: "todo", name: "To do", category: "todo", statusIds: ["todo"] },
      { id: "done", name: "Done", category: "done", statusIds: ["done"] },
    ],
    editable: true,
    removal: "archive",
  });
  api.taskTrackerCreateColumn = (() => {
    calls += 1;
    return new Promise((_resolve, reject) => { refuse = reject; });
  }) as typeof api.taskTrackerCreateColumn;
  const view = await mountBoard();
  const names = () => [...view.container.querySelectorAll(".tt-column > header strong")].map((item) => item.textContent);
  try {
    await act(async () => { button(view.container, "Add column")!.click(); });
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="New column name"]')!;
    await act(async () => { typeInto(input, "QA"); });
    await act(async () => {
      input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
    });
    await settle(1);
    assert.deepEqual(names(), ["To do", "Done", "QA"], "the column shows before the tracker answers");
    const pending = view.container.querySelector(".tt-column.pending")!;
    assert.ok(pending, "marked pending");
    assert.equal(pending.querySelector('[aria-label="QA column actions"]'), null, "no actions on a pending column");

    await act(async () => { refuse(new Error("Jira said no")); });
    await settle();
    assert.equal(calls, 1);
    assert.deepEqual(names(), ["To do", "Done"]);
    assert.match(view.container.textContent ?? "", /Couldn’t add the column “QA”/);
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("a board shown before paints from the cache at once while it refreshes, and an opened task shows what it last loaded", async () => {
  const run = harness();
  const withComments: TaskTrackerTaskDto = {
    ...task("1", "Fix mobile overflow"),
    comments: [{ id: "c-1", text: "Seen before", author: "Alice", createdAt: new Date().toISOString() }],
  };
  api.taskTrackerTask = async (_provider, id) => id === "1" ? withComments : task(id, `Task ${id}`);
  let view = await mountBoard();
  try {
    // Load the board and the task once.
    await act(async () => { view.container.querySelector<HTMLElement>('[aria-label^="Open POL-1:"]')!.click(); });
    await settle(3);
    assert.match(document.querySelector(".tt-detail")?.textContent ?? "", /Seen before/);
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.tt-detail button[aria-label="Close task details"]')!.click();
    });
    await view.unmount();

    // The tracker is slow now: nothing answers until released.
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = { tasks: api.taskTrackerTasks, task: api.taskTrackerTask };
    let taskReads = 0;
    api.taskTrackerTasks = async (...args) => { await gate; return original.tasks(...args); };
    api.taskTrackerTask = async (...args) => { taskReads++; await gate; return original.task(...args); };

    view = await mountBoard();
    assert.ok(view.container.querySelector('[aria-label^="Open POL-1:"]'), "cached tasks paint before the tracker answers");
    assert.doesNotMatch(view.container.textContent ?? "", /Loading tasks/);

    await act(async () => { view.container.querySelector<HTMLElement>('[aria-label^="Open POL-1:"]')!.click(); });
    await settle(2);
    assert.match(document.querySelector(".tt-detail")?.textContent ?? "", /Seen before/, "the cached detail shows at once");
    assert.match(document.querySelector(".tt-detail")?.textContent ?? "", /Refreshing/, "and says it is refreshing");
    assert.equal(taskReads, 1, "the task is still re-read");

    release();
    await settle(4);
    assert.doesNotMatch(document.querySelector(".tt-detail")?.textContent ?? "", /Refreshing/);
  } finally {
    await view.unmount();
    run.restore();
  }
});

test("board outcomes left no bespoke toast styles behind (the host notification stack draws them)", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../widgets/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /tt-board-toast/);
});
