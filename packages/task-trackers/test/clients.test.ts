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
      LINEAR_API_KEY: "lin_api_linearsecrettoken",
    },
    fetchImpl: (async () => response([])) as typeof fetch,
  });

  assert.deepEqual(service.providers(), [
    {
      provider: "jira",
      mode: "live",
      configured: true,
      requiredEnv: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
      enabled: true,
      source: "env",
    },
    {
      provider: "trello",
      mode: "live",
      configured: true,
      requiredEnv: ["TRELLO_API_KEY", "TRELLO_API_TOKEN"],
      enabled: true,
      source: "env",
    },
    {
      provider: "linear",
      mode: "live",
      configured: true,
      requiredEnv: ["LINEAR_API_KEY"],
      enabled: true,
      source: "env",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(service.providers()), /secret-token|public-key|dev@example|lin_api_/);

  const empty = createTaskTrackerService({ env: {} });
  assert.deepEqual(empty.providers().map(({ provider, mode, configured }) => ({
    provider,
    mode,
    configured,
  })), [
    { provider: "jira", mode: "demo", configured: false },
    { provider: "trello", mode: "demo", configured: false },
    { provider: "linear", mode: "demo", configured: false },
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

  for (const provider of ["jira", "trello", "linear"] as const) {
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
    // The Linear sandbox mirrors a new Linear team's six statuses.
    assert.equal(todo.availableStatuses?.length, provider === "linear" ? 6 : 3);

    const updated = await service.updateStatus(provider, todo.id, "demo-done");
    assert.equal(updated.status.category, "done");
    assert.equal((await service.getTask(provider, todo.id)).status.category, "done");

    const board = await service.createBoard!(provider, { name: "Q4 launch", projectId: projects[0]?.id, type: "scrum" });
    assert.equal(board.type, provider === "jira" ? "scrum" : "kanban");
    assert.deepEqual((await service.listBoards(provider)).map((item) => item.id), [boards[0]?.id, board.id]);
    assert.deepEqual(await service.listTasks(provider, { boardId: board.id }), [], "a new board starts empty");
    const filed = await service.createTask!(provider, { title: "Plan the launch", boardId: board.id });
    assert.equal(filed.boardId, board.id);
    assert.deepEqual((await service.listTasks(provider, { boardId: board.id })).map((task) => task.id), [filed.id]);
    assert.ok(!(await service.listTasks(provider, { boardId: boards[0]?.id })).some((task) => task.id === filed.id));
    await assert.rejects(
      () => service.createBoard!(provider, { name: "Elsewhere", projectId: "other-workspace" }),
      (cause: Error & { code?: string }) => cause.code === "not-found",
    );
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
    if (url.pathname === "/rest/agile/1.0/board" && method === "GET") {
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
    if (url.pathname === "/rest/api/3/project/10") return response({ id: "10", key: "POL" });
    if (url.pathname === "/rest/api/3/filter" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { name: string };
      // The first name is taken; Jira answers 400 and the client retries once.
      return body.name === "Delivery 2" ? response({ errorMessages: ["name exists"] }, 400) : response({ id: 500 });
    }
    if (url.pathname === "/rest/agile/1.0/board" && method === "POST") {
      return response({ id: 9, name: "Delivery 2", type: "scrum", location: { projectId: 10, projectKey: "POL" } });
    }
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

  const board = await jira.createBoard({ name: "Delivery 2", projectId: "10", type: "scrum" });
  assert.deepEqual(board, {
    provider: "jira",
    id: "9",
    name: "Delivery 2",
    type: "scrum",
    projectId: "10",
    projectKey: "POL",
    url: "https://acme.atlassian.net/secure/RapidBoard.jspa?rapidView=9",
  });
  const filters = calls.filter((call) => call.url.pathname === "/rest/api/3/filter");
  assert.equal(filters.length, 2, "a taken filter name is retried once with a suffix");
  assert.match((filters[1]?.body as { name: string }).name, /^Delivery 2 \(\w+\)$/);
  assert.equal((filters[0]?.body as { jql: string }).jql, 'project = "POL" ORDER BY Rank ASC');
  assert.deepEqual((filters[0]?.body as { sharePermissions: unknown }).sharePermissions, [{ type: "project", project: { id: "10" } }]);
  const created = calls.find((call) => call.url.pathname === "/rest/agile/1.0/board" && call.method === "POST");
  assert.deepEqual(created?.body, { name: "Delivery 2", type: "scrum", filterId: 500, location: { type: "project", projectKeyOrId: "10" } });
  await assert.rejects(
    () => jira.createBoard({ name: "No home" }),
    (cause: Error & { code?: string }) => cause.code === "invalid-input" && /Jira project/.test(cause.message),
  );
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
    if (url.pathname === "/1/boards" && method === "POST") {
      return response({
        id: "board-3",
        name: url.searchParams.get("name"),
        url: "https://trello.com/b/3",
        idOrganization: url.searchParams.get("idOrganization"),
      });
    }
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

  const board = await trello.createBoard({ name: "Roadmap", projectId: "org-1" });
  assert.deepEqual(board, {
    provider: "trello",
    id: "board-3",
    name: "Roadmap",
    type: "kanban",
    projectId: "org-1",
    url: "https://trello.com/b/3",
  });
  const create = calls.find((call) => call.url.pathname === "/1/boards" && call.method === "POST");
  assert.equal(create?.url.searchParams.get("defaultLists"), "true");
  assert.equal(create?.url.searchParams.get("idOrganization"), "org-1");
  const personal = await trello.createBoard({ name: "Mine" });
  assert.equal(personal.projectId, undefined, "no workspace makes a personal board");
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

test("clients upload validated images as multipart attachments", async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl = (async (url: URL, init: RequestInit = {}) => {
    calls.push({ url: new URL(url), init });
    return response([]);
  }) as typeof fetch;
  const png = { name: "C:\\shots\\bug.png", mimeType: "image/png", data: Buffer.from("png-bytes").toString("base64") };
  const jira = createJiraClient({ baseUrl: "https://acme.atlassian.net", email: "dev@example.test", apiToken: "t", fetchImpl });
  const trello = createTrelloClient({ apiKey: "k", apiToken: "t", fetchImpl });

  await jira.addAttachments("POL-9", [png]);
  await trello.addAttachments("card-1", [png]);

  const [jiraCall, trelloCall] = calls;
  assert.equal(jiraCall?.url.pathname, "/rest/api/3/issue/POL-9/attachments");
  assert.equal((jiraCall?.init.headers as Record<string, string>)["x-atlassian-token"], "no-check");
  assert.equal((jiraCall?.init.headers as Record<string, string>)["content-type"], undefined, "fetch sets the multipart boundary");
  assert.equal(trelloCall?.url.pathname, "/1/cards/card-1/attachments");
  assert.equal(trelloCall?.url.searchParams.get("name"), "bug.png");
  for (const call of calls) {
    const file = (call.init.body as FormData).get("file") as File;
    assert.equal(file.name, "bug.png", "path segments are stripped");
    assert.equal(file.type, "image/png");
    assert.equal(Buffer.from(await file.arrayBuffer()).toString(), "png-bytes");
  }

  for (const files of [
    [],
    [{ ...png, mimeType: "image/svg+xml" }],
    [{ ...png, data: "not base64!" }],
    Array.from({ length: 11 }, () => png),
  ]) {
    await assert.rejects(() => jira.addAttachments("POL-9", files), (cause: Error & { code?: string }) => cause.code === "invalid-input");
  }
  assert.equal(calls.length, 2, "invalid images never reach the tracker");
});

test("sandbox boards keep their own editable columns, empty ones included", async () => {
  const service = createTaskTrackerService({ env: {} });
  const board = "demo-trello-board";
  const before = await service.listColumns!("trello", board);
  assert.equal(before.editable, true);
  assert.equal(before.removal, "delete-empty");
  assert.deepEqual(before.columns.map((column) => column.name), ["To do", "In progress", "Done"]);

  const review = await service.createColumn!("trello", board, { name: "Review", position: 2 });
  assert.equal(review.category, "in_progress");
  assert.deepEqual(review.statusIds, [review.id]);
  const renamed = await service.updateColumn!("trello", board, review.id, { name: "Code review", position: 0 });
  assert.equal(renamed.name, "Code review");
  assert.deepEqual((await service.listColumns!("trello", board)).columns.map((column) => column.name),
    ["Code review", "To do", "In progress", "Done"]);

  const moved = await service.moveTask!("trello", "demo-trello-21", board, review.id);
  assert.equal(moved.status.name, "Code review");
  assert.ok(moved.availableStatuses?.some((status) => status.id === review.id));
  await assert.rejects(service.removeColumn!("trello", board, review.id), /Move this column’s tasks/);
  await service.moveTask!("trello", "demo-trello-21", board, "demo-todo");
  await service.removeColumn!("trello", board, review.id);
  assert.equal((await service.listColumns!("trello", board)).columns.length, 3);

  // A new board starts with its own columns.
  const other = await service.createBoard!("trello", { name: "Side project" });
  const otherColumns = await service.listColumns!("trello", other.id);
  await service.createColumn!("trello", other.id, { name: "Ideas" });
  assert.equal((await service.listColumns!("trello", board)).columns.length, 3);
  assert.equal((await service.listColumns!("trello", other.id)).columns.length, otherColumns.columns.length + 1);

  // The Jira sandbox mirrors Jira: columns follow the workflow.
  const jira = await service.listColumns!("jira", "demo-jira-board");
  assert.equal(jira.editable, false);
  await assert.rejects(service.createColumn!("jira", "demo-jira-board", { name: "QA" }), /edit them in Jira/);
  const jiraMoved = await service.moveTask!("jira", "POL-101", "demo-jira-board", "demo-done");
  assert.equal(jiraMoved.status.category, "done");
});

test("Trello lists are board columns: ordered, added, renamed, moved, archived", async () => {
  const calls: Array<{ method: string; path: string; body: string }> = [];
  const lists = [
    { id: "l-done", name: "Done", closed: false, pos: 300 },
    { id: "l-todo", name: "To Do", closed: false, pos: 100 },
    { id: "l-old", name: "Old", closed: true, pos: 50 },
    { id: "l-doing", name: "Doing", closed: false, pos: 200 },
  ];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, body: String(init?.body ?? "") });
    if (url.pathname === "/1/boards/b1/lists") return response(lists);
    if (url.pathname === "/1/lists" && method === "POST") {
      const body = new URLSearchParams(String(init?.body));
      return response({ id: "l-new", name: body.get("name"), pos: Number(body.get("pos")) });
    }
    if (url.pathname === "/1/lists/l-doing" && method === "PUT") return response({ id: "l-doing", name: "Doing now", pos: 50 });
    if (url.pathname === "/1/lists/l-done/closed" && method === "PUT") return response({ id: "l-done", closed: true });
    if (url.pathname === "/1/cards/c1" && method === "PUT") return response({ id: "c1" });
    if (url.pathname === "/1/cards/c1") return response({ id: "c1", name: "Card", idBoard: "b1", idList: "l-doing" });
    return response({}, 404);
  }) as typeof fetch;
  const trello = createTrelloClient({ apiKey: "k", apiToken: "t", fetchImpl });

  const board = await trello.listColumns!("b1");
  assert.equal(board.editable, true);
  assert.equal(board.removal, "archive");
  assert.deepEqual(board.columns.map((column) => [column.id, column.category]),
    [["l-todo", "todo"], ["l-doing", "in_progress"], ["l-done", "done"]]);

  const created = await trello.createColumn!("b1", { name: "Review", position: 2 });
  assert.equal(created.id, "l-new");
  const createBody = new URLSearchParams(calls.find((call) => call.path === "/1/lists")!.body);
  assert.equal(createBody.get("idBoard"), "b1");
  assert.equal(createBody.get("pos"), "250");

  const renamed = await trello.updateColumn!("b1", "l-doing", { name: "Doing now", position: 0 });
  assert.equal(renamed.name, "Doing now");
  const updateBody = new URLSearchParams(calls.find((call) => call.path === "/1/lists/l-doing")!.body);
  assert.equal(updateBody.get("name"), "Doing now");
  assert.equal(updateBody.get("pos"), "50");

  await trello.removeColumn!("b1", "l-done");
  assert.equal(new URLSearchParams(calls.find((call) => call.path === "/1/lists/l-done/closed")!.body).get("value"), "true");

  // Archived lists and lists of other boards are not columns of this board.
  await assert.rejects(trello.removeColumn!("b1", "l-old"), /not found/);
  await assert.rejects(trello.moveTask!("c1", "b1", "l-elsewhere"), /not found/);
  const moved = await trello.moveTask!("c1", "b1", "l-doing");
  assert.equal(moved.status.id, "l-doing");
});

test("Jira board columns come from the board configuration and moves use workflow transitions", async () => {
  const posted: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/agile/1.0/board/7/configuration") {
      return response({ columnConfig: { columns: [
        { name: "Backlog", statuses: [{ id: "1" }] },
        { name: "Doing", statuses: [{ id: "3" }, { id: "4" }] },
        { name: "Shipped", statuses: [{ id: "10" }] },
        { name: "Parking", statuses: [] },
      ] } });
    }
    if (url.pathname === "/rest/api/3/status") {
      return response([
        { id: "1", statusCategory: { key: "new" } },
        { id: "3", statusCategory: { key: "indeterminate" } },
        { id: "10", statusCategory: { key: "done" } },
      ]);
    }
    if (url.pathname === "/rest/api/3/issue/POL-1/transitions" && init?.method === "POST") {
      posted.push(String(init.body));
      return response(null, 204);
    }
    if (url.pathname === "/rest/api/3/issue/POL-1/transitions") {
      return response({ transitions: [
        { id: "21", name: "Start", to: { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } } },
      ] });
    }
    if (url.pathname === "/rest/api/3/issue/POL-1") {
      return response({ id: "100", key: "POL-1", fields: { summary: "Task", status: { id: "1", name: "Backlog" } } });
    }
    return response({}, 404);
  }) as typeof fetch;
  const jira = createJiraClient({ baseUrl: "https://acme.atlassian.net", email: "dev@example.test", apiToken: "t", fetchImpl });

  const board = await jira.listColumns!("7");
  assert.equal(board.editable, false);
  assert.match(board.manageUrl ?? "", /^https:\/\/acme\.atlassian\.net\/secure\/RapidView\.jspa\?rapidView=7&tab=columns$/);
  assert.deepEqual(board.columns.map((column) => [column.name, column.category, column.statusIds]), [
    ["Backlog", "todo", ["1"]],
    ["Doing", "in_progress", ["3", "4"]],
    ["Shipped", "done", ["10"]],
    ["Parking", "unknown", []],
  ]);

  await jira.moveTask!("POL-1", "7", "Doing");
  assert.deepEqual(posted.map((body) => JSON.parse(body)), [{ transition: { id: "21" } }]);
  await assert.rejects(jira.moveTask!("POL-1", "7", "Shipped"), /no transition from Backlog to Shipped/);
  await assert.rejects(jira.moveTask!("POL-1", "7", "Nope"), /column was not found/);
});

