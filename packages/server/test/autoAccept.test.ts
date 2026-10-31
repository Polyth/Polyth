// Auto-accept: policy-approved requests append BOTH events at once
// (requested + resolved{auto:true}) and never notify; deny rules still win;
// subagents inherit the nearest parent's policy with child opt-out; enabling
// reconciles already-pending requests; composer-shell confirmations stay manual.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";
import type { AgentRuntime, Project, ProjectService, RuntimeEvent } from "@polyth/contracts";
import { createApprovalDefaultsService, createAutoAcceptStore, type ApprovalDefaultsService, type PermissionRule, type PermissionScopeCheck, type PermissionService } from "@polyth/permissions";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

type Emit = (sessionId: string, ev: RuntimeEvent) => void;

function fakeRuntime() {
  const listeners = new Set<Emit>();
  const permissionReplies: Array<{ requestId: string; reply: string }> = [];
  const emit = (sessionId: string, ev: RuntimeEvent) => {
    for (const l of listeners) l(sessionId, ev);
  };
  const rt: AgentRuntime = {
    harnessId: "opencode",
    capabilities: async () => ({ streaming: true, permissions: true, questions: true, compaction: false, subagents: true }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async (req) => { emit(req.sessionId, { type: "turn/started", turnId: "t1" }); },
    abort: async () => {},
    replyPermission: async (_s, requestId, reply) => { permissionReplies.push({ requestId, reply }); },
    replyQuestion: async () => {},
    onEvent(cb) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    dispose: async () => {},
  };
  return { rt, emit, permissionReplies };
}

const flush = () => new Promise((r) => setTimeout(r, 25));

function harness(opts: {
  permission?: "allow" | "deny" | "ask";
  dir?: string;
  org?: boolean;
  guardedSpace?: boolean;
  approvalDefaults?: ApprovalDefaultsService;
  redactToolInput?: (tool: string, input: Record<string, unknown>) => Record<string, unknown>;
  permissionScopeCheck?: PermissionScopeCheck;
  /** Fails wiring a runtime for this project, as a replaced runtime does. */
  unwirableProject?: string;
} = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "polyth-aa-"));
  const store = createStore(join(dir, "s.db"));
  const project: Project = { id: "p1", path: dir, name: "p", spaceId: "space-a", createdAt: 1 };
  // A second project in the same Space, for project approval defaults.
  const second: Project = { id: "p2", path: join(dir, "two"), name: "two", spaceId: "space-a", createdAt: 2 };
  mkdirSync(second.path, { recursive: true });
  const projects: ProjectService = {
    list: async () => [project, second],
    get: async (id) => (id === "p1" ? project : id === "p2" ? second : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  let permission = opts.permission ?? "ask";
  const rules: PermissionRule[] = [];
  const permissions = {
    evaluate: () => permission,
    addRule: (rule: PermissionRule) => { rules.push(rule); },
    rules: () => [...rules],
  } as unknown as PermissionService;
  const attention: Array<{ sessionId: string; kind: string }> = [];
  const waiting: Array<{ sessionId: string; requestId: string }> = [];
  const stopped: Array<{ sessionId: string; reason: string }> = [];
  const statuses: string[] = [];
  const broadcasts: string[] = [];
  const broadcast: Broadcaster = {
    event: (event) => broadcasts.push(event.type),
    projection: (projection) => statuses.push(projection.status),
  };
  const fake = fakeRuntime();
  const sessions = createSessionService({
    redactToolInput: opts.redactToolInput,
    ...(opts.org ? { org: store } : {}),
    ...(opts.guardedSpace ? { guardedSpace: () => true } : {}),
    store, projects, permissions, broadcast, queue: store,
    runtimes: {
      forProject: async (projectId) => {
        if (projectId === opts.unwirableProject) {
          throw Object.assign(new Error("runtime replacement is pending a durable epoch transition"), { code: "epoch-pending" });
        }
        return fake.rt;
      },
    },
    autoAccept: createAutoAcceptStore(join(dir, "auto-accept.json")),
    ...(opts.approvalDefaults ? { approvalDefaults: opts.approvalDefaults } : {}),
    ...(opts.permissionScopeCheck ? { permissionScopeCheck: () => opts.permissionScopeCheck } : {}),
    notify: {
      attention: (sessionId, kind) => attention.push({ sessionId, kind }),
      turnStopped: (sessionId, reason) => stopped.push({ sessionId, reason }),
      permissionWaiting: (sessionId, requestId) => waiting.push({ sessionId, requestId }),
    },
    shell: { run: async () => ({ output: "ok", exitCode: 0, timedOut: false, truncated: false }) },
  });
  return {
    dir, sessions, store, fake, attention, waiting, stopped, statuses, broadcasts, rules,
    setPermission: (value: "allow" | "deny" | "ask") => { permission = value; },
  };
}

test("project-scoped agent tool pauses in the active canonical session until approved", async () => {
  const { sessions, store, fake, attention } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "do the requested package action" });
  await flush();

  const decision = sessions.requestAgentToolPermission({
    spaceId: "space-a",
    projectId: "p1",
    cwd: (await store.projection(id))?.runtimeBinding?.location.directory ?? "",
    harnessId: "opencode",
    toolId: "example-feature.write",
    toolName: "write",
    owner: "example-feature",
  });
  await flush();

  const requested = (await store.events(id)).find((event) =>
    event.type === "permission/requested"
    && (event.data as { permission?: string }).permission === "package-tool");
  assert.ok(requested);
  assert.equal((await store.projection(id))?.status, "waiting");
  assert.deepEqual(attention, [{ sessionId: id, kind: "permission" }]);
  await sessions.replyPermission(
    id,
    (requested.data as { requestId: string }).requestId,
    "once",
  );
  assert.equal(await decision, "allow");
  assert.deepEqual(fake.permissionReplies, [], "package-tool approval is owned by Polyth, not forwarded to the harness");
  assert.ok((await store.events(id)).some((event) =>
    event.type === "permission/resolved"
    && (event.data as { requestId?: string }).requestId === (requested.data as { requestId: string }).requestId));
});

test("a deny rule added while agent-tool approval is pending still wins", async () => {
  const { sessions, store, setPermission } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "do the requested package action" });
  await flush();
  const projection = await store.projection(id);
  const decision = sessions.requestAgentToolPermission({
    spaceId: "space-a",
    projectId: "p1",
    cwd: projection?.runtimeBinding?.location.directory ?? "",
    harnessId: "opencode",
    toolId: "example-feature.write",
    toolName: "write",
    owner: "example-feature",
  });
  await flush();
  const requested = (await store.events(id)).find((event) =>
    event.type === "permission/requested"
    && (event.data as { permission?: string }).permission === "package-tool");
  assert.ok(requested);

  setPermission("deny");
  await sessions.replyPermission(id, (requested.data as { requestId: string }).requestId, "once");
  assert.equal(await decision, "deny");
});

test("agent tool authorization fails closed for idle, foreign-Space, and ambiguous sessions", async () => {
  const { sessions, store } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "Idle" });
  const projection = await store.projection(id);
  const request = (spaceId: string, harnessId = "opencode") => sessions.requestAgentToolPermission({
    spaceId,
    projectId: "p1",
    cwd: projection?.runtimeBinding?.location.directory ?? "",
    harnessId,
    toolId: "example-feature.write",
    toolName: "write",
    owner: "example-feature",
  });
  assert.equal(await request("space-a"), "permission-required");

  await sessions.send(id, { text: "first active turn" });
  await flush();
  assert.equal(await request("space-b"), "permission-required");
  assert.equal(await request("space-a", "claude"), "permission-required");

  const { id: second } = await sessions.create({ projectId: "p1", title: "Also active" });
  await sessions.send(second, { text: "second active turn" });
  await flush();
  assert.equal(await sessions.requestAgentToolPermission({
    spaceId: "space-a",
    projectId: "p1",
    cwd: projection?.runtimeBinding?.location.directory ?? "",
    harnessId: "opencode",
    toolId: "example-feature.write",
    toolName: "write",
    owner: "example-feature",
  }), "permission-required");
  assert.equal((await store.events(id)).some((event) => event.type === "permission/requested"), false);
  assert.equal((await store.events(second)).some((event) => event.type === "permission/requested"), false);
});

