// F16 access control: scrypt hashing round-trips, the login rate limiter is
// pure and clock-injected (10 failures → 429 + Retry-After), the gate's
// allow/deny table covers disabled/cookie/localhost/revoked/expired, sessions
// survive a restart via data/auth.json, and /ws upgrades without a valid
// cookie are rejected at the socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import type { SessionService } from "@polyth/contracts";
import {
  createAuthService, createLoginRateLimiter, hashPassword, parseCookieToken,
  rateKeyFor, verifyPassword, type AuthRequestLike,
} from "../src/auth.ts";
import { authRoutes } from "../src/routes/auth.ts";
import { createHttpServer, type RouteRequest } from "../src/http.ts";
import { attachWs } from "../src/ws.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-auth-"));

const reqOf = (cookie?: string, remoteAddress?: string): AuthRequestLike => ({
  headers: { ...(cookie ? { cookie } : {}) },
  socket: { ...(remoteAddress ? { remoteAddress } : {}) },
});

// ---- password hashing --------------------------------------------------------

test("scrypt hashing: round-trip verifies, wrong password and garbage do not", () => {
  const stored = hashPassword("hunter2");
  assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(verifyPassword("hunter2", stored), true);
  assert.equal(verifyPassword("HUNTER2", stored), false);
  assert.equal(verifyPassword("hunter2", "not-a-hash"), false);
  assert.equal(verifyPassword("hunter2", "scrypt$zz$zz"), false);
  // two hashes of the same password differ (fresh salt) yet both verify
  const second = hashPassword("hunter2");
  assert.notEqual(second, stored);
  assert.equal(verifyPassword("hunter2", second), true);
});

// ---- rate limiter (pure, clock-injected) --------------------------------------

test("rate limiter: 10th failure locks for 15 minutes, success clears, keys independent", () => {
  let clock = 1_000_000;
  const rl = createLoginRateLimiter({ now: () => clock });

  for (let i = 0; i < 9; i++) {
    assert.equal(rl.check("1.2.3.4").allowed, true);
    rl.fail("1.2.3.4");
  }
  assert.equal(rl.check("1.2.3.4").allowed, true); // 9 failures: still open
  rl.fail("1.2.3.4"); // 10th trips the lock
  const locked = rl.check("1.2.3.4");
  assert.equal(locked.allowed, false);
  assert.ok(!locked.allowed && locked.retryAfterSec === 900);

  // an unrelated key keeps its own budget
  assert.equal(rl.check("5.6.7.8").allowed, true);

  // half the lockout later: still locked, Retry-After counts down
  clock += 7.5 * 60_000;
  const still = rl.check("1.2.3.4");
  assert.ok(!still.allowed && still.retryAfterSec === 450);

  // past the lockout: open again
  clock += 7.5 * 60_000;
  assert.equal(rl.check("1.2.3.4").allowed, true);

  // success wipes the failure budget
  rl.fail("9.9.9.9"); rl.fail("9.9.9.9");
  rl.succeed("9.9.9.9");
  for (let i = 0; i < 9; i++) rl.fail("9.9.9.9");
  assert.equal(rl.check("9.9.9.9").allowed, true); // 9 fresh failures only

  // failures outside the 10-minute window age out
  let t2 = 0;
  const rl2 = createLoginRateLimiter({ now: () => t2 });
  for (let i = 0; i < 9; i++) rl2.fail("a");
  t2 += 11 * 60_000; // window slid past all 9
  rl2.fail("a"); // would be the 10th otherwise
  assert.equal(rl2.check("a").allowed, true);
});

test("unidentified clients share the anon budget", () => {
  assert.equal(rateKeyFor(undefined), "anon");
  assert.equal(rateKeyFor(""), "anon");
  assert.equal(rateKeyFor("10.0.0.1"), "10.0.0.1");
});

// ---- cookie parsing -----------------------------------------------------------

test("cookie parsing: extracts polyth_auth among others, rejects malformed values", () => {
  const tok = "a".repeat(64);
  assert.equal(parseCookieToken(`polyth_auth=${tok}`), tok);
  assert.equal(parseCookieToken(`theme=dark; polyth_auth=${tok}; x=1`), tok);
  assert.equal(parseCookieToken("polyth_auth=short"), null);
  assert.equal(parseCookieToken("other=1"), null);
  assert.equal(parseCookieToken(undefined), null);
});

// ---- gate allow/deny table ------------------------------------------------------

