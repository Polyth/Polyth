import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CreateSessionInput,
  JsonObject,
  RouteRequest,
  SessionEvent,
  SessionProjection,
  SpaceContext,
  SpaceRole,
  SpaceStorage,
  TaskTrackerService,
  UserTurnInput,
} from "@polyth/contracts";
import {
  createDemoClient,
  createJiraClient,
  createTrelloClient,
  reduceTaskLifecycle,
} from "@polyth/task-trackers";
import { createTaskTrackerManagement, type TaskTrackerVault } from "../src/management.ts";
import registerPackage, { MAX_DISPATCH, taskTrackerRoutes, type ScopedTaskTrackerService } from "../src/serverEntry.ts";
import { createTaskAgentTools, TASKS_READ_TOOL_NAME } from "../src/agentTool.ts";
import { DEFAULT_TASK_TRACKER_PREFERENCES } from "../src/types.ts";
import { fakePeople } from "./peopleHost.ts";
import type { ServerPackageHost } from "@polyth/plugins";

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const auth = (email: string, token: string) => Buffer.from(`${email}:${token}`).toString("base64");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tt-team-"));
  // One storage root per Space, like host.spaceStorage.
  const storages = new Map<string, SpaceStorage>();
  const storageOf = (spaceId: string): SpaceStorage => {
    let storage = storages.get(spaceId);
    if (!storage) {
      const dir = join(root, "spaces", spaceId);
      storage = { root: dir, packageDir: (id) => join(dir, "packages", id), path: (relative) => join(dir, relative) };
      storages.set(spaceId, storage);
    }
    return storage;
  };
  const secrets = new Map<string, string>();
  const vault: TaskTrackerVault = {
    putOpaque: (key, value) => { secrets.set(key, value); },
    getOpaque: (key) => secrets.get(key) ?? null,
    deleteOpaque: (key) => { secrets.delete(key); },
  };
  const people = fakePeople(root, {
    spc_a: ["u-ada", "u-admin", "u-other"],
    spc_b: ["u-ada", "u-admin"],
    spc_c: ["u-bob"],
  });
  const seen: string[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const header = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
    const who = header.includes(auth("ada@acme.test", "ada-token"))
      ? "ada"
      : header.includes(auth("ops@acme.test", "ops-token"))
        ? "ops"
        : header.includes(auth("env@acme.test", "env-token")) ? "env" : "";
    seen.push(`${who}:${url.pathname}`);
    if (!who) return response({}, 401);
    if (url.pathname === "/rest/api/3/myself") {
      return response({ displayName: who === "ada" ? "Ada Dev" : "Ops Bot", emailAddress: `${who}@acme.test` });
    }
    if (url.pathname === "/rest/api/3/project/search") return response({ values: [{ id: "1", key: "ACME", name: who }] });
    return response({});
  }) as typeof fetch;
  const space = (role: SpaceRole, userId = "u-ada", spaceId = "spc_a"): SpaceContext => ({
    spaceId,
    spaceSlug: spaceId,
    userId,
    role,
    deployment: "local-trusted",
    storageDir: storageOf(spaceId).root,
  } as SpaceContext);
  const env: NodeJS.ProcessEnv = {};
  const management = createTaskTrackerManagement({
    storage: (context) => storageOf(context.spaceId),
    vault: () => vault,
    people: () => people,
    env,
    fetchImpl,
  });
  /** What an agent turn acting for `userId` (or nobody) reaches in `spaceId`. */
  const agent = async (userId: string | undefined, spaceId = "spc_a", installationOwner = false) => {
    seen.length = 0;
    const system = space("viewer", "system:agent", spaceId);
    try {
      await management.agentTrackers(
        system,
        userId ? { origin: "agent", userId, installationOwner } : { origin: "system" },
        "jira",
      ).listProjects("jira");
      return seen.map((item) => item.split(":")[0]).join(",");
    } catch (error) {
      return `refused: ${(error as Error & { code?: string }).code} ${(error as Error).message}`;
    }
  };
  return { management, secrets, people, seen, space, env, agent, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a personal account belongs to the person, acts only for them, and is enabled per Space", async () => {
  const { management, secrets, people, seen, space, cleanup } = fixture();
  try {
    await assert.rejects(
      management.connectJira(space("viewer"), { site: "acme", email: "ada@acme.test", apiToken: "ada-token" }, "personal"),
      { code: "forbidden" },
    );
    await assert.rejects(
      management.connectJira(space("member"), { site: "acme", email: "ops@acme.test", apiToken: "ops-token" }),
      { code: "forbidden" },
      "the Space service account stays admin-only",
    );

    await management.connectJira(space("admin", "u-admin"), { site: "acme", email: "ops@acme.test", apiToken: "ops-token" });
    const mine = await management.connectJira(space("member"), { site: "acme", email: "ada@acme.test", apiToken: "ada-token" }, "personal");
    assert.equal(mine.canConnect, true);
    assert.equal(mine.canManage, false);
    assert.equal(mine.personalAvailable, true);
    assert.equal(mine.agentsMayUseService, undefined, "members never see the admin policy");
    const [own] = mine.personalConnections ?? [];
    assert.equal(own?.account.name, "Ada Dev");
    assert.equal(own?.enabled, true, "connecting from a Space turns it on there");
    const ownId = own?.id ?? "";
    assert.match(ownId, /^jira-/);
    assert.deepEqual(mine.connections.map((item) => item.account.name), ["Ops Bot"]);
    assert.equal(mine.providers.find((item) => item.provider === "jira")?.source, "personal");
    // The secret lives with the person, never in the Space vault.
    assert.deepEqual([...secrets.keys()], ["task-trackers:spc_a:jira"]);
    assert.match(people.secrets.get("u-ada")?.get(`connection:${ownId}`) ?? "", /ada-token/);
    assert.deepEqual(people.enabled("u-ada", "spc_a", "task-trackers"), [ownId]);
    assert.equal(JSON.stringify(mine).includes("ada-token"), false);

    seen.length = 0;
    await management.trackers(space("member")).listProjects("jira");
    await management.trackers(space("member", "u-other")).listProjects("jira");
    assert.deepEqual(seen, ["ada:/rest/api/3/project/search", "ops:/rest/api/3/project/search"],
      "people use their own account, else the Space account in the UI");
    const other = management.state(space("member", "u-other"));
    assert.deepEqual(other.personalConnections, [], "a member never sees another member's account");

    // Another Space Ada belongs to: her account is there but off until she turns it on.
    const inB = management.state(space("member", "u-ada", "spc_b"));
    assert.deepEqual(inB.personalConnections?.map((item) => [item.id, item.enabled]), [[ownId, false]]);
    assert.equal(inB.providers.find((item) => item.provider === "jira")?.source, "demo", "never silently used elsewhere");
    const onInB = management.setPersonalEnabled(space("member", "u-ada", "spc_b"), ownId, true);
    assert.equal(onInB.personalConnections?.[0]?.enabled, true);
    assert.equal(onInB.providers.find((item) => item.provider === "jira")?.source, "personal");
    const offInB = management.setPersonalEnabled(space("member", "u-ada", "spc_b"), ownId, false);
    assert.equal(offInB.personalConnections?.[0]?.enabled, false);
    assert.equal(management.state(space("member")).personalConnections?.[0]?.enabled, true, "Space A is unaffected");

    // Someone else's connection id is not theirs to toggle, here or anywhere.
    assert.throws(() => management.setPersonalEnabled(space("member", "u-other"), ownId, true), { code: "not-found" });
    // A Space the person is not a member of can't turn it on.
    assert.throws(() => management.setPersonalEnabled(space("member", "u-ada", "spc_c"), ownId, true), { code: "forbidden" });

    const after = management.disconnect(space("member"), "jira", "personal");
    assert.deepEqual(after.personalConnections, []);
    assert.equal(after.connections.length, 1, "removing a personal account keeps the shared one");
    assert.equal(people.secrets.get("u-ada")?.size, 0);
    assert.equal(after.providers.find((item) => item.provider === "jira")?.source, "connection");
  } finally {
    cleanup();
  }
});

