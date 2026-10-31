import test from "node:test";
import assert from "node:assert/strict";
import {
  harnessUsableByUser,
  harnessVisibleToUser,
  normalizeAccountPermissions,
  normalizeHarnessAccessList,
  type HarnessAccessRule,
  type HarnessSelection,
  type ModelDescriptor,
  type SessionProjection,
  type SessionService,
} from "@polyth/contracts";
import {
  hasHarnessManagerAuthority,
  hasPersonalHarnessAuthority,
  requireHarnessManagerAuthority,
  requirePersonalHarnessAuthority,
} from "@polyth/contracts/instance-authority";
import { harnessAccessOf, privateHarnessCatalog, privateHarnessSessionService } from "../src/accountPermissions.ts";
import { personDefaultSessionService } from "../src/personHarnessDefault.ts";

const owners = () => new Map<string, HarnessAccessRule>([["claude-ida", { accountOwnerUserId: "u-ida" }]]);
const as = (userId: string, spaceId = "home") => ({ userId, spaceId });

function base(projection: Partial<SessionProjection>) {
  const calls: string[] = [];
  const service = {
    async create(input: { harness?: HarnessSelection }) { calls.push(`create:${input.harness?.mode === "pinned" ? input.harness.harnessId : "auto"}`); return { id: "s1" }; },
    async send() { calls.push("send"); return { accepted: true }; },
    async resumeNow() { calls.push("resume"); return { accepted: true }; },
    async switchHarness(_id: string, selection: HarnessSelection) { calls.push(`switch:${selection.mode === "pinned" ? selection.harnessId : "auto"}`); return projection; },
    async restartRuntime() { calls.push("restart"); return projection; },
    async snapshot() { return projection as SessionProjection; },
  } as unknown as SessionService;
  return { service, calls };
}

const pinned = (harnessId: string): HarnessSelection => ({ mode: "pinned", harnessId });

test("permissions are a closed, ordered vocabulary", () => {
  assert.deepEqual(normalizeAccountPermissions(["harnesses.manage", "harnesses.manage"]), ["harnesses.manage"]);
  assert.deepEqual(normalizeAccountPermissions(["harnesses.personal", "harnesses.manage"]), ["harnesses.manage", "harnesses.personal"]);
  assert.deepEqual(normalizeAccountPermissions([]), []);
  assert.throws(() => normalizeAccountPermissions(["root"]), { code: "invalid-input" });
  assert.throws(() => normalizeAccountPermissions("harnesses.manage"), { code: "invalid-input" });
  assert.equal(harnessVisibleToUser({}, "anyone", undefined), true);
  assert.equal(harnessVisibleToUser({ accountOwnerUserId: "u-ida" }, "u-ida", "home"), true);
  assert.equal(harnessVisibleToUser({ accountOwnerUserId: "u-ida" }, "u-bob", "home"), false);
  assert.equal(harnessVisibleToUser({ accountOwnerUserId: "u-ida" }, undefined, "home"), false);
});

test("harness management authority comes only from server-minted markers", () => {
  const request = (space: Record<string, unknown>, kind = "ui-session") => ({ space, principal: { kind } }) as never;
  assert.equal(hasHarnessManagerAuthority(request({ instanceOwner: true })), true);
  assert.equal(hasHarnessManagerAuthority(request({ instanceOwner: false, harnessManager: true })), true);
  assert.equal(hasHarnessManagerAuthority(request({ instanceOwner: false, harnessManager: false })), false);
  assert.equal(hasHarnessManagerAuthority(request({ instanceOwner: false })), false);
  // Pre-canonical single local user only; a canonical ui-session never.
  assert.equal(hasHarnessManagerAuthority(request({}, "local-user")), true);
  assert.equal(hasHarnessManagerAuthority(request({})), false);
  assert.throws(() => requireHarnessManagerAuthority(request({ instanceOwner: false })), { code: "forbidden" });
});

test("personal harness authority: owner, managers and harnesses.personal holders only", () => {
  const request = (space: Record<string, unknown>, kind = "ui-session") => ({ space, principal: { kind } }) as never;
  assert.equal(hasPersonalHarnessAuthority(request({ instanceOwner: true })), true);
  assert.equal(hasPersonalHarnessAuthority(request({ instanceOwner: false, harnessManager: true })), true);
  assert.equal(hasPersonalHarnessAuthority(request({ instanceOwner: false, harnessPersonal: true })), true);
  assert.equal(hasPersonalHarnessAuthority(request({ instanceOwner: false })), false);
  assert.equal(hasPersonalHarnessAuthority(request({ harnessPersonal: "yes" })), false);
  // A personal holder is not a manager.
  assert.equal(hasHarnessManagerAuthority(request({ instanceOwner: false, harnessPersonal: true })), false);
  assert.throws(() => requirePersonalHarnessAuthority(request({ instanceOwner: false })), { code: "forbidden" });
});

