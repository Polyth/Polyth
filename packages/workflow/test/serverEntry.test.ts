import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  JsonObject,
  HarnessRegistry,
  RouteRequest,
  SessionEvent,
  SpaceContext,
  SpaceStorage,
  UserTurnInput,
  WorkflowLaunchOptionsDto,
  WorkflowRunContextDto,
  WorkflowRunDto,
  WorkflowDto,
} from "@polyth/contracts";
import {
  createServerServiceRegistry,
  serverServiceKey,
  type ServerPackageHost,
} from "@polyth/plugins";
import {
  createWorkflowService,
  type RunNodeFn,
  type WorkflowService,
} from "../src/index.ts";
import { getWorkflowPreset, workflowPresets } from "../src/presets.ts";
import registerPackage, { workflowRoutes } from "../src/serverEntry.ts";

const space = (spaceId: string): SpaceContext => ({
  spaceId,
  spaceSlug: spaceId,
  userId: "user",
  role: "owner",
  deployment: "local-trusted",
  storageDir: `/tmp/${spaceId}`,
});

function request(
  currentSpace: SpaceContext,
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
      principal: { kind: "user", userId: "user" },
      space: currentSpace,
      requireCapability: () => {},
      body: async () => value,
      json: (status: number, body: unknown) => {
        response.status = status;
        response.body = body;
      },
    } as unknown as RouteRequest,
  };
}

function routeHarness(
  service: WorkflowService,
  projectSpace = "space-a",
  capturedEvents: Array<{ type: string; data: JsonObject }> = [],
  parent: Record<string, unknown> = {},
) {
  const projects = {
    get: async (id: string) =>
      id === "project" ? { id, name: "Project", path: "/project", spaceId: projectSpace } : undefined,
  };
  const sessions = {
    snapshot: async (id: string) =>
      id === "parent"
        ? { id, projectId: "project", status: "idle", spaceId: projectSpace, ...parent }
        : undefined,
  };
  const route = workflowRoutes(service, undefined, {
    forSpace: () => ({ projects, sessions }),
  } as never);
  const append = async (_sessionId: string, type: string, data: JsonObject) => {
    capturedEvents.push({ type, data });
  };
  return { route, append };
}

function serviceIn(
  runNode: RunNodeFn,
  buildContext?: (
    sessionId: string,
    launch?: WorkflowLaunchOptionsDto,
    input?: string,
  ) => Promise<WorkflowRunContextDto | undefined>,
  builtin = (id: string) => getWorkflowPreset(id),
  append: (
    sessionId: string,
    type: string,
    data: JsonObject,
  ) => Promise<unknown> = async () => {},
) {
  return createWorkflowService({
    file: join(mkdtempSync(join(tmpdir(), "polyth-workflow-route-")), "workflows.json"),
    append,
    runNode,
    ...(buildContext ? { buildContext } : {}),
    builtin,
  });
}

const canonicalEvent = (
  sessionId: string,
  seq: number,
  type: string,
  data: JsonObject,
): SessionEvent => ({
  id: `${sessionId}-${seq}`,
  sessionId,
  seq,
  time: seq,
  type,
  data,
  v: 1,
});

