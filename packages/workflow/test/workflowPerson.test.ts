import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HarnessRegistry,
  JsonObject,
  RouteRequest,
  SessionEvent,
  SpaceContext,
  SpaceStorage,
  WorkflowDto,
  WorkflowRunDto,
} from "@polyth/contracts";
import {
  createServerServiceRegistry,
  serverServiceKey,
  type ServerPackageHost,
} from "@polyth/plugins";
import registerPackage from "../src/serverEntry.ts";

// Two people share one Space. Workflows must act for the person who started
// each run, never for whoever first opened workflows in that Space.

const person = (userId: string): SpaceContext => ({
  spaceId: "space-a",
  spaceSlug: "space-a",
  userId,
  role: "member",
  deployment: "local-trusted",
  storageDir: "/tmp/space-a",
});

function call(
  space: SpaceContext,
  path: string,
  method: string,
  value: Record<string, unknown> = {},
): { request: RouteRequest; response: { status?: number; body?: unknown } } {
  const response: { status?: number; body?: unknown } = {};
  const url = new URL(`http://localhost${path}`);
  return {
    response,
    request: {
      req: {},
      res: {},
      url,
      path: url.pathname,
      method,
      ingress: "local",
      principal: { kind: "user", userId: space.userId },
      space,
      requireCapability: () => {},
      body: async () => value,
      json: (status: number, body: unknown) => {
        response.status = status;
        response.body = body;
      },
    } as unknown as RouteRequest,
  };
}

const event = (sessionId: string, seq: number, type: string, data: JsonObject): SessionEvent => ({
  id: `${sessionId}-${seq}`,
  sessionId,
  seq,
  time: seq,
  type,
  data,
  v: 1,
});

function sharedSpace(onSend?: (userId: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "polyth-workflow-person-"));
  const members = new Set(["alice", "bob"]);
  const events = new Map<string, SessionEvent[]>([["parent", []]]);
  /** Every scoped call records the person whose context served it. */
  const calls: Array<{ op: string; userId: string; sessionId?: string }> = [];
  const resolved: string[] = [];
  const project = { id: "project", name: "Project", path: "/project", spaceId: "space-a", createdAt: 0 };
  let children = 0;
  const forSpace = (ctx: SpaceContext) => ({
    projects: {
      list: async () => {
        calls.push({ op: "projects.list", userId: ctx.userId });
        return [project];
      },
      get: async (id: string) => {
        calls.push({ op: "projects.get", userId: ctx.userId });
        return id === project.id ? project : undefined;
      },
    },
    sessions: {
      create: async () => {
        const id = `child-${++children}`;
        calls.push({ op: "create", userId: ctx.userId, sessionId: id });
        events.set(id, []);
        return { id };
      },
      autoAcceptSet: async () => ({ setting: "off", effective: false }),
      send: async (sessionId: string) => {
        calls.push({ op: "send", userId: ctx.userId, sessionId });
        onSend?.(ctx.userId);
        const log = events.get(sessionId) ?? [];
        const seq = log.length;
        log.push(
          event(sessionId, seq + 1, "assistant/message", { text: "done" }),
          event(sessionId, seq + 2, "turn/stopped", { reason: "completed" }),
        );
        return {};
      },
      events: async (sessionId: string, afterSeq = 0) => {
        calls.push({ op: "events", userId: ctx.userId, sessionId });
        return (events.get(sessionId) ?? []).filter((item) => item.seq > afterSeq);
      },
      snapshot: async (sessionId: string) =>
        sessionId === "parent"
          ? ({ id: "parent", projectId: "project", status: "idle", spaceId: "space-a" } as never)
          : undefined,
      abort: async () => {},
    },
  });
  const storage: SpaceStorage = {
    root,
    packageDir(packageId) {
      const directory = join(root, "packages", packageId);
      mkdirSync(directory, { recursive: true });
      return directory;
    },
    path: (relative) => join(root, relative),
  };
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey<HarnessRegistry>("harnesses"), {
    resolve: async (context: { space: SpaceContext }) => {
      resolved.push(context.space.userId);
      return {};
    },
  } as unknown as HarnessRegistry);
  let nextSeq = 0;
  const host = {
    pluginId: "workflow",
    storageDir: root,
    services,
    spaceStorage: () => storage,
    systemSpaceContext: () => person("system:space"),
    personSpaceContext: (userId: string, spaceId: string) =>
      spaceId === "space-a" && members.has(userId) ? person(userId) : undefined,
    forSpace,
    events: {
      append: async (sessionId: string, type: string, data: JsonObject) => {
        const appended = event(sessionId, ++nextSeq, type, data);
        events.set(sessionId, [...(events.get(sessionId) ?? []), appended]);
        return appended;
      },
    },
  } as unknown as ServerPackageHost;
  const route = registerPackage(host).routes!;
  const file = join(root, "packages", "workflow", "workflows.json");
  return { route, calls, resolved, members, file };
}

const settle = async (route: RouteHandlerLike, runId: string, as: SpaceContext): Promise<WorkflowRunDto> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    const read = call(as, `/api/workflow-runs/${runId}`, "GET");
    await route(read.request);
    const run = read.response.body as WorkflowRunDto;
    if (run.status !== "running") return run;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`workflow run ${runId} did not settle`);
};
type RouteHandlerLike = (request: RouteRequest) => Promise<boolean>;

