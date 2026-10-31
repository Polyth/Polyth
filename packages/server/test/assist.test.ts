// Core utility-model note and task-brief routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection, SpaceContext } from "@polyth/contracts";
import { buildNotePrompt, parseNoteReply } from "../src/assist.ts";
import { assistRoutes } from "../src/routes/assist.ts";
import type { RouteRequest } from "../src/http.ts";

test("note transforms produce a bounded title and markdown draft", () => {
  assert.match(buildNotePrompt("T"), /project note/);
  assert.deepEqual(parseNoteReply("Title here\n\nBody line"), { title: "Title here", body: "Body line" });
  assert.deepEqual(parseNoteReply("only-title"), { title: "only-title", body: "" });
});

function routeHarness(opts: {
  projections?: Record<string, SessionProjection>;
  distill?: (space: SpaceContext, sessionId: string) => Promise<{ title: string; body: string }>;
  taskBrief?: (space: SpaceContext, sessionId: string) => Promise<string>;
}) {
  const routes = assistRoutes({
    projection: async (id) => opts.projections?.[id],
    ...(opts.distill ? { distill: opts.distill } : {}),
    ...(opts.taskBrief ? { taskBrief: opts.taskBrief } : {}),
  });
  const call = async (method: string, path: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    const rc = {
      req: {}, res: {}, space: { spaceId: "space-1", userId: "usr_test", membership: { role: "owner" } },
      url: new URL(`http://x${path}`),
      path, method,
      body: async () => body,
      json: (code: number, b: unknown) => { status = code; payload = b; },
    } as unknown as RouteRequest;
    const handled = await routes(rc);
    return { handled, status, payload };
  };
  return { call };
}

const proj = (id: string): SessionProjection => ({
  id, projectId: "p1", title: "t", status: "idle", createdAt: 1, updatedAt: 1,
});

test("POST assist/note: 404 unknown, 503 unwired, draft when wired, 502 on failure", async () => {
  const unknown = routeHarness({ distill: async () => ({ title: "t", body: "b" }) });
  assert.equal((await unknown.call("POST", "/api/sessions/nope/assist/note")).status, 404);

  const unwired = routeHarness({ projections: { s1: proj("s1") } });
  assert.equal((await unwired.call("POST", "/api/sessions/s1/assist/note")).status, 503);

  const wired = routeHarness({
    projections: { s1: proj("s1") },
    distill: async (_space, id) => ({ title: `Note for ${id}`, body: "decisions" }),
  });
  const ok = await wired.call("POST", "/api/sessions/s1/assist/note");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.payload, { title: "Note for s1", body: "decisions" });

  const failing = routeHarness({
    projections: { s1: proj("s1") },
    distill: async () => { throw new Error("model offline"); },
  });
  const soft = await failing.call("POST", "/api/sessions/s1/assist/note");
  assert.equal(soft.status, 502);
  assert.match(String((soft.payload as { message: string }).message), /model offline/);
});
test("POST task-brief is guarded and returns the small-model summary", async () => {
  const unknown = routeHarness({ taskBrief: async () => "brief" });
  assert.equal((await unknown.call("POST", "/api/sessions/nope/task-brief")).status, 404);

  const unwired = routeHarness({ projections: { s1: proj("s1") } });
  assert.equal((await unwired.call("POST", "/api/sessions/s1/task-brief")).status, 503);

  const wired = routeHarness({ projections: { s1: proj("s1") }, taskBrief: async () => "Ship mobile task overview" });
  assert.deepEqual((await wired.call("POST", "/api/sessions/s1/task-brief")).payload, { brief: "Ship mobile task overview" });
});
test("small-model routes forward the authenticated account identity", async () => {
  const seen: string[] = [];
  const h = routeHarness({
    projections: { s1: proj("s1") },
    distill: async (space, sessionId) => {
      seen.push(`${space.userId}:${sessionId}`);
      return { title: "Note", body: "Body" };
    },
    taskBrief: async (space, sessionId) => {
      seen.push(`${space.userId}:${sessionId}`);
      return "Brief";
    },
  });
  await h.call("POST", "/api/sessions/s1/assist/note");
  await h.call("POST", "/api/sessions/s1/task-brief");
  assert.deepEqual(seen, ["usr_test:s1", "usr_test:s1"]);
});

test("core routes do not serve optional prompt inference", async () => {
  const h = routeHarness({ projections: { s1: proj("s1") } });
  assert.equal((await h.call("POST", "/api/sessions/s1/assist/suggestion")).handled, false);
  assert.equal((await h.call("POST", "/api/projects/p1/assist/prompt", { draft: "fix it" })).handled, false);
});