test("agents act with the turn's actor's account; the Space account only under the Space policy", async () => {
  const { management, space, agent, cleanup } = fixture();
  try {
    await management.connectJira(space("admin", "u-admin"), { site: "acme", email: "ops@acme.test", apiToken: "ops-token" });
    await management.connectJira(space("member"), { site: "acme", email: "ada@acme.test", apiToken: "ada-token" }, "personal");

    assert.equal(management.servicePolicy(space("admin", "u-admin")).agentsMayUseService, false, "policy defaults to off");
    assert.equal(await agent("u-ada"), "ada", "the actor's own enabled account");
    assert.match(await agent("u-other"), /^refused: forbidden .*Connect your Jira account in Tasks settings/,
      "actor B never gets A's account, and not the Space account while the policy is off");
    assert.match(await agent(undefined), /^refused: forbidden .*acts for no one/, "system work needs the policy");
    assert.match(await agent("u-bob"), /^refused: forbidden .*not a member/, "a non-member actor is refused");

    assert.throws(() => management.setServicePolicy(space("member"), { agentsMayUseService: true }), { code: "forbidden" });
    const allowed = management.setServicePolicy(space("admin", "u-admin"), { agentsMayUseService: true });
    assert.equal(allowed.agentsMayUseService, true);
    assert.equal(await agent("u-other"), "ops", "under the policy B's agent uses the Space account");
    assert.equal(await agent(undefined), "ops", "and so does system work");
    assert.equal(await agent("u-ada"), "ada", "the actor's own account still wins");
    assert.match(await agent("u-bob"), /not a member/, "the policy never admits a non-member");

    // Ada's account is off in Space B and B has no service account: refused, not borrowed.
    management.updatePreferences(space("admin", "u-admin", "spc_b"), { demo: false });
    assert.match(await agent("u-ada", "spc_b"), /Connect your Jira account/);
  } finally {
    cleanup();
  }
});

