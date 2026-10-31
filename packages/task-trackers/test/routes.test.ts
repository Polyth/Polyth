import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  JsonObject,
  RouteRequest,
  SessionEvent,
  SessionProjection,
  SpaceContext,
  SpaceRole,
  SpaceStorage,
  TaskTrackerService,
  TaskTrackerTaskDto,
  UserTurnInput,
} from "@polyth/contracts";
import {
  buildTaskWorkPrompt,
  reduceTaskLifecycle,
} from "@polyth/task-trackers";
import { createTaskTrackerManagement } from "../src/management.ts";
import { requestAccess, taskTrackerRoutes } from "../src/serverEntry.ts";
import type { TaskTrackerManagementDto } from "../src/types.ts";
import { fakePeople } from "./peopleHost.ts";

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
      { provider: "jira", mode: "live", configured: true, requiredEnv: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"] },
      { provider: "trello", mode: "demo", configured: false, requiredEnv: ["TRELLO_API_KEY", "TRELLO_API_TOKEN"] },
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
    createBoard: async (provider, input) => {
      calls.push({ kind: "service", action: `createBoard:${provider}:${JSON.stringify(input)}` });
      return { provider, id: "b2", name: input.name, type: input.type ?? "kanban", ...(input.projectId ? { projectId: input.projectId } : {}) };
    },
    listColumns: async (provider, boardId) => {
      calls.push({ kind: "service", action: `columns:${provider}:${boardId}` });
      return { columns: [{ id: "c1", name: "To do", category: "todo", statusIds: ["c1"] }], editable: true, removal: "archive" };
    },
    createColumn: async (provider, boardId, input) => {
      calls.push({ kind: "service", action: `createColumn:${provider}:${boardId}:${JSON.stringify(input)}` });
      return { id: "c2", name: input.name ?? "", category: "unknown", statusIds: ["c2"] };
    },
    updateColumn: async (provider, boardId, columnId, input) => {
      calls.push({ kind: "service", action: `updateColumn:${provider}:${boardId}:${columnId}:${JSON.stringify(input)}` });
      return { id: columnId, name: input.name ?? "To do", category: "todo", statusIds: [columnId] };
    },
    removeColumn: async (provider, boardId, columnId) => {
      calls.push({ kind: "service", action: `removeColumn:${provider}:${boardId}:${columnId}` });
    },
    moveTask: async (provider, taskId, boardId, columnId) => {
      calls.push({ kind: "service", action: `move:${provider}:${taskId}:${boardId}:${columnId}` });
      return { ...doneTask(), provider };
    },
    archiveTask: async (provider, taskId) => {
      calls.push({ kind: "service", action: `archive:${provider}:${taskId}` });
    },
    deleteTask: async (provider, taskId) => {
      calls.push({ kind: "service", action: `delete:${provider}:${taskId}` });
    },
    addComment: async (provider, taskId, text) => {
      calls.push({ kind: "service", action: `comment:${provider}:${taskId}:${text}` });
    },
    attachmentContent: async (provider, taskId, attachmentId, preview) => {
      calls.push({ kind: "service", action: `content:${provider}:${taskId}:${attachmentId}:${preview}` });
      return attachmentId === "svg"
        ? { name: "x.svg", mimeType: "image/svg+xml", bytes: new TextEncoder().encode("<svg/>") }
        : { name: "shot one.png", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) };
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
    role?: "viewer" | "member" | "admin",
  ) => {
    const url = new URL(`http://polyth.test${pathAndQuery}`);
    let status = 0;
    let payload: unknown;
    let headers: Record<string, string> = {};
    const handled = await routes({
      req: {},
      res: {
        writeHead: (code: number, value: Record<string, string>) => {
          status = code;
          headers = value;
        },
        end: (value: Buffer) => { payload = value; },
      },
      url,
      path: url.pathname,
      method,
      ...(role ? { space: { spaceId: "spc_test", userId: "u1", role } } : {}),
      body: async () => requestBody,
      json: (code: number, value: unknown) => {
        calls.push({ kind: "json" });
        status = code;
        payload = value;
      },
    } as unknown as RouteRequest);
    return { handled, status, payload, headers };
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
    () => h.call("GET", "/api/task-trackers/projects?provider=asana"),
    (cause: Error & { code?: string; field?: string }) =>
      cause.code === "invalid-input" && cause.field === "provider",
  );
});