test("each run acts for the person who started it, not the first caller in the Space", async () => {
  const { route, calls, resolved, file } = sharedSpace();
  const alice = person("alice");
  const bob = person("bob");

  // Alice opens workflows first, which creates the Space's shared service.
  const created = call(alice, "/api/workflows", "POST", {
    projectId: "project",
    name: "Shared",
    nodes: [{ id: "a", role: "A", prompt: "Do A", harness: { mode: "pinned", harnessId: "bob-private" } }],
    edges: [],
  });
  await route(created.request);
  const workflow = created.response.body as WorkflowDto;
  calls.length = 0;

  const started = call(bob, `/api/workflows/${workflow.id}/run`, "POST", {
    sessionId: "parent",
    input: "bob's request",
  });
  await route(started.request);
  const run = await settle(route, (started.response.body as WorkflowRunDto).id, bob);
  assert.equal(run.status, "done");

  const nodeWork = calls.filter((entry) => ["create", "send", "projects.get"].includes(entry.op));
  assert.ok(nodeWork.some((entry) => entry.op === "create"));
  assert.ok(nodeWork.some((entry) => entry.op === "send"));
  assert.deepEqual(new Set(nodeWork.map((entry) => entry.userId)), new Set(["bob"]));
  assert.deepEqual(resolved, ["bob"], "the pinned harness is resolved for Bob");
  assert.ok(!calls.some((entry) => entry.userId === "alice" && entry.op !== "projects.get"),
    "nothing in Bob's run used Alice's context");

  // The launcher is stored beside the run, never in the run sent to clients.
  assert.equal("launchedBy" in run, false);
  const stored = JSON.parse(readFileSync(file, "utf8")) as { launchers?: Record<string, string> };
  assert.equal(stored.launchers?.[run.id], "bob");
});

test("a run whose launcher left is refused, and a retry by someone else acts for the retrier", async () => {
  let leaveAfterFirstUnit = true;
  const space = sharedSpace((userId) => {
    // Bob leaves the Space while his first unit is working.
    if (userId === "bob" && leaveAfterFirstUnit) space.members.delete("bob");
  });
  const { route, calls, members } = space;
  const alice = person("alice");
  const bob = person("bob");
  const created = call(alice, "/api/workflows", "POST", {
    projectId: "project",
    name: "Departure",
    nodes: [
      { id: "a", role: "A", prompt: "Do A" },
      { id: "b", role: "B", prompt: "Do B" },
    ],
    edges: [{ id: "a-b", source: "a", target: "b" }],
  });
  await route(created.request);
  const workflow = created.response.body as WorkflowDto;

  const started = call(bob, `/api/workflows/${workflow.id}/run`, "POST", {
    sessionId: "parent",
    input: "bob's request",
  });
  await route(started.request);
  const runId = (started.response.body as WorkflowRunDto).id;
  const failed = await settle(route, runId, alice);
  assert.equal(failed.status, "error");
  assert.equal(failed.nodes.find((entry) => entry.id === "a")?.status, "done");
  const refused = failed.nodes.find((entry) => entry.id === "b")!;
  assert.equal(refused.status, "error");
  assert.match(refused.error ?? "", /no longer a member of this Space/);
  assert.equal(refused.retryable, true, "refusal happens before any child exists");
  assert.equal(calls.filter((entry) => entry.op === "create").length, 1, "no child for the refused unit");

  // Bob rejoins; Alice retries. The fork acts for Alice, never borrowing Bob's accounts.
  members.add("bob");
  leaveAfterFirstUnit = false;
  calls.length = 0;
  const retried = call(alice, `/api/workflow-runs/${runId}/retry`, "POST", { nodeId: "b" });
  await route(retried.request);
  const retry = await settle(route, (retried.response.body as WorkflowRunDto).id, alice);
  assert.equal(retry.status, "done");
  const nodeWork = calls.filter((entry) => entry.op === "create" || entry.op === "send");
  assert.ok(nodeWork.length >= 2);
  assert.deepEqual(new Set(nodeWork.map((entry) => entry.userId)), new Set(["alice"]));
});

test("a run started by system work keeps the Space's system context", async () => {
  const { route, calls } = sharedSpace();
  const system = person("system:automation");
  const created = call(system, "/api/workflows", "POST", {
    projectId: "project",
    name: "Background",
    nodes: [{ id: "a", role: "A", prompt: "Do A" }],
    edges: [],
  });
  await route(created.request);
  const workflow = created.response.body as WorkflowDto;
  calls.length = 0;
  const started = call(system, `/api/workflows/${workflow.id}/run`, "POST", {
    sessionId: "parent",
    input: "scheduled request",
  });
  await route(started.request);
  const run = await settle(route, (started.response.body as WorkflowRunDto).id, system);
  assert.equal(run.status, "done");
  const nodeWork = calls.filter((entry) => entry.op === "create" || entry.op === "send");
  assert.deepEqual(new Set(nodeWork.map((entry) => entry.userId)), new Set(["system:space"]));
});