test("the env account is the instance owner's alone", async () => {
  const { management, space, env, agent, seen, cleanup } = fixture();
  try {
    Object.assign(env, { JIRA_BASE_URL: "https://acme.atlassian.net", JIRA_EMAIL: "env@acme.test", JIRA_API_TOKEN: "env-token" });
    assert.equal(management.state(space("admin")).providers.find((item) => item.provider === "jira")?.source, "demo",
      "a member who is not the instance owner never sees it");
    const owner = management.state(space("admin"), { installationOwner: true });
    assert.equal(owner.providers.find((item) => item.provider === "jira")?.source, "env");
    seen.length = 0;
    await management.trackers(space("member"), { installationOwner: true }).listProjects("jira");
    assert.deepEqual(seen, ["env:/rest/api/3/project/search"]);

    assert.equal(await agent("u-ada", "spc_a", true), "env", "the owner's agent may use it");
    management.updatePreferences(space("admin"), { demo: false });
    assert.match(await agent("u-other"), /Connect your Jira account/, "nobody else's agent may");
    assert.match(await agent(undefined), /acts for no one/, "nor system work, even with the policy on");
    management.setServicePolicy(space("admin"), { agentsMayUseService: true });
    assert.match(await agent(undefined), /acts for no one/);
  } finally {
    cleanup();
  }
});

test("agent tools pass the turn's actor to the tracker resolver", async () => {
  const { management, space, seen, cleanup } = fixture();
  try {
    await management.connectJira(space("member"), { site: "acme", email: "ada@acme.test", apiToken: "ada-token" }, "personal");
    management.updatePreferences(space("admin", "u-admin"), { demo: false });
    const linked = [{
      seq: 1,
      type: "task/selected",
      data: { provider: "jira", taskId: "1", taskKey: "POL-1", title: "Task 1", statusId: "todo", statusName: "To do" },
    } as unknown as SessionEvent];
    const actors: Array<string | undefined> = [];
    const [read] = createTaskAgentTools({
      trackers: (spaceId, actorUserId, provider) => {
        actors.push(actorUserId);
        return management.agentTrackers(
          space("viewer", "system:agent", spaceId),
          actorUserId ? { origin: "agent", userId: actorUserId } : { origin: "system" },
          provider,
        );
      },
      preferences: () => DEFAULT_TASK_TRACKER_PREFERENCES,
      events: async () => linked,
      append: async () => undefined,
    });
    const ctx = { sessionId: "s1", projectId: "p", cwd: "/", spaceId: "spc_a" };
    await assert.rejects(read!.execute!({ provider: "jira", taskId: "1" }, { ...ctx, actorUserId: "u-other" }),
      /Connect your Jira account in Tasks settings/);
    await assert.rejects(read!.execute!({ provider: "jira", taskId: "1" }, ctx), /acts for no one/);
    seen.length = 0;
    await read!.execute!({ provider: "jira", taskId: "1" }, { ...ctx, actorUserId: "u-ada" }).catch(() => undefined);
    assert.ok(seen.length > 0 && seen.every((item) => item.startsWith("ada:")), "Ada's turn reads with Ada's account");
    assert.deepEqual(actors, ["u-other", undefined, "u-ada"]);
  } finally {
    cleanup();
  }
});