test("tasks archive and delete through each tracker's own API", async () => {
  const calls: Array<{ method: string; path: string; query: string; body: string }> = [];
  let archiveReply: unknown = { numberOfIssuesUpdated: 1 };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, query: url.searchParams.get("closed") ?? "", body: String(init?.body ?? "") });
    if (url.pathname === "/rest/api/3/issue/archive") return response(archiveReply);
    if (url.pathname === "/rest/api/3/issue/POL-1" && method === "DELETE") return response(null, 204);
    if (url.pathname === "/rest/api/3/issue/POL-2") return response({ errorMessages: ["No permission"] }, 403);
    if (url.pathname === "/1/cards/c1") return response({ id: "c1" });
    return response({}, 404);
  }) as typeof fetch;
  const jira = createJiraClient({ baseUrl: "https://acme.atlassian.net", email: "dev@example.test", apiToken: "t", fetchImpl });
  const trello = createTrelloClient({ apiKey: "k", apiToken: "t", fetchImpl });

  await jira.archiveTask!("POL-1");
  assert.deepEqual(JSON.parse(calls.at(-1)!.body), { issueIdsOrKeys: ["POL-1"] });
  archiveReply = { numberOfIssuesUpdated: 0, errors: { issueIsSubtask: { message: "Subtasks can't be archived" } } };
  await assert.rejects(jira.archiveTask!("POL-1"), /didn’t archive this issue: Subtasks can't be archived/);
  await jira.deleteTask!("POL-1");
  assert.deepEqual(calls.at(-1), { method: "DELETE", path: "/rest/api/3/issue/POL-1", query: "", body: "" });
  await assert.rejects(jira.deleteTask!("POL-2"), /can’t delete this issue \(403/);

  await trello.archiveTask!("c1");
  assert.deepEqual([calls.at(-1)!.method, calls.at(-1)!.path, calls.at(-1)!.query], ["PUT", "/1/cards/c1", "true"]);
  await trello.deleteTask!("c1");
  assert.deepEqual([calls.at(-1)!.method, calls.at(-1)!.path], ["DELETE", "/1/cards/c1"]);

  // The sandbox drops the task from its board either way.
  const service = createTaskTrackerService({ env: {} });
  const before = await service.listTasks("trello", { boardId: "demo-trello-board" });
  await service.archiveTask!("trello", before[0]!.id);
  await service.deleteTask!("trello", before[1]!.id);
  const after = await service.listTasks("trello", { boardId: "demo-trello-board" });
  assert.deepEqual(after.map((task) => task.id), before.slice(2).map((task) => task.id));
  await assert.rejects(service.deleteTask!("trello", before[0]!.id), /not found/);
});

