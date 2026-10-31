import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlPlane } from "@polyth/control-plane";
import { createIdentityService, type PasswordService } from "@polyth/identity";
import { CLI_ACCESS_PROFILES, normalizeCliTokenGrants, type AuthPrincipal, type RequestIngress } from "@polyth/contracts";
import { authRequestLike, isPrivateNetworkAddress, type AuthRequestLike } from "../src/auth.ts";
import { createCanonicalAuthGateway } from "../src/canonicalAuth.ts";
import { assertPairedHttpAllowed, CORE_REMOTE_ACCESS } from "../src/remotePolicy.ts";
import { createSessionEventWaiters, clampWaitMs } from "../src/sessionEventWaiters.ts";
import { createAuthService } from "../src/auth.ts";
import { createHttpHandler, createInternalControlServer } from "../src/http.ts";
import { testTenancy } from "./support/spaces.ts";

const passwords: PasswordService = {
  async hash(password) { return `test:${password}`; },
  async verify(password, encoded) { return { valid: encoded === `test:${password}`, needsRehash: false }; },
  close() {},
};

async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-cli-access-"));
  const control = openControlPlane({ directory: dir });
  let clock = 1_800_000_000_000;
  const identity = createIdentityService(control, {
    passwords, now: () => clock,
    accessTokens: { normalizeGrants: normalizeCliTokenGrants, profiles: CLI_ACCESS_PROFILES },
  });
  t.after(() => { identity.close(); control.close(); rmSync(dir, { recursive: true, force: true }); });
  const claim = identity.setup.issueClaim();
  const binding = "a".repeat(64);
  identity.setup.bindClaim(claim.token, binding);
  const recovery = identity.setup.prepareRecovery(claim.token, binding);
  const owner = await identity.setup.complete({
    claimToken: claim.token, browserBinding: binding, name: "Owner", organizationName: "Local",
    login: "owner", password: "owner test passphrase", recoverySetId: recovery.setId, recoveryAcknowledged: true,
  });
  const gateway = createCanonicalAuthGateway({ control, identity, cookieName: identity.sessions.cookieName() });
  return { control, identity, owner, gateway, advance: (ms: number) => { clock += ms; } };
}

const ingress = (over: Partial<Extract<RequestIngress, { kind: "public-http" }>> = {}): RequestIngress =>
  ({ kind: "public-http", listenerId: "public", loopback: false, secure: false, ...over });
const req = (headers: AuthRequestLike["headers"], remoteAddress = "127.0.0.1", forwarded = false): AuthRequestLike =>
  ({ headers, socket: { remoteAddress }, ...(forwarded ? { forwarded: true } : {}) });
const userOf = (principal: AuthPrincipal) => (principal as AuthPrincipal & { userId?: string }).userId;

test("bearer tokens resolve to a grant-bound principal, only over TLS or loopback", async (t) => {
  const f = await fixture(t);
  const { token, summary } = f.identity.accessTokens.create(f.owner.token, { label: "ci", profile: "read" });
  const bearer = { authorization: `Bearer ${token}` };

  const viaTls = f.gateway.resolve(req(bearer, "203.0.113.7"), ingress({ secure: true, proxied: true }));
  assert.equal(viaTls.authenticated, true);
  assert.equal(viaTls.principal.kind, "access-token");
  assert.equal(userOf(viaTls.principal), f.owner.userId);
  assert.deepEqual(viaTls.principal.kind === "access-token" ? [...viaTls.principal.grants] : [], [...CLI_ACCESS_PROFILES.read].sort());
  assert.equal(f.gateway.resolve(req(bearer), ingress({ loopback: true })).authenticated, true);
  // Plain HTTP from the network: the token is refused, never accepted in clear.
  assert.equal(f.gateway.resolve(req(bearer, "192.168.1.20"), ingress()).authenticated, false);
  // A presented-but-bad token never falls back to a cookie.
  const cookie = `${f.identity.sessions.cookieName()}=${f.owner.token}`;
  assert.equal(f.gateway.resolve(req({ authorization: `Bearer pth_${"0".repeat(64)}`, cookie }), ingress({ loopback: true })).authenticated, false);

  assert.ok(f.gateway.refreshPrincipal(viaTls.principal));
  f.identity.accessTokens.revoke(f.owner.token, summary.id, summary.revision);
  assert.equal(f.gateway.refreshPrincipal(viaTls.principal), null);
  assert.equal(f.gateway.resolve(req(bearer), ingress({ loopback: true })).authenticated, false);
});

test("token principals only reach the default-deny route table, never approvals", async (t) => {
  const f = await fixture(t);
  const { token } = f.identity.accessTokens.create(f.owner.token, { label: "bot", profile: "control" });
  const { principal } = f.gateway.resolve(req({ authorization: `Bearer ${token}` }), ingress({ loopback: true }));
  const core = [{ owner: "core", policy: CORE_REMOTE_ACCESS }];
  assert.ok(assertPairedHttpAllowed(principal, "GET", "/api/sessions/summaries", core));
  assert.ok(assertPairedHttpAllowed(principal, "POST", "/api/sessions/abc/message", core));
  assert.ok(assertPairedHttpAllowed(principal, "GET", "/api/cli/whoami", core));
  assert.throws(() => assertPairedHttpAllowed(principal, "POST", "/api/sessions/abc/permission/req", core), { code: "forbidden" });
  assert.throws(() => assertPairedHttpAllowed(principal, "DELETE", "/api/sessions/abc", core), { code: "forbidden" });
  assert.throws(() => assertPairedHttpAllowed(principal, "GET", "/api/system/info", core), { code: "forbidden" });
  assert.throws(() => normalizeCliTokenGrants(["core.requests.respond"]), /not grantable/);
});

