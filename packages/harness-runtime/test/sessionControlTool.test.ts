import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CreateSessionInput,
  DelegatedIsolationDto,
  HarnessContext,
  HarnessSelection,
  Project,
  ProjectService,
  SessionProjection,
  SessionService,
  SpaceContext,
  ToolExecutionContext,
  UserTurnInput,
} from "@polyth/contracts";
import {
  createServerServiceRegistry,
  SERVER_MODEL_ROUTING,
  SERVER_SESSION_ISOLATION,
  SERVER_SESSION_WATCHES,
  serverServiceKey,
  type ServerPackageHost,
  type ServerSessionIsolationService,
  type ServerSessionWatchDto,
} from "@polyth/plugins";
import { createCapabilityContributionRegistry } from "../src/contextualCapabilities.ts";
import { registerPolythSessionControl } from "../src/sessionControlTool.ts";

const space: SpaceContext = {
  spaceId: "space-a",
  spaceSlug: "space-a",
  userId: "user-a",
  role: "owner",
  deployment: "local-trusted",
  storageDir: "/tmp/polyth-space-a",
};

const context: HarnessContext = {
  space,
  spaceId: space.spaceId,
  projectId: "p1",
  cwd: "/projects/p1",
};

const toolContext: ToolExecutionContext = {
  sessionId: "caller",
  spaceId: space.spaceId,
  projectId: "p1",
  cwd: "/projects/p1",
};

const projection = (
  id: string,
  projectId = "p1",
  title = id,
): SessionProjection => ({
  id,
  projectId,
  title,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
});

