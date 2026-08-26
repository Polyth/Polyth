import test from "node:test";
import assert from "node:assert/strict";
import type {
  JsonObject,
  RouteRequest,
  SessionEvent,
  SessionProjection,
  TaskTrackerService,
  TaskTrackerTaskDto,
  UserTurnInput,
} from "@polyth/contracts";
import {
  buildTaskWorkPrompt,
  reduceTaskLifecycle,
} from "@polyth/task-trackers";
import { taskTrackerRoutes } from "../src/serverEntry.ts";

const workingTask = (): TaskTrackerTaskDto => ({
  provider: "jira",
  id: "10001",
  key: "POL-7",
  title: "Fix mobile overflow",
  description: "Cards must stay inside the viewport.",
  url: "https://acme.atlassian.net/browse/POL-7",
  projectId: "10",
  projectKey: "POL",
  status: { id: "2", name: "In Progress", category: "in_progress" },
  availableStatuses: [{ id: "31", name: "Done", category: "done" }],
  labels: ["mobile"],
  assignees: ["Ada"],
});

const doneTask = (): TaskTrackerTaskDto => ({
  ...workingTask(),
  status: { id: "3", name: "Done", category: "done" },
});

interface HarnessCall {
  kind: "snapshot" | "service" | "append" | "send" | "json";
  action?: string;
  sessionId?: string;
  type?: string;
  data?: JsonObject;
  input?: UserTurnInput;
}

