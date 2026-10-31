import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteRequest, SpaceContext } from "@polyth/contracts";
import {
  createLinearClient,
  createTaskTrackerService,
  verifyLinearAccount,
} from "@polyth/task-trackers";
import { createTaskTrackerManagement, type TaskTrackerVault } from "../src/management.ts";
import { taskTrackerRoutes } from "../src/serverEntry.ts";
import { fakePeople } from "./peopleHost.ts";

const KEY = "lin_api_0123456789abcdefghijklmnopqrstuv";
const ORG_UPLOAD = "https://uploads.linear.app/org-1";

interface Call {
  operation: string;
  variables: Record<string, unknown>;
  authorization: string | null;
}

type Resolver = (variables: Record<string, unknown>) => unknown;

/** A Linear GraphQL endpoint answering by operation name. */
function linear(resolvers: Record<string, Resolver>, extra?: (url: URL, init: RequestInit) => Response | undefined) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const custom = extra?.(url, init);
    if (custom) return custom;
    assert.equal(url.toString(), "https://api.linear.app/graphql");
    const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    const operation = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "";
    const headers = new Headers(init.headers);
    calls.push({ operation, variables, authorization: headers.get("authorization") });
    const resolve = resolvers[operation];
    if (!resolve) throw new Error(`unexpected Linear operation ${operation}`);
    const result = resolve(variables);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify({ data: result }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const graphqlError = (status: number, code: string, message: string, httpStatus = status) =>
  new Response(JSON.stringify({
    errors: [{ message, extensions: { code, statusCode: status, userPresentableMessage: message, http: { status } } }],
  }), { status: httpStatus, headers: { "content-type": "application/json" } });

const STATES = [
  { id: "s-done", name: "Done", type: "completed", position: 0 },
  { id: "s-dup", name: "Duplicate", type: "duplicate", position: 0 },
  { id: "s-review", name: "In Review", type: "started", position: 2 },
  { id: "s-todo", name: "Todo", type: "unstarted", position: 0 },
  { id: "s-progress", name: "In Progress", type: "started", position: 1 },
  { id: "s-canceled", name: "Canceled", type: "canceled", position: 0 },
  { id: "s-backlog", name: "Backlog", type: "backlog", position: 0 },
];

const issue = (overrides: Record<string, unknown> = {}) => ({
  id: "1b4e28ba-2fa1-11d2-883f-0016d3cca427",
  identifier: "ENG-41",
  title: "Sync offline edits",
  description: `Steps below.\n\n![screen.png](${ORG_UPLOAD}/file-1)\n\nAnd again ![](${ORG_UPLOAD}/file-1)`,
  url: "https://linear.app/acme/issue/ENG-41/sync-offline-edits",
  priority: 2,
  priorityLabel: "High",
  dueDate: "2026-10-20",
  updatedAt: "2026-10-14T10:00:00.000Z",
  sortOrder: 10,
  state: { id: "s-progress", name: "In Progress", type: "started" },
  assignee: { id: "u-iris", name: "Iris Novak", displayName: "iris", avatarUrl: "https://public.linear.app/avatar.png" },
  labels: { nodes: [{ name: "Mobile" }, { name: "Bug" }] },
  attachments: {
    nodes: [
      { id: "att-file", title: "trace.png", url: `${ORG_UPLOAD}/file-2`, createdAt: "2026-10-13T09:00:00.000Z" },
      { id: "att-pr", title: "PR #12", url: "https://github.com/acme/app/pull/12", createdAt: "2026-10-13T10:00:00.000Z" },
      { id: "att-bad", title: "Bad", url: "javascript:alert(1)" },
    ],
  },
  team: { id: "team-1", key: "ENG" },
  project: { id: "proj-1" },
  ...overrides,
});

test("Linear teams become projects; a team's issues and its active projects become boards", async () => {
  const { calls, fetchImpl } = linear({
    Teams: () => ({
      organization: { urlKey: "acme" },
      teams: { nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }, { id: "team-2", key: "DES", name: "Design" }] },
    }),
    Boards: (variables) => ({
      organization: { urlKey: "acme" },
      teams: {
        nodes: [
          {
            id: "team-1",
            key: "ENG",
            name: "Engineering",
            projects: { nodes: [{ id: "proj-1", name: "Mobile app", url: "https://linear.app/acme/project/mobile" }, { id: "proj-2", name: "Launch", url: "https://linear.app/acme/project/launch" }] },
          },
          ...(variables.teamFilter ? [] : [{
            id: "team-2",
            key: "DES",
            name: "Design",
            projects: { nodes: [{ id: "proj-2", name: "Launch", url: "https://linear.app/acme/project/launch" }] },
          }]),
        ],
      },
    }),
  });
  const client = createLinearClient({ apiKey: KEY, fetchImpl });

  assert.deepEqual(await client.listProjects(), [
    { provider: "linear", id: "team-1", key: "ENG", name: "Engineering", url: "https://linear.app/acme/team/ENG/all" },
    { provider: "linear", id: "team-2", key: "DES", name: "Design", url: "https://linear.app/acme/team/DES/all" },
  ]);
  // A personal API key goes as it is, never as a bearer token.
  assert.equal(calls[0]!.authorization, KEY);

  const all = await client.listBoards();
  assert.deepEqual(all.map((board) => [board.id, board.name, board.projectId]), [
    ["team-1", "Engineering", "team-1"],
    ["team-1:proj-1", "Mobile app", "team-1"],
    ["team-1:proj-2", "Launch · ENG", "team-1"],
    ["team-2", "Design", "team-2"],
    ["team-2:proj-2", "Launch · DES", "team-2"],
  ], "a project shared by two teams names its team");
  assert.deepEqual(calls.at(-1)!.variables, {
    projectFilter: { status: { type: { nin: ["completed", "canceled"] } } },
  });

  const one = await client.listBoards("team-1");
  assert.deepEqual(one.map((board) => board.name), ["Engineering", "Mobile app", "Launch"]);
  assert.deepEqual(calls.at(-1)!.variables.teamFilter, { id: { eq: "team-1" } });

  const oauth = linear({ Teams: () => ({ organization: { urlKey: "acme" }, teams: { nodes: [] } }) });
  await createLinearClient({ apiKey: "lin_oauth_abcdefabcdefabcdefabcdef", fetchImpl: oauth.fetchImpl }).listProjects();
  assert.equal(oauth.calls[0]!.authorization, "Bearer lin_oauth_abcdefabcdefabcdefabcdef");
});