test("polyth tool can discover projects and autonomously orchestrate canonical child sessions", async () => {
  const projects: Project[] = [
    { id: "p1", name: "Current", path: "/projects/p1", spaceId: space.spaceId, createdAt: 1 },
    { id: "p2", name: "External", path: "/projects/p2", spaceId: space.spaceId, createdAt: 1 },
  ];
  const projectService = {
    async list() { return projects; },
    async get(id: string) { return projects.find((project) => project.id === id); },
  } as unknown as ProjectService;

  const rows = new Map<string, SessionProjection>([
    ["caller", projection("caller", "p1", "Parent")],
    ["other-project", projection("other-project", "p2", "Foreign")],
  ]);
  const createdInputs: CreateSessionInput[] = [];
  const sends: unknown[] = [];
  const switches: unknown[] = [];
  const delegatedReplies: unknown[] = [];

  const sessions = {
    async create(input: CreateSessionInput) {
      createdInputs.push(input);
      const row: SessionProjection = {
        ...projection(`spawned-${input.projectId}`, input.projectId, input.title ?? ""),
        ...(input.parentId ? { parentId: input.parentId } : {}),
        ...(input.harness ? { harness: input.harness } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
      };
      rows.set(row.id, row);
      return { id: row.id };
    },
    async list() { return [...rows.values()]; },
    async snapshot(id: string) {
      const row = rows.get(id);
      if (!row) throw Object.assign(new Error("not found"), { code: "not-found" });
      return row;
    },
    async events(_id: string) {
      return [
        { seq: 1, time: 1, type: "turn/stopped", data: { reason: "error" } },
        { seq: 2, time: 2, type: "assistant/message", data: { text: "diagnostic answer", reasoning: "never expose this" } },
      ];
    },
    async debug(_id: string) {
      return {
        status: "idle",
        eventCount: 2,
        latestSeq: 2,
        runtime: { attached: true, activeTurn: false, admissionPending: false },
        queue: [],
        pending: { permissions: [], questions: [], secrets: [] },
        recentErrors: [{ seq: 1, time: 1, type: "turn/stopped", message: "error" }],
      };
    },
    async send(id: string, input: UserTurnInput) {
      sends.push({ id, input });
      return { turnId: `turn-${id}` };
    },
    async abort(_id: string) {},
    async archive(id: string) {
      const row = rows.get(id)!;
      rows.set(id, { ...row, status: "archived", updatedAt: row.updatedAt + 1 });
    },
    async restore(id: string) {
      const row = rows.get(id)!;
      rows.set(id, { ...row, status: "idle", updatedAt: row.updatedAt + 1 });
    },
    async fork(id: string, _atSeq?: number) {
      const source = rows.get(id)!;
      const fork = { ...source, id: `${id}-fork`, title: `${source.title} fork` };
      rows.set(fork.id, fork);
      return { id: fork.id };
    },
    async replyDelegatedPermission(...args: unknown[]) {
      delegatedReplies.push(args);
    },
    async switchHarness(id: string, selection: HarnessSelection, timing?: "after-turn" | "stop-now") {
      switches.push({ id, selection, timing });
      const row = rows.get(id)!;
      const resolvedHarnessId = selection.mode === "pinned" ? selection.harnessId : "opencode";
      const next = { ...row, harness: selection, resolvedHarnessId, updatedAt: row.updatedAt + 1 };
      rows.set(id, next);
      return next;
    },
  } as unknown as SessionService;

  const registry = createCapabilityContributionRegistry();
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey("harness.capabilities"), registry);
  const watchRows: ServerSessionWatchDto[] = [];
  services.provide(SERVER_SESSION_WATCHES, {
    async create(_space, input) {
      const watch: ServerSessionWatchDto = {
        id: `watch-${watchRows.length + 1}`,
        sourceSessionId: input.sourceSessionId,
        targetSessionId: input.targetSessionId,
        events: input.events ?? ["completed", "error", "aborted"],
        delivery: input.delivery ?? "wake",
        once: input.once !== false,
        createdAt: watchRows.length + 1,
      };
      watchRows.push(watch);
      return watch;
    },
    async list(_space, input = {}) {
      return watchRows.filter((watch) =>
        (!input.sourceSessionId || watch.sourceSessionId === input.sourceSessionId)
        && (!input.targetSessionId || watch.targetSessionId === input.targetSessionId));
    },
    async remove(_space, id, targetSessionId) {
      const index = watchRows.findIndex((watch) =>
        watch.id === id && (!targetSessionId || watch.targetSessionId === targetSessionId));
      if (index < 0) return false;
      watchRows.splice(index, 1);
      return true;
    },
  });
  const host = {
    services,
    forSpace: (ctx: SpaceContext) => {
      assert.equal(ctx.spaceId, space.spaceId);
      return { projects: projectService, sessions };
    },
  } as unknown as ServerPackageHost;

  const registration = registerPolythSessionControl(host);
  const [descriptor] = registry.resolve(context);
  assert.equal(descriptor?.id, "harness-runtime.polyth-control");
  assert.equal(descriptor?.kind, "tool");
  assert.equal(descriptor?.kind === "tool" ? descriptor.name : undefined, "polyth");

  const execute = registry.executor("harness-runtime.polyth-control");
  assert.ok(execute);

  const projectList = JSON.parse((await execute!({ action: "project.list" }, toolContext)).output) as {
    currentProjectId: string;
    projects: Array<{ id: string; name: string }>;
  };
  assert.equal(projectList.currentProjectId, "p1");
  assert.deepEqual(projectList.projects.map((project) => project.id), ["p1", "p2"]);

  await assert.rejects(
    () => execute!({ action: "session.create", parameters: {} }, toolContext),
    /title is required/,
  );

  await assert.rejects(
    () => execute!({
      action: "agent.spawn",
      parameters: { projectId: "p2", title: "Illegal cross-project child" },
    }, toolContext),
    /cannot cross project boundaries/,
  );

  const created = await execute!({
    action: "agent.spawn",
    parameters: {
      title: "  Fix   mobile navigation  ",
      prompt: "Audit and fix the mobile project navigator.",
      harnessId: "claude",
      model: { providerID: "anthropic", modelID: "claude-sonnet" },
      watchCaller: true,
    },
  }, toolContext);
  assert.match(created.output, /Fix mobile navigation/);
  assert.deepEqual(created.metadata, {
    action: "agent.spawn",
    projectId: "p1",
    parentSessionId: "caller",
    childSessionId: "spawned-p1",
    childTitle: "Fix mobile navigation",
  });
  assert.deepEqual(createdInputs[0], {
    projectId: "p1",
    title: "Fix mobile navigation",
    parentId: "caller",
    harness: { mode: "pinned", harnessId: "claude" },
    model: { providerID: "anthropic", modelID: "claude-sonnet" },
  });
  assert.equal(sends.length, 1);
  assert.deepEqual(watchRows[0], {
    id: "watch-1",
    sourceSessionId: "spawned-p1",
    targetSessionId: "caller",
    events: ["completed", "error", "aborted"],
    delivery: "wake",
    once: true,
    createdAt: 1,
  });

  const customWatch = JSON.parse((await execute!({
    action: "session.watch",
    parameters: {
      sessionId: "spawned-p1",
      events: ["completed", "error"],
      watchDelivery: "observe",
      once: false,
    },
  }, toolContext)).output) as { watch: ServerSessionWatchDto };
  assert.equal(customWatch.watch.targetSessionId, "caller");
  assert.deepEqual(customWatch.watch.events, ["completed", "error"]);
  assert.equal(customWatch.watch.delivery, "observe");
  assert.equal(customWatch.watch.once, false);

  const listedWatches = JSON.parse((await execute!({
    action: "session.watches",
    parameters: { sessionId: "spawned-p1" },
  }, toolContext)).output) as {
    sourceSessionId: string | null;
    targetSessionId: string;
    watches: ServerSessionWatchDto[];
  };
  assert.equal(listedWatches.sourceSessionId, "spawned-p1");
  assert.equal(listedWatches.targetSessionId, "caller");
  assert.equal(listedWatches.watches.length, 2);

  const removedWatch = JSON.parse((await execute!({
    action: "session.unwatch",
    parameters: { watchId: customWatch.watch.id },
  }, toolContext)).output) as { removed: boolean };
  assert.equal(removedWatch.removed, true);
  assert.deepEqual(watchRows.map((watch) => watch.id), ["watch-1"]);

  // There is deliberately no orchestration child-count/depth gate here. The
  // caller may fan out as much work as runtime/provider resources permit.
  for (let index = 0; index < 12; index += 1) {
    await execute!({
      action: "agent.spawn",
      parameters: { title: `Worker ${index + 1}`, harnessId: index % 2 ? "codex" : "claude" },
    }, toolContext);
  }
  await execute!({
    action: "agent.spawn",
    parameters: { title: "Worker with explicit worktree", worktreePath: "/tmp/custom-worktree" },
  }, toolContext);
  assert.equal(createdInputs.filter((input) => input.projectId === "p1").length, 14);
  assert.equal(
    createdInputs.filter((input) => input.projectId === "p1").every((input) => input.parentId === "caller"),
    true,
  );
  assert.equal(createdInputs.at(-1)?.worktreePath, "/tmp/custom-worktree");
  const agents = JSON.parse((await execute!({ action: "agent.list" }, toolContext)).output) as {
    parentSessionId: string;
    agents: Array<{ parentId: string | null }>;
  };
  assert.equal(agents.parentSessionId, "caller");
  assert.equal(agents.agents.length, 1);
  assert.equal(agents.agents.every((agent) => agent.parentId === "caller"), true);

  const debug = JSON.parse((await execute!({
    action: "session.debug",
    parameters: { sessionId: "spawned-p1" },
  }, toolContext)).output) as {
    debug: { eventCount: number };
    recentDiagnosticEvents: Array<{ type: string }>;
    session: { parentId: string | null };
  };
  assert.equal(debug.debug.eventCount, 2);
  assert.deepEqual(debug.recentDiagnosticEvents, [{ seq: 1, time: 1, type: "turn/stopped" }]);
  assert.equal(debug.session.parentId, "caller");
  assert.doesNotMatch(JSON.stringify(debug), /never expose this/);

  const external = await execute!({
    action: "session.create",
    parameters: {
      projectId: "p2",
      title: "Review external project",
      harnessId: "codex",
    },
  }, toolContext);
  assert.match(external.output, /Review external project/);
  assert.deepEqual(createdInputs.at(-1), {
    projectId: "p2",
    title: "Review external project",
    harness: { mode: "pinned", harnessId: "codex" },
  });

  const externalList = JSON.parse((await execute!({
    action: "session.list",
    parameters: { projectId: "p2" },
  }, toolContext)).output) as { sessions: Array<{ id: string }> };
  assert.deepEqual(new Set(externalList.sessions.map((row) => row.id)), new Set(["other-project", "spawned-p2"]));

  const externalGet = await execute!({
    action: "session.get",
    parameters: { projectId: "p2", sessionId: "other-project" },
  }, toolContext);
  assert.match(externalGet.output, /Foreign/);

  await assert.rejects(
    () => execute!({ action: "session.get", parameters: { sessionId: "other-project" } }, toolContext),
    /does not belong to the requested project/,
  );

  await execute!({
    action: "session.switchHarness",
    parameters: { sessionId: "spawned-p1", harnessId: "codex", timing: "after-turn" },
  }, toolContext);
  assert.deepEqual(switches, [{
    id: "spawned-p1",
    selection: { mode: "pinned", harnessId: "codex" },
    timing: "after-turn",
  }]);

  // The calling session is the delegate; the service decides whether a
  // person actually delegated this request to it.
  await execute!({
    action: "permission.reply",
    parameters: { sessionId: "spawned-p1", requestId: "per_1", reply: "once" },
  }, toolContext);
  assert.deepEqual(delegatedReplies, [["caller", "spawned-p1", "per_1", "once"]]);
  await assert.rejects(() => execute!({
    action: "permission.reply",
    parameters: { sessionId: "spawned-p1", requestId: "per_1", reply: "always" },
  }, toolContext), /reply must be once or reject/);
  await assert.rejects(() => execute!({
    action: "permission.reply",
    parameters: { sessionId: "spawned-p1", reply: "once" },
  }, toolContext), /requestId is required/);

  sessions.send = async () => {
    throw Object.assign(new Error("admission response lost"), { code: "outcome-unknown" });
  };
  const previousWatchCount = watchRows.length;
  await assert.rejects(() => execute!({
    action: "agent.spawn",
    parameters: { title: "Uncertain worker", prompt: "Run once", watchCaller: true },
  }, toolContext), { code: "outcome-unknown" });
  assert.equal(watchRows.length, previousWatchCount + 1,
    "an uncertain send must preserve the completion watch for the admitted child");

  await registration.dispose();
  assert.equal(registry.resolve(context).length, 0);
});