test("auto-accept on: request resolves with auto:true, runtime replied, no notify", async () => {
  const { sessions, store, fake, attention, broadcasts } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });

  const r = await sessions.autoAcceptSet!(id, "on");
  assert.deepEqual(r, { setting: "on", effective: true, level: "routine", inherited: "off" });
  assert.equal((await store.projection(id))?.autoAccept, true);
  assert.equal((await store.projection(id))?.autoAcceptSetting, "on");

  fake.emit(id, { type: "permission/requested", requestId: "per_1", permission: "edit", patterns: ["src/*"] });
  await flush();

  const evs = await store.events(id);
  const req = evs.find((e) => e.type === "permission/requested");
  const res = evs.find((e) => e.type === "permission/resolved");
  assert.ok(req, "requested stays in the log — it must remain truthful");
  assert.ok(res);
  const durableIntent = evs.filter((event) => event.seq > req!.seq && event.seq < res!.seq);
  assert.deepEqual(
    durableIntent.map((event) => event.type),
    [
      "permission/response-intended",
      "mutation/prepared",
      "mutation/claimed",
      "mutation/confirmed",
    ],
  );
  assert.equal(durableIntent.every((event) => event.ignorable === true), true);
  assert.deepEqual(durableIntent[0]?.data, {
    requestId: "per_1",
    reply: "once",
    auto: true,
  });
  assert.deepEqual(res!.data, { requestId: "per_1", reply: "once", auto: true });
  assert.deepEqual(fake.permissionReplies, [{ requestId: "per_1", reply: "once" }]);
  assert.notEqual((await store.projection(id))?.status, "waiting");
  assert.equal(attention.length, 0); // auto-accepted cards never notify
  assert.equal(
    broadcasts.includes("permission/requested"),
    false,
    "an automatically resolved request is never published as a permission window",
  );
});

test("an Auto-Approve change succeeds while another chat waits for a runtime epoch", async () => {
  const first = harness();
  const { id: held } = await first.sessions.create({ projectId: "p2", title: "Held" });
  const { id: chat } = await first.sessions.create({ projectId: "p1", title: "Judged" });
  await first.sessions.autoAcceptSet!(held, "on");
  first.fake.emit(held, { type: "permission/requested", requestId: "per_wipe", permission: "bash", patterns: ["rm -rf ~/Documents"] });
  await flush();

  // After a restart the held chat's runtime was replaced: it cannot be wired
  // until its fresh epoch recovers, and its request stays open for a person.
  const restarted = harness({ dir: first.dir, unwirableProject: "p2" });
  await flush();
  const result = await restarted.sessions.autoAcceptSet!(chat, "all");
  assert.deepEqual(result, { setting: "all", effective: true, level: "all", inherited: "off" });
  assert.equal((await restarted.store.projection(chat))?.autoAcceptSetting, "all");
  assert.equal((await restarted.store.events(held)).some((event) => event.type === "permission/resolved"), false);
});

test("auto-accept answers routine requests but holds high-risk ones for a person", async () => {
  const { dir, sessions, store, fake, attention, broadcasts } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.autoAcceptSet!(id, "on");

  fake.emit(id, { type: "permission/requested", requestId: "per_test", permission: "bash", patterns: ["npm test"] });
  fake.emit(id, { type: "permission/requested", requestId: "per_inside", permission: "edit", patterns: [join(dir, "src", "a.ts")] });
  fake.emit(id, { type: "permission/requested", requestId: "per_wipe", permission: "bash", patterns: ["rm -rf ~/Documents"] });
  fake.emit(id, { type: "permission/requested", requestId: "per_hosts", permission: "edit", patterns: ["/etc/hosts"] });
  await flush();

  assert.deepEqual(fake.permissionReplies.map((reply) => reply.requestId).sort(), ["per_inside", "per_test"]);
  const requested = (await store.events(id)).filter((event) => event.type === "permission/requested");
  const preview = (requestId: string) => (requested.find((event) =>
    (event.data as { requestId?: string }).requestId === requestId)?.data as { preview?: { risk?: string; reasons?: string[] } }).preview;
  assert.equal(preview("per_wipe")?.risk, "high");
  assert.deepEqual(preview("per_wipe")?.reasons, ["destructive-delete"]);
  assert.deepEqual(preview("per_hosts")?.reasons, ["outside-workspace"]);
  assert.equal(preview("per_test")?.reasons, undefined);
  // Held requests are real cards: published, waiting, and notified.
  assert.equal(broadcasts.filter((type) => type === "permission/requested").length, 2);
  assert.equal((await store.projection(id))?.status, "waiting");
  assert.deepEqual(attention, [{ sessionId: id, kind: "permission" }, { sessionId: id, kind: "permission" }]);

  // Re-enabling the policy reconciles pending requests, but never these.
  await sessions.autoAcceptSet!(id, "off");
  await sessions.autoAcceptSet!(id, "on");
  await flush();
  assert.equal(fake.permissionReplies.length, 2);

  // A person decides; the decision is not recorded as automatic.
  await sessions.replyPermission(id, "per_wipe", "reject");
  await sessions.replyPermission(id, "per_hosts", "once");
  const resolved = (await store.events(id)).filter((event) => event.type === "permission/resolved"
    && ["per_wipe", "per_hosts"].includes((event.data as { requestId: string }).requestId));
  assert.deepEqual(resolved.map((event) => event.data), [
    { requestId: "per_wipe", reply: "reject" },
    { requestId: "per_hosts", reply: "once" },
  ]);
  assert.notEqual((await store.projection(id))?.status, "waiting");
});

test("Full access answers high-risk requests too, but explicit deny rules still win", async () => {
  const { sessions, store, fake, attention, broadcasts, setPermission } = harness();
  const { id: parent } = await sessions.create({ projectId: "p1", title: "Parent" });
  const { id: child } = await sessions.create({ projectId: "p1", title: "Child", parentId: parent });

  // A held request waits under "on"; switching to "all" reconciles it.
  await sessions.autoAcceptSet!(parent, "on");
  fake.emit(parent, { type: "permission/requested", requestId: "per_held", permission: "bash", patterns: ["git push --force origin main"] });
  await flush();
  assert.deepEqual(fake.permissionReplies, []);
  assert.deepEqual(await sessions.autoAcceptSet!(parent, "all"), { setting: "all", effective: true, level: "all", inherited: "off" });
  await flush();
  assert.deepEqual(fake.permissionReplies, [{ requestId: "per_held", reply: "once" }]);
  assert.equal((await store.projection(parent))?.autoAcceptAll, true);

  // Children inherit Full access; nothing new is published or notified.
  assert.deepEqual(await sessions.autoAcceptGet!(child), { setting: "inherit", effective: true, level: "all", inherited: "all" });
  assert.equal((await store.projection(child))?.autoAcceptAll, true);
  const published = broadcasts.filter((type) => type === "permission/requested").length;
  fake.emit(child, { type: "permission/requested", requestId: "per_wipe", permission: "bash", patterns: ["rm -rf ~/Documents"] });
  await flush();
  assert.deepEqual(fake.permissionReplies.at(-1), { requestId: "per_wipe", reply: "once" });
  const resolved = (await store.events(child)).find((event) => event.type === "permission/resolved");
  assert.deepEqual(resolved?.data, { requestId: "per_wipe", reply: "once", auto: true });
  assert.equal(broadcasts.filter((type) => type === "permission/requested").length, published);

  // A child can narrow it back to routine approval.
  await sessions.autoAcceptSet!(child, "on");
  assert.deepEqual(await sessions.autoAcceptGet!(child), { setting: "on", effective: true, level: "routine", inherited: "all" });
  assert.equal((await store.projection(child))?.autoAcceptAll, false);

  // Deny rules are the user's hard floor even under Full access.
  setPermission("deny");
  fake.emit(parent, { type: "permission/requested", requestId: "per_denied", permission: "bash", patterns: ["npm publish"] });
  await flush();
  assert.deepEqual(fake.permissionReplies.at(-1), { requestId: "per_denied", reply: "reject" });
  assert.equal(attention.length, 1, "only the held request under \"on\" ever notified");
});

const approvalDefaultsIn = (dir: string) =>
  createApprovalDefaultsService((spaceId) => join(dir, "spaces", spaceId, "full-access.json"));

