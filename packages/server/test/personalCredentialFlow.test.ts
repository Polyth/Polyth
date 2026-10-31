// Personal Credential Vault partitions at the session boundary (Spaces §14.4):
// the composer shell resolves for the person who runs it, and a saved
// credential request lands in the partition the Space facade chose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@polyth/session";
import type {
  AgentRuntime, Project, ProjectService, RuntimeEndpoint, RuntimeEvent, SecretResolvedData,
  SecureSafeCreateInput, SecureSafeExecutionRequest, SecureSafeService,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

type Emit = (sessionId: string, ev: RuntimeEvent) => void;

function fakeRuntime() {
  const listeners = new Set<Emit>();
  const secretReplies: SecretResolvedData[] = [];
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
    replyQuestion: async () => {},
    replySecret: async (_sessionId, _requestId, result) => { secretReplies.push(result); },
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
    onEvent(cb) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    dispose: async () => {},
  };
  return { rt, secretReplies };
}

// A synthetic vault: values are test strings, never real credentials.
function fakeVault(name: string, calls: string[]) {
  const saved: SecureSafeCreateInput[] = [];
  const requests: SecureSafeExecutionRequest[] = [];
  const vault = {
    redact: (text: string) => text.split("synthetic-shell-value").join("[redacted]"),
    resolveExecutionEnv(input: SecureSafeExecutionRequest) {
      requests.push(input);
      return { env: { POLYTH_SAFE_DEPLOY: "synthetic-shell-value" }, handles: ["deploy"] };
    },
    async upsertByHandle(input: SecureSafeCreateInput) {
      calls.push(name);
      saved.push(input);
      return { id: `${name}-1`, handle: input.handle, label: input.label, purpose: "", kind: "token", scope: "global", revision: 1, createdAt: 1, updatedAt: 1 };
    },
    hasHandle: () => false,
  };
  return { vault, saved, requests };
}

function makeService(t: test.TestContext, opts: { personal?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-personal-flow-"));
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
  const calls: string[] = [];
  const space = fakeVault("space", calls);
  const alice = fakeVault("alice", calls);
  const personFor: string[] = [];
  const secureSafe = {
    ...space.vault,
    ...(opts.personal === false ? {} : {
      forPerson(userId: string) {
        personFor.push(userId);
        return userId === "alice" ? alice.vault : undefined;
      },
    }),
  } as unknown as SecureSafeService;
  const shellRuns: Array<{ cmd: string; secureEnv?: Readonly<Record<string, string>> }> = [];
  const fake = fakeRuntime();
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store,
    runtimes: { forProject: async () => fake.rt },
    secureSafe,
    shell: {
      run: async (input: { cmd: string; secureEnv?: Readonly<Record<string, string>> }) => {
        shellRuns.push(input);
        return { output: "printed synthetic-shell-value\n", exitCode: 0, timedOut: false, truncated: false };
      },
    },
  });
  return { sessions, store, calls, space, alice, personFor, shellRuns, fake };
}

test("composer shell resolves Credential Vault refs for the person who runs it", async (t) => {
  const { sessions, store, space, shellRuns } = makeService(t);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.runShell!(id, "deploy --token $POLYTH_SAFE_DEPLOY", { userId: "alice" });
  await sessions.runShell!(id, "deploy --token $POLYTH_SAFE_DEPLOY");
  assert.deepEqual(space.requests.map((request) => request.actorUserId), ["alice", undefined]);
  assert.deepEqual(space.requests.map((request) => request.envRefs), [["POLYTH_SAFE_DEPLOY"], ["POLYTH_SAFE_DEPLOY"]]);
  assert.equal(shellRuns[0]?.secureEnv?.POLYTH_SAFE_DEPLOY, "synthetic-shell-value");
  // Redaction still covers the resolved value in the model-visible result.
  const results = (await store.events(id)).filter((event) => event.type === "tool/result");
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal((result.data as { output?: string }).output, "printed [redacted]\n");
  }
});

