import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlPlane } from "@polyth/control-plane";
import { createIdentityService, type PasswordService } from "@polyth/identity";
import {
  accountLimitsEmpty,
  normalizeAccountLimits,
  type AccountLimits,
  type ModelDescriptor,
  type ProjectService,
  type SessionProjection,
  type SessionService,
  type SpaceContext,
} from "@polyth/contracts";
import {
  harnessAllowedFor,
  limitedCatalog,
  limitedProjectsForActor,
  limitedSessionService,
  type LimitsAuthority,
} from "../src/accountLimits.ts";

const passwords: PasswordService = {
  async hash(password) { return `test:${password}`; },
  async verify(password, encoded) { return { valid: encoded === `test:${password}`, needsRehash: false }; },
  close() {},
};

const normalizeLimits = (raw: unknown) => {
  const limits = normalizeAccountLimits(raw);
  return accountLimitsEmpty(limits) ? null : limits;
};

async function fixture(t: test.TestContext, clock = { now: Date.UTC(2026, 9, 4, 12) }) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-limits-"));
  const control = openControlPlane({ directory: dir });
  const identity = createIdentityService(control, { passwords, normalizeLimits, now: () => clock.now });
  t.after(() => { identity.close(); control.close(); rmSync(dir, { recursive: true, force: true }); });
  const claim = identity.setup.issueClaim();
  const binding = "a".repeat(64);
  identity.setup.bindClaim(claim.token, binding);
  const recovery = identity.setup.prepareRecovery(claim.token, binding);
  const owner = await identity.setup.complete({
    claimToken: claim.token, browserBinding: binding, name: "Owner", organizationName: "Local",
    login: "owner", password: "owner test passphrase", recoverySetId: recovery.setId, recoveryAcknowledged: true,
  });
  const member = await identity.accounts.createLocal(owner.token, { login: "olena", name: "Olena", password: "member test passphrase" });
  const memberSession = control.transaction(() => identity.sessions.issue(member.id, "test"));
  return { control, identity, owner, member, memberToken: memberSession.token, clock };
}

const LIMITS: AccountLimits = { projects: ["prj_a"], harnesses: ["claude", "codex"], messagesPerDay: 2, chatsPerDay: 1 };

test("limits validate untrusted input and treat all-null as no limits", () => {
  assert.deepEqual(normalizeAccountLimits({ projects: ["p", "p"], harnesses: null, messagesPerDay: 5 }), {
    projects: ["p"], harnesses: null, messagesPerDay: 5, chatsPerDay: null,
  });
  assert.equal(normalizeLimits({ projects: null, harnesses: null, messagesPerDay: null, chatsPerDay: null }), null);
  for (const bad of [null, [], { projects: "p" }, { messagesPerDay: -1 }, { chatsPerDay: 1.5 }, { harnesses: [""] }, { projects: ["a\u0000"] }]) {
    assert.throws(() => normalizeAccountLimits(bad), { code: "invalid-input" }, JSON.stringify(bad));
  }
});

test("only the instance owner sets limits, with revisions, never on an owner", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.identity.limits.get(f.memberToken, f.member.id), {
    userId: f.member.id, limits: null, revision: 0, usage: { day: "2026-10-04", messages: 0, chats: 0 },
  });
  const saved = f.identity.limits.set(f.owner.token, f.member.id, LIMITS, 0);
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.limits, LIMITS);
  assert.deepEqual(f.identity.limits.forUser(f.member.id).limits, LIMITS);
  // The account reads its own limits; it cannot change them or read others'.
  assert.deepEqual(f.identity.limits.get(f.memberToken, f.member.id).limits, LIMITS);
  assert.throws(() => f.identity.limits.set(f.memberToken, f.member.id, null, 1), { code: "forbidden" });
  assert.throws(() => f.identity.limits.get(f.memberToken, f.owner.userId), { code: "not-found" });
  assert.throws(() => f.identity.limits.set(f.owner.token, f.member.id, LIMITS, 0), { code: "conflict" });
  assert.throws(() => f.identity.limits.set(f.owner.token, f.owner.userId, LIMITS, 0), { code: "invalid-input" });
  // Limits that restrict nothing are stored as removed; the revision still moves.
  const cleared = f.identity.limits.set(f.owner.token, f.member.id, { projects: null, harnesses: null, messagesPerDay: null, chatsPerDay: null }, 1);
  assert.equal(cleared.limits, null);
  assert.equal(cleared.revision, 2);
  assert.equal(f.identity.limits.forUser(f.member.id).limits, null);
  const audit = f.control.all<{ action: string }>("SELECT action FROM audit_events WHERE resource_id=? ORDER BY seq", f.member.id).map(row => row.action);
  assert.ok(audit.includes("identity.limits-updated") && audit.includes("identity.limits-removed"));
});