test("the Space's Full access default covers chats without a choice of their own", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-aa-space-"));
  const approvalDefaults = approvalDefaultsIn(dir);
  const { sessions, store, fake } = harness({ dir, approvalDefaults });
  const { id: plain } = await sessions.create({ projectId: "p1", title: "Plain" });
  const { id: optedOut } = await sessions.create({ projectId: "p1", title: "Opted out" });
  await sessions.autoAcceptSet!(optedOut, "off");
  fake.emit(plain, { type: "permission/requested", requestId: "per_wait", permission: "bash", patterns: ["git push --force origin main"] });
  await flush();
  assert.deepEqual(fake.permissionReplies, []);

  // Turning it on reaches existing chats and approves what was waiting.
  approvalDefaults.setSpaceLevel("space-a", "all", "owner");
  await flush();
  assert.deepEqual(fake.permissionReplies, [{ requestId: "per_wait", reply: "once" }]);
  assert.equal((await store.projection(plain))?.autoAcceptAll, true);
  assert.deepEqual(await sessions.autoAcceptGet!(plain), { setting: "inherit", effective: true, level: "all", inherited: "all" });
  // An explicit choice is kept.
  assert.deepEqual(await sessions.autoAcceptGet!(optedOut), { setting: "off", effective: false, level: "off", inherited: "all" });
  assert.equal((await store.projection(optedOut))?.autoAccept, false);

  // New chats and their subagents start in Full access.
  const { id: fresh } = await sessions.create({ projectId: "p1", title: "Fresh" });
  assert.equal((await store.projection(fresh))?.autoAcceptAll, true);
  const { id: child } = await sessions.create({ projectId: "p1", title: "Child", parentId: fresh });
  assert.equal((await store.projection(child))?.autoAcceptAll, true);
  assert.equal((await sessions.list("p1")).find((row) => row.id === fresh)?.autoAcceptAll, true);

  // Back to Ask goes back to asking.
  approvalDefaults.setSpaceLevel("space-a", "off", "owner");
  await flush();
  assert.equal((await store.projection(plain))?.autoAccept, false);
  assert.equal((await store.projection(child))?.autoAccept, false);
  fake.emit(plain, { type: "permission/requested", requestId: "per_ask", permission: "bash", patterns: ["npm test"] });
  await flush();
  assert.equal(fake.permissionReplies.length, 1);
});

test("a Space approval change refreshes chat flags without reordering the recency list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-aa-order-"));
  const approvalDefaults = approvalDefaultsIn(dir);
  const { sessions, store } = harness({ dir, approvalDefaults });
  const { id: older } = await sessions.create({ projectId: "p1", title: "Older" });
  const { id: newer } = await sessions.create({ projectId: "p1", title: "Newer" });
  const before = await store.projection(older);
  await new Promise((r) => setTimeout(r, 5));

  approvalDefaults.setSpaceLevel("space-a", "all", "owner");
  await flush();
  const after = await store.projection(older);
  assert.equal(after?.autoAcceptAll, true);
  // Derived policy flags are not session activity: an idle chat keeps its
  // place, so old (pinned) chats are not pushed off the first catalog page.
  assert.equal(after?.updatedAt, before?.updatedAt);
  assert.ok((await store.projection(newer))!.updatedAt >= after!.updatedAt);
});

test("an Auto-approve default answers routine requests in chats without a choice and holds high-risk ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-aa-routine-"));
  const approvalDefaults = approvalDefaultsIn(dir);
  const { sessions, store, fake, attention } = harness({ dir, approvalDefaults });
  const { id: plain } = await sessions.create({ projectId: "p1", title: "Plain" });
  const { id: asks } = await sessions.create({ projectId: "p1", title: "Asks" });
  await sessions.autoAcceptSet!(asks, "off");
  fake.emit(plain, { type: "permission/requested", requestId: "per_test", permission: "bash", patterns: ["npm test"] });
  fake.emit(asks, { type: "permission/requested", requestId: "per_asks", permission: "bash", patterns: ["npm test"] });
  await flush();
  assert.deepEqual(fake.permissionReplies, []);

  // Choosing it answers the routine request already waiting, only where no
  // level was picked.
  approvalDefaults.setSpaceLevel("space-a", "routine", "owner");
  await flush();
  assert.deepEqual(fake.permissionReplies, [{ requestId: "per_test", reply: "once" }]);
  assert.deepEqual(await sessions.autoAcceptGet!(plain), { setting: "inherit", effective: true, level: "routine", inherited: "routine" });
  const row = await store.projection(plain);
  assert.equal(row?.autoAccept, true);
  assert.equal(row?.autoAcceptAll, false);
  assert.deepEqual(await sessions.autoAcceptGet!(asks), { setting: "off", effective: false, level: "off", inherited: "routine" });

  // High-risk requests still wait for a person.
  const notified = attention.length;
  fake.emit(plain, { type: "permission/requested", requestId: "per_force", permission: "bash", patterns: ["git push --force origin main"] });
  await flush();
  assert.equal(fake.permissionReplies.length, 1);
  assert.equal(attention.length, notified + 1, "the held request reaches the person");

  // New chats and subagents start auto-approving routine actions.
  const { id: fresh } = await sessions.create({ projectId: "p1", title: "Fresh" });
  const { id: child } = await sessions.create({ projectId: "p1", title: "Child", parentId: fresh });
  for (const id of [fresh, child]) {
    const projection = await store.projection(id);
    assert.equal(projection?.autoAccept, true);
    assert.equal(projection?.autoAcceptAll, false);
  }
});

test("a project's own approval level wins over the Space's in both directions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-aa-project-"));
  const approvalDefaults = approvalDefaultsIn(dir);
  const { sessions, store, fake } = harness({ dir, approvalDefaults });
  const { id: one } = await sessions.create({ projectId: "p1", title: "One" });
  const { id: two } = await sessions.create({ projectId: "p2", title: "Two" });

  // Raise one project above the Space's Ask.
  approvalDefaults.setProjectLevel("space-a", "p2", "routine", "owner");
  await flush();
  assert.equal((await sessions.autoAcceptGet!(one)).level, "off");
  assert.equal((await sessions.autoAcceptGet!(two)).level, "routine");
  assert.equal((await sessions.list("p2")).find((row) => row.id === two)?.autoAccept, true);
  fake.emit(two, { type: "permission/requested", requestId: "per_two", permission: "bash", patterns: ["npm test"] });
  fake.emit(one, { type: "permission/requested", requestId: "per_one", permission: "bash", patterns: ["npm test"] });
  await flush();
  assert.deepEqual(fake.permissionReplies, [{ requestId: "per_two", reply: "once" }]);

  // Narrow one project below the Space's Full access.
  approvalDefaults.setSpaceLevel("space-a", "all", "owner");
  approvalDefaults.setProjectLevel("space-a", "p2", "off", "owner");
  await flush();
  assert.equal((await sessions.autoAcceptGet!(one)).level, "all");
  assert.equal((await sessions.autoAcceptGet!(two)).level, "off");
  assert.equal((await store.projection(two))?.autoAccept, false);
  fake.emit(two, { type: "permission/requested", requestId: "per_two_wipe", permission: "bash", patterns: ["rm -rf ~/Documents"] });
  await flush();
  assert.equal(fake.permissionReplies.some((reply) => reply.requestId === "per_two_wipe"), false);
  assert.ok(fake.permissionReplies.some((reply) => reply.requestId === "per_one"), "Full access answered the request waiting in the other project");
});

test("a subagent in another project falls back to its own project's level", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-aa-cross-"));
  const approvalDefaults = approvalDefaultsIn(dir);
  approvalDefaults.setProjectLevel("space-a", "p2", "routine", "owner");
  const { sessions, store } = harness({ dir, approvalDefaults });
  const { id: parent } = await sessions.create({ projectId: "p1", title: "Parent" });
  const { id: child } = await sessions.create({ projectId: "p2", title: "Child", parentId: parent });
  // No chat chose a level: the child's own project decides, from the first projection on.
  assert.equal((await store.projection(child))?.autoAccept, true);
  assert.deepEqual(await sessions.autoAcceptGet!(child), { setting: "inherit", effective: true, level: "routine", inherited: "routine" });
  assert.deepEqual(await sessions.autoAcceptGet!(parent), { setting: "inherit", effective: false, level: "off", inherited: "off" });
  // An explicit choice above it still wins.
  await sessions.autoAcceptSet!(parent, "off");
  assert.deepEqual(await sessions.autoAcceptGet!(child), { setting: "inherit", effective: false, level: "off", inherited: "off" });
});