test("agent.models returns the usage-owned shortlist for the caller's Space, or a fallback when Usage is off", async () => {
  const run = async (withRouting: boolean) => {
    const registry = createCapabilityContributionRegistry();
    const services = createServerServiceRegistry();
    services.provide(serverServiceKey("harness.capabilities"), registry);
    const calls: Array<{ space: SpaceContext; options: unknown }> = [];
    if (withRouting) {
      services.provide(SERVER_MODEL_ROUTING, {
        async candidates(callerSpace, options) {
          calls.push({ space: callerSpace, options });
          return { windowDays: 7, generatedAt: 1, candidates: [], quotas: [], omitted: 2, unlisted: 3, text: "1. ★ claude anthropic/opus · quota 51%" };
        },
      });
    }
    const host = { services, forSpace: () => ({}) } as unknown as ServerPackageHost;
    const registration = registerPolythSessionControl(host);
    registry.resolve(context);
    const execute = registry.executor("harness-runtime.polyth-control")!;
    const result = await execute({
      action: "agent.models",
      parameters: { harnessId: "claude", limit: 5, windowDays: 7 },
    }, toolContext);
    await registration.dispose();
    return { result, calls };
  };

  const routed = await run(true);
  assert.equal(routed.result.output, "1. ★ claude anthropic/opus · quota 51%");
  assert.deepEqual(routed.result.metadata, { action: "agent.models", candidates: 0, omitted: 2, unlisted: 3 });
  assert.equal(routed.calls[0]!.space.userId, "user-a");
  assert.deepEqual(routed.calls[0]!.options, { limit: 5, windowDays: 7, harnessId: "claude" });

  const fallback = await run(false);
  assert.match(fallback.result.output, /Usage package is disabled/);
});