test("link index keeps the newest link per task and session", () => {
  const { management, space, cleanup } = fixture();
  try {
    management.recordLink(space("member"), { provider: "jira", taskId: "1", taskKey: "POL-1", sessionId: "s1" });
    management.recordLink(space("member"), { provider: "jira", taskId: "2", taskKey: "POL-2", sessionId: "s2" });
    management.recordLink(space("member"), { provider: "jira", taskId: "1", taskKey: "POL-1", sessionId: "s1" });
    assert.deepEqual(management.links(space("viewer")).map((item) => `${item.taskKey}@${item.sessionId}`), ["POL-1@s1", "POL-2@s2"]);
  } finally {
    cleanup();
  }
});

test("Jira and Trello clients create tasks and post comments", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown; query?: Record<string, string> }> = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: url.pathname,
      ...(init?.body instanceof URLSearchParams
        ? { body: Object.fromEntries(init.body) }
        : init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      query: Object.fromEntries([...url.searchParams].filter(([key]) => key !== "key" && key !== "token")),
    });
    if (url.pathname === "/rest/agile/1.0/board/7") return response({ location: { projectId: 10 } });
    if (url.pathname === "/rest/api/3/issue/createmeta/10/issuetypes") {
      return response({ issueTypes: [{ id: "5", name: "Sub-task", subtask: true }, { id: "1", name: "Bug" }, { id: "3", name: "Task" }] });
    }
    if (url.pathname === "/rest/api/3/issue" && method === "POST") return response({ id: "100", key: "ACME-9" });
    if (url.pathname === "/rest/api/3/issue/100") {
      return response({ id: "100", key: "ACME-9", fields: { summary: "Ship it", status: { id: "1", name: "To Do", statusCategory: { key: "new" } } } });
    }
    if (url.pathname === "/rest/api/3/issue/100/transitions") return response({ transitions: [] });
    if (url.pathname === "/1/boards/b1/lists") {
      return response([{ id: "l-done", name: "Done" }, { id: "l-todo", name: "To do" }, { id: "l-old", name: "Backlog", closed: true }]);
    }
    if (url.pathname === "/1/cards" && method === "POST") {
      return response({ id: "c1", name: "Ship it", desc: "Why", url: "https://trello.com/c/c1", idBoard: "b1", idList: "l-todo", labels: [] });
    }
    return response({});
  }) as typeof fetch;

  const jira = createJiraClient({ baseUrl: "https://acme.atlassian.net", email: "a@b.c", apiToken: "t", fetchImpl });
  const issue = await jira.createTask({ boardId: "7", title: " Ship it ", description: "Line one\n\nLine three" });
  assert.equal(issue.key, "ACME-9");
  const created = calls.find((call) => call.path === "/rest/api/3/issue" && call.method === "POST");
  assert.deepEqual(created?.body, {
    fields: {
      project: { id: "10" },
      issuetype: { id: "3" },
      summary: "Ship it",
      description: {
        type: "doc",
        version: 1,
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Line one" }] },
          { type: "paragraph", content: [] },
          { type: "paragraph", content: [{ type: "text", text: "Line three" }] },
        ],
      },
    },
  });
  await jira.addComment("100", "Done in abc123");
  assert.deepEqual(calls.at(-1), {
    method: "POST",
    path: "/rest/api/3/issue/100/comment",
    body: { body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Done in abc123" }] }] } },
    query: {},
  });
  await assert.rejects(jira.createTask({ title: "No project" }), { code: "invalid-input" });
  await assert.rejects(jira.createTask({ projectId: "10", title: "  " }), { code: "invalid-input" });

  const trello = createTrelloClient({ apiKey: "k", apiToken: "t", fetchImpl });
  const before = calls.length;
  const card = await trello.createTask({ boardId: "b1", title: "Ship it", description: "Why" });
  assert.equal(card.status.id, "l-todo");
  assert.equal(card.url, "https://trello.com/c/c1");
  assert.deepEqual(card.availableStatuses?.map((status) => status.id), ["l-done", "l-todo", "l-old"]);
  const post = calls.find((call) => call.path === "/1/cards" && call.method === "POST");
  // Card fields travel in the body; a long description can't outgrow the URL.
  assert.deepEqual(post?.query, {});
  assert.deepEqual(post?.body, { idList: "l-todo", name: "Ship it", desc: "Why", pos: "top" });
  assert.deepEqual(calls.slice(before).map((call) => `${call.method} ${call.path}`), ["GET /1/boards/b1/lists", "POST /1/cards"],
    "the card comes from Trello's create answer, not a second read");
  await trello.addComment("c1", "Result");
  assert.deepEqual(calls.at(-1)?.query, {});
  assert.deepEqual(calls.at(-1)?.body, { text: "Result" });
  await assert.rejects(trello.createTask({ title: "No board" }), { code: "invalid-input" });
});