test("approval defaults never answer in a guarded Space or another Space", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-aa-space-"));
  const approvalDefaults = approvalDefaultsIn(dir);
  approvalDefaults.setSpaceLevel("space-b", "all", "owner");
  const other = harness({ dir, approvalDefaults });
  const { id } = await other.sessions.create({ projectId: "p1", title: "T" });
  assert.equal((await other.sessions.autoAcceptGet!(id)).level, "off", "space-b's choice does not reach space-a");

  const guarded = harness({ approvalDefaults, guardedSpace: true });
  approvalDefaults.setSpaceLevel("space-a", "routine", "owner");
  approvalDefaults.setProjectLevel("space-a", "p1", "all", "owner");
  const { id: g } = await guarded.sessions.create({ projectId: "p1", title: "G" });
  assert.equal((await guarded.sessions.autoAcceptGet!(g)).level, "off");
  guarded.fake.emit(g, { type: "permission/requested", requestId: "per_g", permission: "bash", patterns: ["npm test"] });
  await flush();
  assert.deepEqual(guarded.fake.permissionReplies, []);
});

test("an always reply without a scope is remembered for its session only", async () => {
  const { sessions, fake, rules } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  fake.emit(id, { type: "permission/requested", requestId: "per_plain", permission: "bash", patterns: ["npm test"] });
  fake.emit(id, { type: "permission/requested", requestId: "per_project", permission: "edit", patterns: ["src/*"] });
  await flush();
  await sessions.replyPermission(id, "per_plain", "always");
  await sessions.replyPermission(id, "per_project", "always", "project");
  assert.deepEqual(rules, [
    { permission: "bash", pattern: "npm test", action: "allow", scope: "session", sessionId: id },
    { permission: "edit", pattern: "src/*", action: "allow", scope: "project", projectId: "p1" },
  ]);
  assert.ok(rules.every((rule) => rule.scope !== "user"), "no remembered approval spans projects or Spaces");
});

test("a held request stays visible in attention counts while auto-accept is on", async () => {
  const { sessions, fake } = harness({ org: true });
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.autoAcceptSet!(id, "on");
  fake.emit(id, { type: "permission/requested", requestId: "per_push", permission: "bash", patterns: ["git push --force origin main"] });
  await flush();
  const row = (await sessions.list("p1")).find((session) => session.id === id);
  assert.equal(row?.autoAccept, true);
  assert.equal(row?.attention?.permissions, 1);
});

test("auto-accept answers routine package tools but holds destructive ones", async () => {
  const { sessions, store } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.autoAcceptSet!(id, "on");
  await sessions.send(id, { text: "use the tools" });
  await flush();
  const grant = {
    spaceId: "space-a",
    projectId: "p1",
    cwd: (await store.projection(id))?.runtimeBinding?.location.directory ?? "",
    harnessId: "opencode",
  };
  assert.equal(await sessions.requestAgentToolPermission({ ...grant, toolId: "example-feature.read", toolName: "read", owner: "example-feature" }), "allow");
  const pending = sessions.requestAgentToolPermission({ ...grant, toolId: "github.delete-repository", toolName: "delete_repository", owner: "github" });
  await flush();
  const request = (await store.events(id)).find((event) => event.type === "permission/requested"
    && (event.data as { permission?: string }).permission === "package-tool");
  assert.ok(request, "the destructive tool waits for a person");
  assert.deepEqual((request.data as { preview: { reasons: string[] } }).preview.reasons, ["destructive-tool"]);
  await sessions.replyPermission(id, (request.data as { requestId: string }).requestId, "reject");
  assert.equal(await pending, "deny");
});

test("auto-accept holds package tools that send, and the card shows the call's arguments", async () => {
  const { sessions, store } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.autoAcceptSet!(id, "on");
  await sessions.send(id, { text: "email the report" });
  await flush();
  const pending = sessions.requestAgentToolPermission({
    spaceId: "space-a",
    projectId: "p1",
    cwd: (await store.projection(id))?.runtimeBinding?.location.directory ?? "",
    harnessId: "opencode",
    toolId: "google.gmail-send",
    toolName: "google_gmail_send",
    owner: "google",
    metadata: { action: "send", to: "ada@example.com", subject: "Report", attachments: "report.pdf" },
  });
  await flush();
  const request = (await store.events(id)).find((event) => event.type === "permission/requested"
    && (event.data as { permission?: string }).permission === "package-tool");
  assert.ok(request, "sending waits for a person even with Auto-Approve on");
  const preview = (request.data as { preview: { lines: string[]; reasons: string[]; risk: string } }).preview;
  assert.equal(preview.risk, "high");
  assert.deepEqual(preview.reasons, ["remote-change"]);
  assert.ok(preview.lines.includes("to: ada@example.com"));
  assert.ok(preview.lines.includes("attachments: report.pdf"));
  await sessions.replyPermission(id, (request.data as { requestId: string }).requestId, "reject");
  assert.equal(await pending, "deny");
});

test("deny rules beat auto-accept", async () => {
  const { sessions, store, fake } = harness({ permission: "deny" });
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.autoAcceptSet!(id, "on");

  fake.emit(id, { type: "permission/requested", requestId: "per_1", permission: "edit", patterns: ["/etc/*"] });
  await flush();

  const res = (await store.events(id)).find((e) => e.type === "permission/resolved");
  assert.deepEqual(res!.data, { requestId: "per_1", reply: "reject" });
  assert.deepEqual(fake.permissionReplies, [{ requestId: "per_1", reply: "reject" }]);
});

test("only a request no rule or automatic approval decided waits for a person's decision", async () => {
  const { sessions, fake, attention, waiting } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  fake.emit(id, { type: "permission/requested", requestId: "per_1", permission: "edit", patterns: ["src/*"] });
  await flush();
  assert.deepEqual(waiting, [{ sessionId: id, requestId: "per_1" }], "a request policy leaves for a person is published");
  await sessions.replyPermission(id, "per_1", "once");

  // Auto-Approve answers a routine request: nothing waits.
  await sessions.autoAcceptSet!(id, "on");
  fake.emit(id, { type: "permission/requested", requestId: "per_2", permission: "edit", patterns: ["src/*"] });
  await flush();
  assert.equal(waiting.length, 1);
});

test("a decided answer that failed to deliver is shown to a person but never offered to automation", async () => {
  const { sessions, store, fake, attention, waiting } = harness({ permission: "deny" });
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  fake.rt.replyPermission = async () => { throw new Error("transport closed"); };
  fake.emit(id, { type: "permission/requested", requestId: "per_1", permission: "edit", patterns: ["/etc/*"] });
  await flush();
  assert.equal((await store.events(id)).some((e) => e.type === "permission/resolved"), false, "the reject did not land");
  assert.deepEqual(attention, [{ sessionId: id, kind: "permission" }], "the card still reaches a person");
  assert.deepEqual(waiting, [], "a deny rule's undelivered reject is never handed to a judge");
});

