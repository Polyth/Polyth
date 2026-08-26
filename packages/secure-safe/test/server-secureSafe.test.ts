import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRuntime,
  JsonObject,
  Project,
  ProjectService,
  RuntimeEvent,
} from "@polyth/contracts";
import { createStore } from "@polyth/session";
import { createPermissionService } from "@polyth/permissions";
import { createSecureSafeService } from "@polyth/secure-safe";
import { createHttpServer } from "../../server/src/http.ts";
import { secureSafeRoutes } from "../src/serverEntry.ts";
import { createSessionService, type Broadcaster } from "../../server/src/sessions.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "polyth-safe-server-"));

async function startRoutes() {
  const dataDir = tempDir();
  const safe = createSecureSafeService({ dataDir });
  const project: Project = { id: "p1", path: dataDir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => id === project.id ? project : undefined,
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const server = createHttpServer({
    sessions: {} as never,
    projects,
    runtimes: {} as never,
    capabilities: () => ["polyth.secureSafe"],
    webDist: dataDir,
    version: "test",
    routes: [secureSafeRoutes(safe)],
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { dataDir, safe, server, base: `http://127.0.0.1:${port}` };
}

test("Secure Safe REST create and list responses redact secret values", async () => {
  const app = await startRoutes();
  try {
    const createdResponse = await fetch(`${app.base}/api/secure-safe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: "DEPLOY_TOKEN",
        label: "Deploy token",
        purpose: "Production deploys",
        kind: "token",
        value: "deploy-secret-value",
      }),
    });
    assert.equal(createdResponse.status, 200);
    const createdText = await createdResponse.text();
    assert.doesNotMatch(createdText, /deploy-secret-value/);
    const created = JSON.parse(createdText) as { id: string; handle: string; value?: string };
    assert.equal(created.handle, "DEPLOY_TOKEN");
    assert.equal("value" in created, false);

    const listText = await (await fetch(`${app.base}/api/secure-safe`)).text();
    assert.doesNotMatch(listText, /deploy-secret-value/);
    assert.equal((JSON.parse(listText) as unknown[]).length, 1);

    const manifestText = await (await fetch(`${app.base}/api/secure-safe/forbidden-config`)).text();
    assert.doesNotMatch(manifestText, /deploy-secret-value/);
    assert.match(manifestText, /POLYTH_SAFE_DEPLOY_TOKEN/);

    const patchedText = await (await fetch(`${app.base}/api/secure-safe/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Production deploy token", value: "" }),
    })).text();
    assert.doesNotMatch(patchedText, /deploy-secret-value/);
    const diskSecrets = JSON.parse(
      readFileSync(join(app.dataDir, "secure-safe-secrets.json"), "utf8"),
    ) as Record<string, string>;
    assert.equal(diskSecrets[created.id], "deploy-secret-value");
  } finally {
    app.server.close();
  }
});

type Emit = (sessionId: string, event: RuntimeEvent) => void;

function fakeRuntime() {
  const listeners = new Set<Emit>();
  const questionReplies: Array<{ requestId: string; answers: JsonObject }> = [];
  const runtime: AgentRuntime = {
    capabilities: async () => ({
      streaming: true,
      permissions: true,
      questions: true,
      compaction: false,
      subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async ({ sessionId }) => `backend-${sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async ({ sessionId }) => {
      for (const listener of listeners) listener(sessionId, { type: "turn/started", turnId: "turn-1" });
    },
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async (_sessionId, requestId, answers) => {
      questionReplies.push({ requestId, answers });
    },
    onEvent(callback) {
      listeners.add(callback);
      return { dispose: () => { listeners.delete(callback); } };
    },
    dispose: async () => {},
  };
  const emit = (sessionId: string, event: RuntimeEvent) => {
    for (const listener of listeners) listener(sessionId, event);
  };
  return { runtime, emit, questionReplies };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

test("secure questions become secret events and saving logs only a handle", async () => {
  const dataDir = tempDir();
  const store = createStore(join(dataDir, "sessions.db"));
  const safe = createSecureSafeService({ dataDir });
  const fake = fakeRuntime();
  const project: Project = { id: "p1", path: dataDir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async () => project,
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const sessions = createSessionService({
    store,
    projects,
    permissions: createPermissionService(dataDir),
    runtimes: { forProject: async () => fake.runtime },
    broadcast,
    secureSafe: safe,
  });
  try {
    const { id } = await sessions.create({ projectId: "p1", title: "Secure request" });
    await sessions.send(id, { text: "configure deploys" });
    fake.emit(id, {
      type: "question/asked",
      requestId: "secret-1",
      questions: [{
        type: "text",
        prompt: "Save the token",
        metadata: {
          secureSafe: true,
          handle: "DEPLOY_TOKEN",
          label: "Deploy token",
          purpose: "Production deploys",
          kind: "token",
        },
      }],
    });
    await flush();

    const requestedEvents = await store.events(id);
    assert.equal(requestedEvents.some((event) => event.type === "question/asked"), false);
    const requested = requestedEvents.find((event) => event.type === "secret/requested");
    assert.deepEqual(requested?.data, {
      requestId: "secret-1",
      handle: "DEPLOY_TOKEN",
      label: "Deploy token",
      purpose: "Production deploys",
      kind: "token",
      existing: false,
    });
    assert.equal((await store.projection(id))?.status, "waiting");

    await sessions.replySecret!(id, "secret-1", { action: "save", value: "runtime-secret" });
    const events = await store.events(id);
    const serialized = JSON.stringify(events);
    assert.doesNotMatch(serialized, /runtime-secret/);
    assert.deepEqual(events.find((event) => event.type === "secret/resolved")?.data, {
      requestId: "secret-1",
      action: "saved",
      handle: "DEPLOY_TOKEN",
    });
    assert.equal(safe.hasHandle("DEPLOY_TOKEN"), true);
    assert.deepEqual(fake.questionReplies, [{
      requestId: "secret-1",
      answers: { action: "reject" },
    }]);
  } finally {
    await store.close();
  }
});