test("a corrupt stored policy fails closed", async t => {
  const f = await fixture(t);
  f.identity.limits.set(f.owner.token, f.member.id, LIMITS, 0);
  f.control.transaction(() => f.control.run("UPDATE account_limits SET limits_json='{\"projects\":7}' WHERE user_id=?", f.member.id));
  // The process cache is only invalidated by `set`; a fresh service reads the row.
  const fresh = createIdentityService(f.control, { passwords, normalizeLimits });
  t.after(() => fresh.close());
  assert.deepEqual(fresh.limits.forUser(f.member.id).limits, { projects: [], harnesses: [], messagesPerDay: 0, chatsPerDay: 0 });
});

test("daily use is counted per server-local day, capped and refundable", async t => {
  const f = await fixture(t);
  const day = f.identity.limits.consume(f.member.id, "messages", 2);
  assert.ok(day);
  assert.ok(f.identity.limits.consume(f.member.id, "messages", 2));
  assert.equal(f.identity.limits.consume(f.member.id, "messages", 2), null);
  f.identity.limits.refund(f.member.id, "messages", day!);
  assert.equal(f.identity.limits.usage(f.member.id).messages, 1);
  // A principal without a users row is never counted.
  assert.ok(f.identity.limits.consume("system:polyth-runtime", "messages", null));
  assert.equal(f.control.get("SELECT 1 FROM account_usage WHERE user_id='system:polyth-runtime'"), undefined);
  f.clock.now += 24 * 60 * 60 * 1000;
  assert.deepEqual(f.identity.limits.usage(f.member.id), { day: "2026-10-05", messages: 0, chats: 0 });
});

test("the owner renames another account and resets its password, ending its sessions", async t => {
  const f = await fixture(t);
  const renamed = f.identity.accounts.renameAccount(f.owner.token, f.member.id, "Olena K.", f.member.revision);
  assert.equal(renamed.displayName, "Olena K.");
  assert.throws(() => f.identity.accounts.renameAccount(f.memberToken, f.owner.userId, "x", 1), { code: "forbidden" });

  await assert.rejects(f.identity.accounts.resetPassword(f.owner.token, f.member.id, "short"), { code: "invalid-input" });
  await assert.rejects(f.identity.accounts.resetPassword(f.owner.token, f.owner.userId, "a new long passphrase"), { code: "forbidden" });
  await assert.rejects(f.identity.accounts.resetPassword(f.memberToken, f.member.id, "a new long passphrase"), { code: "forbidden" });
  await f.identity.accounts.resetPassword(f.owner.token, f.member.id, "a new long passphrase");
  assert.throws(() => f.identity.sessions.require(f.memberToken), { code: "unauthorized" });
  await f.identity.credentials.login({ login: "olena", password: "a new long passphrase" });
  await assert.rejects(f.identity.credentials.login({ login: "olena", password: "member test passphrase" }), { code: "invalid-credentials" });
});

// ---------------------------------------------------------------- session facade

function fakeAuthority(limits: AccountLimits | null, caps = new Map<string, number>()): LimitsAuthority & { used: Map<string, number> } {
  const used = new Map<string, number>();
  return {
    used,
    forUser: () => limits,
    consume(_userId, metric, cap) {
      const count = used.get(metric) ?? 0;
      if (cap !== null && count >= cap) return null;
      used.set(metric, count + 1);
      caps.set(metric, cap ?? -1);
      return "2026-10-04";
    },
    refund(_userId, metric) { used.set(metric, (used.get(metric) ?? 1) - 1); },
  };
}

