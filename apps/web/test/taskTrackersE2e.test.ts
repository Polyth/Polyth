import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type {
  JsonObject,
  RouteRequest,
  SessionEvent,
  SessionProjection,
  TaskTrackerProvider,
  TaskTrackerStatusDto,
} from "@polyth/contracts";
import { createTaskTrackerService, reduceTaskLifecycle } from "@polyth/task-trackers";
import { taskTrackerRoutes } from "../../../packages/task-trackers/src/serverEntry.ts";

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
const { TaskTrackerBoard } = await import("../src/widgets/taskTrackersPlugin.tsx");

const response = (body: unknown, status = 200): Response =>
  status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

const settle = async (turns = 3): Promise<void> => {
  for (let index = 0; index < turns; index++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const buttonByText = (container: Element, text: string): HTMLButtonElement => {
  const button = [...container.querySelectorAll("button")]
    .find((candidate) => candidate.textContent?.trim().includes(text));
  assert.ok(button, `button containing "${text}" exists`);
  return button as HTMLButtonElement;
};

const setControlValue = (
  control: HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  event: "input" | "change",
): void => {
  const prototype = control instanceof dom.HTMLTextAreaElement
    ? dom.HTMLTextAreaElement.prototype
    : dom.HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
  control.dispatchEvent(new Event(event, { bubbles: true }));
};

interface JourneyHarness {
  fetch: typeof fetch;
  events: SessionEvent[];
  operations: string[];
  providerWrites: string[];
  prompts: string[];
  expected: {
    taskId: string;
    taskKey: string;
    title: string;
    inProgressStatusId: string;
    doneStatusId: string;
  };
}

function journeyHarness(provider: TaskTrackerProvider): JourneyHarness {
  const operations: string[] = [];
  const providerWrites: string[] = [];
  const prompts: string[] = [];
  const events: SessionEvent[] = [];
  let seq = 0;
  let currentStatus = "todo";

  const trelloStatuses = [
    { id: "todo", name: "To do", category: "todo" },
    { id: "doing", name: "In Progress", category: "in_progress" },
    { id: "done", name: "Done", category: "done" },
  ] satisfies TaskTrackerStatusDto[];
  const trelloCard = () => ({
    id: "card-7",
    name: "Fix mobile overflow",
    desc: "Keep every control inside the mobile viewport.",
    url: "https://trello.com/c/card-7",
    idBoard: "delivery",
    idList: currentStatus,
    labels: [{ name: "mobile" }],
    members: [{ fullName: "Ada Lovelace" }],
  });

  const jiraStatus = () => currentStatus === "done"
    ? { id: "3", name: "Done", statusCategory: { key: "done" } }
    : currentStatus === "doing"
      ? { id: "2", name: "In Progress", statusCategory: { key: "indeterminate" } }
      : { id: "1", name: "To Do", statusCategory: { key: "new" } };
  const jiraIssue = () => ({
    id: "10007",
    key: "POL-7",
    fields: {
      summary: "Fix mobile overflow",
      description: {
        type: "doc",
        content: [{
          type: "paragraph",
          content: [{ type: "text", text: "Keep every control inside the mobile viewport." }],
        }],
      },
      status: jiraStatus(),
      labels: ["mobile"],
      assignee: { displayName: "Ada Lovelace" },
      project: { id: "polyth", key: "POL" },
    },
  });

  const providerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    operations.push(`provider:${method}:${url.pathname}`);

    if (provider === "trello") {
      assert.equal(url.searchParams.get("key"), "test-key");
      assert.equal(url.searchParams.get("token"), "test-token");
      if (url.pathname === "/1/members/me/organizations") {
        return response([{ id: "polyth", name: "polyth", displayName: "Polyth" }]);
      }
      if (url.pathname === "/1/members/me/boards") {
        return response([{
          id: "delivery",
          name: "Delivery",
          idOrganization: "polyth",
          url: "https://trello.com/b/delivery",
        }]);
      }
      if (url.pathname === "/1/boards/delivery/cards") return response([trelloCard()]);
      if (url.pathname === "/1/boards/delivery/lists") {
        return response(trelloStatuses.map((status) => ({
          id: status.id,
          name: status.name,
          closed: false,
        })));
      }
      if (url.pathname === "/1/cards/card-7" && method === "PUT") {
        currentStatus = url.searchParams.get("idList") ?? currentStatus;
        providerWrites.push(`trello:${currentStatus}`);
        return response(trelloCard());
      }
      if (url.pathname === "/1/cards/card-7") return response(trelloCard());
    } else {
      assert.match(new Headers(init?.headers).get("authorization") ?? "", /^Basic /);
      if (url.pathname === "/rest/api/3/project/search") {
        return response({ values: [{ id: "polyth", key: "POL", name: "Polyth" }] });
      }
      if (url.pathname === "/rest/agile/1.0/board") {
        return response({
          values: [{
            id: "delivery",
            name: "Delivery",
            type: "kanban",
            location: { projectId: "polyth", projectKey: "POL" },
          }],
        });
      }
      if (url.pathname === "/rest/agile/1.0/board/delivery/issue") {
        return response({ issues: [jiraIssue()] });
      }
      if (/^\/rest\/api\/3\/issue\/(?:10007|POL-7)$/.test(url.pathname)) {
        return response(jiraIssue());
      }
      if (/^\/rest\/api\/3\/issue\/(?:10007|POL-7)\/transitions$/.test(url.pathname)) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body)) as { transition: { id: string } };
          currentStatus = body.transition.id === "31" ? "done" : "doing";
          providerWrites.push(`jira:${body.transition.id}`);
          return response(undefined, 204);
        }
        return response({
          transitions: [
            {
              id: "21",
              name: "Start progress",
              to: { id: "2", name: "In Progress", statusCategory: { key: "indeterminate" } },
            },
            {
              id: "31",
              name: "Complete",
              to: { id: "3", name: "Done", statusCategory: { key: "done" } },
            },
          ],
        });
      }
    }
    throw new Error(`unexpected provider request: ${method} ${url}`);
  }) as typeof fetch;

  const trackers = createTaskTrackerService({
    env: provider === "trello"
      ? { TRELLO_API_KEY: "test-key", TRELLO_API_TOKEN: "test-token" }
      : {
          JIRA_BASE_URL: "https://acme.atlassian.net",
          JIRA_EMAIL: "dev@example.test",
          JIRA_API_TOKEN: "test-token",
        },
    fetchImpl: providerFetch,
  });

  const routes = taskTrackerRoutes({
    trackers,
    snapshot: async (sessionId): Promise<SessionProjection> => ({
      id: sessionId,
      projectId: "local-project",
      title: "Task tracker E2E",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    }),
    events: async () => [...events],
    append: async (sessionId, type, data) => {
      operations.push(`append:${type}`);
      const event: SessionEvent = {
        id: `event-${++seq}`,
        sessionId,
        seq,
        time: 1_000 + seq,
        type,
        data,
        ignorable: true,
        producerPlugin: "task-trackers",
        v: 1,
      };
      events.push(event);
      return event;
    },
    send: async (_sessionId, input) => {
      operations.push("agent:send");
      prompts.push(input.text);
      return { turnId: "turn-e2e" };
    },
  });

  const apiFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://polyth.test");
    let status = 404;
    let payload: unknown = { error: "not-found", message: "route not found" };
    try {
      const handled = await routes({
        req: {},
        res: {},
        url,
        path: url.pathname,
        method: init?.method ?? "GET",
        body: async () => init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
        json: (code, value) => {
          status = code;
          payload = value;
        },
      } as unknown as RouteRequest);
      if (!handled) status = 404;
    } catch (cause) {
      const error = cause as Error & { code?: string };
      status = error.code === "invalid-input" ? 400 : error.code === "not-found" ? 404 : 500;
      payload = { error: error.code ?? "internal", message: error.message };
    }
    return response(payload, status);
  }) as typeof fetch;

  return {
    fetch: apiFetch,
    events,
    operations,
    providerWrites,
    prompts,
    expected: provider === "trello"
      ? {
          taskId: "card-7",
          taskKey: "card-7",
          title: "Fix mobile overflow",
          inProgressStatusId: "doing",
          doneStatusId: "done",
        }
      : {
          taskId: "10007",
          taskKey: "POL-7",
          title: "Fix mobile overflow",
          inProgressStatusId: "21",
          doneStatusId: "31",
        },
  };
}

