import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CreateSessionInput,
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
  serverServiceKey,
  type ServerPackageHost,
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

  const created = await execute!({
    action: "session.create",
    parameters: {
      title: "  Fix   mobile navigation  ",
      prompt: "Audit and fix the mobile project navigator.",
      harnessId: "claude",
      model: { providerID: "anthropic", modelID: "claude-sonnet" },
    },
  }, toolContext);
  assert.match(created.output, /Fix mobile navigation/);
  assert.deepEqual(createdInputs[0], {
    projectId: "p1",
    title: "Fix mobile navigation",
    parentId: "caller",
    harness: { mode: "pinned", harnessId: "claude" },
    model: { providerID: "anthropic", modelID: "claude-sonnet" },
  });
  assert.equal(sends.length, 1);

  // There is deliberately no orchestration child-count/depth gate here. The
  // caller may fan out as much work as runtime/provider resources permit.
  for (let index = 0; index < 12; index += 1) {
    await execute!({
      action: "session.create",
      parameters: { title: `Worker ${index + 1}`, harnessId: index % 2 ? "codex" : "claude" },
    }, toolContext);
  }
  assert.equal(createdInputs.filter((input) => input.projectId === "p1").length, 13);
  assert.equal(
    createdInputs.filter((input) => input.projectId === "p1").every((input) => input.parentId === "caller"),
    true,
  );

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

  await registration.dispose();
  assert.equal(registry.resolve(context).length, 0);
});