function registeredRouteHarness(seed: SessionEvent[], harnesses?: HarnessRegistry) {
  const root = mkdtempSync(join(tmpdir(), "polyth-workflow-registered-"));
  const events = new Map<string, SessionEvent[]>([["parent", [...seed]]]);
  const childInputs: UserTurnInput[] = [];
  let childCreates = 0;
  const appended: SessionEvent[] = [];
  const nextSeq = new Map<string, number>([
    ["parent", Math.max(0, ...seed.map((event) => event.seq))],
  ]);
  const project = {
    id: "project",
    name: "Project",
    path: "/project",
    spaceId: "space-a",
    createdAt: 0,
  };
  const sessions = {
    create: async () => {
      childCreates++;
      const id = `child-${childInputs.length + 1}`;
      events.set(id, [canonicalEvent(id, 1, "turn/stopped", { reason: "completed" })]);
      return { id };
    },
    autoAcceptSet: async () => ({ setting: "off", effective: false }),
    send: async (_sessionId: string, input: UserTurnInput) => {
      childInputs.push(input);
      return {};
    },
    events: async (sessionId: string, afterSeq = 0) =>
      (events.get(sessionId) ?? []).filter((event) => event.seq > afterSeq),
    snapshot: async (sessionId: string) =>
      sessionId === "parent"
        ? ({ id: "parent", projectId: "project", status: "idle", spaceId: "space-a" } as never)
        : undefined,
    abort: async () => {},
  };
  const scoped = {
    projects: {
      list: async () => [project],
      get: async (id: string) => (id === project.id ? project : undefined),
    },
    sessions,
  };
  const storage: SpaceStorage = {
    root,
    packageDir(packageId) {
      const directory = join(root, "packages", packageId);
      mkdirSync(directory, { recursive: true });
      return directory;
    },
    path(relative) {
      return join(root, relative);
    },
  };
  const services = createServerServiceRegistry();
  if (harnesses)
    services.provide(serverServiceKey<HarnessRegistry>("harnesses"), harnesses);
  const host = {
    pluginId: "workflow",
    storageDir: root,
    services,
    spaceStorage: () => storage,
    systemSpaceContext: (spaceId: string) => ({ ...space(spaceId), userId: "system:test" }),
    forSpace: () => scoped,
    events: {
      append: async (sessionId: string, type: string, data: JsonObject) => {
        const seq = (nextSeq.get(sessionId) ?? 0) + 1;
        nextSeq.set(sessionId, seq);
        const event = canonicalEvent(sessionId, seq, type, data);
        events.set(sessionId, [...(events.get(sessionId) ?? []), event]);
        appended.push(event);
        return event;
      },
    },
  } as unknown as ServerPackageHost;
  const registered = registerPackage(host);
  return { route: registered.routes!, childInputs, childCreates: () => childCreates, appended };
}

test("built-in workflows run directly and copies preserve origin metadata", async () => {
  const preset = workflowPresets("project")[0]!;
  const service = serviceIn(async () => ({ output: "ok" }));
  const { route } = routeHarness(service);
  const runRequest = request(space("space-a"), `/api/workflows/${encodeURIComponent(preset.id)}/run`, "POST", {
    sessionId: "parent",
    input: "Task",
  });
  await route(runRequest.request);
  assert.equal(runRequest.response.status, 200);

  const copyRequest = request(space("space-a"), "/api/workflows", "POST", {
    projectId: "project",
    name: "Build + Review copy",
    preset: preset.preset,
    nodes: preset.nodes,
    edges: preset.edges,
  });
  await route(copyRequest.request);
  assert.equal(copyRequest.response.status, 200);
  assert.deepEqual((copyRequest.response.body as WorkflowDto).preset, preset.preset);
  assert.equal((copyRequest.response.body as WorkflowDto).builtin, undefined);
});

test("workflow routes seed unassigned nodes from the current parent chat route", async () => {
  const service = serviceIn(async () => ({ output: "ok" }));
  const { route } = routeHarness(service, "space-a", [], {
    model: { providerID: "chat", modelID: "current", variant: "high" },
    resolvedHarnessId: "chat-harness",
    agent: "chat-agent",
  });
  const create = request(space("space-a"), "/api/workflows", "POST", {
    projectId: "project",
    name: "Current route",
    nodes: [{ id: "a", role: "A", prompt: "Do A" }],
    edges: [],
  });
  await route(create.request);
  const workflow = create.response.body as WorkflowDto;
  const run = request(space("space-a"), `/api/workflows/${workflow.id}/run`, "POST", {
    sessionId: "parent",
    input: "Use the current chat route",
  });
  await route(run.request);
  assert.equal(run.response.status, 200);
  const started = run.response.body as WorkflowRunDto;
  assert.deepEqual(started.nodes[0]?.model, {
    providerID: "chat",
    modelID: "current",
    variant: "high",
  });
  assert.deepEqual(started.nodes[0]?.harness, { mode: "pinned", harnessId: "chat-harness" });
  assert.equal(started.nodes[0]?.agent, "chat-agent");
});