test("todo-list tools never ask, even with Auto-Approve off; deny rules and guarded Spaces still hold", async () => {
  const { sessions, store, fake, attention, broadcasts, setPermission } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  assert.equal((await sessions.autoAcceptGet!(id)).effective, false);

  fake.emit(id, { type: "permission/requested", requestId: "per_claude", permission: "mcp__polyth-agent-tools__polyth_todo", patterns: ["mcp__polyth-agent-tools__polyth_todo"] });
  fake.emit(id, { type: "permission/requested", requestId: "per_opencode", permission: "polyth-agent-tools_polyth_todo", patterns: ["*"] });
  fake.emit(id, { type: "permission/requested", requestId: "per_native", permission: "todowrite", patterns: ["*"] });
  fake.emit(id, { type: "permission/requested", requestId: "per_foreign", permission: "mcp__other__todowrite", patterns: ["mcp__other__todowrite"] });
  await flush();

  assert.deepEqual(fake.permissionReplies.map((reply) => reply.requestId).sort(), ["per_claude", "per_native", "per_opencode"]);
  const resolved = (await store.events(id)).filter((event) => event.type === "permission/resolved");
  assert.equal(resolved.every((event) => (event.data as { auto?: boolean }).auto === true), true);
  // Only the foreign server's tool became a card.
  assert.equal(broadcasts.filter((type) => type === "permission/requested").length, 1);
  assert.deepEqual(attention, [{ sessionId: id, kind: "permission" }]);

  setPermission("deny");
  fake.emit(id, { type: "permission/requested", requestId: "per_denied", permission: "todowrite", patterns: ["*"] });
  await flush();
  assert.deepEqual(fake.permissionReplies.at(-1), { requestId: "per_denied", reply: "reject" });

  const guarded = harness({ guardedSpace: true });
  const { id: guardedId } = await guarded.sessions.create({ projectId: "p1", title: "G" });
  guarded.fake.emit(guardedId, { type: "permission/requested", requestId: "per_guarded", permission: "todowrite", patterns: ["*"] });
  await flush();
  assert.deepEqual(guarded.fake.permissionReplies, []);
});

test("subagent inherits the nearest parent's policy; child opt-out wins", async () => {
  const { sessions, store, fake, attention } = harness();
  const { id: parent } = await sessions.create({ projectId: "p1", title: "Parent" });
  await sessions.autoAcceptSet!(parent, "on");

  // child created AFTER enabling: projection flag inherited at birth
  const { id: child } = await sessions.create({ projectId: "p1", title: "Child", parentId: parent });
  assert.equal((await store.projection(child))?.autoAccept, true);
  assert.deepEqual(await sessions.autoAcceptGet!(child), { setting: "inherit", effective: true, level: "routine", inherited: "routine" });

  fake.emit(child, { type: "permission/requested", requestId: "per_c", permission: "bash", patterns: ["npm test"] });
  await flush();
  const res = (await store.events(child)).find((e) => e.type === "permission/resolved");
  assert.deepEqual(res!.data, { requestId: "per_c", reply: "once", auto: true });

  // explicit child opt-out: next request waits like normal
  await sessions.autoAcceptSet!(child, "off");
  assert.equal((await store.projection(child))?.autoAccept, false);
  assert.equal((await store.projection(parent))?.autoAccept, true); // parent untouched
  fake.emit(child, { type: "permission/requested", requestId: "per_c2", permission: "bash", patterns: ["rm -rf"] });
  await flush();
  assert.equal((await store.projection(child))?.status, "waiting");
  assert.deepEqual(attention, [{ sessionId: child, kind: "permission" }]);
});

test("a chat's own choice refreshes only the subagents inheriting it, never waiting on other chats", async () => {
  const { sessions, store } = harness();
  const { id: other } = await sessions.create({ projectId: "p1", title: "Other" });
  await sessions.autoAcceptSet!(other, "on");
  const { id: parent } = await sessions.create({ projectId: "p1", title: "Parent" });
  const { id: child } = await sessions.create({ projectId: "p1", title: "Child", parentId: parent });
  const { id: grandchild } = await sessions.create({ projectId: "p1", title: "Grandchild", parentId: child });
  const { id: optedOut } = await sessions.create({ projectId: "p1", title: "Opted out", parentId: parent });
  await sessions.autoAcceptSet!(optedOut, "off");
  const { id: underOptOut } = await sessions.create({ projectId: "p1", title: "Under opt-out", parentId: optedOut });

  // An unrelated chat that cannot be read right now (its lock is busy, or the
  // Space holds ~1,800 chats) must not hold up this chat's change.
  const read: string[] = [];
  const projection = store.projection.bind(store);
  store.projection = async (id) => {
    read.push(id);
    return id === other ? new Promise<never>(() => {}) : projection(id);
  };
  const result = await Promise.race([
    sessions.autoAcceptSet!(parent, "all"),
    new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 2_000)),
  ]);
  store.projection = projection;

  assert.notEqual(result, "timed out", "the change does not wait on an unrelated chat");
  assert.equal(read.includes(other), false);
  assert.equal(read.includes(underOptOut), false, "a subagent under its own choice is out of reach");
  for (const id of [parent, child, grandchild]) {
    assert.equal((await store.projection(id))?.autoAcceptAll, true, "inheriting subagents see the change");
  }
  assert.equal((await store.projection(optedOut))?.autoAccept ?? false, false);
  assert.equal((await store.projection(underOptOut))?.autoAccept ?? false, false);
});

test("enabling reconciles pending requests and leaves idle when no turn is active", async () => {
  const { sessions, store, fake, attention } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });

  fake.emit(id, { type: "permission/requested", requestId: "per_1", permission: "edit", patterns: ["a"] });
  fake.emit(id, { type: "permission/requested", requestId: "per_2", permission: "edit", patterns: ["b"] });
  await flush();
  assert.equal((await store.projection(id))?.status, "waiting");
  assert.equal(attention.length, 2); // real pending cards did notify

  await sessions.autoAcceptSet!(id, "on");
  await flush();

  const evs = await store.events(id);
  const resolved = evs.filter((e) => e.type === "permission/resolved");
  assert.equal(resolved.length, 2);
  for (const r of resolved) assert.equal((r.data as { auto?: boolean }).auto, true);
  assert.deepEqual(
    fake.permissionReplies.map((p) => p.requestId).sort(),
    ["per_1", "per_2"],
  );
  assert.equal(
    (await store.projection(id))?.status,
    "idle",
    "no active turn → resolving the last open request returns idle",
  );

  // disabling flips the flag back and new requests wait again
  await sessions.autoAcceptSet!(id, "off");
  assert.equal((await store.projection(id))?.autoAccept, false);

  fake.emit(id, { type: "permission/requested", requestId: "per_3", permission: "edit", patterns: ["c"] });
  await flush();
  assert.equal((await store.projection(id))?.status, "waiting");
  assert.equal(
    (await store.events(id)).some((event) =>
      event.type === "permission/requested"
      && (event.data as { requestId?: string }).requestId === "per_3"),
    true,
  );
  assert.equal(
    (await store.events(id)).some((event) =>
      event.type === "permission/resolved"
      && (event.data as { requestId?: string }).requestId === "per_3"),
    false,
    "turning Auto-Approve off restores prompting for future requests immediately",
  );
});

test("enabling drains a stale queued request even when projection status is not waiting", async () => {
  const { sessions, store, fake } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await store.append(id, "permission/requested", {
    requestId: "per_stale",
    permission: "bash",
    patterns: ["npm test"],
  }, { ignorable: true });
  await store.upsertProjection({ ...(await store.projection(id))!, status: "idle" });

  await sessions.autoAcceptSet!(id, "on");
  await flush();

  assert.deepEqual(fake.permissionReplies, [{ requestId: "per_stale", reply: "once" }]);
  assert.ok((await store.events(id)).some((event) =>
    event.type === "permission/resolved"
    && (event.data as { requestId?: string; auto?: boolean }).requestId === "per_stale"
    && (event.data as { auto?: boolean }).auto === true));
});

test("setting survives a server reload and resumed job uses it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-aa-restart-"));
  const first = harness({ dir });
  const { id } = await first.sessions.create({ projectId: "p1", title: "T" });
  await first.sessions.autoAcceptSet!(id, "on");
  await first.store.close();

  const resumed = harness({ dir });
  assert.deepEqual(await resumed.sessions.autoAcceptGet!(id), { setting: "on", effective: true, level: "routine", inherited: "off" });
  assert.equal((await resumed.store.projection(id))?.autoAcceptSetting, "on");
  await resumed.sessions.send(id, { text: "continue" });
  resumed.fake.emit(id, {
    type: "permission/requested",
    requestId: "per_resumed",
    permission: "bash",
    patterns: ["git status"],
  });
  await flush();

  assert.deepEqual(resumed.fake.permissionReplies, [{ requestId: "per_resumed", reply: "once" }]);
  assert.equal(resumed.broadcasts.includes("permission/requested"), false);
  await resumed.store.close();
});

