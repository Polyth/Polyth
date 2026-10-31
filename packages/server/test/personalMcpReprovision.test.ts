// Sharing a chat drops its owner's personal MCP servers from a live runtime
// (Spaces §14.6): an idle runtime is released at once; a busy one after its
// turn, and until then only the owner may drive turns in the chat.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessProvider, SpaceContext } from "@polyth/contracts";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";
import { createBehaviorService } from "../src/behavior.ts";
import { createCapabilityProvisioningController } from "../src/capabilityProvisioning.ts";
import { createMcpConfigService, PERSONAL_MCP_PACKAGE } from "../src/mcp.ts";
import { createPeopleStore } from "../src/people.ts";
import { createPersonalMcpReprovisioner, REPROVISIONING_MESSAGE } from "../src/personalMcpReprovision.ts";
import { createSessionSharingService, privateSessionOwner } from "../src/sessionSharing.ts";
import { sharingFixture } from "./support/sharingFixture.ts";

function setup(t: test.TestContext) {
  const f = sharingFixture(t);
  const dataDir = mkdtempSync(join(tmpdir(), "polyth-mcp-reprovision-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(f.ctx("usr_owner").storageDir, { recursive: true });
  const people = createPeopleStore({
    dataDir,
    spaceRoot: (spaceId) => f.ctx("usr_owner", spaceId).storageDir,
    isMember: (userId, spaceId) => !!f.security.control.get(
      "SELECT 1 FROM space_memberships WHERE space_id=? AND principal_id=? AND state='active'",
      spaceId,
      userId,
    ),
  });
  const mcp = createMcpConfigService({
    dataDir,
    deployment: "server-trusted",
    assertProject() {},
    projectForProbe: async () => ({ path: "/tmp/project" }),
    people: () => people.forPackage(PERSONAL_MCP_PACKAGE),
    privateOwner: privateSessionOwner,
  });
  const applied: string[][] = [];
  const perChat: HarnessProvider = {
    descriptor: { id: "per-chat", name: "per-chat", priority: 0, integration: "test" },
    probe: async () => ({ harnessId: "per-chat", installed: true, authenticated: true, healthy: true }),
    createRuntime: async () => { throw new Error("unused"); },
    provisioner: {
      support: () => ({
        harnessId: "per-chat",
        targetLifetime: "session",
        kinds: { "mcp-server": { modes: ["native"], mutability: "session-create", configScope: "session" } },
      }),
      apply: async (_context, plan) => {
        applied.push(plan.items.filter((item) => item.capability.kind === "mcp-server")
          .map((item) => (item.capability as { name: string }).name));
        return { harnessId: "per-chat", desiredRevision: plan.desiredRevision, records: [] };
      },
    },
  };
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: {
      register: () => ({ dispose() {} }),
      providers: () => [perChat],
      get: () => perChat,
      probe: async () => [],
      resolve: async () => perChat,
    },
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
  });
  t.after(() => controller.dispose());

  // The session service's idle-release gate, reduced to what matters here.
  const runtime = { live: new Set<string>(), busy: new Set<string>(), released: [] as string[] };
  const reprovision = createPersonalMcpReprovisioner({
    personalMcpLoaded: (spaceId, sessionId) => controller.personalMcpLoaded(spaceId, sessionId),
    forgetPersonalMcp: (spaceId, sessionId) => controller.forgetPersonalMcp(spaceId, sessionId),
    releaseIfIdle: async (sessionId) => {
      if (!runtime.live.has(sessionId)) return { released: false };
      if (runtime.busy.has(sessionId)) return { released: false, blocker: "turn" };
      runtime.live.delete(sessionId);
      runtime.released.push(sessionId);
      return { released: true };
    },
    retryMs: 60_000,
  });
  t.after(() => reprovision.dispose());
  const sharing = createSessionSharingService({
    projection: async (id) => f.projections.get(id),
    leftPrivate: (spaceId, chats) => reprovision.leftPrivate(spaceId, chats),
  });
  const system = f.system();
  /** A launch for this chat: the capability reconcile `beforeCreate` runs. */
  const launch = async (sessionId: string) => {
    await controller.reconcile(perChat, { spaceId: system.spaceId, projectId: "prj_one", cwd: "/tmp/project", sessionId, space: system });
    runtime.live.add(sessionId);
    return applied.at(-1);
  };
  const personal = (owner: SpaceContext) => mcp.createPersonal(owner, {
    name: "notes",
    transport: { kind: "http", url: "https://notes.example/mcp", headersSecretRefs: [] },
  });
  return { f, sharing, controller, reprovision, runtime, launch, personal, system };
}

test("sharing an idle chat releases its runtime at once; the next launch has no personal server", async (t) => {
  const { f, sharing, controller, reprovision, runtime, launch, personal, system } = setup(t);
  const owner = f.ctx("usr_owner");
  await personal(owner);
  const chat = await f.sessionsFor(owner).create({ projectId: "prj_one" });
  assert.deepEqual(await launch(chat.id), ["notes"]);
  assert.equal(controller.personalMcpLoaded(system.spaceId, chat.id), true);

  await sharing.update(owner, chat.id, { visibility: "restricted", grants: [{ userId: "usr_member", access: "collaborate" }] });
  await reprovision.idle();
  assert.deepEqual(runtime.released, [chat.id]);
  assert.equal(reprovision.pendingOwner(chat.id), undefined);
  assert.equal(controller.personalMcpLoaded(system.spaceId, chat.id), false);

  await f.sessionsFor(f.ctx("usr_member")).send(chat.id, { text: "hi" } as never);
  assert.deepEqual(f.sent, [chat.id]);
  assert.deepEqual(await launch(chat.id), [], "the relaunch reconciles without the owner's server");
  assert.equal(controller.personalMcpLoaded(system.spaceId, chat.id), false);

  // Widening again only re-checks: nothing personal is loaded any more.
  await sharing.update(owner, chat.id, { visibility: "space" });
  await reprovision.idle();
  assert.deepEqual(runtime.released, [chat.id]);
});