test("gate allow/deny: disabled, cookie, localhost bypass, revoked, expired", () => {
  let clock = 1_700_000_000_000;
  const dir = tmp();

  // no password at all → everything passes
  const off = createAuthService({ file: join(dir, "off.json"), now: () => clock });
  assert.equal(off.gate(reqOf()), null);
  assert.equal(off.enabled(), false);

  const auth = createAuthService({
    file: join(dir, "auth.json"), envPassword: "pw", now: () => clock,
  });
  assert.equal(auth.enabled(), true);

  // no cookie → 401
  const denied = auth.gate(reqOf(undefined, "203.0.113.7"));
  assert.equal(denied?.status, 401);
  assert.equal(denied?.body.error, "unauthorized");

  // garbage cookie → 401
  assert.equal(auth.gate(reqOf(`polyth_auth=${"f".repeat(64)}`))?.status, 401);

  // valid login mints a token the gate accepts
  const login = auth.login("pw", "203.0.113.7", "TestUA");
  assert.ok(login.ok);
  const cookie = `polyth_auth=${login.ok ? login.token : ""}`;
  assert.equal(auth.gate(reqOf(cookie, "203.0.113.7")), null);
  assert.equal(auth.authorized(reqOf(cookie)), true);

  // logout-all revokes it
  auth.logoutAll();
  assert.equal(auth.gate(reqOf(cookie))?.status, 401);

  // fresh session expires after 30 idle days
  const again = auth.login("pw", "203.0.113.7");
  assert.ok(again.ok);
  const cookie2 = `polyth_auth=${again.ok ? again.token : ""}`;
  clock += 31 * 24 * 60 * 60_000;
  assert.equal(auth.gate(reqOf(cookie2))?.status, 401);

  // localhost bypass only with the explicit flag, and only for loopback
  const lax = createAuthService({
    file: join(dir, "lax.json"), envPassword: "pw", localhostOptional: true, now: () => clock,
  });
  assert.equal(lax.gate(reqOf(undefined, "127.0.0.1")), null);
  assert.equal(lax.gate(reqOf(undefined, "::1")), null);
  assert.equal(lax.gate(reqOf(undefined, "::ffff:127.0.0.1")), null);
  assert.equal(lax.gate(reqOf(undefined, "192.168.1.20"))?.status, 401);
  assert.equal(lax.gate(reqOf(undefined))?.status, 401); // no address ≠ local
});

test("sessions survive restart; the file stores hashes, never tokens or passwords", () => {
  const file = join(tmp(), "auth.json");
  const a1 = createAuthService({ file, envPassword: "pw" });
  const login = a1.login("pw", "10.0.0.1", "Mozilla/5.0 Chrome/120");
  assert.ok(login.ok);
  const token = login.ok ? login.token : "";

  const disk = readFileSync(file, "utf8");
  assert.doesNotMatch(disk, new RegExp(token)); // only sha256(token) on disk
  assert.doesNotMatch(disk, /pw/); // env password never persisted
  assert.match(disk, /Chrome\/120/); // device label kept for the settings list

  // restart: same file, same env password → old cookie still valid
  const a2 = createAuthService({ file, envPassword: "pw" });
  assert.equal(a2.gate(reqOf(`polyth_auth=${token}`)), null);
  const devices = a2.listSessions(token);
  assert.equal(devices.length, 1);
  assert.equal(devices[0]!.current, true);

  // revoke by id → gate denies
  assert.equal(a2.revoke(devices[0]!.id), true);
  assert.equal(a2.gate(reqOf(`polyth_auth=${token}`))?.status, 401);
  assert.equal(a2.revoke("nope"), false);
});

test("stored hash in auth.json enables auth without the env password", () => {
  const file = join(tmp(), "auth.json");
  const a1 = createAuthService({ file, envPassword: "boot-pw" });
  assert.ok(a1.login("boot-pw", "1.1.1.1").ok);

  // restart WITHOUT the env password: stored file has no hash → auth off
  const a2 = createAuthService({ file });
  assert.equal(a2.enabled(), false);

  // a hash written into the file turns auth on by itself
  const file2 = join(tmp(), "auth.json");
  const a3 = createAuthService({ file: file2, envPassword: "x" });
  assert.ok(a3.login("x", "1.1.1.1").ok); // forces a save
  const raw = JSON.parse(readFileSync(file2, "utf8")) as { passwordHash: string | null };
  raw.passwordHash = hashPassword("stored-pw");
  writeFileSync(file2, JSON.stringify(raw));
  const a4 = createAuthService({ file: file2 });
  assert.equal(a4.enabled(), true);
  assert.ok(a4.login("stored-pw", "1.1.1.1").ok);
  assert.equal(a4.login("wrong", "1.1.1.1").ok, false);
});

// ---- login route: 429 + Retry-After, Set-Cookie -------------------------------------

function routeHarness(auth: ReturnType<typeof createAuthService>) {
  const routes = authRoutes(auth);
  const call = async (
    method: string, path: string,
    opts: { body?: Record<string, unknown>; cookie?: string; remoteAddress?: string } = {},
  ) => {
    let status = 0;
    let payload: unknown;
    const headers: Record<string, string> = {};
    const rc = {
      req: {
        headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), "user-agent": "TestUA" },
        socket: { remoteAddress: opts.remoteAddress ?? "198.51.100.9" },
      },
      res: { setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; } },
      url: new URL(`http://x${path}`),
      path, method,
      body: async () => opts.body ?? {},
      json: (code: number, b: unknown) => { status = code; payload = b; },
    } as unknown as RouteRequest;
    const handled = await routes(rc);
    return { handled, status, payload: payload as Record<string, unknown>, headers };
  };
  return call;
}