test("shared account allowlists: people and Spaces, strictest with account limits", () => {
  const rule = { id: "claude-work", accountAllowedUserIds: ["u-ida"], accountAllowedSpaceIds: ["work"] };
  assert.equal(harnessUsableByUser(rule, "u-ida", null, "work"), true);
  assert.equal(harnessUsableByUser(rule, "u-bob", null, "work"), false, "foreign person");
  assert.equal(harnessUsableByUser(rule, "u-ida", null, "home"), false, "foreign Space");
  assert.equal(harnessUsableByUser(rule, "u-ida", null, undefined), false, "no Space never matches a Space list");
  assert.equal(harnessUsableByUser(rule, "u-ida", ["claude"], "work"), false, "limits still apply");
  assert.equal(harnessUsableByUser({ id: "claude-team", accountAllowedSpaceIds: ["work"] }, "anyone", null, "work"), true);
  // A private account ignores any list and the limits.
  assert.equal(harnessUsableByUser({ id: "claude-ida", accountOwnerUserId: "u-ida", accountAllowedUserIds: ["u-bob"] }, "u-bob", null, "work"), false);
  assert.equal(harnessUsableByUser({ id: "claude-ida", accountOwnerUserId: "u-ida" }, "u-ida", ["claude"], "work"), true);
  assert.equal(normalizeHarnessAccessList(null, "x"), undefined);
  assert.equal(normalizeHarnessAccessList([], "x"), undefined);
  assert.deepEqual(normalizeHarnessAccessList(["a", "a", "b"], "x"), ["a", "b"]);
  assert.throws(() => normalizeHarnessAccessList(["../x"], "x"), { code: "invalid-input" });
  assert.throws(() => normalizeHarnessAccessList(["system:polyth-runtime"], "x"), { code: "invalid-input" });
  assert.throws(() => normalizeHarnessAccessList("u-ida", "x"), { code: "invalid-input" });
  assert.deepEqual([...harnessAccessOf([
    { id: "claude" },
    { id: "claude-ida", accountOwnerUserId: "u-ida" },
    { id: "claude-work", accountAllowedSpaceIds: ["work"] },
  ]).keys()], ["claude-ida", "claude-work"]);
});

test("a restricted shared account runs chats only for allowed people in allowed Spaces", async () => {
  const access = () => new Map<string, HarnessAccessRule>([["claude-work", { accountAllowedUserIds: ["u-ida"], accountAllowedSpaceIds: ["work"] }]]);
  const { service, calls } = base({ harness: pinned("claude-work") });
  await assert.rejects(privateHarnessSessionService(service, as("u-bob", "work"), access).create({ projectId: "p", harness: pinned("claude-work") } as never), { code: "forbidden" });
  await assert.rejects(privateHarnessSessionService(service, as("u-ida", "home"), access).create({ projectId: "p", harness: pinned("claude-work") } as never), { code: "forbidden" });
  await assert.rejects(privateHarnessSessionService(service, as("u-bob", "work"), access).send("s1", { text: "hi" } as never), { code: "forbidden" });
  await assert.rejects(privateHarnessSessionService(service, as("u-ida", "home"), access).switchHarness!("s1", pinned("claude-work")), { code: "forbidden" });
  await assert.rejects(privateHarnessSessionService(service, as("u-bob", "work"), access).restartRuntime!("s1"), { code: "forbidden" });
  const ida = privateHarnessSessionService(service, as("u-ida", "work"), access);
  await ida.create({ projectId: "p", harness: pinned("claude-work") } as never);
  await ida.send("s1", { text: "hi" } as never);
  assert.deepEqual(calls, ["create:claude-work", "send"]);
  const models = [{ providerID: "a", modelID: "m", harnessId: "claude-work" }, { providerID: "a", modelID: "m", harnessId: "claude" }] as ModelDescriptor[];
  assert.deepEqual(privateHarnessCatalog(models, as("u-ida", "home"), access).map((m) => m.harnessId), ["claude"]);
  assert.equal(privateHarnessCatalog(models, as("u-ida", "work"), access).length, 2);
});