test("agent.spawn can isolate a child in its own worktree, and the delegator merges, resolves or discards it", async () => {
  const projects: Project[] = [
    { id: "p1", name: "Current", path: "/projects/p1", spaceId: space.spaceId, createdAt: 1 },
  ];
  const projectService = {
    async list() { return projects; },
    async get(id: string) { return projects.find((project) => project.id === id); },
  } as unknown as ProjectService;
  const rows = new Map<string, SessionProjection>([
    ["caller", projection("caller", "p1", "Orchestrator")],
    ["shared-child", { ...projection("shared-child", "p1", "Shared helper"), parentId: "caller" }],
    ["foreign-child", { ...projection("foreign-child", "p1", "Someone else's"), parentId: "other-parent" }],
  ]);
  const created: CreateSessionInput[] = [];
  const sends: Array<{ id: string; input: UserTurnInput }> = [];
  const archived: string[] = [];
  const sessions = {
    async create(input: CreateSessionInput) {
      created.push(input);
      return { id: "never" };
    },
    async list() { return [...rows.values()]; },
    async snapshot(id: string) {
      const row = rows.get(id);
      if (!row) throw Object.assign(new Error("not found"), { code: "not-found" });
      return row;
    },
    async send(id: string, input: UserTurnInput) {
      sends.push({ id, input });
      return { turnId: `turn-${id}` };
    },
    async archive(id: string) { archived.push(id); },
  } as unknown as SessionService;

  const delegatedRow = (id: string, overrides: Partial<DelegatedIsolationDto> = {}): DelegatedIsolationDto => ({
    sessionId: id,
    title: rows.get(id)?.title ?? id,
    status: "idle",
    state: "merge-ready",
    hasChanges: true,
    revision: `${id}-rev`,
    worktreePath: `/projects/p1-polyth-isolate/${id}`,
    worktreeBranch: `polyth/isolate/${id}`,
    targetBranch: "polyth/isolate/caller",
    ...overrides,
  });
  const children = new Map<string, DelegatedIsolationDto>();
  const calls: string[] = [];
  let mergeFailure: Error | undefined;
  const isolation: ServerSessionIsolationService = {
    async createDelegatedSession(input) {
      calls.push(`create:${input.parentSessionId}:${input.title}:${input.harness?.mode === "pinned" ? input.harness.harnessId : ""}`);
      const row: SessionProjection = { ...projection("isolated-child", "p1", input.title ?? ""), parentId: input.parentSessionId };
      rows.set(row.id, row);
      children.set(row.id, delegatedRow(row.id, { state: "active", hasChanges: false }));
      return {
        id: row.id,
        originUncommitted: 2,
        isolation: {
          kind: "git-worktree",
          state: "active",
          createdAt: "now",
          worktreePath: "/projects/p1-polyth-isolate/isolated-child",
          worktreeBranch: "polyth/isolate/isolated-child",
          targetPath: "/projects/p1",
          targetBranch: "polyth/isolate/caller",
          originPath: "/projects/p1-polyth-isolate/caller",
          baseCommit: "a".repeat(40),
          sourceSessionId: input.parentSessionId,
        },
      };
    },
    async delegatedChildren(parentSessionId) {
      calls.push(`children:${parentSessionId}`);
      return parentSessionId === "caller" ? [...children.values()] : [];
    },
    async mergeDelegated(sessionId) {
      calls.push(`merge:${sessionId}`);
      if (mergeFailure) throw mergeFailure;
      children.delete(sessionId);
      return { merged: true, commit: "b".repeat(40), targetBranch: "polyth/isolate/caller", finalized: true, session: rows.get(sessionId)! };
    },
    async discard(sessionId) {
      calls.push(`discard:${sessionId}`);
      children.delete(sessionId);
      return rows.get(sessionId)!;
    },
    async resolveWithAgent(sessionId) {
      calls.push(`resolve:${sessionId}`);
      return { sessionId };
    },
    // The session control tool never merges a top-level isolation itself.
    async getStatus() { throw new Error("not used by the control tool"); },
    async mergeBack() { throw new Error("not used by the control tool"); },
    async isolateSession() { throw new Error("not used by agent.spawn"); },
  };

  const registry = createCapabilityContributionRegistry();
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey("harness.capabilities"), registry);
  services.provide(SERVER_SESSION_ISOLATION, isolation);
  const watchRows: ServerSessionWatchDto[] = [];
  services.provide(SERVER_SESSION_WATCHES, {
    async create(_space, input) {
      const watch: ServerSessionWatchDto = {
        id: `watch-${watchRows.length + 1}`,
        sourceSessionId: input.sourceSessionId,
        targetSessionId: input.targetSessionId,
        events: input.events ?? ["completed", "error", "aborted"],
        delivery: input.delivery ?? "wake",
        once: input.once !== false,
        createdAt: watchRows.length + 1,
      };
      watchRows.push(watch);
      return watch;
    },
    async list() { return watchRows; },
    async remove() { return false; },
  });
  const noted: string[] = [];
  const host = {
    services,
    forSpace: () => ({ projects: projectService, sessions }),
  } as unknown as ServerPackageHost;
  const registration = registerPolythSessionControl(host, { delegations: { noteDelegation: (id) => noted.push(id) } });
  registry.resolve(context);
  const execute = registry.executor("harness-runtime.polyth-control")!;

  await assert.rejects(() => execute({
    action: "agent.spawn",
    parameters: { title: "Bad combo", isolation: "isolated", worktreePath: "/tmp/elsewhere" },
  }, toolContext), /cannot be combined with isolation=isolated/);
  await assert.rejects(() => execute({
    action: "session.create",
    parameters: { title: "Not a delegation", isolation: "isolated" },
  }, toolContext), /isolation applies only to agent.spawn/);
  await assert.rejects(() => execute({
    action: "agent.spawn",
    parameters: { title: "Typo", isolation: "worktree" },
  }, toolContext), /isolation must be shared or isolated/);

  const spawned = await execute({
    action: "agent.spawn",
    parameters: { title: "Parser rewrite", prompt: "Rewrite the parser.", harnessId: "codex", isolation: "isolated" },
  }, toolContext);
  const spawnedOutput = JSON.parse(spawned.output) as {
    session: { id: string; parentId: string };
    workspace: { mode: string; branch: string; mergeTarget: string; yourUncommittedFiles: number };
    next: string;
    watch: ServerSessionWatchDto;
  };
  assert.deepEqual(calls.splice(0), ["create:caller:Parser rewrite:codex"]);
  assert.equal(created.length, 0, "an isolated child is created by the isolation owner, not the shared path");
  assert.deepEqual(noted, ["caller"]);
  assert.equal(spawnedOutput.session.parentId, "caller");
  assert.equal(spawnedOutput.workspace.mode, "isolated");
  assert.equal(spawnedOutput.workspace.mergeTarget, "polyth/isolate/caller");
  assert.equal(spawnedOutput.workspace.yourUncommittedFiles, 2);
  assert.match(spawnedOutput.next, /agent\.merge/);
  assert.match(spawnedOutput.next, /2 uncommitted file/);
  assert.equal(spawnedOutput.watch.sourceSessionId, "isolated-child", "an isolated child wakes its delegator by default");
  assert.equal(spawnedOutput.watch.targetSessionId, "caller");
  assert.deepEqual(sends.map((send) => send.id), ["isolated-child"]);
  assert.equal(spawned.metadata?.isolation, "isolated");

  const quiet = JSON.parse((await execute({
    action: "agent.spawn",
    parameters: { title: "Quiet", isolation: "isolated", watchCaller: false },
  }, toolContext)).output) as { watch?: unknown };
  assert.equal(quiet.watch, undefined, "watchCaller=false opts out explicitly");
  calls.splice(0);

  children.set("isolated-child", delegatedRow("isolated-child"));
  const listed = JSON.parse((await execute({ action: "agent.list" }, toolContext)).output) as {
    agents: Array<{ id: string; workspace: { mode: string; next?: string } }>;
    unmergedIsolatedAgents: number;
  };
  assert.equal(listed.unmergedIsolatedAgents, 1);
  assert.deepEqual(listed.agents.find((agent) => agent.id === "shared-child")?.workspace, { mode: "shared" });
  const isolatedListing = listed.agents.find((agent) => agent.id === "isolated-child")?.workspace;
  assert.equal(isolatedListing?.mode, "isolated");
  assert.match(isolatedListing?.next ?? "", /agent\.merge/);

  await assert.rejects(() => execute({
    action: "session.archive",
    parameters: { sessionId: "isolated-child" },
  }, toolContext), /still holds isolated work/);
  assert.deepEqual(archived, []);
  await assert.rejects(() => execute({
    action: "agent.merge",
    parameters: { sessionId: "foreign-child" },
  }, toolContext), /only to agents you spawned/);
  const sharedMerge = JSON.parse((await execute({
    action: "agent.merge",
    parameters: { sessionId: "shared-child" },
  }, toolContext)).output) as { merged: boolean; isolated: boolean };
  assert.deepEqual([sharedMerge.merged, sharedMerge.isolated], [false, false]);
  await assert.rejects(() => execute({
    action: "agent.discard",
    parameters: { sessionId: "shared-child" },
  }, toolContext), /only to an agent with an isolated worktree/);

  children.set("isolated-child", delegatedRow("isolated-child", { status: "working", hasChanges: false }));
  await assert.rejects(() => execute({
    action: "agent.merge",
    parameters: { sessionId: "isolated-child" },
  }, toolContext), /still running/);

  children.set("isolated-child", delegatedRow("isolated-child"));
  mergeFailure = Object.assign(new Error("polyth/isolate/caller has uncommitted changes that overlap this merge."), {
    code: "conflict", reason: "target-overlap", files: ["src/parser.ts"],
  });
  const overlap = JSON.parse((await execute({
    action: "agent.merge",
    parameters: { sessionId: "isolated-child" },
  }, toolContext)).output) as { merged: boolean; reason: string; files: string[]; next: string };
  assert.equal(overlap.merged, false);
  assert.equal(overlap.reason, "target-overlap");
  assert.deepEqual(overlap.files, ["src/parser.ts"]);
  assert.match(overlap.next, /Commit/);

  mergeFailure = Object.assign(new Error("polyth/isolate/caller changed in conflicting areas."), {
    code: "conflict", files: ["src/parser.ts"],
  });
  const conflict = JSON.parse((await execute({
    action: "agent.merge",
    parameters: { sessionId: "isolated-child" },
  }, toolContext)).output) as { merged: boolean; reason: string; next: string };
  assert.equal(conflict.reason, "conflict");
  assert.match(conflict.next, /agent\.resolve/);
  mergeFailure = Object.assign(new Error("disk full"), { code: "git-failed" });
  await assert.rejects(() => execute({
    action: "agent.merge",
    parameters: { sessionId: "isolated-child" },
  }, toolContext), /disk full/, "only conflicts become structured results");
  mergeFailure = undefined;

  await assert.rejects(() => execute({
    action: "agent.resolve",
    parameters: { sessionId: "isolated-child" },
  }, toolContext), /no merge conflict/);
  children.set("isolated-child", delegatedRow("isolated-child", { state: "conflict", conflictFiles: ["src/parser.ts"] }));
  const watchesBeforeResolve = watchRows.length;
  const resolving = JSON.parse((await execute({
    action: "agent.resolve",
    parameters: { sessionId: "isolated-child" },
  }, toolContext)).output) as { resolving: boolean; watch: ServerSessionWatchDto };
  assert.equal(resolving.resolving, true);
  assert.equal(watchRows.length, watchesBeforeResolve + 1, "the delegator is woken when the resolution ends");
  assert.equal(resolving.watch.targetSessionId, "caller");

  children.set("isolated-child", delegatedRow("isolated-child"));
  calls.splice(0);
  const merged = JSON.parse((await execute({
    action: "agent.merge",
    parameters: { sessionId: "isolated-child" },
  }, toolContext)).output) as { merged: boolean; commit: string; into: string; finalized: boolean };
  assert.deepEqual([merged.merged, merged.into, merged.finalized], [true, "polyth/isolate/caller", true]);
  assert.ok(calls.includes("merge:isolated-child"));

  children.set("quiet-child", delegatedRow("quiet-child"));
  rows.set("quiet-child", { ...projection("quiet-child", "p1", "Quiet"), parentId: "caller" });
  await assert.rejects(() => execute({
    action: "agent.discard",
    parameters: { sessionId: "quiet-child" },
  }, toolContext), /pass force=true/);
  const dropped = JSON.parse((await execute({
    action: "agent.discard",
    parameters: { sessionId: "quiet-child", force: true },
  }, toolContext)).output) as { discarded: boolean; droppedChanges: boolean };
  assert.deepEqual([dropped.discarded, dropped.droppedChanges], [true, true]);

  await registration.dispose();
});