test("workflow routes persist auto allow-lists and resolve them at launch", async () => {
  const service = serviceIn(async () => ({ output: "ok" }));
  const { route } = routeHarness(service, "space-a", [], {
    model: { providerID: "chat", modelID: "current" },
    resolvedHarnessId: "chat-harness",
  });
  const create = request(space("space-a"), "/api/workflows", "POST", {
    projectId: "project",
    name: "Auto route",
    nodes: [
      { id: "auto", role: "Auto", prompt: "Do A", model: { providerID: "old", modelID: "pinned" }, allowedModels: [{ providerID: "x", modelID: "y" }] },
      { id: "pinned", role: "Pinned", prompt: "Do B", model: { providerID: "z", modelID: "w" } },
    ],
    edges: [],
  });
  await route(create.request);
  const workflow = create.response.body as WorkflowDto;
  assert.deepEqual(workflow.nodes[0]?.allowedModels, [{ providerID: "x", modelID: "y" }],
    "the allow-list survives the route boundary");
  const run = request(space("space-a"), `/api/workflows/${workflow.id}/run`, "POST", {
    sessionId: "parent",
    input: "Task",
  });
  await route(run.request);
  const started = run.response.body as WorkflowRunDto;
  assert.deepEqual(started.nodes.find((entry) => entry.id === "auto")?.model,
    { providerID: "x", modelID: "y" }, "a disallowed chat model falls back to the allow-list, not a stale pin");
  assert.deepEqual(started.nodes.find((entry) => entry.id === "pinned")?.model,
    { providerID: "z", modelID: "w" }, "a pinned model still wins");
});

test("workflow routes reject malformed and oversized allow-lists without creating a workflow", async () => {
  const service = serviceIn(async () => ({ output: "ok" }));
  const { route } = routeHarness(service);
  for (const allowedModels of [
    "all",
    [{ providerID: "p", modelID: "m" }, { providerID: "p" }],
    [{ providerID: "p", modelID: "m", variant: 1 }],
    Array.from({ length: 25 }, (_, index) => ({ providerID: "p", modelID: `m${index}` })),
  ]) {
    const create = request(space("space-a"), "/api/workflows", "POST", {
      projectId: "project", name: "Invalid auto route",
      nodes: [{ id: "a", role: "A", prompt: "Do A", allowedModels }], edges: [],
    });
    await assert.rejects(route(create.request), (cause: unknown) =>
      (cause as { code?: string }).code === "invalid-input");
    assert.equal(service.list("project").length, 0);
  }
});

test("workflow PATCH preserves revisioned metadata and rejects foreign Space resources", async () => {
  const service = serviceIn(async () => ({ output: "ok" }));
  const { route } = routeHarness(service);
  const create = request(space("space-a"), "/api/workflows", "POST", {
    projectId: "project",
    name: "Editable",
    description: "before",
    category: "general",
    profile: "balanced",
    nodes: [{ id: "a", role: "A", prompt: "Do A" }],
    edges: [],
  });
  await route(create.request);
  const created = create.response.body as WorkflowDto;
  const update = request(space("space-a"), `/api/workflows/${created.id}`, "PATCH", {
    description: "after",
    category: "review",
    profile: "quality",
    expectedRevision: created.revision,
  });
  await route(update.request);
  assert.equal(update.response.status, 200);
  assert.equal((update.response.body as WorkflowDto).revision, (created.revision ?? 0) + 1);
  assert.equal((update.response.body as WorkflowDto).description, "after");
  assert.equal((update.response.body as WorkflowDto).category, "review");
  assert.equal((update.response.body as WorkflowDto).profile, "quality");

  const foreign = request(space("space-a"), "/api/workflows?projectId=project", "GET");
  const foreignHarness = routeHarness(service, "space-foreign");
  await assert.rejects(() => foreignHarness.route(foreign.request), /project not found/);
});