test("Linear board tasks load open and recently closed issues, most urgent first", async () => {
  const { calls, fetchImpl } = linear({
    Issues: () => ({
      issues: {
        nodes: [
          issue({ id: "a", identifier: "ENG-1", priority: 0, priorityLabel: "No priority", sortOrder: 1 }),
          issue({ id: "b", identifier: "ENG-2", priority: 4, priorityLabel: "Low", sortOrder: 2 }),
          issue({ id: "c", identifier: "ENG-3", priority: 1, priorityLabel: "Urgent", sortOrder: 9 }),
          issue({ id: "d", identifier: "ENG-4", priority: 1, priorityLabel: "Urgent", sortOrder: 3, assignee: null, attachments: { nodes: [] }, description: null }),
        ],
      },
    }),
  });
  const client = createLinearClient({ apiKey: KEY, fetchImpl });
  const tasks = await client.listTasks({ boardId: "team-1:proj-1", limit: 40 });

  assert.deepEqual(tasks.map((task) => task.key), ["ENG-4", "ENG-3", "ENG-2", "ENG-1"]);
  assert.deepEqual(calls[0]!.variables, {
    first: 40,
    filter: {
      and: [
        { team: { id: { eq: "team-1" } } },
        { project: { id: { eq: "proj-1" } } },
        { state: { type: { neq: "duplicate" } } },
        {
          or: [
            { state: { type: { nin: ["completed", "canceled"] } } },
            { completedAt: { gt: "-P2W" } },
            { canceledAt: { gt: "-P2W" } },
          ],
        },
      ],
    },
  });

  const mapped = tasks.find((task) => task.key === "ENG-3")!;
  assert.equal(mapped.provider, "linear");
  assert.equal(mapped.status.category, "in_progress");
  assert.deepEqual(mapped.priority, { level: "urgent", name: "Urgent" });
  assert.deepEqual(mapped.assignees, ["Iris Novak"]);
  assert.deepEqual(mapped.assigneePeople, [{ id: "u-iris", name: "Iris Novak", avatarUrl: "https://public.linear.app/avatar.png" }]);
  assert.deepEqual(mapped.labels, ["Mobile", "Bug"]);
  assert.equal(mapped.boardId, "team-1:proj-1");
  assert.equal(mapped.projectKey, "ENG");
  assert.equal(mapped.dueAt, "2026-10-20");
  assert.equal(mapped.availableStatuses, undefined, "lists leave statuses to the detail");
  // Pasted images and uploaded files read through Polyth; a link opens where
  // it lives; a non-web address never reaches the board.
  assert.deepEqual(mapped.attachments?.map((item) => [item.id, item.name, item.mimeType, item.url]), [
    ["upload~org-1~file-1", "screen.png", "image/png", "/api/task-trackers/linear/tasks/c/attachments/upload~org-1~file-1/content"],
    ["att-file", "trace.png", "image/png", "/api/task-trackers/linear/tasks/c/attachments/att-file/content"],
    ["att-pr", "PR #12", "text/uri-list", "https://github.com/acme/app/pull/12"],
  ]);
  const bare = tasks.find((task) => task.key === "ENG-4")!;
  assert.deepEqual([bare.assignees, bare.assigneePeople, bare.description, bare.attachments], [[], undefined, "", undefined]);

  await client.listTasks({ projectId: "team-2" });
  assert.deepEqual((calls.at(-1)!.variables.filter as { and: unknown[] }).and[0], { team: { id: { eq: "team-2" } } });
  await assert.rejects(() => client.listTasks({}), (cause: Error & { code?: string }) => cause.code === "invalid-input");
  await assert.rejects(() => client.listTasks({ boardId: "a:b:c" }), (cause: Error & { code?: string }) => cause.code === "invalid-input");
});

