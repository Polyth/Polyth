// MCP servers with an owner (Spaces §14.6): Space servers are admin-managed
// and redacted for members; personal servers are their owner's alone and
// attach only to that person's private chats.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessProvider, McpTransport, SpaceContext } from "@polyth/contracts";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";
import { createBehaviorService } from "../src/behavior.ts";
import { createCapabilityProvisioningController } from "../src/capabilityProvisioning.ts";
import { createMcpConfigService, PERSONAL_MCP_PACKAGE } from "../src/mcp.ts";
import { createPeopleStore } from "../src/people.ts";
import { createSessionSharingService, privateSessionOwner } from "../src/sessionSharing.ts";
import { sharingFixture } from "./support/sharingFixture.ts";

const http = (url: string, headersSecretRefs: string[] = []): McpTransport => ({ kind: "http", url, headersSecretRefs });
const PROJECT_SPACE: Record<string, string> = { prj_one: "spc_home", prj_work: "spc_work" };

function setup(t: test.TestContext) {
  const f = sharingFixture(t);
  const dataDir = mkdtempSync(join(tmpdir(), "polyth-mcp-owner-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  for (const spaceId of ["spc_home", "spc_work"]) mkdirSync(f.ctx("usr_owner", spaceId).storageDir, { recursive: true });
  const people = createPeopleStore({
    dataDir,
    spaceRoot: (spaceId) => f.ctx("usr_owner", spaceId).storageDir,
    isMember: (userId, spaceId) => !!f.security.control.get(
      "SELECT 1 FROM space_memberships WHERE space_id=? AND principal_id=? AND state='active'",
      spaceId,
      userId,
    ),
  });
  const invoked: Array<{ secrets: Record<string, string>; authorityFile: string }> = [];
  const mcp = createMcpConfigService({
    dataDir,
    deployment: "server-trusted",
    assertProject(space, projectId) {
      if (PROJECT_SPACE[projectId] !== space.spaceId) throw Object.assign(new Error("project not found"), { code: "not-found" });
    },
    projectForProbe: async () => ({ path: "/tmp/project" }),
    inspect: async () => ({ ok: true, message: "ok", checkedAt: 1, tools: [{ name: "ping", inputSchema: {} }] }),
    invoke: async (input) => {
      invoked.push({ secrets: input.secrets, authorityFile: input.authorityFile });
      return { content: [] };
    },
    people: () => people.forPackage(PERSONAL_MCP_PACKAGE),
    privateOwner: privateSessionOwner,
  });
  return { f, mcp, people, invoked, dataDir };
}

const personalNotes = (mcp: ReturnType<typeof setup>["mcp"], owner: SpaceContext, name = "notes") =>
  mcp.createPersonal(owner, {
    name,
    transport: http("https://notes.example/mcp", ["Authorization"]),
    secrets: { Authorization: "Bearer personal-secret" },
  });

test("Space MCP servers: only Space admins write; members list them redacted and never see a secret", async (t) => {
  const { f, mcp } = setup(t);
  const admin = f.ctx("usr_admin");
  const member = f.ctx("usr_member");
  const viewer = f.ctx("usr_viewer");

  await assert.rejects(mcp.create(member, { name: "mine", transport: http("https://x.example") }), { code: "forbidden" });
  await assert.rejects(mcp.create(member, { name: "mine", transport: http("https://x.example") }, "prj_one"), { code: "forbidden" });
  await assert.rejects(mcp.importServers(member, [{ name: "mine", transport: http("https://x.example") }]), { code: "forbidden" });

  const remote = await mcp.create(admin, {
    name: "linear",
    transport: http("https://mcp.example.com/k3y-in-path/sse?token=q-secret", ["Authorization"]),
    secrets: { Authorization: "Bearer header-secret" },
  });
  const local = await mcp.create(admin, {
    name: "files",
    transport: { kind: "stdio", command: "npx", args: ["-y", "server", "--token", "arg-secret"], envKeys: ["API_KEY"] },
    secrets: { API_KEY: "env-secret" },
  }, "prj_one");

  // Every write and every secret change stays with admins.
  await assert.rejects(mcp.update(member, remote.id, { secrets: { Authorization: "x" } }, remote.revision), { code: "forbidden" });
  await assert.rejects(mcp.update(member, local.id, { enabled: false }, local.revision, "prj_one"), { code: "forbidden" });
  await assert.rejects(mcp.remove(member, remote.id), { code: "forbidden" });
  await assert.rejects(mcp.test(member, remote.id), { code: "forbidden" });
  await assert.rejects(mcp.override(member, remote.id, "prj_one", false), { code: "forbidden" });

  const seen = mcp.list(member, "prj_one");
  assert.deepEqual(seen.map((row) => [row.name, row.owner, row.canManage, row.redacted]), [
    ["files", "space", false, true],
    ["linear", "space", false, true],
  ]);
  const text = JSON.stringify(seen);
  for (const secret of ["header-secret", "env-secret", "q-secret", "k3y-in-path", "arg-secret"]) {
    assert.equal(text.includes(secret), false, `${secret} must not reach a member`);
  }
  const linear = seen.find((row) => row.name === "linear")!;
  assert.equal(linear.transport.kind === "http" && linear.transport.url, "https://mcp.example.com/");
  assert.deepEqual(linear.transport.kind === "http" && linear.transport.headersSecretRefs, ["Authorization"]);
  const files = seen.find((row) => row.name === "files")!;
  assert.deepEqual(files.transport.kind === "stdio" && [files.transport.command, files.transport.args, files.transport.envKeys], ["npx", [], ["API_KEY"]]);

  const full = mcp.list(admin, "prj_one");
  assert.equal(full.every((row) => row.canManage === true && row.redacted === undefined), true);
  assert.match(JSON.stringify(full), /k3y-in-path/);
  assert.equal(/header-secret|env-secret/.test(JSON.stringify(full)), false, "admins never read secret values back either");

  assert.deepEqual(mcp.access(admin), { canManageSpace: true, canManagePersonal: true });
  assert.deepEqual(mcp.access(member), { canManageSpace: false, canManagePersonal: true });
  assert.deepEqual(mcp.access(viewer), { canManageSpace: false, canManagePersonal: false });
  assert.deepEqual(mcp.access(f.system()), { canManageSpace: true, canManagePersonal: false });
});

test("a personal server is visible only to its owner, who keeps its secret out of the config file", async (t) => {
  const { f, mcp, people, dataDir } = setup(t);
  const owner = f.ctx("usr_owner");
  const member = f.ctx("usr_member");
  const row = await personalNotes(mcp, owner);
  assert.deepEqual([row.owner, row.scope, row.canManage], ["person", "person", true]);

  assert.deepEqual(mcp.listPersonal(owner).map((server) => server.name), ["notes"]);
  assert.equal(JSON.stringify(mcp.listPersonal(owner)).includes("personal-secret"), false);
  assert.deepEqual(mcp.listPersonal(member), []);
  assert.deepEqual(mcp.list(f.ctx("usr_admin")), [], "a Space list never shows anyone's personal servers");

  await assert.rejects(mcp.updatePersonal(member, row.id, { enabled: false }, row.revision), { code: "not-found" });
  assert.equal(await mcp.removePersonal(member, row.id), false);
  assert.throws(() => mcp.personalTools(member, row.id), { code: "not-found" });
  await assert.rejects(mcp.testPersonal(member, row.id), { code: "not-found" });
  await assert.rejects(personalNotes(mcp, f.ctx("usr_viewer")), { code: "forbidden" });
  assert.throws(() => mcp.listPersonal(f.system()), { code: "forbidden" });
  await assert.rejects(personalNotes(mcp, owner), { code: "conflict" });

  const file = readFileSync(join(dataDir, "people", "usr_owner", "packages", "mcp", "servers.json"), "utf8");
  assert.equal(file.includes("personal-secret"), false);
  const vault = people.forPackage(PERSONAL_MCP_PACKAGE).vault("usr_owner", PERSONAL_MCP_PACKAGE);
  assert.match(vault.getOpaque(`mcp:server:${row.id}`) ?? "", /personal-secret/);
  assert.equal(mcp.hasPersonalServers("usr_owner"), true);
  assert.equal(mcp.hasPersonalServers("usr_member"), false);

  // Changing the transport drops secrets it no longer names; removing deletes them.
  const updated = await mcp.updatePersonal(owner, row.id, { transport: http("https://notes.example/mcp", ["X-Key"]) }, row.revision);
  assert.equal(vault.getOpaque(`mcp:server:${row.id}`), null);
  await mcp.updatePersonal(owner, row.id, { secrets: { "X-Key": "k2" } }, updated.revision);
  assert.equal(await mcp.removePersonal(owner, row.id), true);
  assert.equal(vault.getOpaque(`mcp:server:${row.id}`), null);
  assert.equal(mcp.hasPersonalServers("usr_owner"), false);
});

test("personal servers attach only to the owner's private chat; sharing detaches them on the next launch", async (t) => {
  const { f, mcp } = setup(t);
  const owner = f.ctx("usr_owner");
  const row = await personalNotes(mcp, owner);
  const chat = await f.sessionsFor(owner).create({ projectId: "prj_one" });
  const othersChat = await f.sessionsFor(f.ctx("usr_member")).create({ projectId: "prj_one" });
  const system = f.system();
  const attached = (sessionId?: string) => mcp.projection(system, "prj_one", sessionId);

  const own = attached(chat.id);
  assert.deepEqual(own.servers.map((server) => [server.name, server.ownerUserId]), [["notes", "usr_owner"]]);
  assert.equal(own.secretsFor(row.id).Authorization, "Bearer personal-secret");
  assert.deepEqual(attached(othersChat.id).servers, [], "never on another person's chat");
  assert.deepEqual(attached().servers, [], "never on a runtime that serves more than one chat");
  assert.deepEqual(attached(othersChat.id).secretsFor(row.id), {});

  // A delegated subagent follows its parent chat.
  const child = await f.sessionsFor(owner).create({ projectId: "prj_one", parentId: chat.id });
  assert.deepEqual(attached(child.id).servers.map((server) => server.name), ["notes"]);

  await f.sharing.update(owner, chat.id, { visibility: "restricted", grants: [{ userId: "usr_member", access: "collaborate" }] });
  assert.deepEqual(attached(chat.id).servers, [], "a chat someone else can open never carries them");
  assert.deepEqual(attached(chat.id).secretsFor(row.id), {});
  assert.deepEqual(attached(child.id).servers, []);
  await f.sharing.update(owner, chat.id, { visibility: "space" });
  assert.deepEqual(attached(chat.id).servers, []);
  await f.sharing.update(owner, chat.id, { visibility: "private" });
  assert.deepEqual(attached(chat.id).servers.map((server) => server.name), ["notes"]);

  // Disabled servers stay home; a Space or project server of the same name wins.
  await mcp.updatePersonal(owner, row.id, { enabled: false }, row.revision);
  assert.deepEqual(attached(chat.id).servers, []);
  const live = mcp.listPersonal(owner)[0]!;
  await mcp.updatePersonal(owner, row.id, { enabled: true }, live.revision);
  await mcp.create(f.ctx("usr_admin"), { name: "notes", transport: http("https://space.example/mcp") }, "prj_one");
  assert.deepEqual(attached(chat.id).servers.map((server) => [server.name, server.ownerUserId]), [["notes", undefined]]);
});

test("foreign Spaces and departed members attach nothing", async (t) => {
  const { f, mcp } = setup(t);
  const owner = f.ctx("usr_owner");
  await personalNotes(mcp, owner);
  const chat = await f.sessionsFor(owner).create({ projectId: "prj_one" });
  // The chat's id presented under a known-valid foreign Space reads as nothing.
  assert.deepEqual(mcp.projection(f.system("spc_work"), "prj_work", chat.id).servers, []);
  assert.deepEqual(mcp.list(f.system("spc_work"), "prj_work", { sessionId: chat.id, actorUserId: "usr_owner" }), []);
  assert.throws(() => mcp.projection(f.system("spc_work"), "prj_one", chat.id), { code: "not-found" });

  f.security.control.transaction(() => {
    f.security.control.run("UPDATE space_memberships SET state='removed' WHERE principal_id='usr_owner'");
  });
  assert.deepEqual(mcp.projection(f.system(), "prj_one", chat.id).servers, [], "leaving the Space detaches them");
});

test("polyth_mcp sees a personal server only when the turn acts for the owner of the private chat", async (t) => {
  const { f, mcp, invoked } = setup(t);
  const owner = f.ctx("usr_owner");
  const row = await personalNotes(mcp, owner);
  const chat = await f.sessionsFor(owner).create({ projectId: "prj_one" });
  const system = f.system();
  const call = (actorUserId?: string) => mcp.call(system, row.id, "prj_one", {
    toolName: "ping", arguments: {}, sessionId: chat.id, cwd: "/tmp/project", ...(actorUserId ? { actorUserId } : {}),
  });

  assert.deepEqual(mcp.list(system, "prj_one", { sessionId: chat.id, actorUserId: "usr_owner" }).map((s) => [s.name, s.scope]), [["notes", "person"]]);
  assert.deepEqual(mcp.list(system, "prj_one", { sessionId: chat.id, actorUserId: "usr_member" }), []);
  assert.deepEqual(mcp.list(system, "prj_one", { sessionId: chat.id }), [], "a turn nobody started borrows nobody's servers");

  await call("usr_owner");
  assert.equal(invoked.length, 1);
  assert.equal(invoked[0]!.secrets.Authorization, "Bearer personal-secret");
  assert.match(invoked[0]!.authorityFile, /people\/usr_owner\/packages\/mcp\/runtime\/mcp-calls\//);
  await assert.rejects(call("usr_member"), { code: "not-found" });
  await assert.rejects(call(), { code: "not-found" });
  assert.equal((await mcp.test(system, row.id, "prj_one", { sessionId: chat.id, actorUserId: "usr_owner" })).ok, true);
  assert.equal(mcp.tools(system, row.id, "prj_one", { sessionId: chat.id, actorUserId: "usr_owner" }).tools[0]?.name, "ping");

  await f.sharing.update(owner, chat.id, { visibility: "space" });
  await assert.rejects(call("usr_owner"), { code: "not-found" });
  assert.throws(() => mcp.tools(system, row.id, "prj_one", { sessionId: chat.id, actorUserId: "usr_owner" }), { code: "not-found" });
  assert.equal(invoked.length, 1);
});

test("a per-chat harness launch carries the owner's personal servers; a shared physical runtime never does", async (t) => {
  const { f, mcp, dataDir } = setup(t);
  const owner = f.ctx("usr_owner");
  const row = await personalNotes(mcp, owner);
  const chat = await f.sessionsFor(owner).create({ projectId: "prj_one" });
  const applied: Record<string, { names: string[]; secrets: Record<string, Record<string, string>> }> = {};
  const fake = (id: string, lifetime: "session" | "physical-runtime", configScope: "session" | "project"): HarnessProvider => ({
    descriptor: { id, name: id, priority: 0, integration: "test" },
    probe: async () => ({ harnessId: id, installed: true, authenticated: true, healthy: true }),
    createRuntime: async () => { throw new Error("unused"); },
    provisioner: {
      support: () => ({ harnessId: id, targetLifetime: lifetime, kinds: { "mcp-server": { modes: ["native"], mutability: "session-create", configScope } } }),
      apply: async (_context, plan, secrets) => {
        const live = plan.items.filter((item) => item.capability.kind === "mcp-server" && item.mode !== "unsupported");
        applied[id] = {
          names: live.map((item) => (item.capability as { name: string }).name),
          secrets: Object.fromEntries(live.map((item) => [item.capability.id, secrets.mcpSecrets(item.capability.id)])),
        };
        return {
          harnessId: id,
          desiredRevision: plan.desiredRevision,
          records: plan.items.map((item) => ({
            capabilityId: item.capability.id, kind: item.capability.kind, owner: item.capability.owner,
            desiredRevision: item.capability.revision, mode: item.mode, status: "pending" as const, mutability: item.mutability,
          })),
        };
      },
    },
  });
  const perChat = fake("per-chat", "session", "session");
  const shared = fake("shared", "physical-runtime", "project");
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: {
      register: () => ({ dispose() {} }),
      providers: () => [perChat, shared],
      get: (id) => [perChat, shared].find((p) => p.descriptor.id === id),
      probe: async () => [],
      resolve: async () => perChat,
    },
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp,
    file: join(dataDir, "status.json"),
  });
  const system = f.system();
  const context = { spaceId: system.spaceId, projectId: "prj_one", cwd: "/tmp/project", sessionId: chat.id, space: system };

  await controller.reconcile(perChat, context);
  await controller.reconcile(shared, context);
  assert.deepEqual(applied["per-chat"]!.names, ["notes"]);
  assert.equal(applied["per-chat"]!.secrets[`polyth.mcp.${row.id}`]?.Authorization, "Bearer personal-secret");
  assert.deepEqual(applied.shared!.names, [], "a runtime serving many chats gets no personal server");

  // Sharing the chat: the next launch's desired set no longer has it.
  await f.sharing.update(owner, chat.id, { visibility: "restricted", grants: [{ userId: "usr_member", access: "view" }] });
  await controller.reconcile(perChat, context);
  assert.deepEqual(applied["per-chat"]!.names, []);
});

test("the sharing DTO warns an owner with personal MCP servers", async (t) => {
  const { f, mcp } = setup(t);
  const owner = f.ctx("usr_owner");
  const sharing = createSessionSharingService({
    projection: async (id) => f.projections.get(id),
    hasPersonalMcpServers: (userId) => mcp.hasPersonalServers(userId),
  });
  const chat = await f.sessionsFor(owner).create({ projectId: "prj_one" });
  assert.equal(sharing.state(owner, chat.id).personalMcpDetachedOnShare, undefined);
  await personalNotes(mcp, owner);
  assert.equal(sharing.state(owner, chat.id).personalMcpDetachedOnShare, true);
  const shared = await sharing.update(owner, chat.id, { visibility: "restricted", grants: [{ userId: "usr_member", access: "view" }] });
  assert.equal(shared.personalMcpDetachedOnShare, true);
  assert.equal(sharing.state(f.ctx("usr_member"), chat.id).personalMcpDetachedOnShare, undefined, "only the owner is told");
});
