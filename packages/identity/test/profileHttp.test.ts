import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createIdentityHttpAdapter } from "../src/http.ts";
import { fixture } from "./fixtures.ts";

async function httpFixture(t: TestContext) {
  let adapter!: ReturnType<typeof createIdentityHttpAdapter>;
  const server = createServer((req, res) => {
    void adapter.handle(req, res).then((handled) => {
      if (!handled) { res.statusCode = 404; res.end("{}"); }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const f = fixture(t, { webauthn: { origin } });
  adapter = createIdentityHttpAdapter(f.identity, { origin, localOnly: true });
  t.after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  });

  const jar = new Map<string, string>();
  let csrf = "";
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin,
        cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; "),
        "content-type": "application/json",
        "x-polyth-csrf": csrf,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const setCookie of response.headers.getSetCookie()) {
      const pair = setCookie.split(";")[0]!;
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const value = await response.json() as Record<string, unknown>;
    if (typeof value.csrfToken === "string") csrf = value.csrfToken;
    return { response, value };
  };

  await request("/api/auth/status");
  const claim = f.identity.setup.issueClaim();
  assert.equal((await request("/api/auth/setup/claim", { claimToken: claim.token })).response.status, 200);
  const recovery = await request("/api/auth/setup/recovery", { claimToken: claim.token });
  assert.equal((await request("/api/auth/setup/complete", {
    claimToken: claim.token,
    name: "Owner",
    organizationName: "Local",
    login: "owner",
    password: "owner test passphrase",
    recoverySetId: recovery.value.setId,
    recoveryAcknowledged: true,
  })).response.status, 200);

  return { ...f, request };
}

test("profile rename keeps opaque identity and session while enforcing revision CAS", async t => {
  const f = await httpFixture(t);
  const before = await f.request("/api/auth/me");
  assert.equal(before.response.status, 200);
  assert.match(String(before.value.id), /^usr_/);
  assert.equal(before.value.displayName, "Owner");
  assert.equal(before.value.revision, 1);

  const renamed = await f.request("/api/auth/me", {
    name: "Max",
    expectedRevision: before.value.revision,
  });
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.value.id, before.value.id);
  assert.equal(renamed.value.displayName, "Max");
  assert.equal(renamed.value.revision, 2);

  const stale = await f.request("/api/auth/me", {
    name: "Stale",
    expectedRevision: before.value.revision,
  });
  assert.equal(stale.response.status, 409);
  assert.deepEqual(stale.value, { error: "conflict" });

  const after = await f.request("/api/auth/me");
  assert.equal(after.response.status, 200, "rename must not revoke the active session");
  assert.equal(after.value.id, before.value.id);
  assert.equal(after.value.displayName, "Max");
  assert.equal(after.value.revision, 2);
  assert.equal(f.control.all("SELECT 1 FROM auth_sessions").length, 1);
  assert.equal(f.control.all("SELECT 1 FROM audit_events WHERE action='identity.profile-renamed'").length, 1);
});
