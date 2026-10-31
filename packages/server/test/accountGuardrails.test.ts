import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlPlane } from "@polyth/control-plane";
import { createIdentityService, type PasswordService } from "@polyth/identity";
import {
  GUARDRAIL_DEFAULT_GRANTS,
  normalizeAccountGuardrails,
  principalAllowsRemoteCapability,
  REMOTE_CAPABILITY,
  type AccountGuardrails,
  type AuthPrincipal,
  type ModelDescriptor,
  type SessionService,
} from "@polyth/contracts";
import { createCanonicalAuthGateway } from "../src/canonicalAuth.ts";
import { assertPairedHttpAllowed, CORE_REMOTE_ACCESS } from "../src/remotePolicy.ts";
import {
  guardedCatalog,
  guardedPermissions,
  guardedRole,
  guardedSessionService,
} from "../src/accountGuardrails.ts";

const passwords: PasswordService = {
  async hash(password) { return `test:${password}`; },
  async verify(password, encoded) { return { valid: encoded === `test:${password}`, needsRehash: false }; },
  close() {},
};

const GUARDRAILS: AccountGuardrails = {
  grants: [...GUARDRAIL_DEFAULT_GRANTS],
  models: [
    { harnessId: "claude", providerID: "anthropic", modelID: "sonnet" },
    { harnessId: "codex", providerID: "openai", modelID: "gpt-mini" },
  ],
  approvals: "none",
};

async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-guardrails-"));
  const control = openControlPlane({ directory: dir });
  const identity = createIdentityService(control, { passwords, normalizeGuardrails: normalizeAccountGuardrails });
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
  const cookieName = identity.sessions.cookieName();
  const gateway = createCanonicalAuthGateway({ control, identity, cookieName });
  const ingress = { kind: "public-http", listenerId: "public", loopback: false, secure: true } as const;
  const resolve = (token: string) => gateway.resolve({ headers: { cookie: `${cookieName}=${token}` }, socket: { remoteAddress: "10.0.0.2" } }, ingress);
  return { control, identity, owner, member, memberToken: memberSession.token, gateway, resolve };
}

test("only the instance owner sets guardrails, with revisions, and never on an owner", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.identity.guardrails.get(f.memberToken, f.member.id), { userId: f.member.id, guardrails: null, revision: 0 });

  const saved = f.identity.guardrails.set(f.owner.token, f.member.id, GUARDRAILS, 0);
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.guardrails, normalizeAccountGuardrails(GUARDRAILS));
  // The account can read its own guardrails; it cannot change them.
  assert.deepEqual(f.identity.guardrails.get(f.memberToken, f.member.id).guardrails, saved.guardrails);
  assert.throws(() => f.identity.guardrails.set(f.memberToken, f.member.id, null, 1), { code: "forbidden" });
  // A guarded member cannot read anyone else's policy, including the owner's existence.
  assert.throws(() => f.identity.guardrails.get(f.memberToken, f.owner.userId), { code: "not-found" });

  assert.throws(() => f.identity.guardrails.set(f.owner.token, f.member.id, GUARDRAILS, 0), { code: "conflict" });
  assert.throws(() => f.identity.guardrails.set(f.owner.token, f.owner.userId, GUARDRAILS, 0), { code: "invalid-input" });
  assert.throws(
    () => f.identity.guardrails.set(f.owner.token, f.member.id, { ...GUARDRAILS, grants: [REMOTE_CAPABILITY.serverShutdown] }, 1),
    { code: "invalid-input" },
  );

  const removed = f.identity.guardrails.set(f.owner.token, f.member.id, null, 1);
  assert.deepEqual(removed, { userId: f.member.id, guardrails: null, revision: 2 });
});

test("a guarded account's principal carries its ceiling live, and the owner's never does", async t => {
  const f = await fixture(t);
  const before = f.resolve(f.memberToken).principal;
  assert.equal(before.kind, "ui-session");
  assert.equal(before.kind === "ui-session" ? before.accountGrants : "x", undefined);

  f.identity.guardrails.set(f.owner.token, f.member.id, GUARDRAILS, 0);
  const guarded = f.resolve(f.memberToken).principal;
  assert.deepEqual(guarded.kind === "ui-session" ? [...guarded.accountGrants!] : [], [...normalizeAccountGuardrails(GUARDRAILS).grants]);
  assert.equal(principalAllowsRemoteCapability(guarded, REMOTE_CAPABILITY.coreSessionsMessage), true);
  assert.equal(principalAllowsRemoteCapability(guarded, REMOTE_CAPABILITY.terminalOpen), false);
  assert.equal(principalAllowsRemoteCapability(f.resolve(f.owner.token).principal, REMOTE_CAPABILITY.terminalOpen), true);

  // WebSocket revalidation re-reads guardrails: an open socket follows changes.
  const refreshed = f.gateway.refreshPrincipal(before)!;
  assert.ok(refreshed.kind === "ui-session" && refreshed.accountGrants);
  f.identity.guardrails.set(f.owner.token, f.member.id, null, 1);
  const lifted = f.gateway.refreshPrincipal(guarded)!;
  assert.equal(lifted.kind === "ui-session" ? lifted.accountGrants : "x", undefined);
});

