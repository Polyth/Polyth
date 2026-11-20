// A package tool call that asks for a credential (`polyth_credential_vault_request`)
// opens the same protected Credential Vault form as a runtime secret question,
// but the person's answer settles that waiting call instead of a runtime
// request. The value goes from the form to the vault, never to the agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { createStore } from "@polyth/session";
import type {
  AgentRuntime, Project, ProjectService, RuntimeEndpoint, SecretResolvedData,
  SecureSafeCreateInput, SecureSafeService,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

const TOOL = { name: "polyth_credential_vault_request", owner: "secure-safe" };

function makeService(t: test.TestContext, opts: { vault?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-tool-secret-"));
  const store = createStore(join(dir, "s.db"));
  t.after(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => (id === "p1" ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = { evaluate: () => "allow", addRule: () => {}, rules: () => [] } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const runtimeReplies: unknown[] = [];
  const rt: AgentRuntime & { endpoint(): Promise<RuntimeEndpoint> } = {
    capabilities: async () => ({ streaming: true, permissions: true, questions: true, compaction: false, subagents: false }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async () => {},
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async (...args) => { runtimeReplies.push(args); },
    replySecret: async (...args) => { runtimeReplies.push(args); },
    endpoint: async () => ({
      authorityId: "fake-runtime",
      continuity: "verified",
      generation: 1,
      url: "http://fake.invalid",
      location: { directory: "/fake" },
      control: { kind: "borrowed", source: "external" },
      config: { kind: "read-only" },
      authentication: { kind: "none" },
    }),
    onEvent: () => ({ dispose: () => {} }),
    dispose: async () => {},
  };
  // A synthetic vault: values are test strings, never real credentials.
  const saved: SecureSafeCreateInput[] = [];
  const secureSafe = {
    redact: (text: string) => text,
    hasHandle: () => false,
    async upsertByHandle(input: SecureSafeCreateInput) {
      saved.push(input);
      return { id: "v1", handle: input.handle, label: input.label, purpose: "", kind: "env", scope: "global", revision: 1, createdAt: 1, updatedAt: 1 };
    },
  } as unknown as SecureSafeService;
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store,
    runtimes: { forProject: async () => rt },
    ...(opts.vault === false ? {} : { secureSafe }),
  });
  return { sessions, store, saved, runtimeReplies };
}

async function openedRequest(store: ReturnType<typeof createStore>, sessionId: string) {
  for (let i = 0; i < 200; i += 1) {
    const event = (await store.events(sessionId)).find((row) => row.type === "secret/requested");
    if (event) return event.data as { requestId: string; handle: string; label: string; purpose?: string; kind?: string; origin?: string; tool?: string };
    await tick();
  }
  throw new Error("secret/requested was never appended");
}

test("a tool-opened Credential Vault form saves the value and answers only the waiting call", async (t) => {
  const { sessions, store, saved, runtimeReplies } = makeService(t);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  const pending = sessions.requestAgentToolSecret(id, {
    handle: "STRIPE_KEY", label: "Stripe key", purpose: "Billing deploys", kind: "env",
  }, TOOL);

  const request = await openedRequest(store, id);
  assert.equal(request.handle, "STRIPE_KEY");
  assert.equal(request.label, "Stripe key");
  assert.equal(request.purpose, "Billing deploys");
  assert.equal(request.kind, "env");
  assert.equal(request.origin, "agent-tool");
  assert.equal(request.tool, TOOL.name);

  await sessions.replySecret!(id, request.requestId, { action: "save", value: "synthetic-tool-value" });
  const result: SecretResolvedData = await pending;
  assert.deepEqual(result, { requestId: request.requestId, action: "saved", handle: "STRIPE_KEY" });
  assert.equal(saved[0]?.value, "synthetic-tool-value");
  assert.equal(saved[0]?.handle, "STRIPE_KEY");
  // No runtime request stands behind the form, so nothing is sent to one.
  assert.deepEqual(runtimeReplies, []);
  const events = await store.events(id);
  assert.ok(events.some((event) => event.type === "secret/resolved"));
  assert.doesNotMatch(JSON.stringify(events), /synthetic-tool-value/);
});

test("dismissing a tool-opened form resolves the call as dismissed without storing anything", async (t) => {
  const { sessions, store, saved, runtimeReplies } = makeService(t);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  const pending = sessions.requestAgentToolSecret(id, { handle: "DEPLOY", label: "Deploy token" }, TOOL);
  const request = await openedRequest(store, id);
  await sessions.replySecret!(id, request.requestId, { action: "dismiss" });
  assert.deepEqual(await pending, { requestId: request.requestId, action: "dismissed", handle: "DEPLOY" });
  assert.deepEqual(saved, []);
  assert.deepEqual(runtimeReplies, []);
});

test("cancelling the waiting call closes its form", async (t) => {
  const { sessions, store } = makeService(t);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  const controller = new AbortController();
  const pending = sessions.requestAgentToolSecret(id, { handle: "DEPLOY", label: "Deploy token" }, TOOL, controller.signal);
  const request = await openedRequest(store, id);
  controller.abort();
  assert.equal((await pending).action, "dismissed");
  for (let i = 0; i < 200; i += 1) {
    if ((await store.events(id)).some((event) => event.type === "secret/expired")) break;
    await tick();
  }
  const expired = (await store.events(id)).find((event) => event.type === "secret/expired");
  assert.equal((expired?.data as { requestId?: string } | undefined)?.requestId, request.requestId);
  await assert.rejects(
    sessions.replySecret!(id, request.requestId, { action: "save", value: "synthetic-late" }),
    (error: { code?: string }) => error.code === "conflict" || error.code === "not-found",
  );
});

test("a tool request is refused when the session has no Credential Vault", async (t) => {
  const { sessions, store } = makeService(t, { vault: false });
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await assert.rejects(
    sessions.requestAgentToolSecret(id, { handle: "DEPLOY", label: "Deploy" }, TOOL),
    (error: { code?: string }) => error.code === "unsupported",
  );
  assert.equal((await store.events(id)).some((event) => event.type === "secret/requested"), false);
});