test("Linear details, columns, moves and writes go through the team's workflow", async () => {
  const writes: Array<[string, Record<string, unknown>]> = [];
  const { calls, fetchImpl } = linear({
    Issue: () => ({
      issue: {
        ...issue(),
        team: { id: "team-1", key: "ENG", states: { nodes: STATES } },
        comments: {
          nodes: [
            { id: "c2", body: "Second", createdAt: "2026-10-13T10:00:00.000Z", user: { id: "u-leo", name: "Leo Park" } },
            { id: "c1", body: "First", createdAt: "2026-10-12T10:00:00.000Z", user: null },
          ],
        },
      },
    }),
    TeamStates: () => ({ team: { id: "team-1", states: { nodes: STATES } } }),
    SetState: (variables) => {
      writes.push(["SetState", variables]);
      return { issueUpdate: { success: true } };
    },
    UpdateIssue: (variables) => {
      writes.push(["UpdateIssue", variables]);
      return { issueUpdate: { success: true } };
    },
    CreateIssue: (variables) => {
      writes.push(["CreateIssue", variables]);
      return {
        issueCreate: {
          success: true,
          issue: { ...issue({ id: "new-1", identifier: "ENG-50", title: "Plan" }), team: { id: "team-1", key: "ENG", states: { nodes: STATES } } },
        },
      };
    },
    CreateProject: (variables) => {
      writes.push(["CreateProject", variables]);
      return { projectCreate: { success: true, project: { id: "proj-9", name: "Q4", url: "https://linear.app/acme/project/q4" } } };
    },
    IssueId: () => ({ issue: { id: "1b4e28ba-2fa1-11d2-883f-0016d3cca427" } }),
    Comment: (variables) => {
      writes.push(["Comment", variables]);
      return { commentCreate: { success: true } };
    },
    Archive: (variables) => {
      writes.push(["Archive", variables]);
      return { issueArchive: { success: true } };
    },
    Delete: (variables) => {
      writes.push(["Delete", variables]);
      return { issueDelete: { success: false } };
    },
  });
  const client = createLinearClient({ apiKey: KEY, fetchImpl });

  const detail = await client.getTask("ENG-41");
  assert.equal(calls[0]!.variables.id, "ENG-41", "an issue reads by its key too");
  assert.deepEqual(detail.availableStatuses?.map((status) => `${status.name}:${status.category}`), [
    "Backlog:todo", "Todo:todo", "In Progress:in_progress", "In Review:in_progress", "Done:done", "Canceled:done",
  ], "states follow Linear's category order, the reserved Duplicate left out");
  assert.deepEqual(detail.comments?.map((comment) => [comment.author, comment.text]), [["Unknown", "First"], ["Leo Park", "Second"]]);

  const columns = await client.listColumns!("team-1:proj-1");
  assert.equal(columns.editable, false);
  assert.equal(columns.manageUrl, "https://linear.app/settings/teams");
  assert.deepEqual(columns.columns.map((column) => column.id), ["s-backlog", "s-todo", "s-progress", "s-review", "s-done", "s-canceled"]);

  await client.moveTask!("1b4e28ba-2fa1-11d2-883f-0016d3cca427", "team-1:proj-1", "s-review");
  assert.deepEqual(writes.at(-1), ["SetState", { id: "1b4e28ba-2fa1-11d2-883f-0016d3cca427", stateId: "s-review" }]);
  const before = writes.length;
  await assert.rejects(
    () => client.moveTask!("1b4e28ba-2fa1-11d2-883f-0016d3cca427", "team-1", "s-dup"),
    (cause: Error & { code?: string }) => cause.code === "not-found",
  );
  assert.equal(writes.length, before, "an unknown or reserved status writes nothing");

  await client.updateTask!("ENG-41", { title: "  Sync edits  ", description: "" });
  assert.deepEqual(writes.at(-1), ["UpdateIssue", { id: "ENG-41", input: { title: "Sync edits", description: "" } }]);

  const created = await client.createTask({ boardId: "team-1:proj-1", title: " Plan ", description: "Details" });
  assert.deepEqual(writes.at(-1), ["CreateIssue", { input: { teamId: "team-1", projectId: "proj-1", title: "Plan", description: "Details" } }]);
  assert.equal(created.key, "ENG-50");
  assert.equal(created.availableStatuses?.length, 6, "the create answer carries the team's statuses");
  await assert.rejects(() => client.createTask({ title: "Nowhere" }), (cause: Error & { code?: string }) => cause.code === "invalid-input");

  const board = await client.createBoard({ name: "Q4", projectId: "team-1" });
  assert.deepEqual(writes.at(-1), ["CreateProject", { input: { name: "Q4", teamIds: ["team-1"] } }]);
  assert.deepEqual(board, { provider: "linear", id: "team-1:proj-9", name: "Q4", type: "kanban", projectId: "team-1", url: "https://linear.app/acme/project/q4" });

  await client.addComment("ENG-41", "Done, see PR #12");
  assert.deepEqual(writes.at(-1), ["Comment", { input: { issueId: "1b4e28ba-2fa1-11d2-883f-0016d3cca427", body: "Done, see PR #12" } }]);

  await client.archiveTask!("ENG-41");
  assert.deepEqual(writes.at(-1), ["Archive", { id: "ENG-41" }]);
  await assert.rejects(
    () => client.deleteTask!("ENG-41"),
    (cause: Error & { mutationOutcome?: string }) => cause.mutationOutcome === "rejected",
    "success: false means Linear applied nothing",
  );
});