test("no-token CLI mode: owner opt-in, scoped by network, never for browsers or proxies", async (t) => {
  const f = await fixture(t);
  const cli = { "x-polyth-cli": "1" };
  const loop = ingress({ loopback: true });
  assert.equal(f.gateway.resolve(req(cli), loop).authenticated, false, "off by default");

  const set = f.identity.accessTokens.trust.set(f.owner.token, "loopback", 0);
  const local = f.gateway.resolve(req(cli), loop);
  assert.equal(local.authenticated, true);
  assert.equal(local.principal.kind, "local-user");
  assert.equal(userOf(local.principal), f.owner.userId);
  assert.equal(f.gateway.resolve(req({}), loop).authenticated, false, "the explicit CLI marker is required");
  assert.equal(f.gateway.resolve(req({ ...cli, origin: "http://evil.example" }), loop).authenticated, false, "browser");
  assert.equal(f.gateway.resolve(req({ ...cli, "sec-fetch-site": "cross-site" }), loop).authenticated, false, "browser");
  assert.equal(f.gateway.resolve(req(cli, "127.0.0.1", true), loop).authenticated, false, "forwarded by an unconfigured proxy");
  assert.equal(f.gateway.resolve(req(cli, "127.0.0.1"), ingress({ loopback: false, proxied: true, secure: true })).authenticated, false, "trusted proxy");
  assert.equal(f.gateway.resolve(req(cli, "192.168.1.5"), ingress()).authenticated, false, "LAN needs private-network");

  const lan = f.identity.accessTokens.trust.set(f.owner.token, "private-network", set.revision);
  assert.equal(f.gateway.resolve(req(cli, "192.168.1.5"), ingress()).authenticated, true);
  assert.equal(f.gateway.resolve(req(cli, "::ffff:10.1.2.3"), ingress()).authenticated, true);
  assert.equal(f.gateway.resolve(req(cli, "100.64.12.34"), ingress()).authenticated, false, "overlay/CGNAT is not private");
  assert.equal(f.gateway.resolve(req(cli, "203.0.113.9"), ingress()).authenticated, false, "public");

  f.identity.accessTokens.trust.set(f.owner.token, "off", lan.revision);
  assert.equal(f.gateway.refreshPrincipal(local.principal), null, "turning it off ends live channels");
  assert.equal(f.gateway.resolve(req(cli), loop).authenticated, false);
});

test("authRequestLike keeps only resolver headers and flags forwarding", () => {
  const like = authRequestLike({
    headers: { cookie: "a=b", authorization: "Bearer x", "x-forwarded-for": "1.2.3.4", "x-polyth-internal-token": "secret" },
    socket: { remoteAddress: "127.0.0.1" },
  });
  assert.deepEqual(like.headers, { cookie: "a=b", authorization: "Bearer x" });
  assert.equal(like.forwarded, true);
  assert.equal(authRequestLike({ headers: {}, socket: null }).forwarded, undefined);
  for (const address of ["10.0.0.1", "172.16.4.4", "172.31.255.1", "192.168.0.10", "fd12::1", "fe80::1"]) assert.equal(isPrivateNetworkAddress(address), true, address);
  for (const address of ["172.32.0.1", "100.64.0.1", "8.8.8.8", "127.0.0.1", "2001:db8::1", undefined]) assert.equal(isPrivateNetworkAddress(address), false, String(address));
});

const call = (socketPath: string, path: string): Promise<number> => new Promise((resolve, reject) => {
  const r = request({ socketPath, path }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
  r.on("error", reject);
  r.end();
});

test("outside local-trusted the control socket answers only health and discovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-cli-socket-"));
  const tenancy = await testTenancy();
  const handler = createHttpHandler({
    spaces: { ...tenancy.gateway, deployment: "server-trusted" },
    runtimes: {} as never,
    capabilities: () => [],
    webDist: dir,
    version: "test",
    auth: createAuthService({ file: join(dir, "auth.json"), envPassword: "test-only" }),
  });
  const socketPath = join(dir, "control.sock");
  const internal = createInternalControlServer(handler);
  await new Promise<void>((resolve) => internal.listen(socketPath, resolve));
  try {
    assert.equal(await call(socketPath, "/api/projects"), 403);
    assert.equal(await call(socketPath, "/api/sessions/summaries"), 403);
    assert.equal(await call(socketPath, "/api/health"), 200);
  } finally {
    await new Promise<void>((resolve) => internal.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("long-poll waiters wake on the right session, time out, abort and release on close", async (t) => {
  // Waiter timers are unref'd (a parked request must not keep a stopping
  // server alive); hold the loop open for the test's own timeouts.
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(keepAlive));
  const waiters = createSessionEventWaiters();
  let woke = false;
  const pending = waiters.waitForEvent("s1", 5_000).then(() => { woke = true; });
  waiters.event("other");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(woke, false);
  waiters.event("s1");
  await pending;
  assert.equal(waiters.size(), 0);

  const started = Date.now();
  await waiters.waitForEvent("s1", 30);
  assert.ok(Date.now() - started >= 25);

  const abort = new AbortController();
  const aborted = waiters.waitForProjection(5_000, abort.signal);
  abort.abort();
  await aborted;

  const held = waiters.waitForEvent("s2", 60_000);
  waiters.close();
  await held;
  assert.equal(waiters.size(), 0);
  await waiters.waitForEvent("s3", 60_000); // closed: resolves at once

  assert.equal(clampWaitMs(null), 0);
  assert.equal(clampWaitMs("120000"), 30_000);
  assert.throws(() => clampWaitMs("-1"), { code: "invalid-input" });
});