test("legacy JSON setting migrates once into canonical session persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-aa-migrate-"));
  const original = harness({ dir });
  const { id } = await original.sessions.create({ projectId: "p1", title: "T" });
  await original.store.close();
  createAutoAcceptStore(join(dir, "auto-accept.json")).set(id, "on");

  const migrated = harness({ dir });
  await waitFor(async () => (await migrated.store.projection(id))?.autoAcceptSetting === "on");

  assert.deepEqual(await migrated.sessions.autoAcceptGet!(id), { setting: "on", effective: true, level: "routine", inherited: "off" });
  assert.doesNotMatch(readFileSync(join(dir, "auto-accept.json"), "utf8"), new RegExp(id));
  await migrated.store.close();
});

test("enabling reconciles pending requests back to working while a turn is active", async () => {
  const { sessions, store, fake } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  fake.emit(id, { type: "turn/started", turnId: "t1" });
  fake.emit(id, { type: "permission/requested", requestId: "per_w", permission: "edit", patterns: ["a"] });
  await flush();
  assert.equal((await store.projection(id))?.status, "waiting");

  await sessions.autoAcceptSet!(id, "on");
  await flush();
  assert.equal((await store.projection(id))?.status, "working");
});

test("the card's own request is answered before its subagents are refreshed", async () => {
  const { sessions, store, fake } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  fake.emit(id, { type: "turn/started", turnId: "t1" });
  fake.emit(id, { type: "permission/requested", requestId: "per_card", permission: "edit", patterns: ["a"] });
  await flush();
  // The refresh lists every projection to find the subagents; until the
  // card's own request is answered the row is `waiting` with nothing to answer.
  const statusAtSweep: Array<string | undefined> = [];
  const projections = store.projections.bind(store);
  store.projections = async (...args) => {
    statusAtSweep.push((await store.projection(id))?.status);
    return projections(...args);
  };

  await sessions.autoAcceptSet!(id, "on");
  assert.equal(statusAtSweep[0], "working");
  assert.ok((await store.events(id)).some((event) => event.type === "permission/resolved"));
});

test("a composer-shell command runs without a confirmation even when the policy asks", async () => {
  const { dir, sessions, store } = harness({ permission: "ask" });
  const { id } = await sessions.create({ projectId: "p1", title: "T" });

  // The person typed and sent the command; sending it is the consent.
  const r = await sessions.runShell!(id, `rm -rf ${join(dir, "build")}`);
  assert.equal(r.status, "completed");
  const evs = await store.events(id);
  assert.equal(evs.some((e) => e.type === "permission/requested"), false);
  assert.deepEqual(evs.slice(-2).map((e) => [e.type, e.producerPlugin]), [
    ["tool/call", "composer-shell"],
    ["tool/result", "composer-shell"],
  ]);
  assert.equal((await store.projection(id))?.status, "idle");
});

test("turn lifecycle reaches the notify seam once per terminal turn", async () => {
  const { sessions, fake, stopped } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  fake.emit(id, { type: "turn/started", turnId: "t-dedupe" });
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  fake.emit(id, { type: "turn/stopped", reason: "error", error: "boom" });
  await flush();
  assert.deepEqual(stopped, [
    { sessionId: id, reason: "completed" },
  ], "a later terminal stop for the same turn is deduplicated");
});

test("error stop + open permission → waiting → resolve → failed; queue stays", async () => {
  const { sessions, store, fake } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await store.enqueue(id, "queued after fail", "follow-up");
  fake.emit(id, { type: "turn/started", turnId: "t-err" });
  fake.emit(id, {
    type: "permission/requested",
    requestId: "per_err",
    permission: "bash",
    patterns: ["ls"],
  });
  await flush();
  assert.equal((await store.projection(id))?.status, "waiting");

  fake.emit(id, { type: "turn/stopped", reason: "error", error: "boom" });
  await flush();
  assert.equal((await store.projection(id))?.status, "waiting");
  const interrupt = (await store.enqueue(id, "late interrupt", "interrupt")).item;
  const queued = await store.queueList(id);
  await store.queueReorder(id, [interrupt.id, ...queued.filter((item) => item.id !== interrupt.id).map((item) => item.id)]);

  await sessions.replyPermission(id, "per_err", "once");
  await flush();
  assert.equal((await store.projection(id))?.status, "failed");
  assert.equal((await store.queueList(id)).length, 2);
  await store.close();
});

// A provider that errors after the final message (a 502 on the tail of a
// finished turn) must not park a read session in `failed`.
test("error stop after a delivered answer settles idle, without it failed", async () => {
  const { sessions, store, fake } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  fake.emit(id, { type: "turn/started", turnId: "t-tail" });
  fake.emit(id, { type: "assistant/message", partId: "t-tail:1", text: "done, all tests pass" });
  await flush();
  fake.emit(id, { type: "turn/stopped", reason: "error", error: "API error (attempt 1): 502" });
  await flush();
  assert.equal((await store.projection(id))?.status, "idle");
  assert.equal((await store.events(id)).findLast((event) => event.type === "turn/stopped")?.data.reason, "error");

  const other = await sessions.create({ projectId: "p1", title: "T2" });
  fake.emit(other.id, { type: "turn/started", turnId: "t-silent" });
  await flush();
  fake.emit(other.id, { type: "turn/stopped", reason: "error", error: "API error (attempt 1): 502" });
  await flush();
  assert.equal((await store.projection(other.id))?.status, "failed");
  await store.close();
});

test("queued interrupt turns a runtime error into a durable abort", async () => {
  const { sessions, store, fake, statuses } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  fake.emit(id, { type: "turn/started", turnId: "t-abort" });
  fake.emit(id, { type: "permission/requested", requestId: "per_abort", permission: "bash", patterns: ["ls"] });
  await store.enqueue(id, "interrupt now", "interrupt");
  await flush();

  fake.emit(id, { type: "turn/stopped", reason: "error", error: "Aborted" });
  await flush();
  assert.equal((await store.events(id)).findLast((event) => event.type === "turn/stopped")?.data.reason, "aborted");
  assert.equal((await store.projection(id))?.status, "waiting");

  await sessions.replyPermission(id, "per_abort", "once");
  await waitFor(async () => (await store.queueList(id)).length === 0);
  assert.equal((await store.projection(id))?.status, "working");
  assert.equal(statuses.includes("idle"), true);
  assert.equal(statuses.includes("failed"), false);
  await store.close();
});

const waitFor = async (condition: () => boolean | Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not reached");
};

test("WS23: permission pending → waiting; resolve → working", async () => {
  const { sessions, store, fake } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  fake.emit(id, { type: "turn/started", turnId: "t1" });
  fake.emit(id, {
    type: "permission/requested",
    requestId: "per_1",
    permission: "edit",
    patterns: ["a.ts"],
  });
  await waitFor(async () => (await store.projection(id))?.status === "waiting");

  await sessions.replyPermission(id, "per_1", "once");
  await waitFor(async () => (await store.projection(id))?.status === "working");
  await store.close();
});

test("WS23: question pending → waiting; resolve → working", async () => {
  const { sessions, store, fake } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  fake.emit(id, { type: "turn/started", turnId: "t1" });
  fake.emit(id, {
    type: "question/asked",
    requestId: "q_1",
    questions: [{ id: "continue", prompt: "Continue?" }],
  });
  await waitFor(async () => (await store.projection(id))?.status === "waiting");

  await sessions.replyQuestion(id, "q_1", { continue: "yes" });
  await waitFor(async () => (await store.projection(id))?.status === "working");
  await store.close();
});

test("WS23: turn/stopped with an open permission stays waiting then idles", async () => {
  const { sessions, store, fake } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  fake.emit(id, { type: "turn/started", turnId: "t1" });
  fake.emit(id, {
    type: "permission/requested",
    requestId: "per_open",
    permission: "bash",
    patterns: ["rm"],
  });
  await waitFor(async () => (await store.projection(id))?.status === "waiting");

  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await waitFor(async () =>
    (await store.events(id)).some((e) => e.type === "turn/stopped"));
  assert.equal((await store.projection(id))?.status, "waiting");

  await sessions.replyPermission(id, "per_open", "reject");
  await waitFor(async () => (await store.projection(id))?.status === "idle");
  await flush();
  await store.close();
});

