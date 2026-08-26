import test from "node:test";
import assert from "node:assert/strict";
import {
  createJiraClient,
  createTaskTrackerService,
  createTrelloClient,
} from "@polyth/task-trackers";

const response = (body: unknown, status = 200): Response =>
  status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

test("provider discovery reports env names without exposing credential values", async () => {
  const service = createTaskTrackerService({
    env: {
      JIRA_BASE_URL: "https://acme.atlassian.net",
      JIRA_EMAIL: "dev@example.test",
      JIRA_API_TOKEN: "jira-secret-token",
      TRELLO_API_KEY: "trello-public-key",
      TRELLO_API_TOKEN: "trello-secret-token",
    },
    fetchImpl: (async () => response([])) as typeof fetch,
  });

  assert.deepEqual(service.providers(), [
    {
      provider: "jira",
      mode: "live",
      configured: true,
      requiredEnv: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
    },
    {
      provider: "trello",
      mode: "live",
      configured: true,
      requiredEnv: ["TRELLO_API_KEY", "TRELLO_API_TOKEN"],
    },
  ]);
  assert.doesNotMatch(JSON.stringify(service.providers()), /secret-token|public-key|dev@example/);

  const empty = createTaskTrackerService({ env: {} });
  assert.deepEqual(empty.providers().map(({ provider, mode, configured }) => ({
    provider,
    mode,
    configured,
  })), [
    { provider: "jira", mode: "demo", configured: false },
    { provider: "trello", mode: "demo", configured: false },
  ]);
  assert.doesNotMatch(JSON.stringify(empty.providers()), /secret-token|public-key|dev@example/);
});

test("credential-free demo mode exposes mutable sample kanban data without external requests", async () => {
  let fetchCalls = 0;
  const service = createTaskTrackerService({
    env: {},
    fetchImpl: (async () => {
      fetchCalls++;
      throw new Error("demo mode must not use the network");
    }) as typeof fetch,
  });

  for (const provider of ["jira", "trello"] as const) {
    const projects = await service.listProjects(provider);
    assert.equal(projects.length, 1);
    const boards = await service.listBoards(provider, projects[0]?.id);
    assert.equal(boards.length, 1);
    assert.equal(boards[0]?.type, "kanban");

    const tasks = await service.listTasks(provider, { boardId: boards[0]?.id, limit: 100 });
    assert.ok(tasks.length >= 4, `${provider} demo has a populated board`);
    assert.deepEqual(
      [...new Set(tasks.map((task) => task.status.category))].sort(),
      ["done", "in_progress", "todo"],
    );
    const todo = tasks.find((task) => task.status.category === "todo");
    assert.ok(todo);
    assert.equal(todo.availableStatuses?.length, 3);

    const updated = await service.updateStatus(provider, todo.id, "demo-done");
    assert.equal(updated.status.category, "done");
    assert.equal((await service.getTask(provider, todo.id)).status.category, "done");
  }
  assert.equal(fetchCalls, 0);

  const fresh = createTaskTrackerService({ env: {} });
  const freshTasks = await fresh.listTasks("jira", { boardId: "demo-jira-board" });
  assert.ok(freshTasks.some((task) => task.status.category === "todo"), "demo state resets with the service");
});

