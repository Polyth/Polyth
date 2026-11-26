// The agent Credential Vault run executes with no HTTP request behind it, so
// no gateway has bound a Space. It must still resolve against the session's
// own Space and acting person — exactly the entries the composer shell sees —
// through the real routed Vault, never the host's legacy root store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@polyth/session";
import {
  configureSecureSafePersonRouting,
  configureSecureSafeSpaceRouting,
  createSecureSafeService,
  VAULT_RUN_TOOL_ID,
} from "@polyth/credential-vault";
import type {
  AgentRuntime, Project, ProjectService, RuntimeEvent, SecureSafeApproval, SecureSafeService, SpaceContext,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

// A runtime whose turns start and never finish: enough for a live turn to
// ask for a Vault run, and for Vault runs that need no turn at all.
function idleRuntime(): AgentRuntime {
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  return {
    harnessId: "opencode",
    capabilities: async () => ({ streaming: true, permissions: true, questions: true, compaction: false, subagents: false }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async (req) => {
      for (const listener of listeners) listener(req.sessionId, { type: "turn/started", turnId: "t1" });
    },
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(cb) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    dispose: async () => {},
  };
}

// Synthetic values only: never real credentials.
const PERSONAL = "synthetic-personal-value";
const SHARED = "synthetic-space-value";
const LEGACY = "synthetic-legacy-root-value";

async function rig(t: test.TestContext, opts: {
  vaultSpace?: boolean;
  permission?: "allow" | "ask";
  approvals?: { deploy?: SecureSafeApproval; shared?: SecureSafeApproval };
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "polyth-vault-run-space-"));
  const store = createStore(join(root, "s.db"));
  t.after(async () => {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const ctx = (spaceId: string, userId: string): SpaceContext => ({
    spaceId,
    spaceSlug: spaceId,
    userId,
    role: "owner",
    deployment: "server-trusted",
    storageDir: join(root, spaceId),
  });

  // The host's routed facade, its legacy root store, one Space store that
  // resolves its member's personal entries first, and that member's store.
  const alice = createSecureSafeService({ dataDir: join(root, "people", "alice"), localOnly: true });
  const space = createSecureSafeService({
    dataDir: join(root, "spc_a", "secure-safe"),
    localOnly: true,
    personal: (userId) => (userId === "alice" ? alice : undefined),
  });
  configureSecureSafeSpaceRouting((space_) => (space_.spaceId === "spc_a" ? space : undefined));
  configureSecureSafePersonRouting((space_, userId) =>
    space_.spaceId === "spc_a" && userId === "alice" ? alice : undefined);
  const routed: SecureSafeService = createSecureSafeService({ dataDir: join(root, "legacy-root") });
  await alice.create({
    handle: "DEPLOY", label: "Deploy", kind: "password", value: PERSONAL,
    ...(opts.approvals?.deploy ? { approval: opts.approvals.deploy } : {}),
  });
  await space.create({
    handle: "SHARED", label: "Shared", kind: "token", value: SHARED,
    ...(opts.approvals?.shared ? { approval: opts.approvals.shared } : {}),
  });
  // A same-named handle in the legacy root must never be what a Space run gets.
  await routed.create({ handle: "LEGACY_ONLY", label: "Legacy", kind: "token", value: LEGACY });

  const project: Project = { id: "p1", path: root, name: "p", createdAt: 1, spaceId: "spc_a" };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => (id === "p1" ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = { evaluate: () => opts.permission ?? "allow", addRule: () => {}, rules: () => [] } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const runs: Array<Readonly<Record<string, string>> | undefined> = [];
  const spaces: Array<{ spaceId: string | undefined; actorUserId?: string }> = [];
  const runtime = idleRuntime();
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store,
    runtimes: { forProject: async () => runtime },
    secureSafe: routed,
    ...(opts.vaultSpace === false ? {} : {
      vaultSpace: (input: { spaceId: string | undefined; actorUserId?: string }) => {
        spaces.push(input);
        if (!input.spaceId) throw Object.assign(new Error("no Space"), { code: "not-found" });
        if (input.actorUserId && input.actorUserId !== "alice") {
          throw Object.assign(new Error("not a member"), { code: "not-found" });
        }
        return ctx(input.spaceId, input.actorUserId ?? "system:polyth-runtime");
      },
    }),
    shell: {
      run: async (input: { cmd: string; secureEnv?: Readonly<Record<string, string>> }) => {
        runs.push(input.secureEnv);
        // A careless command that prints every value it was given.
        return { output: `${Object.values(input.secureEnv ?? {}).join(" ")}\n`, exitCode: 0, timedOut: false, truncated: false };
      },
    },
  });
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  return { sessions, store, id, runs, spaces, root };
}

test("the agent Vault run resolves the actor's own and the session Space's entries and redacts both", async (t) => {
  const { sessions, id, runs, spaces } = await rig(t);
  const result = await sessions.runVaultCommand({
    sessionId: id,
    command: "deploy \"$POLYTH_SAFE_DEPLOY\" \"$POLYTH_SAFE_SHARED\"",
    purpose: "Publish",
    actorUserId: "alice",
    timeoutMs: 60_000,
  });
  assert.deepEqual(spaces, [{ spaceId: "spc_a", actorUserId: "alice" }]);
  assert.equal(runs[0]?.POLYTH_SAFE_DEPLOY, PERSONAL);
  assert.equal(runs[0]?.POLYTH_SAFE_SHARED, SHARED);
  assert.deepEqual([...result.handles].sort(), ["DEPLOY", "SHARED"]);
  assert.equal(result.output, "[redacted] [redacted]\n");
  assert.doesNotMatch(JSON.stringify(result), /synthetic-/);
});

test("the agent Vault run never falls back to the host's legacy root store", async (t) => {
  const { sessions, id, runs } = await rig(t);
  await assert.rejects(
    sessions.runVaultCommand({
      sessionId: id,
      command: "echo \"$POLYTH_SAFE_LEGACY_ONLY\"",
      purpose: "x",
      actorUserId: "alice",
      timeoutMs: 60_000,
    }),
    (error: { code?: string }) => error.code === "not-found",
  );
  assert.equal(runs.length, 0);
});

test("system work resolves only the session Space's entries, never a person's", async (t) => {
  const { sessions, id, runs } = await rig(t);
  const shared = await sessions.runVaultCommand({
    sessionId: id, command: "echo \"$POLYTH_SAFE_SHARED\"", purpose: "x", timeoutMs: 60_000,
  });
  assert.equal(runs[0]?.POLYTH_SAFE_SHARED, SHARED);
  assert.equal(shared.output, "[redacted]\n");
  await assert.rejects(
    sessions.runVaultCommand({ sessionId: id, command: "echo \"$POLYTH_SAFE_DEPLOY\"", purpose: "x", timeoutMs: 60_000 }),
    (error: { code?: string }) => error.code === "not-found",
  );
  assert.equal(runs.length, 1);
});

test("an actor the session's Space does not admit gets nothing and runs nothing", async (t) => {
  const { sessions, id, runs } = await rig(t);
  await assert.rejects(
    sessions.runVaultCommand({
      sessionId: id, command: "echo \"$POLYTH_SAFE_SHARED\"", purpose: "x", actorUserId: "mallory", timeoutMs: 60_000,
    }),
    (error: { code?: string }) => error.code === "not-found",
  );
  assert.equal(runs.length, 0);
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 25));

/** Alice's running turn asks for a Vault run of `refs`; returns the decision
 *  and the package-tool card, if the server left one for a person. */
async function askVaultRun(r: Awaited<ReturnType<typeof rig>>, refs: string[]) {
  await r.sessions.send(r.id, { text: "use the vault" }, { author: { userId: "alice" } });
  await flush();
  const cwd = r.root;
  const pending = r.sessions.requestAgentToolPermission({
    spaceId: "spc_a",
    projectId: "p1",
    cwd,
    toolId: VAULT_RUN_TOOL_ID,
    toolName: "polyth_credential_vault_run",
    owner: "secure-safe",
    metadata: { command: `deploy ${refs.map((ref) => `$${ref}`).join(" ")}`, handles: refs, purpose: "Publish", cwd },
  });
  await flush();
  const card = (await r.store.events(r.id)).find((event) => event.type === "permission/requested"
    && (event.data as { permission?: string }).permission === "package-tool");
  return { pending, card: card?.data as { requestId: string; metadata?: { handles?: string[] } } | undefined };
}

test("a run's approval level comes from the keys in the session's own Space", async (t) => {
  // Alice made her own key fully safe: no card, even at Ask.
  const r = await rig(t, { permission: "ask", approvals: { deploy: "safe" } });
  const { pending, card } = await askVaultRun(r, ["POLYTH_SAFE_DEPLOY"]);
  assert.equal(card, undefined);
  assert.equal(await pending, "allow");
});

test("a card the keys leave for a person names them by handle", async (t) => {
  const r = await rig(t, { permission: "ask", approvals: { deploy: "safe", shared: "always" } });
  const { pending, card } = await askVaultRun(r, ["POLYTH_SAFE_DEPLOY", "POLYTH_SAFE_SHARED"]);
  assert.ok(card, "the Space key that always asks leaves a card");
  assert.deepEqual(card.metadata?.handles, ["DEPLOY", "SHARED"]);
  await r.sessions.replyPermission(r.id, card.requestId, "reject");
  assert.equal(await pending, "deny");
});