test("login route: 10 wrong passwords → 429 with Retry-After; unlock after lockout", async () => {
  let clock = 1_700_000_000_000;
  const auth = createAuthService({ file: join(tmp(), "auth.json"), envPassword: "right", now: () => clock });
  const call = routeHarness(auth);

  const status0 = await call("GET", "/api/auth/status");
  assert.deepEqual(status0.payload, { required: true, authorized: false });

  for (let i = 0; i < 10; i++) {
    const r = await call("POST", "/api/auth/login", { body: { password: "wrong" } });
    assert.equal(r.status, 401);
    assert.equal(r.payload.error, "invalid-password");
  }
  // locked now — even the RIGHT password is refused until the window passes
  const locked = await call("POST", "/api/auth/login", { body: { password: "right" } });
  assert.equal(locked.status, 429);
  assert.equal(locked.payload.error, "rate-limited");
  assert.equal(locked.headers["retry-after"], "900");
  assert.equal(locked.payload.retryAfterSec, 900);

  // another IP is unaffected
  const other = await call("POST", "/api/auth/login", { body: { password: "right" }, remoteAddress: "198.51.100.10" });
  assert.equal(other.status, 200);

  // past the lockout the original IP logs in and gets a session cookie
  clock += 15 * 60_000 + 1_000;
  const ok = await call("POST", "/api/auth/login", { body: { password: "right" } });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers["set-cookie"];
  assert.match(setCookie, /^polyth_auth=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);

  // the cookie authorizes status + the device list; logout-all clears it
  const cookie = setCookie.split(";")[0]!;
  const status1 = await call("GET", "/api/auth/status", { cookie });
  assert.deepEqual(status1.payload, { required: true, authorized: true });
  const list = await call("GET", "/api/auth/sessions", { cookie });
  assert.equal((list.payload as unknown as Array<{ current: boolean }>).filter((d) => d.current).length, 1);

  const out = await call("POST", "/api/auth/logout-all", { cookie });
  assert.equal(out.status, 200);
  assert.match(out.headers["set-cookie"], /Max-Age=0/);
  const status2 = await call("GET", "/api/auth/status", { cookie });
  assert.deepEqual(status2.payload, { required: true, authorized: false });
});

// ---- http gate integration ------------------------------------------------------

test("http gate: /api requires a session, auth endpoints and static stay public", async () => {
  const dir = tmp();
  const auth = createAuthService({ file: join(dir, "auth.json"), envPassword: "pw" });
  const webDist = join(dir, "dist");
  mkdirSync(webDist, { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<html>lock shell</html>");

  const server = createHttpServer({
    sessions: {} as never,
    projects: { list: async () => [] } as never,
    runtimes: {} as never,
    capabilities: () => [],
    webDist,
    version: "test",
    routes: [authRoutes(auth)],
    auth,
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // static shell is public — the SPA must be able to render the lock screen
    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /lock shell/);

    // auth endpoints public, everything else 401
    assert.equal((await fetch(`${base}/api/auth/status`)).status, 200);
    assert.equal((await fetch(`${base}/api/projects`)).status, 401);
    assert.equal((await fetch(`${base}/api/health`)).status, 401);

    const bad = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    });
    assert.equal(bad.status, 401);

    const good = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "pw" }),
    });
    assert.equal(good.status, 200);
    const cookie = good.headers.get("set-cookie")!.split(";")[0]!;

    const withCookie = await fetch(`${base}/api/projects`, { headers: { cookie } });
    assert.equal(withCookie.status, 200);
    assert.deepEqual(await withCookie.json(), []);
  } finally {
    server.close();
  }
});

// ---- ws upgrade rejection ----------------------------------------------------------

test("ws upgrade without a valid cookie is rejected with 401", async () => {
  const auth = createAuthService({ file: join(tmp(), "auth.json"), envPassword: "pw" });
  const login = auth.login("pw", "127.0.0.1");
  assert.ok(login.ok);
  const token = login.ok ? login.token : "";

  const sessionsDouble = { events: async () => [], list: async () => [] } as unknown as SessionService;
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  attachWs(server, sessionsDouble, undefined, undefined, (req) => auth.authorized(req));
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  try {
    // no cookie → the handshake never completes
    const denied = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const deniedErr = await new Promise<Error>((res, rej) => {
      denied.on("error", res);
      denied.on("open", () => rej(new Error("upgrade should have been rejected")));
    });
    assert.match(deniedErr.message, /401/);

    // valid cookie → normal connection
    const allowed = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: `polyth_auth=${token}` } });
    await new Promise<void>((res, rej) => {
      allowed.on("open", () => res());
      allowed.on("error", rej);
    });
    allowed.close();
  } finally {
    server.close();
  }
});