test("session.isolate moves an existing chat into its own worktree through the acting person's sessions", async () => {
  const projects: Project[] = [
    { id: "p1", name: "Current", path: "/projects/p1", spaceId: space.spaceId, createdAt: 1 },
  ];
  const projectService = {
    async list() { return projects; },
    async get(id: string) { return projects.find((project) => project.id === id); },
  } as unknown as ProjectService;
  const rows = new Map<string, SessionProjection>([
    ["caller", { ...projection("caller", "p1", "Orchestrator"), status: "working" }],
    ["shared-child", { ...projection("shared-child", "p1", "Shared helper"), parentId: "caller" }],
    ["other-chat", projection("other-chat", "p1", "Someone's chat")],
    ["busy-chat", { ...projection("busy-chat", "p1", "Busy"), status: "working" }],
    ["old-chat", { ...projection("old-chat", "p1", "Old"), status: "archived" }],
    ["elsewhere", projection("elsewhere", "p2", "Other project")],
  ]);
  const sessions = {
    async snapshot(id: string) {
      const row = rows.get(id);
      if (!row) throw Object.assign(new Error("not found"), { code: "not-found" });
      return row;
    },
    async rebindWorkspace() { throw new Error("the fake isolation service owns the rebind"); },
  } as unknown as SessionService;
  const calls: Array<{ sessionId: string; scoped: boolean }> = [];
  const isolated = (id: string, sourceSessionId?: string) => ({
    kind: "git-worktree" as const,
    state: "active" as const,
    createdAt: "now",
    worktreePath: `/projects/p1-polyth-isolate/${id}`,
    worktreeBranch: `polyth/isolate/${id}`,
    targetPath: "/projects/p1",
    targetBranch: "main",
    originPath: "/projects/p1",
    baseCommit: "c".repeat(40),
    ...(sourceSessionId ? { sourceSessionId } : {}),
  });
  const isolation = {
    async isolateSession(sessionId, options) {
      calls.push({ sessionId, scoped: options?.sessions === sessions });
      const row = rows.get(sessionId)!;
      const next = { ...row, isolation: isolated(sessionId, row.parentId) };
      rows.set(sessionId, next);
      return { ok: true as const, session: next, targetBranch: "main", originUncommitted: sessionId === "shared-child" ? 3 : 0 };
    },
  } as Partial<ServerSessionIsolationService> as ServerSessionIsolationService;
  const registry = createCapabilityContributionRegistry();
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey("harness.capabilities"), registry);
  services.provide(SERVER_SESSION_ISOLATION, isolation);
  const noted: string[] = [];
  const host = {
    services,
    forSpace: () => ({ projects: projectService, sessions }),
  } as unknown as ServerPackageHost;
  const registration = registerPolythSessionControl(host, { delegations: { noteDelegation: (id) => noted.push(id) } });
  registry.resolve(context);
  const execute = registry.executor("harness-runtime.polyth-control")!;

  await assert.rejects(() => execute({ action: "session.isolate" }, toolContext));
  await assert.rejects(() => execute({ action: "session.isolate", parameters: { sessionId: "caller" } }, toolContext), /your own running session/);
  await assert.rejects(() => execute({ action: "session.isolate", parameters: { sessionId: "busy-chat" } }, toolContext), /still running/);
  await assert.rejects(() => execute({ action: "session.isolate", parameters: { sessionId: "old-chat" } }, toolContext), /archived/);
  await assert.rejects(() => execute({ action: "session.isolate", parameters: { sessionId: "elsewhere" } }, toolContext), /does not belong/);
  await assert.rejects(() => execute({ action: "session.isolate", parameters: { sessionId: "missing" } }, toolContext), /not found/);
  await assert.rejects(() => execute({
    action: "session.isolate", parameters: { sessionId: "other-chat", isolation: "isolated" },
  }, toolContext), /isolation applies only to agent.spawn/);
  assert.deepEqual(calls, [], "refusals never reach the Git owner");

  const child = await execute({ action: "session.isolate", parameters: { sessionId: "shared-child" } }, toolContext);
  const childOutput = JSON.parse(child.output) as {
    session: { id: string; parentId: string };
    workspace: { mode: string; branch: string; mergeTarget: string; uncommittedLeftBehind?: number };
    next: string;
  };
  assert.deepEqual(calls, [{ sessionId: "shared-child", scoped: true }], "the acting person's scoped sessions authorize it");
  assert.equal(childOutput.workspace.mode, "isolated");
  assert.equal(childOutput.workspace.branch, "polyth/isolate/shared-child");
  assert.equal(childOutput.workspace.mergeTarget, "main");
  assert.equal(childOutput.workspace.uncommittedLeftBehind, 3);
  assert.match(childOutput.next, /agent\.merge/);
  assert.match(childOutput.next, /3 uncommitted file/);
  assert.deepEqual(noted, ["caller"], "the delegator is reminded of its new isolated child");
  assert.equal(child.metadata?.childSessionId, "shared-child");

  const other = JSON.parse((await execute({ action: "session.isolate", parameters: { sessionId: "other-chat" } }, toolContext)).output) as {
    workspace: { uncommittedLeftBehind?: number };
    next: string;
  };
  assert.equal(other.workspace.uncommittedLeftBehind, undefined);
  assert.match(other.next, /isolation card/);
  assert.doesNotMatch(other.next, /agent\.merge/);
  assert.deepEqual(noted, ["caller"]);

  await registration.dispose();
});