test("tracker attachments load through Polyth with the connection's credentials", async () => {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const png = new Uint8Array([137, 80, 78, 71]);
  const binary = (type: string) => new Response(png, { status: 200, headers: { "content-type": type } });
  const trelloAttachment = {
    id: "att-1",
    name: "screen.png",
    mimeType: "",
    bytes: 4,
    isUpload: true,
    url: "https://trello.com/1/cards/card-1/attachments/att-1/download/screen.png",
    previews: [
      { url: "https://trello.com/1/cards/card-1/attachments/att-1/previews/p-small/download/screen.png", width: 150 },
      { url: "https://trello.com/1/cards/card-1/attachments/att-1/previews/p-mid/download/screen.png", width: 600 },
      { url: "https://trello.com/1/cards/card-1/attachments/att-1/previews/p-big/download/screen.png", width: 1200 },
    ],
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.pathname === "/1/cards/card-1") {
      return response({
        id: "card-1",
        name: "Card",
        idBoard: "board-1",
        idList: "todo",
        badges: { comments: 7 },
        idAttachmentCover: "att-1",
        attachments: [
          trelloAttachment,
          { id: "att-link", name: "Spec", isUpload: false, url: "https://example.test/spec", mimeType: "" },
        ],
        actions: [
          { id: "a-2", date: "2026-08-02T00:00:00Z", data: { text: "second" }, memberCreator: { fullName: "Ada" } },
          { id: "a-1", date: "2026-08-01T00:00:00Z", data: { text: "first" }, memberCreator: { fullName: "Ada" } },
        ],
      });
    }
    if (url.pathname === "/1/boards/board-1/lists") return response([{ id: "todo", name: "To do" }]);
    if (url.pathname === "/1/cards/card-1/attachments/att-1") return response(trelloAttachment);
    if (url.pathname === "/1/cards/card-1/attachments/att-evil") {
      return response({ ...trelloAttachment, id: "att-evil", url: "https://evil.example/steal.png", previews: [] });
    }
    if (url.hostname === "trello.com") return binary("image/png");
    if (url.pathname === "/rest/api/3/issue/POL-9") {
      return response({ id: "10009", key: "POL-9", fields: { attachment: [{ id: 55, filename: "diagram.png", mimeType: "image/png", thumbnail: "x" }] } });
    }
    if (url.pathname.startsWith("/rest/api/3/attachment/")) return binary("image/png");
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;

  const trello = createTrelloClient({ apiKey: "key-value", apiToken: "token-value", fetchImpl });
  const card = await trello.getTask("card-1");
  const [upload, link] = card.attachments ?? [];
  assert.equal(upload?.mimeType, "image/png", "the file name types an upload Trello left untyped");
  assert.equal(upload?.url, "/api/task-trackers/trello/tasks/card-1/attachments/att-1/content");
  assert.equal(upload?.thumbnailUrl, "/api/task-trackers/trello/tasks/card-1/attachments/att-1/content?preview=1");
  assert.equal(link?.url, "https://example.test/spec", "links open where they point");
  assert.equal(link?.thumbnailUrl, undefined);
  assert.equal(card.coverAttachmentId, "att-1", "the card's Trello cover leads it on the board");
  assert.deepEqual(card.comments?.map((comment) => comment.text), ["first", "second"], "oldest comment first");
  assert.equal(card.commentCount, 7);
  const detailCall = calls.find((call) => call.url.pathname === "/1/cards/card-1");
  assert.match(detailCall?.url.searchParams.get("fields") ?? "", /badges/);
  assert.match(detailCall?.url.searchParams.get("attachment_fields") ?? "", /isUpload/);

  const preview = await trello.attachmentContent!("card-1", "att-1", true);
  assert.deepEqual([...preview.bytes], [...png]);
  assert.equal(preview.mimeType, "image/png");
  const download = calls.at(-1)!;
  assert.match(download.url.pathname, /previews\/p-mid\//, "the smallest preview that fills a cover");
  assert.equal(download.url.search, "", "credentials stay out of file URLs");
  assert.equal(download.headers.authorization, 'OAuth oauth_consumer_key="key-value", oauth_token="token-value"');
  await trello.attachmentContent!("card-1", "att-1", false);
  assert.match(calls.at(-1)!.url.pathname, /att-1\/download\/screen\.png$/);

  const before = calls.length;
  await assert.rejects(trello.attachmentContent!("card-1", "att-evil", false), /unexpected attachment address/);
  assert.equal(calls.length, before + 1, "credentials never go to another host");

  const jira = createJiraClient({ baseUrl: "https://acme.atlassian.net", email: "dev@example.test", apiToken: "t", fetchImpl });
  const thumb = await jira.attachmentContent!("POL-9", "55", true);
  assert.equal(thumb.name, "diagram.png");
  assert.equal(calls.at(-1)!.url.pathname, "/rest/api/3/attachment/thumbnail/55");
  assert.match(calls.at(-1)!.headers.authorization ?? "", /^Basic /);
  await jira.attachmentContent!("POL-9", "55", false);
  assert.equal(calls.at(-1)!.url.pathname, "/rest/api/3/attachment/content/55");
  await assert.rejects(jira.attachmentContent!("POL-9", "99", false), (cause: Error & { code?: string }) => cause.code === "not-found");
});

test("Jira and Trello name assignees by account id with avatars, and name the connected account", async () => {
  const jiraCalls: string[] = [];
  const jira = createJiraClient({
    baseUrl: "https://acme.atlassian.net",
    email: "dev@example.test",
    apiToken: "token",
    fetchImpl: (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      jiraCalls.push(`${url.pathname}?${url.searchParams.get("fields") ?? ""}`);
      if (url.pathname === "/rest/api/3/myself") {
        return response({ accountId: "acc-ada", displayName: "Ada Lovelace", avatarUrls: { "48x48": "https://avatar.test/ada.png" } });
      }
      return response({
        issues: [{
          id: "1",
          key: "POL-1",
          fields: {
            summary: "One",
            status: { id: "1", name: "To Do", statusCategory: { key: "new" } },
            assignee: { accountId: "acc-ada", displayName: "Ada Lovelace", avatarUrls: { "48x48": "https://avatar.test/ada.png" } },
            priority: { name: "Highest" },
          },
        }, {
          id: "2",
          key: "POL-2",
          fields: { summary: "Two", status: { id: "1", name: "To Do", statusCategory: { key: "new" } }, assignee: null, priority: { name: "Lowest" } },
        }],
      });
    }) as typeof fetch,
  });
  const [first, second] = await jira.listTasks({ boardId: "7" });
  assert.deepEqual(first!.assigneePeople, [{ id: "acc-ada", name: "Ada Lovelace", avatarUrl: "https://avatar.test/ada.png" }]);
  assert.deepEqual(first!.priority, { level: "urgent", name: "Highest" });
  assert.deepEqual([second!.assignees, second!.assigneePeople, second!.priority], [[], undefined, { level: "low", name: "Lowest" }]);
  assert.match(jiraCalls[0]!, /assignee,priority/, "the board asks Jira for the priority field");
  assert.deepEqual(await jira.currentUser!(), { id: "acc-ada", name: "Ada Lovelace", avatarUrl: "https://avatar.test/ada.png" });

  const trelloQueries: URLSearchParams[] = [];
  const trello = createTrelloClient({
    apiKey: "key",
    apiToken: "token",
    fetchImpl: (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      trelloQueries.push(url.searchParams);
      if (url.pathname === "/1/members/me") return response({ id: "m-1", fullName: "Grace Hopper", avatarUrl: "https://trello-members.test/abc" });
      if (url.pathname.endsWith("/lists")) return response([{ id: "l1", name: "To do", pos: 1 }]);
      return response([{
        id: "c1",
        name: "Card",
        idList: "l1",
        members: [{ id: "m-1", fullName: "Grace Hopper", avatarUrl: "https://trello-members.test/abc" }, { id: "m-2", username: "kay" }],
      }]);
    }) as typeof fetch,
  });
  const [card] = await trello.listTasks({ boardId: "b1" });
  assert.deepEqual(card!.assignees, ["Grace Hopper", "kay"]);
  assert.deepEqual(card!.assigneePeople, [
    { id: "m-1", name: "Grace Hopper", avatarUrl: "https://trello-members.test/abc/50.png" },
    { id: "m-2", name: "kay" },
  ]);
  assert.equal(card!.priority, undefined, "Trello has no priority");
  assert.ok(trelloQueries.some((query) => query.get("member_fields") === "fullName,username,avatarUrl"));
  assert.deepEqual(await trello.currentUser!(), { id: "m-1", name: "Grace Hopper", avatarUrl: "https://trello-members.test/abc/50.png" });
});