test("Linear failures keep their meaning: rejected keys, refused writes, rate limits, missing issues", async () => {
  const rejectedKey = linear({ Me: () => graphqlError(401, "AUTHENTICATION_ERROR", "Authentication required, not authenticated") });
  await assert.rejects(
    () => verifyLinearAccount({ apiKey: "lin_api_bad", fetchImpl: rejectedKey.fetchImpl }),
    (cause: Error & { code?: string }) => cause.code === "invalid-input" && cause.message === "Linear rejected this API key",
  );

  const verified = linear({
    Me: () => ({
      viewer: { id: "u-iris", name: "Iris Novak", email: "iris@acme.test", avatarUrl: "https://public.linear.app/a.png" },
      organization: { name: "Acme", urlKey: "acme" },
    }),
  });
  assert.deepEqual(await verifyLinearAccount({ apiKey: KEY, fetchImpl: verified.fetchImpl }), {
    name: "Iris Novak",
    email: "iris@acme.test",
    avatarUrl: "https://public.linear.app/a.png",
    site: "https://linear.app/acme",
  });

  const forbidden = linear({ SetState: () => graphqlError(403, "FORBIDDEN", "You don't have access to this team", 200) });
  await assert.rejects(
    () => createLinearClient({ apiKey: KEY, fetchImpl: forbidden.fetchImpl }).updateStatus("ENG-41", "s-done"),
    (cause: Error & { code?: string; httpStatus?: number; mutationOutcome?: string; trackerReason?: string }) =>
      cause.httpStatus === 403 && cause.mutationOutcome === "rejected" && cause.trackerReason === "You don't have access to this team"
      && /403 Forbidden/.test(cause.message),
  );

  const vague = linear({
    SetState: () => new Response(JSON.stringify({ data: null, errors: [{ message: "Something went wrong" }] }), { status: 200 }),
  });
  await assert.rejects(
    () => createLinearClient({ apiKey: KEY, fetchImpl: vague.fetchImpl }).updateStatus("ENG-41", "s-done"),
    (cause: Error & { mutationOutcome?: string }) => cause.mutationOutcome === undefined,
    "an error Linear gives no status for leaves a write's outcome unknown",
  );

  const limited = linear({ Teams: () => graphqlError(400, "RATELIMITED", "Rate limit exceeded") });
  await assert.rejects(
    () => createLinearClient({ apiKey: KEY, fetchImpl: limited.fetchImpl }).listProjects(),
    (cause: Error & { code?: string }) => cause.code === "unavailable" && /rate limit/i.test(cause.message),
  );

  const missing = linear({ Issue: () => graphqlError(400, "INVALID_INPUT", "Entity not found: Issue", 200) });
  await assert.rejects(
    () => createLinearClient({ apiKey: KEY, fetchImpl: missing.fetchImpl }).getTask("ENG-404"),
    (cause: Error & { code?: string }) => cause.code === "not-found",
  );

  const offline = createLinearClient({
    apiKey: KEY,
    fetchImpl: (async () => { throw new TypeError("fetch failed: secret"); }) as typeof fetch,
  });
  await assert.rejects(
    () => offline.updateStatus("ENG-41", "s-done"),
    (cause: Error & { code?: string; mutationOutcome?: string }) =>
      cause.code === "unavailable" && cause.mutationOutcome === undefined && !/secret/.test(cause.message),
    "a lost answer to a write stays an unknown outcome",
  );
});