test("polyth tool acts for the person who sent the turn and refuses for someone who left", async () => {
  const project: Project = { id: "p1", name: "Current", path: "/projects/p1", spaceId: space.spaceId, createdAt: 1 };
  const used: string[] = [];
  const registry = createCapabilityContributionRegistry();
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey("harness.capabilities"), registry);
  const host = {
    services,
    personSpaceContext: (userId: string, spaceId: string) =>
      userId === "user-b" && spaceId === space.spaceId ? { ...space, userId, role: "member" } : undefined,
    forSpace: (ctx: SpaceContext) => {
      used.push(ctx.userId);
      return {
        projects: { async list() { return [project]; }, async get() { return project; } } as unknown as ProjectService,
        sessions: { async list() { return [projection("caller")]; } } as unknown as SessionService,
      };
    },
  } as unknown as ServerPackageHost;
  registerPolythSessionControl(host);
  registry.resolve(context);
  const execute = registry.executor("harness-runtime.polyth-control")!;

  await execute({ action: "session.list" }, { ...toolContext, actorUserId: "user-b" });
  assert.deepEqual(used, ["user-b"], "the actor's own access scopes what the agent sees");
  await execute({ action: "session.list" }, toolContext);
  assert.deepEqual(used, ["user-b", "user-a"], "a turn no person started keeps the provisioned context");
  await assert.rejects(execute({ action: "session.list" }, { ...toolContext, actorUserId: "user-gone" }), { code: "forbidden" });
  assert.deepEqual(used, ["user-b", "user-a"]);
});