test("kanban journeys drive Jira and Trello through selection, agent handoff, status, and completion APIs", async (t) => {
  const originalFetch = globalThis.fetch;
  for (const provider of ["jira", "trello"] as const) {
    await t.test(provider, async () => {
      const harness = journeyHarness(provider);
      globalThis.fetch = harness.fetch;
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(createElement(TaskTrackerBoard, {
            sessionId: "session-e2e",
            config: {},
            updateConfig: () => {},
          }));
        });
        await settle(7);

        const board = container.querySelector('[aria-label="Delivery kanban board"]');
        assert.ok(board, `${provider} board renders in kanban mode`);
        const card = container.querySelector<HTMLButtonElement>(
          `[aria-label="Open ${harness.expected.taskKey}: ${harness.expected.title}"]`,
        );
        assert.ok(card, "task can be picked directly from its kanban column");
        await act(async () => { card.click(); });
        await settle(3);
        assert.match(container.querySelector(".tt-detail")?.textContent ?? "", /Hand off to the agent/);

        const instructions = container.querySelector<HTMLTextAreaElement>(".tt-detail textarea");
        assert.ok(instructions);
        await act(async () => {
          setControlValue(instructions, "Keep the regression covered.", "input");
          buttonByText(container, "Link & start agent").click();
        });
        await settle(4);

        assert.deepEqual(harness.events.map((event) => event.type), ["task/selected"]);
        assert.ok(
          harness.operations.indexOf("append:task/selected") < harness.operations.indexOf("agent:send"),
          "selection is durable before the agent turn starts",
        );
        assert.match(harness.prompts[0] ?? "", new RegExp(harness.expected.taskKey));
        assert.match(harness.prompts[0] ?? "", /Keep the regression covered/);
        assert.match(container.textContent ?? "", /Linked\. The agent is starting work/);

        const status = container.querySelector<HTMLSelectElement>(".tt-status-row select");
        assert.ok(status);
        await act(async () => {
          setControlValue(status, harness.expected.inProgressStatusId, "change");
        });
        await act(async () => { buttonByText(container, "Update status").click(); });
        await settle(5);
        assert.match(container.textContent ?? "", /Moved to In Progress/);
        assert.deepEqual(harness.events.map((event) => event.type), [
          "task/selected",
          "task/status-changed",
        ]);

        await act(async () => { buttonByText(container, "Mark complete").click(); });
        await settle(5);
        assert.match(container.textContent ?? "", /Task marked complete/);
        assert.deepEqual(harness.events.map((event) => event.type), [
          "task/selected",
          "task/status-changed",
          "task/status-changed",
          "task/completed",
        ]);

        const linked = await api.taskTrackerSessionTasks("session-e2e");
        assert.deepEqual(linked, reduceTaskLifecycle(harness.events));
        assert.deepEqual(linked, [{
          provider,
          taskId: harness.expected.taskId,
          taskKey: harness.expected.taskKey,
          title: harness.expected.title,
          statusId: provider === "jira" ? "3" : harness.expected.doneStatusId,
          statusName: "Done",
          completed: true,
          selectedAtSeq: 1,
          updatedAtSeq: 4,
        }]);
        assert.deepEqual(
          harness.providerWrites,
          provider === "jira" ? ["jira:21", "jira:31"] : ["trello:doing", "trello:done"],
        );
      } finally {
        await act(async () => { root.unmount(); });
        container.remove();
      }
    });
  }
  globalThis.fetch = originalFetch;
});