function fakeSessions(projection: Partial<SessionProjection> = {}) {
  const calls: Array<{ method: string; input: unknown }> = [];
  let fail = false;
  const base = {
    async create(input: unknown) { calls.push({ method: "create", input }); if (fail) throw new Error("boom"); return { id: "s1" }; },
    async send(_id: string, input: unknown) { calls.push({ method: "send", input }); if (fail) throw new Error("boom"); return { id: "s1" }; },
    async fork() { calls.push({ method: "fork", input: null }); return { id: "s2" }; },
    async snapshot() { return { id: "s1", projectId: "prj_a", status: "idle", ...projection }; },
    async switchHarness(_id: string, selection: unknown) { calls.push({ method: "switchHarness", input: selection }); return {}; },
    async resumeNow(_id: string, options: unknown) { calls.push({ method: "resumeNow", input: options }); return {}; },
    async summaries(input: unknown) {
      calls.push({ method: "summaries", input });
      return { sessions: [{ id: "a", projectId: "prj_a" }, { id: "b", projectId: "prj_b" }], complete: true, revision: 1 };
    },
  } as unknown as SessionService;
  return { base, calls, failNext: () => { fail = true; } };
}

test("a harness list pins new chats and every turn to an allowed harness", async () => {
  const authority = fakeAuthority({ ...LIMITS, messagesPerDay: null, chatsPerDay: null });
  const auto = fakeSessions({ harness: { mode: "auto" }, resolvedHarnessId: "codex" });
  const limited = limitedSessionService(auto.base, { userId: "usr_m", spaceId: "home" }, authority);

  await limited.create({ projectId: "prj_a" } as never);
  assert.deepEqual((auto.calls[0]!.input as { harness: unknown }).harness, { mode: "pinned", harnessId: "claude" });
  await assert.rejects(limited.create({ projectId: "prj_a", harness: { mode: "pinned", harnessId: "gemini" } } as never), { code: "forbidden" });
  await assert.rejects(limited.create({ projectId: "prj_a", harness: { mode: "auto" } } as never), { code: "forbidden" });
  // A project outside the list is indistinguishable from a missing one.
  await assert.rejects(limited.create({ projectId: "prj_b" } as never), { code: "not-found" });

  // An Auto chat already running on an allowed harness is pinned there: no switch.
  await limited.send("s1", { text: "hi" } as never);
  assert.deepEqual((auto.calls.at(-1)!.input as { harness: unknown }).harness, { mode: "pinned", harnessId: "codex" });
  await assert.rejects(limited.send("s1", { text: "hi", harness: { mode: "pinned", harnessId: "gemini" } } as never), { code: "forbidden" });
  await assert.rejects(limited.switchHarness!("s1", { mode: "auto" }, "stop-now"), { code: "forbidden" });
  await limited.switchHarness!("s1", { mode: "pinned", harnessId: "claude" }, "stop-now");

  // Another member's chat on a harness this account may not use moves to the default first.
  const foreign = fakeSessions({ harness: { mode: "pinned", harnessId: "gemini" }, resolvedHarnessId: "gemini" });
  const onForeign = limitedSessionService(foreign.base, { userId: "usr_m", spaceId: "home" }, authority);
  await onForeign.send("s1", { text: "hi" } as never);
  assert.deepEqual((foreign.calls.at(-1)!.input as { harness: unknown }).harness, { mode: "pinned", harnessId: "claude" });
  await onForeign.resumeNow!("s1", undefined);
  assert.deepEqual((foreign.calls.at(-1)!.input as { harness: unknown }).harness, { mode: "pinned", harnessId: "claude" });

  // A chat pinned to an allowed harness is sent unchanged.
  const pinned = fakeSessions({ harness: { mode: "pinned", harnessId: "codex" }, resolvedHarnessId: "codex" });
  await limitedSessionService(pinned.base, { userId: "usr_m", spaceId: "home" }, authority).send("s1", { text: "hi" } as never);
  assert.equal((pinned.calls.at(-1)!.input as { harness?: unknown }).harness, undefined);
});