test("Linear images upload to its storage without the key and read back only from uploads.linear.app", async () => {
  const puts: Array<{ url: string; headers: Headers; size: number }> = [];
  const downloads: Array<{ url: string; authorization: string | null }> = [];
  const { calls, fetchImpl } = linear({
    Upload: (variables) => ({
      fileUpload: {
        success: true,
        uploadFile: {
          uploadUrl: "https://storage.googleapis.com/linear-uploads/signed?x=1",
          assetUrl: `${ORG_UPLOAD}/file-9`,
          headers: [{ key: "Content-Type", value: String(variables.contentType) }, { key: "x-goog-meta-id", value: "abc" }],
        },
      },
    }),
    Attach: () => ({ attachmentCreate: { success: true } }),
    IssueFiles: () => ({ issue: { id: "1b4e28ba-2fa1-11d2-883f-0016d3cca427", description: issue().description, attachments: issue().attachments } }),
  }, (url, init) => {
    if (url.hostname === "storage.googleapis.com") {
      const headers = new Headers(init.headers);
      puts.push({ url: url.toString(), headers, size: (init.body as Blob).size });
      return new Response(null, { status: 200 });
    }
    if (url.hostname === "uploads.linear.app") {
      downloads.push({ url: url.toString(), authorization: new Headers(init.headers).get("authorization") });
      return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } });
    }
    return undefined;
  });
  const client = createLinearClient({ apiKey: KEY, fetchImpl });

  await client.addAttachments("1b4e28ba-2fa1-11d2-883f-0016d3cca427", [
    { name: "C:\\shots\\screen.png", mimeType: "image/png", data: Buffer.from("png-bytes").toString("base64") },
  ]);
  assert.deepEqual(calls.find((call) => call.operation === "Upload")!.variables, { contentType: "image/png", filename: "screen.png", size: 9 });
  assert.equal(puts.length, 1);
  assert.equal(puts[0]!.size, 9);
  assert.equal(puts[0]!.headers.get("authorization"), null, "the storage upload never sees the API key");
  assert.equal(puts[0]!.headers.get("content-type"), "image/png", "one content type, not a merged pair");
  assert.equal(puts[0]!.headers.get("x-goog-meta-id"), "abc");
  assert.equal(puts[0]!.headers.get("cache-control"), "public, max-age=31536000");
  assert.deepEqual(calls.find((call) => call.operation === "Attach")!.variables, {
    input: { issueId: "1b4e28ba-2fa1-11d2-883f-0016d3cca427", title: "screen.png", url: `${ORG_UPLOAD}/file-9` },
  });

  const pasted = await client.attachmentContent!("ENG-41", "upload~org-1~file-1", true);
  assert.equal(pasted.mimeType, "image/png");
  assert.deepEqual(downloads, [{ url: `${ORG_UPLOAD}/file-1`, authorization: KEY }]);
  await client.attachmentContent!("ENG-41", "att-file", false);
  assert.equal(downloads.at(-1)!.url, `${ORG_UPLOAD}/file-2`);
  for (const foreign of ["att-pr", "att-bad", "upload~other~file"]) {
    await assert.rejects(
      () => client.attachmentContent!("ENG-41", foreign, false),
      (cause: Error & { code?: string }) => cause.code === "not-found",
      `${foreign} is not a file of this issue`,
    );
  }
  assert.equal(downloads.length, 2);

  const hostile = linear({
    Upload: () => ({ fileUpload: { success: true, uploadFile: { uploadUrl: "http://evil.test/put", assetUrl: `${ORG_UPLOAD}/x`, headers: [] } } }),
  });
  await assert.rejects(
    () => createLinearClient({ apiKey: KEY, fetchImpl: hostile.fetchImpl })
      .addAttachments("1b4e28ba-2fa1-11d2-883f-0016d3cca427", [{ name: "a.png", mimeType: "image/png", data: "AAAA" }]),
    (cause: Error & { code?: string }) => cause.code === "unavailable",
  );
});