test("a corrupt stored policy fails closed", async t => {
  const f = await fixture(t);
  f.identity.guardrails.set(f.owner.token, f.member.id, GUARDRAILS, 0);
  f.control.transaction(() => f.control.run(
    "UPDATE account_guardrails SET guardrails_json=? WHERE user_id=?",
    JSON.stringify({ grants: ["not-a-capability"], models: [], approvals: "none" }),
    f.member.id,
  ));
  const principal = f.resolve(f.memberToken).principal;
  assert.deepEqual(principal.kind === "ui-session" ? [...principal.accountGrants!] : ["x"], []);
});

test("guarded browser sessions share the paired-device default-deny route table", () => {
  const principal = {
    kind: "ui-session", sessionId: "s", rememberedDeviceId: "s", accountGrants: GUARDRAIL_DEFAULT_GRANTS,
  } as AuthPrincipal;
  const policies = [{ owner: "core", policy: CORE_REMOTE_ACCESS }];
  assert.ok(assertPairedHttpAllowed(principal, "POST", "/api/sessions/abc/message", policies));
  assert.ok(assertPairedHttpAllowed(principal, "GET", "/api/models", policies));
  for (const [method, path] of [
    ["POST", "/api/projects"],          // host folders: core.projects.write
    ["DELETE", "/api/sessions/abc"],    // core.sessions.delete
    ["GET", "/api/browse"],             // not remotely routable at all
    ["POST", "/api/spaces"],            // tenancy administration
    ["POST", "/api/providers/x/enabled"],
  ] as const) {
    assert.throws(() => assertPairedHttpAllowed(principal, method, path, policies), { code: "forbidden" }, `${method} ${path}`);
  }
  // An unguarded browser session is not a restricted principal.
  assert.throws(() => assertPairedHttpAllowed(
    { kind: "ui-session", sessionId: "s", rememberedDeviceId: "s" },
    "GET", "/api/models", policies,
  ), { code: "forbidden" });
  // A paired device of a guarded account gets the intersection.
  const device = {
    kind: "paired-device", deviceId: "d", deviceEndpointId: "e", connectionId: "c", transport: "relay",
    grants: [REMOTE_CAPABILITY.coreSessionsRead, REMOTE_CAPABILITY.coreProjectsWrite], grantRevision: 1,
    accountGrants: GUARDRAIL_DEFAULT_GRANTS,
  } as AuthPrincipal;
  assert.ok(assertPairedHttpAllowed(device, "GET", "/api/models", policies));
  assert.throws(() => assertPairedHttpAllowed(device, "POST", "/api/projects", policies), { code: "forbidden" });
});

function recordingSessions() {
  const calls: Array<[string, unknown[]]> = [];
  const record = (name: string) => async (...args: unknown[]) => { calls.push([name, args]); return {} as never; };
  const base = {
    create: record("create"), send: record("send"), resumeNow: record("resumeNow"),
    switchHarness: record("switchHarness"), runShell: record("runShell"),
    autoAcceptSet: record("autoAcceptSet"), replyPermission: record("replyPermission"),
    snapshot: record("snapshot"),
  } as unknown as SessionService;
  return { base, calls };
}