test("registered routes bound context to canonical messages and preserve child provenance", async () => {
  const seed = [
    canonicalEvent("parent", 1, "user/message", {
      text: `old ${"x".repeat(13_000)}`,
    }),
    canonicalEvent("parent", 2, "tool/call", { tool: "secret-tool" }),
    canonicalEvent("parent", 3, "secret/requested", { handle: "safe_1" }),
    canonicalEvent("parent", 4, "assistant/message", { text: "assistant reply" }),
    canonicalEvent("parent", 5, "user/message", { text: "latest user" }),
    canonicalEvent("parent", 6, "assistant/chunk", {
      partId: "part-1",
      text: "assistant chunk",
    }),
  ];
  const { route, childInputs, appended } = registeredRouteHarness(seed);
  const runRequest = request(space("space-a"), "/api/workflows", "POST", {
    projectId: "project",
    name: "Provenance",
    nodes: [{ id: "a", role: "A", prompt: "Do A" }],
    edges: [],
  });
  await route(runRequest.request);
  const workflow = runRequest.response.body as WorkflowDto;
  const waitForInput = async (index: number): Promise<UserTurnInput> => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const input = childInputs[index];
      if (input) return input;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.fail(`child input ${index} was not admitted`);
  };

  const recent = request(space("space-a"), `/api/workflows/${workflow.id}/run`, "POST", {
    sessionId: "parent",
    input: "recent request",
    launch: { context: "recent" },
  });
  await route(recent.request);
  assert.equal(recent.response.status, 200);
  const recentInput = await waitForInput(0);
  assert.match(recentInput.text, /latest user/);
  assert.match(recentInput.text, /assistant chunk/);
  assert.doesNotMatch(recentInput.text, /secret-tool|safe_1/);
  assert.ok(recentInput.text.length <= 12_000);

  const requestOnly = request(space("space-a"), `/api/workflows/${workflow.id}/run`, "POST", {
    sessionId: "parent",
    input: "submitted request",
    launch: { context: "request" },
  });
  await route(requestOnly.request);
  const requestInput = await waitForInput(1);
  assert.match(requestInput.text, /submitted request/);
  assert.doesNotMatch(requestInput.text, /latest user|assistant chunk|secret-tool|safe_1/);

  const sourceChunk = request(space("space-a"), `/api/workflows/${workflow.id}/run`, "POST", {
    sessionId: "parent",
    input: "chunk request",
    launch: {
      context: "request",
      sourceMessageSeq: 6,
      attachments: [{ id: "fresh", name: "fresh.txt", mime: "text/plain", size: 1 }],
    },
  });
  await route(sourceChunk.request);
  const sourceInput = await waitForInput(2);
  assert.match(sourceInput.text, /assistant chunk/);
  assert.doesNotMatch(sourceInput.text, /latest user|assistant reply/);
  assert.deepEqual(sourceInput.attachments, [
    { id: "fresh", name: "fresh.txt", mime: "text/plain", size: 1 },
  ]);

  const foreignSource = request(space("space-a"), `/api/workflows/${workflow.id}/run`, "POST", {
    sessionId: "parent",
    input: "bad source",
    launch: { context: "request", sourceMessageSeq: 999 },
  });
  await assert.rejects(() => route(foreignSource.request), /sourceMessageSeq is not a canonical message/);

  const started = appended.find((event) => event.type === "workflow/run-started");
  assert.equal((started?.data as { workflowId?: unknown }).workflowId, workflow.id);
  assert.ok(Array.isArray((started?.data as { nodes?: unknown }).nodes));
  const progress = appended.find((event) => event.type === "workflow/node-progress");
  assert.equal((progress?.data as { nodeId?: unknown }).nodeId, "a");
  assert.equal(typeof (progress?.data as { runId?: unknown }).runId, "string");
});