function harness() {
  const calls: HarnessCall[] = [];
  const storedEvents: SessionEvent[] = [];
  let seq = 0;
  const service: TaskTrackerService = {
    providers: () => [
      { provider: "jira", configured: true, requiredEnv: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"] },
      { provider: "trello", configured: false, requiredEnv: ["TRELLO_API_KEY", "TRELLO_API_TOKEN"] },
    ],
    listProjects: async (provider) => {
      calls.push({ kind: "service", action: `projects:${provider}` });
      return [{ provider, id: "p", key: "POL", name: "Polyth" }];
    },
    listBoards: async (provider, projectId) => {
      calls.push({ kind: "service", action: `boards:${provider}:${projectId ?? ""}` });
      return [{ provider, id: "b", name: "Delivery", type: "kanban" }];
    },
    listTasks: async (provider, query) => {
      calls.push({ kind: "service", action: `tasks:${provider}:${query.boardId ?? ""}` });
      return [{ ...workingTask(), provider }];
    },
    getTask: async (provider, taskId) => {
      calls.push({ kind: "service", action: `get:${provider}:${taskId}` });
      return { ...workingTask(), provider };
    },
    updateStatus: async (provider, taskId, statusId) => {
      calls.push({ kind: "service", action: `update:${provider}:${taskId}:${statusId}` });
      return { ...doneTask(), provider };
    },
  };
  const routes = taskTrackerRoutes({
    trackers: service,
    snapshot: async (sessionId): Promise<SessionProjection> => {
      calls.push({ kind: "snapshot", sessionId });
      if (sessionId === "missing") throw new Error("not found");
      return {
        id: sessionId,
        projectId: "local-project",
        title: "Session",
        status: "idle",
        createdAt: 1,
        updatedAt: 1,
      };
    },
    events: async () => [...storedEvents],
    append: async (sessionId, type, data) => {
      calls.push({ kind: "append", sessionId, type, data });
      const event: SessionEvent = {
        id: `e${++seq}`,
        sessionId,
        seq,
        time: 1000 + seq,
        type,
        data,
        ignorable: true,
        producerPlugin: "task-trackers",
        v: 1,
      };
      storedEvents.push(event);
      return event;
    },
    send: async (sessionId, input) => {
      calls.push({ kind: "send", sessionId, input });
      return { turnId: "turn-1" };
    },
  });

  const call = async (
    method: string,
    pathAndQuery: string,
    requestBody: Record<string, unknown> = {},
  ) => {
    const url = new URL(`http://polyth.test${pathAndQuery}`);
    let status = 0;
    let payload: unknown;
    const handled = await routes({
      req: {},
      res: {},
      url,
      path: url.pathname,
      method,
      body: async () => requestBody,
      json: (code, value) => {
        calls.push({ kind: "json" });
        status = code;
        payload = value;
      },
    } as unknown as RouteRequest);
    return { handled, status, payload };
  };
  return { call, calls, storedEvents };
}

test("read routes expose providers, projects, boards, tasks, and details", async () => {
  const h = harness();
  const providers = await h.call("GET", "/api/task-trackers/providers");
  assert.equal(providers.status, 200);
  assert.doesNotMatch(JSON.stringify(providers.payload), /token-value|secret/);

  assert.equal((await h.call("GET", "/api/task-trackers/projects?provider=jira")).status, 200);
  assert.equal((await h.call("GET", "/api/task-trackers/boards?provider=trello&projectId=org-1")).status, 200);
  assert.equal((await h.call("GET", "/api/task-trackers/tasks?provider=jira&boardId=b&limit=20")).status, 200);
  const detail = await h.call("GET", "/api/task-trackers/jira/tasks/POL-7");
  assert.equal((detail.payload as TaskTrackerTaskDto).key, "POL-7");
  assert.deepEqual(
    h.calls.filter((call) => call.kind === "service").map((call) => call.action),
    ["projects:jira", "boards:trello:org-1", "tasks:jira:b", "get:jira:POL-7"],
  );

  await assert.rejects(
    () => h.call("GET", "/api/task-trackers/projects?provider=linear"),
    (cause: Error & { code?: string; field?: string }) =>
      cause.code === "invalid-input" && cause.field === "provider",
  );
});

test("link persists task/selected before starting agent work and responding", async () => {
  const h = harness();
  const result = await h.call(
    "POST",
    "/api/task-trackers/jira/tasks/POL-7/link",
    {
      sessionId: "s1",
      instructions: "Preserve horizontal swipe gestures.",
    },
  );

  assert.equal(result.status, 200);
  assert.deepEqual(h.calls.map((call) => call.kind), [
    "snapshot",
    "service",
    "append",
    "send",
    "json",
  ]);
  assert.equal(h.calls[2]?.type, "task/selected");
  assert.equal(h.calls[2]?.data?.taskKey, "POL-7");
  assert.equal(h.calls[3]?.sessionId, "s1");
  assert.match(h.calls[3]?.input?.text ?? "", /Cards must stay inside the viewport/);
  assert.match(h.calls[3]?.input?.text ?? "", /Preserve horizontal swipe gestures/);
  assert.equal(h.storedEvents[0]?.type, "task/selected");
});

test("link can select without starting a turn and rejects missing sessions first", async () => {
  const h = harness();
  const selected = await h.call(
    "POST",
    "/api/task-trackers/jira/tasks/POL-7/link",
    { sessionId: "s1", startAgent: false },
  );
  assert.equal(selected.status, 200);
  assert.equal(h.calls.some((call) => call.kind === "send"), false);
  assert.equal(h.storedEvents[0]?.type, "task/selected");

  const missing = harness();
  await assert.rejects(
    () => missing.call(
      "POST",
      "/api/task-trackers/jira/tasks/POL-7/link",
      { sessionId: "missing" },
    ),
    (cause: Error & { code?: string }) => cause.code === "not-found",
  );
  assert.deepEqual(missing.calls.map((call) => call.kind), ["snapshot"]);
});

test("status update validates the session, writes externally, then logs change and completion", async () => {
  const h = harness();
  const result = await h.call(
    "PATCH",
    "/api/task-trackers/jira/tasks/POL-7",
    { sessionId: "s1", statusId: "31" },
  );

  assert.equal(result.status, 200);
  assert.deepEqual(h.calls.map((call) => call.kind), [
    "snapshot",
    "service",
    "service",
    "append",
    "append",
    "json",
  ]);
  assert.equal(h.calls[1]?.action, "get:jira:POL-7");
  assert.equal(h.calls[2]?.action, "update:jira:POL-7:31");
  assert.equal(h.calls[3]?.type, "task/status-changed");
  assert.equal(h.calls[3]?.data?.previousStatusName, "In Progress");
  assert.equal(h.calls[4]?.type, "task/completed");
  assert.deepEqual(h.storedEvents.map((event) => event.type), [
    "task/status-changed",
    "task/completed",
  ]);
});

test("task lifecycle reducer replays known events and ignores unknown events safely", () => {
  const events: SessionEvent[] = [
    {
      id: "e0", sessionId: "s1", seq: 1, time: 1,
      type: "future/unknown", data: { anything: true }, v: 1,
    },
    {
      id: "e1", sessionId: "s1", seq: 2, time: 2,
      type: "task/selected",
      data: {
        provider: "jira", taskId: "10001", taskKey: "POL-7",
        title: "Fix mobile overflow", statusId: "2", statusName: "In Progress",
      },
      v: 1,
    },
    {
      id: "e2", sessionId: "s1", seq: 3, time: 3,
      type: "task/status-changed",
      data: {
        provider: "jira", taskId: "10001", taskKey: "POL-7",
        title: "Fix mobile overflow", statusId: "3", statusName: "Done",
        previousStatusId: "2", previousStatusName: "In Progress",
      },
      v: 1,
    },
    {
      id: "e3", sessionId: "s1", seq: 4, time: 4,
      type: "task/completed",
      data: {
        provider: "jira", taskId: "10001", taskKey: "POL-7",
        title: "Fix mobile overflow", statusId: "3", statusName: "Done",
      },
      v: 1,
    },
  ];
  assert.deepEqual(reduceTaskLifecycle(events), [{
    provider: "jira",
    taskId: "10001",
    taskKey: "POL-7",
    title: "Fix mobile overflow",
    statusId: "3",
    statusName: "Done",
    completed: true,
    selectedAtSeq: 2,
    updatedAtSeq: 4,
  }]);
});

test("agent work prompt preserves tracker context and merge/status safety", () => {
  const prompt = buildTaskWorkPrompt(workingTask(), "Use the existing CSS tokens.");
  assert.match(prompt, /Jira issue POL-7/);
  assert.match(prompt, /Use the existing CSS tokens/);
  assert.match(prompt, /Run the relevant tests, commit the result/);
  assert.match(prompt, /Do not merge or change the external task status/);
});