test("a card on a Trello board without an open list lands in a new To Do list", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname} ${init?.body ?? ""}`);
    if (url.pathname === "/1/boards/b1/lists") return response([{ id: "l-old", name: "Old", closed: true }]);
    if (url.pathname === "/1/lists") return response({ id: "l-new", name: "To Do", closed: false });
    if (url.pathname === "/1/cards") return response({ id: "c1", name: "Ship it", idList: "l-new", idBoard: "b1" });
    return response({});
  }) as typeof fetch;
  const trello = createTrelloClient({ apiKey: "key123", apiToken: "a".repeat(64), fetchImpl });
  const card = await trello.createTask({ boardId: "b1", title: "Ship it" });
  assert.deepEqual(calls, [
    "GET /1/boards/b1/lists ",
    "POST /1/lists idBoard=b1&name=To+Do&pos=top",
    "POST /1/cards idList=l-new&name=Ship+it&pos=top",
  ]);
  assert.equal(card.status.id, "l-new");
  assert.equal(card.status.category, "todo");
});

test("a tracker that refuses a create says why and is not reported as an unknown outcome", async () => {
  // Trello answers 401 for a board the account may read but not edit, while
  // the same token writes elsewhere. That used to surface as "result not confirmed".
  let answer = (): Response => new Response("unauthorized permission requested", { status: 401, statusText: "Unauthorized" });
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/1/boards/b1/lists") return response([{ id: "l-todo", name: "To do" }]);
    if (url.pathname === "/1/cards" && init?.method === "POST") return answer();
    return response({});
  }) as typeof fetch;
  const token = "a".repeat(64);
  const trello = createTrelloClient({ apiKey: "key123", apiToken: token, fetchImpl });
  await assert.rejects(trello.createTask({ boardId: "b1", title: "Ship it" }), (cause: Error & Record<string, unknown>) => {
    assert.equal(cause.mutationOutcome, "rejected");
    assert.equal(cause.code, "unavailable");
    assert.match(cause.message, /^The connected Trello account can’t add cards to this board \(401: unauthorized permission requested\)\. Ask a board admin/);
    assert.ok(!cause.message.includes(token));
    return true;
  });

  // Any other refusal keeps the tracker's own words and is still a refusal.
  answer = () => response({ message: "invalid value for idList", error: "ERROR" }, 400);
  await assert.rejects(trello.createTask({ boardId: "b1", title: "Ship it" }), {
    code: "invalid-input",
    mutationOutcome: "rejected",
    message: "Trello request failed (400 HTTP error): invalid value for idList; ERROR",
  });

  // A server error after sending is honestly unknown: the card may exist.
  answer = () => new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" });
  await assert.rejects(trello.createTask({ boardId: "b1", title: "Ship it" }), (cause: Error & Record<string, unknown>) => {
    assert.equal(cause.mutationOutcome, undefined);
    assert.equal(cause.message, "Trello request failed (502 Bad Gateway)");
    return true;
  });

  // Reads never claim a mutation outcome of their own.
  const reads = createTrelloClient({
    apiKey: "key123",
    apiToken: token,
    fetchImpl: (async () => new Response(`invalid token ${token}`, { status: 401, statusText: "Unauthorized" })) as typeof fetch,
  });
  await assert.rejects(reads.listBoards(), (cause: Error & Record<string, unknown>) => {
    assert.equal(cause.mutationOutcome, undefined);
    assert.equal(cause.message, "Trello request failed (401 Unauthorized): invalid token …");
    return true;
  });
});

test("a Jira issue that exists is returned even when reading it back fails", async () => {
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/issue/createmeta/10/issuetypes") return response({ issueTypes: [{ id: "3", name: "Task" }] });
    if (url.pathname === "/rest/api/3/issue" && init?.method === "POST") return response({ id: "100", key: "ACME-9" });
    return new Response("", { status: 503, statusText: "Service Unavailable" });
  }) as typeof fetch;
  const jira = createJiraClient({ baseUrl: "https://acme.atlassian.net", email: "a@b.c", apiToken: "t", fetchImpl });
  const issue = await jira.createTask({ projectId: "10", title: "Ship it" });
  assert.equal(issue.key, "ACME-9");
  assert.equal(issue.title, "Ship it");
  assert.equal(issue.url, "https://acme.atlassian.net/browse/ACME-9");
  assert.equal(issue.status.category, "unknown");
});

test("tracker preconditions refuse before any write", async () => {
  const { createTaskTrackerService } = await import("@polyth/task-trackers");
  const off = createTaskTrackerService({
    credentials: {},
    preferences: { ...DEFAULT_TASK_TRACKER_PREFERENCES, demo: false },
  });
  await assert.rejects(off.createTask!("trello", { boardId: "b", title: "x" }), {
    code: "unavailable",
    mutationOutcome: "not-started",
    message: "Trello is not connected",
  });
});

test("demo sandbox creates tasks at the top of the board", async () => {
  const demo = createDemoClient("jira");
  const created = await demo.createTask({ title: "Write release notes", description: "Short" });
  assert.equal(created.key, "POL-106");
  assert.equal(created.status.category, "todo");
  assert.equal((await demo.listTasks({}))[0]?.id, created.id);
  await demo.addComment(created.id, "Looks good");
  await assert.rejects(demo.createTask({ boardId: "elsewhere", title: "x" }), { code: "not-found" });
});

test("a status change out of done reopens a linked task", () => {
  const base = { provider: "jira", taskId: "1", taskKey: "POL-1", title: "T" };
  const event = (seq: number, type: string, data: JsonObject): SessionEvent =>
    ({ seq, type, data, sessionId: "s", ts: seq } as unknown as SessionEvent);
  const events = [
    event(1, "task/selected", { ...base, statusId: "todo", statusName: "To do" }),
    event(2, "task/status-changed", { ...base, statusId: "done", statusName: "Done" }),
    event(3, "task/completed", { ...base, statusId: "done", statusName: "Done" }),
  ];
  assert.equal(reduceTaskLifecycle(events)[0]?.completed, true);
  events.push(event(4, "task/status-changed", { ...base, statusId: "todo", statusName: "To do" }));
  assert.equal(reduceTaskLifecycle(events)[0]?.completed, false);
});

const task = (id: string) => ({
  provider: "jira" as const,
  id,
  key: `POL-${id}`,
  title: `Task ${id}`,
  description: "Do it",
  status: { id: "todo", name: "To do", category: "todo" as const },
  availableStatuses: [
    { id: "t-progress", name: "In Progress", category: "in_progress" as const },
    { id: "t-done", name: "Done", category: "done" as const },
  ],
  labels: [],
  assignees: [],
});

function routeHarness(options: { role?: SpaceRole; handoff?: boolean } = {}) {
  const log: string[] = [];
  const links: string[] = [];
  let sessions = 0;
  const service: TaskTrackerService = {
    providers: () => [],
    listProjects: async () => [],
    listBoards: async () => [],
    listTasks: async () => [],
    getTask: async (_provider, id) => {
      if (id === "missing") throw Object.assign(new Error("Jira issue was not found"), { code: "not-found" });
      return task(id);
    },
    updateStatus: async (_provider, id) => task(id),
    createTask: async (_provider, input) => {
      log.push(`createTask:${input.boardId}:${input.title}`);
      return task("new");
    },
  };
  const preferences = { ...DEFAULT_TASK_TRACKER_PREFERENCES, agentHandoff: options.handoff ?? true };
  const routes = taskTrackerRoutes({
    trackers: service,
    management: {
      preferences: () => preferences,
      recordLink: (_space: SpaceContext, link: { taskKey: string; sessionId: string }) => {
        links.push(`${link.taskKey}@${link.sessionId}`);
      },
    } as never,
    snapshot: async (sessionId) => ({ id: sessionId } as SessionProjection),
    events: async () => [],
    append: async (sessionId, type) => {
      log.push(`append:${sessionId}:${type}`);
      return {} as SessionEvent;
    },
    send: async (sessionId, input: UserTurnInput) => {
      log.push(`send:${sessionId}:${input.text.split("\n")[0]}:${input.model?.modelID ?? ""}`);
      return {};
    },
    create: async (input: CreateSessionInput) => {
      sessions += 1;
      log.push(`create:${input.projectId}:${input.title}:${input.harness?.mode ?? ""}`);
      return { id: `s${sessions}` };
    },
  });
  const call = async (method: string, path: string, body: JsonObject = {}) => {
    let status = 0;
    let payload: unknown;
    const request = {
      path,
      method,
      url: new URL(`http://polyth.local${path}`),
      body: async () => body,
      json: (code: number, value: unknown) => { status = code; payload = value; },
      space: { spaceId: "space-a", userId: "u", role: options.role ?? "member" } as SpaceContext,
    } as unknown as RouteRequest;
    await routes(request);
    return { status, payload };
  };
  return { call, log, links };
}