test("the board's 'me' is the caller's own account only", async () => {
  const viewer = linear({ Viewer: () => ({ viewer: { id: "u-iris", name: "Iris Novak", avatarUrl: null } }) });
  const service = (source: "personal" | "connection" | "env", connectedBy: string | undefined, viewerUserId: string | undefined) =>
    createTaskTrackerService({
      credentials: { linear: { apiKey: KEY, source, ...(connectedBy ? { connectedBy } : {}) } },
      fetchImpl: viewer.fetchImpl,
      ...(viewerUserId ? { viewerUserId } : {}),
    });
  assert.deepEqual(await service("connection", "u1", "u1").currentUser!("linear"), {
    person: { id: "u-iris", name: "Iris Novak" },
    own: true,
  });
  assert.equal((await service("connection", "u1", "u2").currentUser!("linear")).own, false, "someone else's shared account");
  assert.equal((await service("connection", undefined, "u1").currentUser!("linear")).own, false, "a shared account of unknown owner");
  assert.equal((await service("env", undefined, "u1").currentUser!("linear")).own, false, "server credentials");
  assert.equal((await service("personal", "u1", "u1").currentUser!("linear")).own, true);
  const demo = await createTaskTrackerService({ env: {} }).currentUser!("linear");
  assert.deepEqual(demo, { person: { id: "demo-user-iris-novak", name: "Iris Novak" }, own: true });
});