test("board creation validates the name, forwards project and type, and needs a member", async () => {
  const h = harness();
  const created = await h.call("POST", "/api/task-trackers/jira/boards", { name: "  Delivery 2 ", projectId: "p", type: "scrum" });
  assert.equal(created.status, 200);
  assert.deepEqual(created.payload, { provider: "jira", id: "b2", name: "Delivery 2", type: "scrum", projectId: "p" });
  assert.deepEqual(
    h.calls.filter((call) => call.kind === "service").map((call) => call.action),
    ['createBoard:jira:{"name":"Delivery 2","projectId":"p","type":"scrum"}'],
  );

  const trello = await h.call("POST", "/api/task-trackers/trello/boards", { name: "Mine", type: "bogus" });
  assert.deepEqual(trello.payload, { provider: "trello", id: "b2", name: "Mine", type: "kanban" }, "unknown types and empty projects are dropped");

  await assert.rejects(
    () => h.call("POST", "/api/task-trackers/jira/boards", { name: "   " }),
    (cause: Error & { code?: string; field?: string }) => cause.code === "invalid-input" && cause.field === "name",
  );
  await assert.rejects(
    () => h.call("POST", "/api/task-trackers/jira/boards", { name: "Nope" }, "viewer"),
    (cause: Error & { code?: string }) => cause.code === "forbidden",
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

test("status update from the board needs no session and logs nothing", async () => {
  const h = harness();
  const result = await h.call("PATCH", "/api/task-trackers/jira/tasks/POL-7", { statusId: "31" }, "member");
  assert.equal(result.status, 200);
  assert.deepEqual(h.calls.map((call) => call.action ?? call.kind), ["get:jira:POL-7", "update:jira:POL-7:31", "json"]);
  assert.equal(h.storedEvents.length, 0);
});

test("column routes list for readers and change columns only for members", async () => {
  const h = harness();
  const listed = await h.call("GET", "/api/task-trackers/trello/boards/b1/columns", {}, "viewer");
  assert.equal(listed.status, 200);
  assert.equal((listed.payload as { editable: boolean }).editable, true);

  await h.call("POST", "/api/task-trackers/trello/boards/b1/columns", { name: "  Review ", position: 1 }, "member");
  await h.call("PATCH", "/api/task-trackers/trello/boards/b1/columns/c1", { position: 0 }, "member");
  const removed = await h.call("DELETE", "/api/task-trackers/trello/boards/b1/columns/c1", {}, "member");
  assert.deepEqual(removed.payload, { ok: true });
  assert.deepEqual(h.calls.filter((call) => call.kind === "service").map((call) => call.action), [
    "columns:trello:b1",
    'createColumn:trello:b1:{"name":"Review","position":1}',
    'updateColumn:trello:b1:c1:{"position":0}',
    "removeColumn:trello:b1:c1",
  ]);

  for (const [method, path, body] of [
    ["POST", "/api/task-trackers/trello/boards/b1/columns", { name: "X" }],
    ["PATCH", "/api/task-trackers/trello/boards/b1/columns/c1", { name: "X" }],
    ["DELETE", "/api/task-trackers/trello/boards/b1/columns/c1", {}],
  ] as const) {
    await assert.rejects(() => h.call(method, path, body, "viewer"), (cause: Error & { code?: string }) => cause.code === "forbidden");
  }
  await assert.rejects(
    () => h.call("POST", "/api/task-trackers/trello/boards/b1/columns", { name: "  " }, "member"),
    (cause: Error & { field?: string }) => cause.field === "name",
  );
  await assert.rejects(
    () => h.call("PATCH", "/api/task-trackers/trello/boards/b1/columns/c1", { position: -1 }, "member"),
    (cause: Error & { field?: string }) => cause.field === "position",
  );
});

test("moving a task needs no session; a linked session records the change", async () => {
  const h = harness();
  const plain = await h.call("POST", "/api/task-trackers/jira/tasks/POL-7/move", { boardId: "b1", columnId: "Done" }, "member");
  assert.equal(plain.status, 200);
  assert.deepEqual(h.calls.map((call) => call.action ?? call.kind), ["move:jira:POL-7:b1:Done", "json"]);

  const linked = harness();
  await linked.call("POST", "/api/task-trackers/jira/tasks/POL-7/move", { boardId: "b1", columnId: "Done", sessionId: "s1" }, "member");
  assert.deepEqual(linked.storedEvents.map((event) => event.type), ["task/status-changed", "task/completed"]);
  await assert.rejects(
    () => linked.call("POST", "/api/task-trackers/jira/tasks/POL-7/move", { boardId: "b1", columnId: "Done", sessionId: "missing" }, "member"),
    /session not found/,
  );
  await assert.rejects(
    () => h.call("POST", "/api/task-trackers/jira/tasks/POL-7/move", { boardId: "b1", columnId: "Done" }, "viewer"),
    (cause: Error & { code?: string }) => cause.code === "forbidden",
  );
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

test("task archive and delete routes are member-only", async () => {
  const h = harness();
  const archived = await h.call("POST", "/api/task-trackers/trello/tasks/c1/archive", {}, "member");
  assert.deepEqual(archived.payload, { ok: true });
  const deleted = await h.call("DELETE", "/api/task-trackers/jira/tasks/POL-7", {}, "member");
  assert.deepEqual(deleted.payload, { ok: true });
  assert.deepEqual(h.calls.filter((call) => call.kind === "service").map((call) => call.action), [
    "archive:trello:c1",
    "delete:jira:POL-7",
  ]);
  for (const [method, path] of [
    ["POST", "/api/task-trackers/trello/tasks/c1/archive"],
    ["DELETE", "/api/task-trackers/jira/tasks/POL-7"],
  ] as const) {
    await assert.rejects(() => h.call(method, path, {}, "viewer"), (cause: Error & { code?: string }) => cause.code === "forbidden");
  }
});

test("attachment content streams tracker files without letting them run", async () => {
  const h = harness();
  const image = await h.call("GET", "/api/task-trackers/trello/tasks/card-1/attachments/att-1/content?preview=1", {}, "viewer");
  assert.equal(image.status, 200);
  assert.deepEqual([...(image.payload as Buffer)], [1, 2, 3]);
  assert.equal(image.headers["content-type"], "image/png");
  assert.equal(image.headers["content-disposition"], "inline; filename*=UTF-8''shot%20one.png");
  assert.match(image.headers["content-security-policy"] ?? "", /sandbox/);
  assert.equal(image.headers["x-content-type-options"], "nosniff");

  const svg = await h.call("GET", "/api/task-trackers/jira/tasks/POL-7/attachments/svg/content");
  assert.equal(svg.headers["content-type"], "application/octet-stream", "scriptable formats download");
  assert.match(svg.headers["content-disposition"] ?? "", /^attachment;/);
  assert.deepEqual(h.calls.filter((call) => call.kind === "service").map((call) => call.action), [
    "content:trello:card-1:att-1:true",
    "content:jira:POL-7:svg:false",
  ]);
});

test("comment route posts for members and answers with the refreshed task", async () => {
  const h = harness();
  const posted = await h.call("POST", "/api/task-trackers/jira/tasks/POL-7/comments", { text: "  Looks good  " }, "member");
  assert.equal(posted.status, 200);
  assert.equal((posted.payload as { ok: boolean; task?: TaskTrackerTaskDto }).task?.key, "POL-7");
  assert.deepEqual(h.calls.filter((call) => call.kind === "service").map((call) => call.action), [
    "comment:jira:POL-7:Looks good",
    "get:jira:POL-7",
  ]);
  await assert.rejects(() => h.call("POST", "/api/task-trackers/jira/tasks/POL-7/comments", { text: " " }, "member"),
    (cause: Error & { code?: string }) => cause.code === "invalid-input");
  await assert.rejects(() => h.call("POST", "/api/task-trackers/jira/tasks/POL-7/comments", { text: "hi" }, "viewer"),
    (cause: Error & { code?: string }) => cause.code === "forbidden");
});

test("personal enablement and the Space account policy have their own routes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tt-routes-people-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const people = fakePeople(root, { spc_a: ["u-ada", "u-admin", "u-other"], spc_b: ["u-ada"] });
  const storageOf = (spaceId: string): SpaceStorage => {
    const dir = join(root, "spaces", spaceId);
    return { root: dir, packageDir: (id) => join(dir, "packages", id), path: (relative) => join(dir, relative) };
  };
  const management = createTaskTrackerManagement({
    storage: (space) => storageOf(space.spaceId),
    vault: () => undefined,
    people: () => people,
    env: {},
    fetchImpl: (async () => new Response(JSON.stringify({ fullName: "Ada T", username: "ada" }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });
  const routes = taskTrackerRoutes({
    trackers: (request) => management.trackers(request.space),
    management,
    snapshot: async () => { throw new Error("unused"); },
    events: async () => [],
    append: async () => { throw new Error("unused"); },
    send: async () => undefined,
  });
  const call = async (
    method: string,
    path: string,
    body: Record<string, unknown> = {},
    who: { userId?: string; role?: SpaceRole; spaceId?: string } = {},
  ) => {
    const url = new URL(`http://polyth.test${path}`);
    const spaceId = who.spaceId ?? "spc_a";
    let payload: unknown;
    try {
      await routes({
        url, path: url.pathname, method,
        space: { spaceId, spaceSlug: spaceId, userId: who.userId ?? "u-ada", role: who.role ?? "member", deployment: "local-trusted", storageDir: storageOf(spaceId).root } as SpaceContext,
        principal: { kind: "ui-session" },
        body: async () => body,
        json: (_code: number, value: unknown) => { payload = value; },
      } as unknown as RouteRequest);
    } catch (error) {
      return { payload: undefined, error: error as Error & { code?: string } };
    }
    return { payload: payload as TaskTrackerManagementDto, error: null };
  };

  // Connecting needs no Space Credential Vault: the account lives with the person.
  const connected = await call("POST", "/api/task-trackers/connections/trello?scope=personal", { apiKey: "abc123", token: "t".repeat(64) });
  assert.equal(connected.error, null);
  const id = connected.payload!.personalConnections?.[0]?.id ?? "";
  assert.match(id, /^trello-/);

  const off = await call("PUT", `/api/task-trackers/personal-connections/${id}/enabled`, { enabled: false });
  assert.equal(off.payload?.personalConnections?.[0]?.enabled, false);
  const inB = await call("PUT", `/api/task-trackers/personal-connections/${id}/enabled`, { enabled: true }, { spaceId: "spc_b" });
  assert.equal(inB.payload?.personalConnections?.[0]?.enabled, true);
  assert.deepEqual(people.enabled("u-ada", "spc_a", "task-trackers"), [], "turning it on in B leaves A off");
  assert.equal((await call("PUT", `/api/task-trackers/personal-connections/${id}/enabled`, { enabled: "yes" })).error?.code, "invalid-input");
  assert.equal((await call("PUT", `/api/task-trackers/personal-connections/${id}/enabled`, { enabled: true }, { userId: "u-other" })).error?.code,
    "not-found", "another member's connection id is refused without revealing it");
  assert.equal((await call("DELETE", `/api/task-trackers/connections/trello?scope=personal&id=${id}`, {}, { userId: "u-other" })).error?.code,
    "not-found");
  assert.equal((await call("PUT", `/api/task-trackers/personal-connections/${id}/enabled`, { enabled: true }, { role: "viewer" })).error?.code,
    "forbidden");

  assert.equal((await call("GET", "/api/task-trackers/service-policy")).error?.code, "forbidden", "members can't read the policy");
  assert.equal((await call("PUT", "/api/task-trackers/service-policy", { agentsMayUseService: true })).error?.code, "forbidden");
  const admin = { userId: "u-admin", role: "admin" as SpaceRole };
  assert.deepEqual((await call("GET", "/api/task-trackers/service-policy", {}, admin)).payload, { agentsMayUseService: false });
  assert.equal((await call("PUT", "/api/task-trackers/service-policy", { agentsMayUseService: 1 }, admin)).error?.code, "invalid-input");
  const saved = await call("PUT", "/api/task-trackers/service-policy", { agentsMayUseService: true }, admin);
  assert.equal(saved.payload?.agentsMayUseService, true);
  assert.deepEqual(people.servicePolicy("spc_a", "task-trackers"), { agentsMayUseService: true });
  assert.deepEqual(people.servicePolicy("spc_b", "task-trackers"), { agentsMayUseService: false }, "per Space");
  assert.equal((await call("GET", "/api/task-trackers/settings")).payload?.agentsMayUseService, undefined);

  const removed = await call("DELETE", `/api/task-trackers/connections/trello?scope=personal&id=${id}`);
  assert.deepEqual(removed.payload?.personalConnections, []);
});

test("only the instance owner on local-trusted gets the installation account", () => {
  const request = (deployment: string, principal: string, instanceOwner?: boolean) => ({
    space: { deployment, ...(instanceOwner === undefined ? {} : { instanceOwner }) },
    principal: { kind: principal },
  }) as unknown as RouteRequest;
  assert.equal(requestAccess(request("local-trusted", "ui-session", true)).installationOwner, true);
  assert.equal(requestAccess(request("local-trusted", "local-user")).installationOwner, true, "pre-canonical single user");
  assert.equal(requestAccess(request("local-trusted", "ui-session", false)).installationOwner, false);
  assert.equal(requestAccess(request("local-trusted", "ui-session")).installationOwner, false);
  assert.equal(requestAccess(request("server-trusted", "ui-session", true)).installationOwner, false);
  assert.equal(requestAccess({ space: { deployment: "local-trusted" } } as unknown as RouteRequest).installationOwner, false);
});