test("a delegated child spawned for one person cannot pin another person's private profile", async () => {
  const project: Project = { id: "p1", name: "Current", path: "/projects/p1", spaceId: space.spaceId, createdAt: 1 };
  const created: Array<{ as: string; harness?: string }> = [];
  const registry = createCapabilityContributionRegistry();
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey("harness.capabilities"), registry);
  const host = {
    services,
    personSpaceContext: (userId: string, spaceId: string) =>
      (userId === "user-a" || userId === "user-b") && spaceId === space.spaceId ? { ...space, userId, role: "member" } : undefined,
    forSpace: (ctx: SpaceContext) => ({
      projects: { async list() { return [project]; }, async get() { return project; } } as unknown as ProjectService,
      // The actor's session facade: user-a's private login is refused for
      // anyone else, exactly as accountPermissions.ts does on the server.
      sessions: {
        async create(input: CreateSessionInput) {
          if (input.harness?.mode === "pinned" && input.harness.harnessId === "claude-user-a" && ctx.userId !== "user-a") {
            throw Object.assign(new Error("This assistant account belongs to someone else"), { code: "forbidden" });
          }
          created.push({ as: ctx.userId, ...(input.harness?.mode === "pinned" ? { harness: input.harness.harnessId } : {}) });
          return { id: `child-${created.length}` };
        },
        async snapshot(id: string) { return { ...projection(id), parentId: "caller" }; },
        async send() { return { turnId: "t" }; },
        async list() { return [projection("caller")]; },
      } as unknown as SessionService,
    }),
  } as unknown as ServerPackageHost;
  registerPolythSessionControl(host);
  registry.resolve(context);
  const execute = registry.executor("harness-runtime.polyth-control")!;
  const spawn = (actorUserId: string) => execute({
    action: "agent.spawn",
    parameters: { title: "Child", prompt: "Do it.", harnessId: "claude-user-a" },
  }, { ...toolContext, actorUserId });

  await assert.rejects(spawn("user-b"), { code: "forbidden" });
  assert.deepEqual(created, [], "nothing was created for user-b");
  await spawn("user-a");
  assert.deepEqual(created, [{ as: "user-a", harness: "claude-user-a" }]);
});