test("connecting Linear keeps the key in the vault and the shared account's owner on the server", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tt-linear-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const secrets = new Map<string, string>();
  const vault: TaskTrackerVault = {
    putOpaque: (key, value) => { secrets.set(key, value); },
    getOpaque: (key) => secrets.get(key) ?? null,
    deleteOpaque: (key) => { secrets.delete(key); },
  };
  const { fetchImpl } = linear({
    Me: () => ({ viewer: { id: "u-iris", name: "Iris Novak", email: "iris@acme.test" }, organization: { urlKey: "acme" } }),
    Viewer: () => ({ viewer: { id: "u-iris", name: "Iris Novak" } }),
  });
  const management = createTaskTrackerManagement({
    storage: () => ({ packageDir: () => root }) as never,
    vault: () => vault,
    env: {},
    fetchImpl,
  });
  const space = (userId: string, role: "admin" | "member" = "admin"): SpaceContext =>
    ({ spaceId: "space-1", userId, role }) as SpaceContext;

  await assert.rejects(
    () => management.connectLinear(space("admin-1"), { apiKey: "lin api key" }),
    (cause: Error & { code?: string }) => cause.code === "invalid-input",
  );
  await assert.rejects(
    () => management.connectLinear(space("member-1", "member"), { apiKey: KEY }),
    (cause: Error & { code?: string }) => cause.code === "forbidden",
    "only admins connect the shared account",
  );
  const state = await management.connectLinear(space("admin-1"), { apiKey: KEY });
  assert.equal(state.connections[0]?.provider, "linear");
  assert.equal(state.connections[0]?.account.site, "https://linear.app/acme");
  assert.equal(JSON.stringify(state).includes(KEY), false, "the key never enters a DTO");
  assert.equal("connectedBy" in state.connections[0]!, false, "who connected it stays on the server");
  assert.deepEqual(JSON.parse(secrets.get("task-trackers:space-1:linear")!), { provider: "linear", apiKey: KEY });
  assert.equal(readFileSync(join(root, "state.json"), "utf8").includes(KEY), false);
  assert.equal(state.providers.find((item) => item.provider === "linear")?.source, "connection");

  // The route answers "me" for the board; only the admin who connected the
  // shared account sees it as their own.
  const routes = taskTrackerRoutes({
    trackers: (request) => management.trackers(request.space),
    management,
    snapshot: async () => { throw new Error("unused"); },
    events: async () => [],
    append: async () => { throw new Error("unused"); },
    send: async () => undefined,
  });
  const me = async (userId: string) => {
    let payload: unknown;
    await routes({
      path: "/api/task-trackers/linear/me",
      method: "GET",
      url: new URL("http://polyth.test/api/task-trackers/linear/me"),
      space: space(userId),
      body: async () => ({}),
      json: (_status: number, value: unknown) => { payload = value; },
    } as unknown as RouteRequest);
    return payload as { own: boolean; person: { id: string } };
  };
  assert.deepEqual(await me("admin-1"), { person: { id: "u-iris", name: "Iris Novak" }, own: true });
  assert.equal((await me("admin-2")).own, false);

  const verified = await management.verify(space("admin-2"), "linear");
  assert.equal(verified.connections[0]?.account.name, "Iris Novak");
  assert.equal((await me("admin-1")).own, true, "testing the connection does not change its owner");
  management.disconnect(space("admin-1"), "linear");
  assert.equal(secrets.size, 0);
});