test("a busy chat re-provisions right after its turn; meanwhile only the owner drives turns", async (t) => {
  const { f, sharing, controller, reprovision, runtime, launch, personal, system } = setup(t);
  const owner = f.ctx("usr_owner");
  const member = f.ctx("usr_member");
  await personal(owner);
  const chat = await f.sessionsFor(owner).create({ projectId: "prj_one" });
  const child = await f.sessionsFor(owner).create({ projectId: "prj_one", parentId: chat.id });
  await launch(chat.id);
  assert.deepEqual(await launch(child.id), ["notes"], "a subagent of a private chat carries them too");
  runtime.busy.add(chat.id);

  await sharing.update(owner, chat.id, { visibility: "restricted", grants: [{ userId: "usr_member", access: "collaborate" }] });
  await reprovision.idle();
  assert.deepEqual(runtime.released, [child.id], "the idle subagent goes at once");
  assert.equal(reprovision.pendingOwner(chat.id), "usr_owner");

  const refused = { code: "conflict", message: REPROVISIONING_MESSAGE };
  const asMember = f.sessionsFor(member);
  await assert.rejects(asMember.send(chat.id, { text: "steer" } as never), refused);
  await assert.rejects(asMember.replyPermission(chat.id, "perm", "once" as never), refused);
  await assert.rejects(asMember.replyQuestion(chat.id, "q", [] as never), refused);
  await assert.rejects(f.sessionsFor(f.ctx("usr_admin")).send(chat.id, { text: "x" } as never), { code: "not-found" },
    "access is still decided first");
  await asMember.send(child.id, { text: "fine" } as never);
  await f.sessionsFor(owner).send(chat.id, { text: "mine" } as never);
  assert.deepEqual(f.sent, [child.id, chat.id]);

  // Still working: a status change does not release it.
  reprovision.projectionChanged({ id: chat.id, status: "working" });
  await reprovision.idle();
  assert.deepEqual(runtime.released, [child.id]);

  // The turn ends.
  runtime.busy.delete(chat.id);
  reprovision.projectionChanged({ id: chat.id, status: "idle" });
  await reprovision.idle();
  assert.deepEqual(runtime.released, [child.id, chat.id]);
  assert.equal(reprovision.pendingOwner(chat.id), undefined);
  assert.equal(controller.personalMcpLoaded(system.spaceId, chat.id), false);
  await asMember.send(chat.id, { text: "now" } as never);
  assert.deepEqual(f.sent, [child.id, chat.id, chat.id]);
});

test("making the chat private again, or a runtime released elsewhere, ends the wait without a release", async (t) => {
  const { f, sharing, controller, reprovision, runtime, launch, personal, system } = setup(t);
  const owner = f.ctx("usr_owner");
  await personal(owner);
  const chat = await f.sessionsFor(owner).create({ projectId: "prj_one" });
  const other = await f.sessionsFor(owner).create({ projectId: "prj_one" });
  await launch(chat.id);
  await launch(other.id);
  runtime.busy.add(chat.id);
  runtime.busy.add(other.id);

  await sharing.update(owner, chat.id, { visibility: "space" });
  await sharing.update(owner, other.id, { visibility: "space" });
  await reprovision.idle();
  assert.equal(reprovision.pendingOwner(chat.id), "usr_owner");
  assert.equal(reprovision.pendingOwner(other.id), "usr_owner");

  await sharing.update(owner, chat.id, { visibility: "private" });
  reprovision.projectionChanged({ id: chat.id, status: "idle" });
  // A restart or harness switch released the other chat's runtime.
  controller.release({ spaceId: system.spaceId, projectId: "prj_one", cwd: "/tmp/project", sessionId: other.id, space: system }, "per-chat");
  reprovision.projectionChanged({ id: other.id, status: "idle" });
  await reprovision.idle();
  assert.equal(reprovision.pendingOwner(chat.id), undefined);
  assert.equal(reprovision.pendingOwner(other.id), undefined);
  assert.deepEqual(runtime.released, []);
});

test("a chat whose runtime never loaded a personal server is shared without waiting", async (t) => {
  const { f, sharing, reprovision, runtime, launch } = setup(t);
  const owner = f.ctx("usr_owner");
  const chat = await f.sessionsFor(owner).create({ projectId: "prj_one" });
  assert.deepEqual(await launch(chat.id), []);
  runtime.busy.add(chat.id);
  await sharing.update(owner, chat.id, { visibility: "restricted", grants: [{ userId: "usr_member", access: "collaborate" }] });
  assert.equal(reprovision.pendingOwner(chat.id), undefined);
  await f.sessionsFor(f.ctx("usr_member")).send(chat.id, { text: "hi" } as never);
});