test("a saved credential request lands in the destination the Space facade chose", async (t) => {
  const { sessions, store, calls, alice, space, personFor, fake } = makeService(t);
  const request = async (requestId: string) => {
    const { id } = await sessions.create({ projectId: "p1", title: requestId });
    await store.append(id, "secret/requested", { requestId, handle: "deploy", label: "Deploy" });
    return id;
  };

  const personalSession = await request("secret-personal");
  await sessions.replySecret!(personalSession, "secret-personal", { action: "save", value: "synthetic-a" }, { partition: "personal", userId: "alice" });
  const spaceSession = await request("secret-space");
  await sessions.replySecret!(spaceSession, "secret-space", { action: "save", value: "synthetic-b" }, { partition: "space" });
  const legacySession = await request("secret-legacy");
  await sessions.replySecret!(legacySession, "secret-legacy", { action: "save", value: "synthetic-c" });

  assert.deepEqual(calls, ["alice", "space", "space"]);
  assert.deepEqual(personFor, ["alice"]);
  assert.equal(alice.saved[0]?.value, "synthetic-a");
  assert.deepEqual(space.saved.map((input) => input.value), ["synthetic-b", "synthetic-c"]);
  // The runtime hears only the handle and outcome, never the value.
  assert.deepEqual(fake.secretReplies.map((reply) => reply.action), ["saved", "saved", "saved"]);
  assert.doesNotMatch(JSON.stringify(fake.secretReplies), /synthetic-/);
  for (const sessionId of [personalSession, spaceSession, legacySession]) {
    assert.doesNotMatch(JSON.stringify(await store.events(sessionId)), /synthetic-[abc]/);
  }

  // A person the host has no partition for is refused, not saved elsewhere.
  const refused = await request("secret-bob");
  await assert.rejects(
    sessions.replySecret!(refused, "secret-bob", { action: "save", value: "synthetic-d" }, { partition: "personal", userId: "bob" }),
    (error: { code?: string }) => error.code === "unsupported",
  );
  assert.deepEqual(calls, ["alice", "space", "space"]);
});

test("the Space facade passes the signed-in person and picks the save partition from the trusted context", async (t) => {
  const { testTenancy } = await import("./support/spaces.ts");
  const shells: unknown[][] = [];
  const replies: unknown[][] = [];
  const base = {
    list: async () => [],
    sync: async () => [],
    snapshot: async (id: string) => ({ id, projectId: "p1", status: "idle", title: "T", createdAt: 1, updatedAt: 1 }),
    runShell: async (...args: unknown[]) => { shells.push(args); return { callId: "c", status: "completed" }; },
    replySecret: async (...args: unknown[]) => { replies.push(args); },
  } as unknown as import("@polyth/contracts").SessionService;
  const tenancy = await testTenancy({ sessions: () => base });
  t.after(() => rmSync(tenancy.dataDir, { recursive: true, force: true }));
  const owner = tenancy.defaultContext;
  tenancy.sessionOwners.own("ses_1", owner.spaceId);
  const scoped = tenancy.services(owner).sessions;

  // The person comes from the context, never from the caller's arguments.
  await scoped.runShell!("ses_1", "echo $POLYTH_SAFE_DEPLOY", { userId: "someone-else" });
  assert.deepEqual(shells[0], ["ses_1", "echo $POLYTH_SAFE_DEPLOY", { userId: owner.userId }]);

  // The owner is a Space admin: no explicit choice in an unshared view keeps
  // the Space default, an explicit choice wins, a forged destination is ignored.
  await scoped.replySecret!("ses_1", "r1", { action: "save", value: "synthetic-1" }, { partition: "personal", userId: "someone-else" });
  await scoped.replySecret!("ses_1", "r2", { action: "save", value: "synthetic-2", partition: "personal" });
  await scoped.replySecret!("ses_1", "r3", { action: "dismiss" });
  assert.deepEqual(replies.map((args) => args[3]), [
    { partition: "space" },
    { partition: "personal", userId: owner.userId },
    undefined,
  ]);

  // A member who is not an admin can never pick the Space.
  const member = { ...owner, role: "member" as const };
  const memberSessions = tenancy.services(member).sessions;
  await memberSessions.replySecret!("ses_1", "r4", { action: "save", value: "synthetic-4" });
  assert.deepEqual(replies.at(-1)?.[3], { partition: "personal", userId: owner.userId });
  await assert.rejects(
    memberSessions.replySecret!("ses_1", "r5", { action: "save", value: "synthetic-5", partition: "space" }),
    (error: { code?: string }) => error.code === "forbidden",
  );
  assert.equal(replies.length, 4);
});