test("registered routes fence an unavailable pinned harness before child admission", async () => {
  let preflightFailure: (Error & {
    workflow?: { retryable?: boolean; phase?: string };
  }) | undefined;
  const harnesses = {
    resolve: async () => {
      const failure = Object.assign(new Error("pinned harness unavailable"), {
        code: "runtime-unavailable",
      });
      preflightFailure = failure;
      throw failure;
    },
  } as unknown as HarnessRegistry;
  const { route, childInputs, childCreates, appended } = registeredRouteHarness([], harnesses);
  const create = request(space("space-a"), "/api/workflows", "POST", {
    projectId: "project",
    name: "Pinned preflight",
    nodes: [{
      id: "pinned",
      role: "Pinned",
      prompt: "Run only on the selected harness",
      harness: { mode: "pinned", harnessId: "missing-harness" },
    }],
    edges: [],
  });
  await route(create.request);
  const workflow = create.response.body as WorkflowDto;
  const run = request(space("space-a"), `/api/workflows/${workflow.id}/run`, "POST", {
    sessionId: "parent",
    input: "preflight this",
  });
  await route(run.request);
  assert.equal(run.response.status, 200);
  const failedNode = () => appended
    .filter((event) => event.type === "workflow/node-progress")
    .map((event) => (event.data as { node?: { id?: string; retryable?: boolean } }).node)
    .find((node) => node?.id === "pinned" && node.retryable === true);
  for (let attempt = 0; attempt < 10 && (!preflightFailure || !failedNode()); attempt++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(preflightFailure?.workflow?.phase, "pre-admission");
  assert.equal(preflightFailure?.workflow?.retryable, true);
  assert.equal(childCreates(), 0);
  assert.equal(childInputs.length, 0);
  assert.equal(failedNode()?.retryable, true);
});

test("workflow launch rejects malformed attachment collections at the route boundary", async () => {
  const service = serviceIn(async () => ({ output: "ok" }));
  const { route } = routeHarness(service);
  const create = request(space("space-a"), "/api/workflows", "POST", {
    projectId: "project",
    name: "Attachment validation",
    nodes: [{ id: "a", role: "A", prompt: "Do A" }],
    edges: [],
  });
  await route(create.request);
  const workflow = create.response.body as WorkflowDto;
  const launch = request(
    space("space-a"),
    `/api/workflows/${workflow.id}/run`,
    "POST",
    {
      sessionId: "parent",
      input: "submitted request",
      launch: { attachments: { id: "foreign-shape" } },
    },
  );
  await assert.rejects(() => route(launch.request), /invalid workflow attachments/);
  const malformedModel = request(
    space("space-a"),
    `/api/workflows/${workflow.id}/run`,
    "POST",
    { sessionId: "parent", input: "submitted request", launch: { model: null } },
  );
  await assert.rejects(() => route(malformedModel.request), /invalid workflow launch model/);
});

test("a fix kept for future runs reaches the bundled template the routes serve", async () => {
  const preset = workflowPresets("project")[0]!;
  const unit = preset.nodes[0]!.id;
  const good = { providerID: "openai", modelID: "gpt-good" };
  const service = serviceIn(async (context) => {
    if (context.node.id === unit && context.node.model?.modelID !== good.modelID)
      throw Object.assign(new Error("not available on this engine"), { workflow: { retryable: true, phase: "pre-admission" } });
    return { output: "ok" };
  });
  const { route } = routeHarness(service);
  const run = request(space("space-a"), `/api/workflows/${encodeURIComponent(preset.id)}/run`, "POST", {
    sessionId: "parent",
    input: "Task",
  });
  await route(run.request);
  const runId = (run.response.body as WorkflowRunDto).id;
  for (let attempt = 0; attempt < 200 && !service.getRun(runId)?.nodes[0]?.needsFix; attempt++)
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  assert.equal(service.getRun(runId)?.nodes[0]?.needsFix, true, "the refused unit waits for a fix");

  const malformed = request(space("space-a"), `/api/workflow-runs/${runId}/retry`, "POST", {
    nodeId: unit, replacement: { model: { providerID: "", modelID: "x" } }, saveToWorkflow: true,
  });
  await assert.rejects(() => route(malformed.request), /invalid replacement model/);

  const fix = request(space("space-a"), `/api/workflow-runs/${runId}/retry`, "POST", {
    nodeId: unit, clientOperationId: "fix-op", replacement: { model: good }, saveToWorkflow: true,
  });
  await route(fix.request);
  assert.equal(fix.response.status, 200);
  assert.equal((fix.response.body as WorkflowRunDto).id, runId, "the run continues in place");

  const list = request(space("space-a"), "/api/workflows?projectId=project", "GET");
  await route(list.request);
  const served = (list.response.body as WorkflowDto[]).find((item) => item.id === preset.id);
  assert.deepEqual(served?.nodes[0]?.model, good, "the library shows the saved route");
  assert.equal(served?.builtin, true, "it stays the bundled template");
  const single = request(space("space-a"), `/api/workflows/${encodeURIComponent(preset.id)}`, "GET");
  await route(single.request);
  assert.deepEqual((single.response.body as WorkflowDto).nodes[0]?.model, good);
});