test("session.send queues behind a busy chat by default, or interrupts or steers it on request", async () => {
  const project: Project = { id: "p1", name: "Current", path: "/projects/p1", spaceId: space.spaceId, createdAt: 1 };
  const rows = new Map<string, SessionProjection>([
    ["caller", { ...projection("caller"), status: "working" }],
    ["busy", { ...projection("busy"), status: "working" }],
    ["idle", projection("idle")],
    ["paused", { ...projection("paused"), paused: { at: 1, stopSeq: 4 } }],
  ]);
  const sends: Array<{ id: string; delivery?: string }> = [];
  const sessions = {
    async snapshot(id: string) {
      const row = rows.get(id);
      if (!row) throw Object.assign(new Error("not found"), { code: "not-found" });
      return row;
    },
    async send(id: string, input: UserTurnInput) {
      sends.push({ id, ...(input.delivery ? { delivery: input.delivery } : {}) });
      if (rows.get(id)?.status !== "working") return { turnId: `turn-${sends.length}` };
      if (input.delivery === "interrupt") return { queueId: `q-${sends.length}`, queued: true, interrupting: true };
      if (input.delivery === "steer") return { turnId: "running" };
      return { queueId: `q-${sends.length}`, queued: true };
    },
  } as unknown as SessionService;
  const registry = createCapabilityContributionRegistry();
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey("harness.capabilities"), registry);
  const host = {
    services,
    forSpace: () => ({
      projects: { async list() { return [project]; }, async get() { return project; } } as unknown as ProjectService,
      sessions,
    }),
  } as unknown as ServerPackageHost;
  const registration = registerPolythSessionControl(host);
  registry.resolve(context);
  const execute = registry.executor("harness-runtime.polyth-control")!;
  const send = async (parameters: Record<string, unknown>) => JSON.parse((await execute({
    action: "session.send",
    parameters: { text: "hello", ...parameters },
  }, toolContext)).output) as { outcome: string; delivery: string; note: string; sendResult: { queueId?: string } };

  const queued = await send({ sessionId: "busy" });
  assert.equal(queued.delivery, "queue", "a send without delivery queues instead of disturbing the chat");
  assert.equal(queued.outcome, "queued");
  assert.equal(queued.sendResult.queueId, "q-1");
  assert.equal((await send({ sessionId: "busy", delivery: "interrupt" })).outcome, "interrupting");
  assert.equal((await send({ sessionId: "busy", delivery: "steer" })).outcome, "steered");
  assert.equal((await send({ sessionId: "idle", delivery: "interrupt" })).outcome, "started");
  assert.equal((await send({ sessionId: "idle" })).outcome, "started");
  assert.equal((await send({ sessionId: "busy", delivery: "normal" })).delivery, "queue", "legacy normal is a queue send");
  assert.deepEqual(sends.map((row) => row.delivery), ["queue", "interrupt", "steer", "interrupt", "queue", "queue"]);

  await assert.rejects(send({ sessionId: "busy", delivery: "now" }), /delivery must be queue, interrupt or steer/);
  await assert.rejects(send({ sessionId: "caller", delivery: "interrupt" }), /cannot target your own session/);
  await assert.rejects(send({ sessionId: "caller", delivery: "steer" }), /cannot target your own session/);
  assert.equal((await send({ sessionId: "caller" })).outcome, "queued", "a chat can still queue its own follow-up");
  assert.equal(sends.length, 7);
  // A person's pause is theirs to continue: an agent's message never lands.
  await assert.rejects(send({ sessionId: "paused" }), /paused by a person; only they can continue it/);
  assert.equal(sends.length, 7);
  const got = JSON.parse((await execute({ action: "session.get", parameters: { sessionId: "paused" } }, toolContext)).output) as {
    session: { status: string; paused?: boolean };
  };
  assert.equal(got.session.paused, true, "the delegator sees the pause, not just an idle session");
  await registration.dispose();
});