test("Jira client normalizes projects, kanban tasks, details, and transitions", async () => {
  const calls: Array<{ url: URL; method: string; auth: string; body?: unknown }> = [];
  const issue = {
    id: "10001",
    key: "POL-7",
    fields: {
      summary: "Fix mobile overflow",
      description: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Keep cards in viewport." }] }],
      },
      status: { id: "2", name: "In Progress", statusCategory: { key: "indeterminate" } },
      labels: ["mobile", "bug"],
      assignee: { displayName: "Ada" },
      duedate: "2026-09-01",
      updated: "2026-08-26T12:00:00Z",
      project: { id: "10", key: "POL" },
    },
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      auth: new Headers(init?.headers).get("authorization") ?? "",
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (url.pathname === "/rest/api/3/project/search") {
      return response({ values: [{ id: "10", key: "POL", name: "Polyth" }] });
    }
    if (url.pathname === "/rest/agile/1.0/board") {
      return response({
        values: [{ id: 8, name: "Delivery", type: "kanban", location: { projectId: 10, projectKey: "POL" } }],
      });
    }
    if (url.pathname === "/rest/agile/1.0/board/8/issue") {
      return response({ issues: [issue] });
    }
    if (url.pathname === "/rest/api/3/issue/POL-7/transitions" && method === "GET") {
      return response({
        transitions: [
          { id: "31", name: "Done", to: { id: "3", name: "Done", statusCategory: { key: "done" } } },
        ],
      });
    }
    if (url.pathname === "/rest/api/3/issue/POL-7/transitions" && method === "POST") {
      return response(undefined, 204);
    }
    if (url.pathname === "/rest/api/3/issue/POL-7") return response(issue);
    throw new Error(`unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
  const jira = createJiraClient({
    baseUrl: "https://acme.atlassian.net",
    email: "dev@example.test",
    apiToken: "token-value",
    fetchImpl,
  });

  const projects = await jira.listProjects();
  assert.equal(projects[0]?.key, "POL");
  assert.equal(projects[0]?.url, "https://acme.atlassian.net/browse/POL");

  const boards = await jira.listBoards("POL");
  assert.equal(boards[0]?.type, "kanban");
  assert.equal(boards[0]?.projectKey, "POL");

  const tasks = await jira.listTasks({ boardId: "8", limit: 25 });
  assert.equal(tasks[0]?.title, "Fix mobile overflow");
  assert.equal(tasks[0]?.description, "Keep cards in viewport.");
  assert.equal(tasks[0]?.status.category, "in_progress");
  assert.deepEqual(tasks[0]?.assignees, ["Ada"]);

  const detail = await jira.getTask("POL-7");
  assert.equal(detail.availableStatuses?.[0]?.id, "31");
  assert.equal(detail.availableStatuses?.[0]?.category, "done");

  await jira.updateStatus("POL-7", "31");
  const transition = calls.find((call) =>
    call.url.pathname.endsWith("/transitions") && call.method === "POST");
  assert.deepEqual(transition?.body, { transition: { id: "31" } });
  assert.ok(calls.every((call) => call.auth.startsWith("Basic ")));
  assert.equal(calls.find((call) => call.url.pathname.endsWith("/board"))?.url.searchParams.get("projectKeyOrId"), "POL");
});

test("Trello client normalizes workspaces, boards, cards, and list moves", async () => {
  const calls: Array<{ url: URL; method: string }> = [];
  const card = {
    id: "card-1",
    name: "Polish touch targets",
    desc: "Minimum 44px controls.",
    url: "https://trello.com/c/card-1",
    idBoard: "board-1",
    idList: "doing",
    labels: [{ name: "mobile" }],
    members: [{ fullName: "Grace" }],
    dateLastActivity: "2026-08-26T12:00:00Z",
  };
  const lists = [
    { id: "todo", name: "Backlog", closed: false },
    { id: "doing", name: "In Progress", closed: false },
    { id: "done", name: "Done", closed: false },
  ];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    assert.equal(url.searchParams.get("key"), "key-value");
    assert.equal(url.searchParams.get("token"), "token-value");
    if (url.pathname === "/1/members/me/organizations") {
      return response([{ id: "org-1", name: "acme", displayName: "Acme", url: "https://trello.com/acme" }]);
    }
    if (url.pathname === "/1/members/me/boards") {
      return response([
        { id: "board-1", name: "Mobile", url: "https://trello.com/b/1", idOrganization: "org-1" },
        { id: "board-2", name: "Other", idOrganization: "org-2" },
      ]);
    }
    if (url.pathname === "/1/boards/board-1/lists") return response(lists);
    if (url.pathname === "/1/boards/board-1/cards") return response([card]);
    if (url.pathname === "/1/cards/card-1" && method === "PUT") return response({ ...card, idList: "done" });
    if (url.pathname === "/1/cards/card-1") return response(card);
    throw new Error(`unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
  const trello = createTrelloClient({
    apiKey: "key-value",
    apiToken: "token-value",
    fetchImpl,
  });

  assert.equal((await trello.listProjects())[0]?.name, "Acme");
  const boards = await trello.listBoards("org-1");
  assert.deepEqual(boards.map((board) => board.id), ["board-1"]);
  assert.equal(boards[0]?.type, "kanban");

  const tasks = await trello.listTasks({ boardId: "board-1" });
  assert.equal(tasks[0]?.status.name, "In Progress");
  assert.equal(tasks[0]?.status.category, "in_progress");
  assert.equal(tasks[0]?.availableStatuses?.at(-1)?.category, "done");
  assert.deepEqual(tasks[0]?.assignees, ["Grace"]);

  await trello.updateStatus("card-1", "done");
  const move = calls.find((call) => call.url.pathname === "/1/cards/card-1" && call.method === "PUT");
  assert.equal(move?.url.searchParams.get("idList"), "done");
});

test("clients reject insecure Jira origins and redact transport failures", async () => {
  assert.throws(
    () => createJiraClient({
      baseUrl: "http://jira.example.test",
      email: "dev@example.test",
      apiToken: "super-secret",
    }),
    /HTTPS/,
  );

  const trello = createTrelloClient({
    apiKey: "key",
    apiToken: "super-secret",
    fetchImpl: (async () => {
      throw new Error("request with super-secret failed");
    }) as typeof fetch,
  });
  await assert.rejects(
    () => trello.listBoards(),
    (cause: Error) => cause.message === "Trello is unreachable" && !cause.message.includes("super-secret"),
  );
});
