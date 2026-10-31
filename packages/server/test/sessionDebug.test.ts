import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  AgentRuntime,
  Project,
  ProjectService,
  RuntimeEndpoint,
  RuntimeEvent,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

const PROMPT = "SECRET_USER_PROMPT_DO_NOT_LEAK";
const TOKEN = "sk-secret-provider-token";

const endpoint: RuntimeEndpoint = {
  authorityId: "owned:new-authority",
  continuity: "verified",
  generation: 2,
  url: "http://runtime.invalid/secret-path",
  location: { directory: "/project" },
  control: { kind: "owned", instanceToken: TOKEN },
  config: { kind: "writable", targetId: "cfg-secret" },
  authentication: { kind: "basic-env", usernameEnv: "OPENCODE_SERVER_USERNAME", passwordEnv: "OPENCODE_SERVER_PASSWORD" },
};

const runtimeFor = (onEnsure: () => void = () => undefined): AgentRuntime => ({
  capabilities: async () => ({
    streaming: true,
    permissions: true,
    questions: true,
    compaction: false,
    subagents: false,
  }),
  models: async () => [],
  agents: async () => [],
  ensureSession: async (input) => {
    onEnsure();
    return input.backendSessionId ?? `backend-${input.sessionId}`;
  },
  sessions: async () => [],
  history: async () => [],
  startTurn: async () => undefined,
  abort: async () => undefined,
  replyPermission: async () => undefined,
  replyQuestion: async () => undefined,
  endpoint: async () => endpoint,
  protocol: async () => "legacy",
  onEvent: (_callback: (sessionId: string, event: RuntimeEvent) => void) => ({
    dispose: () => undefined,
  }),
  dispose: async () => undefined,
});

const harness = (runtime: AgentRuntime, prefix: string, onProject?: () => void) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const store = createStore(join(dir, "sessions.db"));
  const project: Project = { id: "project-1", name: "Project", path: dir, createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => id === project.id ? project : undefined,
    add: async () => project,
    create: async () => project,
    remove: async () => undefined,
  };
  const permissions = {
    evaluate: () => "ask",
    addRule: () => undefined,
    rules: () => [],
  } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => undefined, projection: () => undefined };
  let forProjectCalls = 0;
  const sessions = createSessionService({
    store,
    projects,
    permissions,
    broadcast,
    queue: store,
    runtimes: {
      forProject: async () => {
        forProjectCalls += 1;
        onProject?.();
        return runtime;
      },
    },
  });
  return { dir, store, project, sessions, forProject: () => forProjectCalls };
};

const observabilityJson = (debug: Record<string, unknown>): string =>
  JSON.stringify({
    runtimeBinding: debug.runtimeBinding,
    endpoint: debug.endpoint,
    counts: debug.counts,
    lastEpochReplaced: debug.lastEpochReplaced,
    recoveryPlan: debug.recoveryPlan,
  });

test("debug reports binding, counts, and epoch stats without waking a runtime", async () => {
  const runtime = runtimeFor();
  const { dir, store, project, sessions, forProject } = harness(runtime, "polyth-session-debug-");
  const sessionId = "session-debug";
  try {
    await store.upsertProjection({
      id: sessionId,
      projectId: project.id,
      title: "Debug",
      status: "epoch-pending",
      backendSessionId: "backend-old",
      runtimeControl: "owned",
      runtimeBinding: {
        backendSessionId: "backend-old",
        authorityId: "owned:destroyed-authority",
        generation: 4,
        epoch: 2,
        continuity: "verified",
        protocol: "legacy",
        location: { directory: project.path },
        historyBaseline: "empty",
      },
      createdAt: 1,
      updatedAt: 1,
    });
    await store.append(sessionId, "user/message", { text: PROMPT });
    const unknown = await store.prepareOperation({
      sessionId,
      mutationKind: "turn-submit",
      intentEvent: { type: "user/message", data: { text: PROMPT } },
    });
    await store.claimOperation(unknown.operation.operationId);
    await store.settleOperation(unknown.operation.operationId, {
      kind: "unknown",
      message: "submission outcome was lost",
    });
    await store.enqueue(sessionId, PROMPT, "queue");
    await store.append(sessionId, "runtime/epoch-replaced", {
      old: { authorityId: "owned:destroyed-authority", generation: 4, epoch: 2 },
      new: { authorityId: endpoint.authorityId, generation: endpoint.generation, epoch: 3 },
      reason: "isolated runtime DB was quarantined after an engine digest change",
    }, { ignorable: true });

    const before = forProject();
    const debug = await sessions.debug(sessionId);
    assert.equal(forProject(), before, "debug must not attach or wake a runtime");
    assert.equal(debug.runtime.attached, false);
    assert.equal(debug.status, "epoch-pending");
    assert.ok(debug.runtimeBinding);
    assert.equal(debug.runtimeBinding.authorityId, "owned:destroyed-authority");
    assert.equal(debug.runtimeBinding.epoch, 2);
    assert.equal(debug.runtimeBinding.historyBaseline, "empty");
    assert.equal(debug.endpoint, undefined);
    assert.equal(debug.counts.unknownOperations, 1);
    assert.equal(debug.counts.fencedOperations, 0);
    assert.equal(debug.counts.heldForReview, 0);
    assert.ok(debug.lastEpochReplaced);
    assert.equal(
      debug.lastEpochReplaced.reason,
      "isolated runtime DB was quarantined after an engine digest change",
    );
    assert.equal(debug.lastEpochReplaced.seq > 0, true);
    assert.ok(debug.recoveryPlan);
    assert.equal(typeof debug.recoveryPlan.omittedMessages, "number");
    assert.equal(typeof debug.recoveryPlan.sectionChars.dialogue, "number");
    assert.equal("recoveryContext" in debug.recoveryPlan, false);

    const json = observabilityJson(debug as unknown as Record<string, unknown>);
    assert.equal(json.includes(PROMPT), false);
    assert.equal(json.includes(TOKEN), false);
    assert.equal(json.includes("http://runtime.invalid"), false);
    assert.equal(json.includes("cfg-secret"), false);
    assert.equal(json.includes("recoveryContext"), false);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("debug includes a redacted attached endpoint after a live bind", async () => {
  const runtime = runtimeFor();
  const { dir, store, project, sessions, forProject } = harness(runtime, "polyth-session-debug-ep-");
  try {
    const ref = await sessions.create({ projectId: project.id, title: "Live" });
    const afterCreate = forProject();
    assert.ok(afterCreate > 0);
    const debug = await sessions.debug(ref.id);
    assert.equal(forProject(), afterCreate, "debug must not wake the runtime again");
    assert.equal(debug.runtime.attached, true);
    assert.ok(debug.endpoint);
    assert.equal(debug.endpoint.authorityId, endpoint.authorityId);
    assert.equal(debug.endpoint.generation, endpoint.generation);
    assert.deepEqual(debug.endpoint.control, { kind: "owned" });
    const json = observabilityJson(debug as unknown as Record<string, unknown>);
    assert.equal(json.includes(TOKEN), false);
    assert.equal(json.includes("http://runtime.invalid"), false);
    assert.equal(json.includes("cfg-secret"), false);
    assert.equal(json.includes(PROMPT), false);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