test("a personal Linear account belongs to its person, and 'Mine' follows the account in use", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tt-linear-person-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const secrets = new Map<string, string>();
  const vault: TaskTrackerVault = {
    putOpaque: (key, value) => { secrets.set(key, value); },
    getOpaque: (key) => secrets.get(key) ?? null,
    deleteOpaque: (key) => { secrets.delete(key); },
  };
  const people = fakePeople(root, { spc_a: ["admin-1", "member-1", "member-2"] });
  const { fetchImpl } = linear({
    Me: () => ({ viewer: { id: "u-iris", name: "Iris Novak", email: "iris@acme.test" }, organization: { urlKey: "acme" } }),
    Viewer: () => ({ viewer: { id: "u-iris", name: "Iris Novak" } }),
  });
  const management = createTaskTrackerManagement({
    storage: () => ({ packageDir: () => join(root, "space") }) as never,
    vault: () => vault,
    people: () => people,
    env: { LINEAR_API_KEY: "lin_api_installationinstallation" },
    fetchImpl,
  });
  const space = (userId: string, role: "admin" | "member" = "member"): SpaceContext =>
    ({ spaceId: "spc_a", userId, role }) as SpaceContext;
  const linearOf = (dto: { providers: ReadonlyArray<{ provider: string; source?: string }> }) =>
    dto.providers.find((item) => item.provider === "linear")?.source;

  const mine = await management.connectLinear(space("member-1"), { apiKey: KEY }, "personal");
  const own = mine.personalConnections?.find((item) => item.provider === "linear");
  assert.match(own?.id ?? "", /^linear-[0-9a-f-]{36}$/);
  assert.equal(own?.enabled, true, "connecting from a Space turns it on there");
  assert.equal(linearOf(mine), "personal");
  assert.equal(secrets.size, 0, "a personal key never enters the Space vault");
  assert.deepEqual(JSON.parse(people.secrets.get("member-1")!.get(`connection:${own!.id}`)!), { provider: "linear", apiKey: KEY });
  assert.equal(JSON.stringify(mine).includes(KEY), false);
  assert.equal(JSON.stringify(management.state(space("member-2"))).includes(own!.id!), false, "nobody else sees it");

  // The person's own account is their "me", in the UI and for their agent.
  assert.equal((await management.trackers(space("member-1")).currentUser!("linear")).own, true);
  const agent = management.agentTrackers(space("member-1"), { origin: "agent", userId: "member-1" }, "linear");
  assert.equal(agent.providers().find((item) => item.provider === "linear")?.source, "personal");
  assert.equal((await agent.currentUser!("linear")).own, true);

  // LINEAR_API_KEY is the instance owner's alone, and nobody's "me".
  assert.equal(linearOf(management.state(space("member-2"))), "demo");
  const installation = management.trackers(space("member-2"), { installationOwner: true });
  assert.equal(installation.providers().find((item) => item.provider === "linear")?.source, "env");
  assert.equal((await installation.currentUser!("linear")).own, false);

  // A Space service account is "me" only for the admin who connected it; an
  // agent may use it only under the Space policy.
  await management.connectLinear(space("admin-1", "admin"), { apiKey: KEY });
  assert.equal((await management.trackers(space("admin-1", "admin")).currentUser!("linear")).own, true);
  const other = management.trackers(space("member-2"));
  assert.equal(other.providers().find((item) => item.provider === "linear")?.source, "connection");
  assert.equal((await other.currentUser!("linear")).own, false);
  assert.throws(
    () => management.agentTrackers(space("member-2"), { origin: "agent", userId: "member-2" }, "linear"),
    (cause: Error & { code?: string }) => cause.code === "forbidden" && /Connect your Linear account/.test(cause.message),
  );
  assert.equal(linearOf(management.state(space("member-1"))), "personal", "their own account still wins for them");

  management.disconnect(space("member-1"), "linear", "personal");
  assert.equal(people.secrets.get("member-1")?.size, 0);
  assert.equal(linearOf(management.state(space("member-1"))), "connection");
});