test("guarded sessions: owner-chosen models only, no shell, no standing approvals", async () => {
  const { base, calls } = recordingSessions();
  const sessions = guardedSessionService(base, normalizeAccountGuardrails(GUARDRAILS));

  await sessions.create({ projectId: "p" });
  assert.deepEqual(calls.at(-1), ["create", [{
    projectId: "p",
    model: { providerID: "anthropic", modelID: "sonnet" },
    harness: { mode: "pinned", harnessId: "claude" },
  }]]);
  await sessions.send("s", { text: "hi", model: { providerID: "openai", modelID: "gpt-mini" } });
  assert.deepEqual(calls.at(-1), ["send", ["s", {
    text: "hi", model: { providerID: "openai", modelID: "gpt-mini" }, harness: { mode: "pinned", harnessId: "codex" },
  }]]);
  await sessions.send("s", { text: "inherit" });
  assert.deepEqual(calls.at(-1), ["send", ["s", { text: "inherit" }]]);

  await assert.rejects(sessions.send("s", { text: "x", model: { providerID: "anthropic", modelID: "opus" } }), { code: "forbidden" });
  // The right model on a different harness is a different execution route.
  await assert.rejects(sessions.send("s", {
    text: "x", model: { providerID: "anthropic", modelID: "sonnet" }, harness: { mode: "pinned", harnessId: "codex" },
  }), { code: "forbidden" });
  await assert.rejects(sessions.create({ projectId: "p", harness: { mode: "pinned", harnessId: "opencode" } }), { code: "forbidden" });
  await assert.rejects(sessions.resumeNow!("s", { providerID: "anthropic", modelID: "opus" }), { code: "forbidden" });
  await assert.rejects(sessions.switchHarness!("s", { mode: "auto" }), { code: "forbidden" });
  await assert.rejects(sessions.runShell!("s", "rm -rf /"), { code: "forbidden" });
  await assert.rejects(sessions.autoAcceptSet!("s", "on"), { code: "forbidden" });
  // Full access is a higher Auto-Approve level; only "off"/"inherit" may pass.
  await assert.rejects(sessions.autoAcceptSet!("s", "all"), { code: "forbidden" });
  await assert.rejects(sessions.autoAcceptSet!("s", "bogus" as never), { code: "forbidden" });
  await assert.rejects(sessions.replyPermission("s", "r", "always"), { code: "forbidden" });
  await assert.rejects(sessions.replyPermission("s", "r", "once"), { code: "forbidden" });
  await sessions.replyPermission("s", "r", "reject");
  await sessions.autoAcceptSet!("s", "off");
  assert.deepEqual(calls.slice(-2).map(([name]) => name), ["replyPermission", "autoAcceptSet"]);
  assert.equal(calls.some(([name]) => name === "runShell"), false);

  const approving = guardedSessionService(base, { ...normalizeAccountGuardrails(GUARDRAILS), approvals: "once" });
  await approving.replyPermission("s", "r", "once");
  await assert.rejects(approving.replyPermission("s", "r", "always"), { code: "forbidden" });
});

test("an empty allowlist leaves the owner's defaults and admits no explicit choice", async () => {
  const { base, calls } = recordingSessions();
  const sessions = guardedSessionService(base, { grants: [], models: [], approvals: "none" });
  await sessions.create({ projectId: "p" });
  assert.deepEqual(calls.at(-1), ["create", [{ projectId: "p" }]]);
  await assert.rejects(sessions.send("s", { text: "x", model: { providerID: "a", modelID: "b" } }), { code: "forbidden" });
});

test("guarded Spaces turn standing allow rules into a question; deny still wins", () => {
  const rules = { evaluate: (permission: string) => (permission === "bash" ? "allow" : permission === "rm" ? "deny" : "ask") as "allow" | "deny" | "ask" };
  const spaces: Record<string, string> = { home: "spc_home", shared: "spc_family" };
  const wrapped = guardedPermissions(rules, (projectId) => spaces[projectId], (spaceId) => spaceId === "spc_family");
  assert.equal(wrapped.evaluate("bash", [], "home"), "allow");
  assert.equal(wrapped.evaluate("bash", [], "shared"), "ask");
  assert.equal(wrapped.evaluate("rm", [], "shared"), "deny");
  assert.equal(wrapped.evaluate("bash", []), "allow");
});

test("guarded roles never administer and the catalog shows only allowed models", () => {
  const guardrails = normalizeAccountGuardrails(GUARDRAILS);
  assert.equal(guardedRole("owner", guardrails), "member");
  assert.equal(guardedRole("admin", guardrails), "member");
  assert.equal(guardedRole("viewer", guardrails), "viewer");
  assert.equal(guardedRole("owner", null), "owner");
  const catalog: ModelDescriptor[] = [
    { harnessId: "claude", providerID: "anthropic", modelID: "sonnet", name: "Sonnet" },
    { harnessId: "claude", providerID: "anthropic", modelID: "opus", name: "Opus" },
    { harnessId: "opencode", providerID: "anthropic", modelID: "sonnet", name: "Sonnet via OpenCode" },
  ];
  assert.deepEqual(guardedCatalog(catalog, guardrails).map((model) => model.name), ["Sonnet"]);
});