test("dispatch starts one session per task, records context first, and reports per-task failures", async () => {
  const { call, log, links } = routeHarness();
  const { payload } = await call("POST", "/api/task-trackers/dispatch", {
    projectId: "p1",
    instructions: "Keep it small",
    harness: { mode: "pinned", harnessId: "claude" },
    model: { providerID: "anthropic", modelID: "opus" },
    tasks: [{ provider: "jira", taskId: "1" }, { provider: "jira", taskId: "missing" }, { provider: "jira", taskId: "2" }],
  });
  assert.deepEqual(payload, {
    results: [
      { provider: "jira", taskId: "1", taskKey: "POL-1", sessionId: "s1" },
      { provider: "jira", taskId: "missing", error: "Jira issue was not found" },
      { provider: "jira", taskId: "2", taskKey: "POL-2", sessionId: "s2" },
    ],
  });
  assert.deepEqual(log, [
    "create:p1:POL-1 · Task 1:pinned",
    "append:s1:task/selected",
    "send:s1:Work on Jira issue POL-1: Task 1:opus",
    "create:p1:POL-2 · Task 2:pinned",
    "append:s2:task/selected",
    "send:s2:Work on Jira issue POL-2: Task 2:opus",
  ]);
  assert.deepEqual(links, ["POL-1@s1", "POL-2@s2"]);

  await assert.rejects(
    call("POST", "/api/task-trackers/dispatch", {
      projectId: "p1",
      tasks: Array.from({ length: MAX_DISPATCH + 1 }, (_, index) => ({ provider: "jira", taskId: String(index) })),
    }),
    { code: "invalid-input" },
  );
  await assert.rejects(call("POST", "/api/task-trackers/dispatch", { tasks: [{ provider: "jira", taskId: "1" }] }), { code: "invalid-input" });
});