test("a person's default pins only chats that name nothing", async () => {
  const { service, calls } = base({});
  const ctx = { userId: "u-ida", spaceId: "home" } as never;
  const scoped = personDefaultSessionService(service, ctx, async () => "claude-ida");
  await scoped.create({ projectId: "p" } as never);
  await scoped.create({ projectId: "p", harness: { mode: "auto" } } as never);
  await scoped.create({ projectId: "p", harness: pinned("claude") } as never);
  await scoped.create({ projectId: "p", model: { providerID: "a", modelID: "m" } } as never);
  await scoped.create({ projectId: "p", parentId: "parent" } as never);
  await personDefaultSessionService(service, ctx, async () => undefined).create({ projectId: "p" } as never);
  await personDefaultSessionService(service, ctx, async () => { throw new Error("broken"); }).create({ projectId: "p" } as never);
  assert.deepEqual(calls, ["create:claude-ida", "create:auto", "create:claude", "create:auto", "create:auto", "create:auto", "create:auto"]);
  // The pin it adds is checked like any other: another person's private default is refused.
  const bob = personDefaultSessionService(privateHarnessSessionService(service, as("u-bob"), owners), ctx, async () => "claude-ida");
  await assert.rejects(bob.create({ projectId: "p" } as never), { code: "forbidden" });
});

test("nobody but its owner runs a chat on a private harness account", async () => {
  const { service, calls } = base({ harness: pinned("claude") });
  const bob = privateHarnessSessionService(service, as("u-bob"), owners);
  const ida = privateHarnessSessionService(service, as("u-ida"), owners);

  await assert.rejects(bob.create({ projectId: "p", harness: pinned("claude-ida") } as never), { code: "forbidden" });
  await assert.rejects(bob.send("s1", { text: "hi", harness: pinned("claude-ida") } as never), { code: "forbidden" });
  await assert.rejects(bob.resumeNow!("s1", { harness: pinned("claude-ida") }), { code: "forbidden" });
  await assert.rejects(bob.switchHarness!("s1", pinned("claude-ida")), { code: "forbidden" });
  await bob.create({ projectId: "p", harness: pinned("claude") } as never);
  await bob.create({ projectId: "p", harness: { mode: "auto" } } as never);
  await bob.send("s1", { text: "hi" } as never);
  await ida.create({ projectId: "p", harness: pinned("claude-ida") } as never);
  await ida.switchHarness!("s1", pinned("claude-ida"));
  assert.deepEqual(calls, ["create:claude", "create:auto", "send", "create:claude-ida", "switch:claude-ida"]);
});

test("a shared chat running on someone's private account does not continue for anyone else", async () => {
  for (const projection of [{ harness: pinned("claude-ida") }, { harness: { mode: "auto" as const }, resolvedHarnessId: "claude-ida" }]) {
    const { service, calls } = base(projection);
    const bob = privateHarnessSessionService(service, as("u-bob"), owners);
    await assert.rejects(bob.send("s1", { text: "hi" } as never), { code: "forbidden" });
    await assert.rejects(bob.resumeNow!("s1"), { code: "forbidden" });
    await assert.rejects(bob.restartRuntime!("s1"), { code: "forbidden" });
    // Switching to a harness Bob may use is the way forward.
    await bob.switchHarness!("s1", pinned("claude"));
    await bob.send("s1", { text: "hi", harness: pinned("claude") } as never);
    await privateHarnessSessionService(service, as("u-ida"), owners).send("s1", { text: "hi" } as never);
    assert.deepEqual(calls, ["switch:claude", "send", "send"]);
  }
});

test("other users' private account models are removed from the catalog", () => {
  const models = [
    { providerID: "anthropic", modelID: "a", harnessId: "claude" },
    { providerID: "anthropic", modelID: "a", harnessId: "claude-ida" },
    { providerID: "x", modelID: "b" },
  ] as ModelDescriptor[];
  assert.deepEqual(privateHarnessCatalog(models, as("u-bob"), owners).map((model) => model.harnessId), ["claude", undefined]);
  assert.equal(privateHarnessCatalog(models, as("u-ida"), owners).length, 3);
  assert.equal(privateHarnessCatalog(models, as("u-bob"), undefined).length, 3);
});