test("daily caps refuse with limit-reached and refund failed work", async () => {
  const authority = fakeAuthority({ projects: null, harnesses: null, messagesPerDay: 1, chatsPerDay: 1 });
  const fake = fakeSessions();
  const limited = limitedSessionService(fake.base, { userId: "usr_m", spaceId: "home" }, authority);
  await limited.send("s1", { text: "one" } as never);
  await assert.rejects(limited.send("s1", { text: "two" } as never), (error: Error & { code?: string; status?: number }) =>
    error.code === "limit-reached" && error.status === 429 && /today's 1 messages/.test(error.message));
  await limited.create({ projectId: "prj_a" } as never);
  await assert.rejects(limited.fork("s1"), { code: "limit-reached" });

  const failing = fakeSessions();
  const again = fakeAuthority({ projects: null, harnesses: null, messagesPerDay: 1, chatsPerDay: null });
  const retry = limitedSessionService(failing.base, { userId: "usr_m", spaceId: "home" }, again);
  failing.failNext();
  await assert.rejects(retry.send("s1", { text: "x" } as never), /boom/);
  assert.equal(again.used.get("messages"), 0);
});

test("an unlimited account is neither counted nor narrowed", async () => {
  const authority = fakeAuthority(null);
  const fake = fakeSessions({ harness: { mode: "auto" } });
  const limited = limitedSessionService(fake.base, { userId: "usr_owner", spaceId: "home" }, authority);
  await limited.create({ projectId: "prj_z", harness: { mode: "auto" } } as never);
  await limited.send("s1", { text: "hi" } as never);
  assert.equal(authority.used.size, 0);
  assert.equal((await limited.summaries!({})).sessions.length, 2);
});

test("a project list narrows the navigator listing and refuses adding projects", async () => {
  const authority = fakeAuthority({ ...LIMITS, harnesses: null });
  const fake = fakeSessions();
  const limited = limitedSessionService(fake.base, { userId: "usr_m", spaceId: "home" }, authority);
  assert.deepEqual((await limited.summaries!({})).sessions.map((s) => s.id), ["a"]);
  await assert.rejects(limited.summaries!({ projectId: "prj_b" }), { code: "not-found" });

  const ctx = { userId: "usr_m", spaceId: "spc" } as SpaceContext;
  const added: string[] = [];
  const projects = {
    list: async () => [], get: async () => undefined, remove: async () => {},
    add: async (path: string) => { added.push(path); return { id: "p" }; },
    create: async (path: string) => { added.push(path); return { id: "p" }; },
    addRemote: async (path: string) => { added.push(path); return { id: "p" }; },
  } as unknown as ProjectService;
  const scoped = limitedProjectsForActor(ctx, projects, () => LIMITS);
  await assert.rejects(scoped.add("/srv/x"), { code: "forbidden" });
  await assert.rejects(scoped.create("/srv/y"), { code: "forbidden" });
  await assert.rejects(scoped.addRemote!("/srv/z", { connectionId: "c" } as never), { code: "forbidden" });
  assert.deepEqual(added, []);
  await limitedProjectsForActor(ctx, projects, () => null).add("/srv/ok");
  assert.deepEqual(added, ["/srv/ok"]);
});

test("the catalog keeps only models on allowed harnesses", () => {
  const models = [
    { harnessId: "claude", providerID: "anthropic", modelID: "sonnet" },
    { harnessId: "gemini", providerID: "google", modelID: "pro" },
    { providerID: "local", modelID: "untagged" },
  ] as ModelDescriptor[];
  assert.deepEqual(limitedCatalog(models, LIMITS).map((m) => m.modelID), ["sonnet", "untagged"]);
  assert.equal(limitedCatalog(models, null).length, 3);
});

test("an account's own private login stays usable outside its harness list; another user's never", async () => {
  const authority = fakeAuthority({ ...LIMITS, messagesPerDay: null, chatsPerDay: null });
  const owners = () => new Map([["claude-mine", { accountOwnerUserId: "usr_m" }], ["claude-theirs", { accountOwnerUserId: "usr_x" }]]);
  const fake = fakeSessions({ harness: { mode: "pinned", harnessId: "claude-mine" }, resolvedHarnessId: "claude-mine" });
  const limited = limitedSessionService(fake.base, { userId: "usr_m", spaceId: "home" }, authority, owners);

  await limited.create({ projectId: "prj_a", harness: { mode: "pinned", harnessId: "claude-mine" } } as never);
  assert.deepEqual((fake.calls.at(-1)!.input as { harness: unknown }).harness, { mode: "pinned", harnessId: "claude-mine" });
  await assert.rejects(limited.create({ projectId: "prj_a", harness: { mode: "pinned", harnessId: "claude-theirs" } } as never), { code: "forbidden" });
  // A chat already on the own login continues there unchanged.
  await limited.send("s1", { text: "hi" } as never);
  assert.equal((fake.calls.at(-1)!.input as { harness?: unknown }).harness, undefined);
  await limited.switchHarness!("s1", { mode: "pinned", harnessId: "claude-mine" }, "stop-now");
  await assert.rejects(limited.switchHarness!("s1", { mode: "pinned", harnessId: "claude-theirs" }, "stop-now"), { code: "forbidden" });

  const models = [
    { harnessId: "claude-mine", providerID: "anthropic", modelID: "mine" },
    { harnessId: "claude-theirs", providerID: "anthropic", modelID: "theirs" },
    { harnessId: "gemini", providerID: "google", modelID: "pro" },
    { harnessId: "codex", providerID: "openai", modelID: "gpt" },
  ] as ModelDescriptor[];
  assert.deepEqual(limitedCatalog(models, LIMITS, harnessAllowedFor({ userId: "usr_m", spaceId: "home" }, owners)).map((m) => m.modelID), ["mine", "gpt"]);
});

test("a restricted shared account obeys its allowlists on top of the limits; strictest wins", async () => {
  const authority = fakeAuthority({ ...LIMITS, harnesses: ["claude", "claude-work"], messagesPerDay: null, chatsPerDay: null });
  const access = () => new Map([["claude-work", { accountAllowedUserIds: ["usr_m"], accountAllowedSpaceIds: ["work"] }]]);
  const fake = fakeSessions({ harness: { mode: "pinned", harnessId: "claude" }, resolvedHarnessId: "claude" });
  const atWork = limitedSessionService(fake.base, { userId: "usr_m", spaceId: "work" }, authority, access);
  await atWork.create({ projectId: "prj_a", harness: { mode: "pinned", harnessId: "claude-work" } } as never);
  // Foreign Space and foreign person are refused even though the limits list it.
  const atHome = limitedSessionService(fake.base, { userId: "usr_m", spaceId: "home" }, authority, access);
  await assert.rejects(atHome.create({ projectId: "prj_a", harness: { mode: "pinned", harnessId: "claude-work" } } as never), { code: "forbidden" });
  const other = limitedSessionService(fake.base, { userId: "usr_x", spaceId: "work" }, authority, access);
  await assert.rejects(other.switchHarness!("s1", { mode: "pinned", harnessId: "claude-work" }, "stop-now"), { code: "forbidden" });
  // Allowed by the allowlist but off the limits list is refused too.
  const narrower = limitedSessionService(fake.base, { userId: "usr_m", spaceId: "work" }, fakeAuthority({ ...LIMITS, messagesPerDay: null, chatsPerDay: null }), access);
  await assert.rejects(narrower.create({ projectId: "prj_a", harness: { mode: "pinned", harnessId: "claude-work" } } as never), { code: "forbidden" });
  const models = [
    { harnessId: "claude-work", providerID: "anthropic", modelID: "work" },
    { harnessId: "claude", providerID: "anthropic", modelID: "sonnet" },
  ] as ModelDescriptor[];
  const limits = { ...LIMITS, harnesses: ["claude", "claude-work"] };
  assert.deepEqual(limitedCatalog(models, limits, harnessAllowedFor({ userId: "usr_m", spaceId: "home" }, access)).map((m) => m.modelID), ["sonnet"]);
  assert.deepEqual(limitedCatalog(models, limits, harnessAllowedFor({ userId: "usr_m", spaceId: "work" }, access)).map((m) => m.modelID), ["work", "sonnet"]);
});