test("viewers can read but not write; handoff off blocks dispatch", async () => {
  const viewer = routeHarness({ role: "viewer" });
  await assert.rejects(viewer.call("POST", "/api/task-trackers/jira/tasks", { title: "x" }), { code: "forbidden" });
  await assert.rejects(viewer.call("POST", "/api/task-trackers/dispatch", { projectId: "p", tasks: [{ provider: "jira", taskId: "1" }] }), { code: "forbidden" });
  await assert.rejects(viewer.call("POST", "/api/task-trackers/jira/tasks/1/link", { sessionId: "s", startAgent: false }), { code: "forbidden" });
  await assert.rejects(viewer.call("PATCH", "/api/task-trackers/jira/tasks/1", { sessionId: "s", statusId: "t-done" }), { code: "forbidden" });
  assert.deepEqual(viewer.log, []);

  const member = routeHarness({ handoff: false });
  await assert.rejects(member.call("POST", "/api/task-trackers/dispatch", { projectId: "p", tasks: [{ provider: "jira", taskId: "1" }] }), { code: "unavailable" });
  const created = await member.call("POST", "/api/task-trackers/jira/tasks", { boardId: "b", title: "New" });
  assert.equal((created.payload as { key: string }).key, "POL-new");
  assert.deepEqual(member.log, ["createTask:b:New"]);
});