test("child auto-accept never creates a duplicate parent permission path", async () => {
  const { sessions, store, fake } = harness();
  const { id: parent } = await sessions.create({ projectId: "p1", title: "Parent" });
  await sessions.autoAcceptSet!(parent, "on");
  const { id: child } = await sessions.create({
    projectId: "p1",
    title: "Child",
    parentId: parent,
  });

  fake.emit(child, {
    type: "permission/requested",
    requestId: "per_mirror",
    permission: "bash",
    patterns: ["npm test"],
  });
  await waitFor(async () =>
    (await store.events(child)).some((e) => e.type === "permission/resolved"));

  assert.notEqual((await store.projection(child))?.status, "waiting");
  assert.equal((await store.events(parent)).some((e) =>
    (e.type === "permission/requested" || e.type === "permission/resolved")
    && (e.data as { requestId?: string }).requestId === "per_mirror"), false);
  assert.notEqual((await store.projection(parent))?.status, "waiting");
  await store.close();
});

for (const childSetting of ["inherit", "off"] as const) {
  test(`enabling parent auto-accept leaves mirrored permissions to the child (${childSetting})`, async (t) => {
    const { dir, sessions, store, fake } = harness();
    t.after(async () => { await sessions.dispose(); await store.close(); rmSync(dir, { recursive: true, force: true }); });
    const { id: parent } = await sessions.create({ projectId: "p1", title: "Parent" });
    const { id: child } = await sessions.create({ projectId: "p1", title: "Child", parentId: parent });
    if (childSetting === "off") await sessions.autoAcceptSet!(child, "off");

    const reply = fake.rt.replyPermission;
    const parentAttempts: string[] = [];
    fake.rt.replyPermission = async (sessionId, requestId, decision) => {
      if (sessionId === parent) {
        parentAttempts.push(requestId);
        throw Object.assign(new Error("permission is not pending in the parent runtime"), { code: "not-found" });
      }
      assert.equal(sessionId, child);
      await reply(sessionId, requestId, decision);
    };
    fake.emit(child, {
      type: "permission/requested", requestId: "per_child_pending", permission: "bash", patterns: ["npm test"],
    });
    await waitFor(async () => (await store.events(parent)).some(event =>
      event.type === "permission/requested" && event.data.sourceSessionId === child));
    // The parent card shows the child's own risk preview and choices.
    const mirror = (await store.events(parent)).find(event =>
      event.type === "permission/requested" && event.data.sourceSessionId === child)!;
    const original = (await store.events(child)).find(event => event.type === "permission/requested")!;
    assert.deepEqual(mirror.data.preview, original.data.preview);
    assert.deepEqual(mirror.data.allowedScopes, original.data.allowedScopes);

    await sessions.autoAcceptSet!(parent, "on");

    assert.deepEqual(parentAttempts, [], "a mirrored request must never reach the parent's native runtime");
    assert.equal((await store.operations(parent)).some(operation => operation.mutationKind === "permission-reply"), false);
    assert.equal((await store.operations(parent)).some(operation => operation.state === "unknown"), false);
    if (childSetting === "off") {
      assert.deepEqual(fake.permissionReplies, [], "the child's explicit opt-out remains authoritative");
      assert.equal((await store.events(child)).some(event => event.type === "permission/resolved"), false);
      await sessions.replyPermission(parent, "per_child_pending", "once");
    }
    assert.deepEqual(fake.permissionReplies, [{ requestId: "per_child_pending", reply: "once" }]);
    const parentEvents = await store.events(parent);
    const childEvents = await store.events(child);
    assert.equal(parentEvents.filter(event => event.type === "permission/resolved").length, 1);
    assert.equal(childEvents.filter(event => event.type === "permission/resolved").length, 1);
    assert.equal(childEvents.filter(event => event.type === "permission/resolved")[0]!.data.auto, childSetting === "inherit" ? true : undefined);
    assert.equal((await store.projection(parent))?.status, "idle");
    assert.equal((await store.projection(child))?.status, "idle");
  });
}

test("reload does not attach a parent runtime to reconcile a mirrored child permission", async (t) => {
  const first = harness();
  let current = first;
  t.after(async () => {
    await current.sessions.dispose();
    await current.store.close();
    rmSync(first.dir, { recursive: true, force: true });
  });
  const { id: parent } = await first.sessions.create({ projectId: "p1", title: "Parent" });
  const { id: child } = await first.sessions.create({ projectId: "p1", title: "Child", parentId: parent });
  await first.sessions.autoAcceptSet!(child, "off");
  first.fake.emit(child, {
    type: "permission/requested", requestId: "per_child_reload", permission: "bash", patterns: ["npm test"],
  });
  await waitFor(async () => (await first.store.events(parent)).some(event =>
    event.type === "permission/requested" && event.data.sourceSessionId === child));
  await first.sessions.autoAcceptSet!(parent, "on");
  await first.sessions.dispose();
  await first.store.close();

  current = harness({ dir: first.dir });
  const attachments: string[] = [];
  const ensureSession = current.fake.rt.ensureSession;
  current.fake.rt.ensureSession = async input => {
    attachments.push(input.sessionId);
    return ensureSession(input);
  };
  await flush();
  await current.sessions.autoAcceptSet!(parent, "on");
  assert.deepEqual(attachments, [], "a parent's mirrored card is not a native request to reattach");
  assert.deepEqual(current.fake.permissionReplies, []);
  assert.equal((await current.store.events(parent)).some(event => event.type === "permission/resolved"), false);

  await current.sessions.replyPermission(parent, "per_child_reload", "once");
  assert.deepEqual(attachments, [child]);
  assert.deepEqual(current.fake.permissionReplies, [{ requestId: "per_child_reload", reply: "once" }]);
  assert.equal((await current.store.operations(parent)).some(operation => operation.mutationKind === "permission-reply"), false);
  assert.equal((await current.store.projection(parent))?.status, "idle");
});

test("a disconnected package tool expires its permission and never receives a late approval", async () => {
  const { sessions, store } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "Browser" });
  await sessions.send(id, { text: "open browser" });
  await flush();
  const controller = new AbortController();
  const grant = { spaceId: "space-a", projectId: "p1", cwd: (await store.projection(id))?.runtimeBinding?.location.directory ?? "", harnessId: "opencode" };
  assert.equal(await sessions.resolveAgentToolSession(grant), id);
  const pending = sessions.requestAgentToolPermission({ ...grant, toolId: "browser.polyth-browser", toolName: "polyth_browser", owner: "browser", signal: controller.signal });
  await flush();
  const request = (await store.events(id)).find((e) => e.type === "permission/requested")!;
  assert.ok(request);
  controller.abort();
  assert.equal(await pending, "deny");
  await flush();
  const requestId = (request.data as { requestId: string }).requestId;
  assert.ok((await store.events(id)).some((e) => e.type === "permission/expired" && (e.data as { requestId: string }).requestId === requestId));
  await assert.rejects(sessions.replyPermission(id, requestId, "once"), /already resolved|not found/);
});


test("native tool write-only inputs are removed before persistence and broadcast", async () => {
  const { sessions, store, fake, broadcasts } = harness({ redactToolInput: (_tool, input) => ({ ...input, value: "[redacted]" }) });
  const { id } = await sessions.create({ projectId: "p1", title: "Browser" });
  await sessions.send(id, { text: "type in browser" });
  await flush();
  fake.emit(id, { type: "tool/started", callId: "browser-call", tool: "polyth_browser", input: { value: "private-password" } });
  await flush();
  const event = (await store.events(id)).find((item) => item.type === "tool/started");
  assert.ok(event);
  assert.ok(!JSON.stringify(event).includes("private-password"));
  assert.ok(JSON.stringify(event).includes("[redacted]"));
  assert.ok(!JSON.stringify(broadcasts).includes("private-password"));
  fake.emit(id, { type: "tool/result", callId: "browser-call", tool: "polyth_browser", output: "done" });
  await flush();
});

const requestEvents = async (
  store: ReturnType<typeof createStore>,
  sessionId: string,
  type: string,
  requestId: string,
) => (await store.events(sessionId)).filter((event) =>
  event.type === type && (event.data as { requestId?: string }).requestId === requestId);

const wakeMessages = async (store: ReturnType<typeof createStore>, sessionId: string, requestId: string) =>
  (await store.events(sessionId)).filter((event) =>
    event.type === "user/message" && String((event.data as { text?: unknown }).text).includes(requestId));