test("agent tools read linked tasks and write back only to them", async () => {
  const appended: string[] = [];
  const writes: string[] = [];
  let statusUpdates = true;
  const linked: SessionEvent[] = [{
    seq: 1,
    type: "task/selected",
    data: { provider: "jira", taskId: "1", taskKey: "POL-1", title: "Task 1", statusId: "todo", statusName: "To do" },
  } as unknown as SessionEvent];
  const service = {
    getTask: async (_provider: string, id: string) => task(id),
    updateStatus: async (_provider: string, id: string, statusId: string) => {
      writes.push(`status:${id}:${statusId}`);
      return { ...task(id), status: { id: "done", name: "Done", category: "done" as const } };
    },
    addComment: async (_provider: string, id: string, text: string) => { writes.push(`comment:${id}:${text}`); },
  } as unknown as TaskTrackerService;
  const [read, update] = createTaskAgentTools({
    trackers: () => service,
    preferences: () => ({ ...DEFAULT_TASK_TRACKER_PREFERENCES, statusUpdates }),
    events: async (spaceId, sessionId) => {
      assert.equal(spaceId, "space-a");
      return sessionId === "s1" ? linked : [];
    },
    append: async (sessionId, type) => { appended.push(`${sessionId}:${type}`); },
  });
  const ctx = { sessionId: "s1", projectId: "p", cwd: "/", spaceId: "space-a" };
  assert.equal((read!.descriptor as { name?: string }).name, TASKS_READ_TOOL_NAME);
  assert.equal(await read!.autoApprove?.({ spaceId: "space-a", projectId: "p", cwd: "/" }), true);
  assert.equal(update!.autoApprove, undefined, "external writes always go through permissions");

  assert.match((await read!.execute!({}, ctx)).output, /POL-1 \(provider: jira, taskId: 1\): Task 1 — To do/);
  assert.match((await read!.execute!({ provider: "jira", taskId: "POL-1" }, ctx)).output, /Can move to: In Progress, Done/);
  assert.equal((await read!.execute!({}, { ...ctx, sessionId: "s2" })).output, "No tracker task is linked to this session.");
  await assert.rejects(read!.execute!({ provider: "jira", taskId: "9" }, ctx), /not linked to this session/);

  const result = await update!.execute!({ provider: "jira", taskId: "1", comment: "Fixed in abc", status: "done" }, ctx);
  assert.equal(result.output, "Comment posted on POL-1.\nPOL-1 moved to Done.");
  assert.deepEqual(writes, ["comment:1:Fixed in abc", "status:1:t-done"]);
  assert.deepEqual(appended, ["s1:task/status-changed", "s1:task/completed"]);

  await assert.rejects(update!.execute!({ provider: "jira", taskId: "1", status: "Shipped" }, ctx), /not an available status/);
  await assert.rejects(update!.execute!({ provider: "jira", taskId: "9", comment: "x" }, ctx), /not linked/);
  await assert.rejects(update!.execute!({ provider: "jira", taskId: "1" }, ctx), /comment, a status/);
  statusUpdates = false;
  await assert.rejects(update!.execute!({ provider: "jira", taskId: "1", status: "Done" }, ctx), /turned off/);
});

test("the shared service names no caller, so it never uses the env account; scoped calls follow the routes' rules", (t) => {
  const { people, space, cleanup } = fixture();
  t.after(cleanup);
  const saved = { JIRA_BASE_URL: process.env.JIRA_BASE_URL, JIRA_EMAIL: process.env.JIRA_EMAIL, JIRA_API_TOKEN: process.env.JIRA_API_TOKEN };
  Object.assign(process.env, { JIRA_BASE_URL: "https://acme.atlassian.net", JIRA_EMAIL: "env@acme.test", JIRA_API_TOKEN: "env-token" });
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const provided = new Map<string, unknown>();
  const host = {
    pluginId: "task-trackers",
    deployment: "local-trusted",
    services: { provide: (key: { id: string }, value: unknown) => provided.set(key.id, value), get: () => undefined },
    root: { provide: (key: { id: string }, value: unknown) => provided.set(key.id, value) },
    spaceStorage: (context: SpaceContext) => ({ root: context.storageDir, packageDir: (id: string) => join(context.storageDir, "packages", id), path: (relative: string) => join(context.storageDir, relative) }),
    systemSpaceContext: (spaceId: string) => space("viewer", "system:agent", spaceId),
    personSpaceContext: (userId: string, spaceId: string) => ({ ...space("member", userId, spaceId), instanceOwner: userId === "u-admin" }),
    people,
  } as unknown as ServerPackageHost;
  registerPackage(host);
  const shared = provided.get("polyth.taskTrackers") as ScopedTaskTrackerService;
  assert.equal([...provided.values()].filter((value) => value === shared).length, 2, "one object behind both keys");
  const jira = (service: TaskTrackerService) => service.providers().find((item) => item.provider === "jira");
  assert.equal(jira(shared)?.configured, false, "no caller: no account, only the sandbox");
  assert.equal(jira(shared)?.mode, "demo");

  const owner = { ...space("owner", "u-admin"), instanceOwner: true } as SpaceContext;
  assert.equal(jira(shared.forPerson(owner))?.configured, true, "the instance owner on local-trusted");
  assert.equal(jira(shared.forPerson(space("admin", "u-ada")))?.configured, false, "a member who is not the owner");
  assert.equal(jira(shared.forPerson({ ...owner, deployment: "server-trusted" } as SpaceContext))?.configured, false, "never off local-trusted");

  assert.equal(jira(shared.forActor("spc_a", "u-admin", "jira"))?.configured, true, "the owner's agent");
  assert.equal(jira(shared.forActor("spc_a", "u-ada", "jira"))?.configured, false, "anyone else's agent gets the sandbox at most");
  assert.equal(jira(shared.forActor("spc_a", undefined, "jira"))?.configured, false, "system work never");
});