test("a person delegates a subagent request to the parent agent, which alone may answer it", async (t) => {
  const { dir, sessions, store, fake } = harness();
  t.after(async () => { await sessions.dispose(); await store.close(); rmSync(dir, { recursive: true, force: true }); });
  const { id: parent } = await sessions.create({ projectId: "p1", title: "Parent" });
  const { id: child } = await sessions.create({ projectId: "p1", title: "Worker", parentId: parent });
  const { id: stranger } = await sessions.create({ projectId: "p1", title: "Stranger" });

  fake.emit(child, { type: "permission/requested", requestId: "per_deleg", permission: "bash", patterns: ["npm test"] });
  await waitFor(async () => (await requestEvents(store, parent, "permission/requested", "per_deleg")).length === 1);
  assert.equal((await store.projection(parent))?.status, "waiting");

  await assert.rejects(
    sessions.replyDelegatedPermission!(parent, child, "per_deleg", "once"),
    { code: "forbidden" },
    "without a person's delegation the parent agent cannot approve",
  );

  // The parent's mirrored card hands the request over; repeating it is idempotent.
  await sessions.delegatePermission!(parent, "per_deleg");
  await sessions.delegatePermission!(parent, "per_deleg");
  const delegated = await requestEvents(store, child, "permission/delegated", "per_deleg");
  assert.equal(delegated.length, 1);
  assert.equal((delegated[0]!.data as { delegateSessionId?: string }).delegateSessionId, parent);
  assert.equal((await requestEvents(store, parent, "permission/delegated", "per_deleg")).length, 1);
  await waitFor(async () => (await wakeMessages(store, parent, "per_deleg")).length > 0);
  const wake = await wakeMessages(store, parent, "per_deleg");
  assert.equal(wake.length, 1, "a repeated delegation never wakes the parent twice");
  assert.match(String((wake[0]!.data as { text: string }).text), new RegExp(child));
  assert.equal((wake[0]!.data as { hiddenUserMessage?: boolean }).hiddenUserMessage, true);

  await assert.rejects(sessions.replyDelegatedPermission!(stranger, child, "per_deleg", "once"), { code: "forbidden" });
  await assert.rejects(
    sessions.replyDelegatedPermission!(parent, child, "per_deleg", "always" as "once"),
    { code: "invalid-input" },
  );
  assert.deepEqual(fake.permissionReplies, []);

  await sessions.replyDelegatedPermission!(parent, child, "per_deleg", "once");
  assert.deepEqual(fake.permissionReplies, [{ requestId: "per_deleg", reply: "once" }]);
  assert.equal((await requestEvents(store, child, "permission/resolved", "per_deleg")).length, 1);
  assert.equal((await requestEvents(store, parent, "permission/resolved", "per_deleg")).length, 1);
  assert.notEqual((await store.projection(child))?.status, "waiting");
  await assert.rejects(sessions.replyDelegatedPermission!(parent, child, "per_deleg", "reject"), { code: "conflict" });
  await assert.rejects(sessions.delegatePermission!(child, "per_deleg"), { code: "conflict" });
});

test("a delegated card no longer parks a busy parent, so the deciding turn is admitted", async (t) => {
  const { dir, sessions, store, fake } = harness();
  t.after(async () => { await sessions.dispose(); await store.close(); rmSync(dir, { recursive: true, force: true }); });
  const { id: parent } = await sessions.create({ projectId: "p1", title: "Parent" });
  const { id: child } = await sessions.create({ projectId: "p1", title: "Worker", parentId: parent });
  await sessions.send(parent, { text: "orchestrate" });
  await waitFor(async () => (await store.projection(parent))?.status === "working");

  fake.emit(child, { type: "permission/requested", requestId: "per_busy", permission: "bash", patterns: ["npm test"] });
  await waitFor(async () => (await store.projection(parent))?.status === "waiting");
  // Delegated from the subagent's own card while the parent turn still runs.
  await sessions.delegatePermission!(child, "per_busy");
  assert.equal((await store.projection(parent))?.status, "working");
  assert.equal((await wakeMessages(store, parent, "per_busy")).length, 0, "a busy parent queues the wake");

  fake.emit(parent, { type: "turn/stopped", reason: "completed" });
  await waitFor(async () => (await wakeMessages(store, parent, "per_busy")).length === 1);
  await sessions.replyDelegatedPermission!(parent, child, "per_busy", "reject");
  assert.deepEqual(fake.permissionReplies, [{ requestId: "per_busy", reply: "reject" }]);
});

test("a guarded Space keeps subagent approvals with a person", async (t) => {
  const { dir, sessions, store, fake } = harness({ guardedSpace: true });
  t.after(async () => { await sessions.dispose(); await store.close(); rmSync(dir, { recursive: true, force: true }); });
  const { id: parent } = await sessions.create({ projectId: "p1", title: "Parent" });
  const { id: child } = await sessions.create({ projectId: "p1", title: "Worker", parentId: parent });
  const { id: root } = await sessions.create({ projectId: "p1", title: "Root" });
  fake.emit(child, { type: "permission/requested", requestId: "per_guard", permission: "bash", patterns: ["npm test"] });
  await waitFor(async () => (await requestEvents(store, parent, "permission/requested", "per_guard")).length === 1);
  await assert.rejects(sessions.delegatePermission!(parent, "per_guard"), { code: "forbidden" });
  assert.equal((await requestEvents(store, child, "permission/delegated", "per_guard")).length, 0);

  fake.emit(root, { type: "permission/requested", requestId: "per_root", permission: "bash", patterns: ["npm test"] });
  await waitFor(async () => (await requestEvents(store, root, "permission/requested", "per_root")).length === 1);
  await assert.rejects(sessions.delegatePermission!(root, "per_root"), { code: "invalid-input" }, "a root session has no parent agent");
});

test("the Judgment second opinion can only leave an automatic answer for a person, once per request", async () => {
  const reviews: Array<{ level: string; permission: string; lines: readonly string[] }> = [];
  const permissionScopeCheck: PermissionScopeCheck = {
    async review(input) {
      reviews.push({ level: input.level, permission: input.request.permission, lines: input.request.preview?.lines ?? [] });
      if (input.request.preview?.lines?.some((line) => line.includes("upload"))) return { hold: true, reason: "outside-task", probability: 0.86 };
      if (input.request.preview?.lines?.some((line) => line.includes("broken"))) throw new Error("engine down");
      return { hold: false, reason: "in-scope", probability: 0.1 };
    },
  };
  const { sessions, store, fake, attention } = harness({ permissionScopeCheck });
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.autoAcceptSet!(id, "on");

  fake.emit(id, { type: "permission/requested", requestId: "per_test", permission: "bash", patterns: ["npm test"] });
  fake.emit(id, { type: "permission/requested", requestId: "per_upload", permission: "bash", patterns: ["node upload.js"] });
  fake.emit(id, { type: "permission/requested", requestId: "per_broken", permission: "bash", patterns: ["node broken.js"] });
  // risk.ts already holds this one: Judgment is not even asked, and "in scope" could never approve it.
  fake.emit(id, { type: "permission/requested", requestId: "per_wipe", permission: "bash", patterns: ["rm -rf ~/Documents"] });
  await flush();

  assert.deepEqual(fake.permissionReplies.map((reply) => reply.requestId).sort(), ["per_broken", "per_test"]);
  assert.deepEqual(reviews.map((review) => review.lines.join(" ")).sort(), ["node broken.js", "node upload.js", "npm test"]);
  assert.ok(reviews.every((review) => review.level === "routine"));
  const preview = async (requestId: string) => ((await store.events(id)).find((event) => event.type === "permission/requested"
    && (event.data as { requestId?: string }).requestId === requestId)?.data as { preview?: { reasons?: string[]; scopeCheck?: { probability: number } } }).preview;
  assert.deepEqual((await preview("per_upload"))?.reasons, ["outside-task"]);
  assert.deepEqual((await preview("per_upload"))?.scopeCheck, { probability: 0.86 });
  assert.equal((await preview("per_test"))?.scopeCheck, undefined);
  assert.equal(attention.length, 2);
  assert.equal((await store.projection(id))?.status, "waiting");
});
