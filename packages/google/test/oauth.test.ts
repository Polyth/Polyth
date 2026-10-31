import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import test from "node:test";
import { createGoogleConnector } from "../src/accounts.ts";
import { authorizationUrl, createOAuthFlows, createPkce } from "../src/oauth.ts";
import { scopesForRequest } from "../src/scopes.ts";
import { fakeGoogle, people, spaces, TEST_CLIENT_ID } from "./fakeGoogle.ts";

const get = (url: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
  const req = request(url, { agent: false }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
  });
  req.on("error", reject);
  req.end();
});

function setup(options: { listen?: boolean; now?: () => number } = {}) {
  const google = fakeGoogle();
  const tenancy = spaces();
  const connector = createGoogleConnector({ storage: tenancy.storage, vault: tenancy.vault, people: people({ spc_a: ["usr_1", "usr_2"] }), env: { clientId: TEST_CLIENT_ID, clientSecret: "desktop-secret" }, fetch: google.fetch });
  const flows = createOAuthFlows({ complete: (completion) => connector.completeAuthorization(completion), listen: options.listen ?? false, ...(options.now ? { now: options.now } : {}) });
  return { google, tenancy, connector, flows };
}

test("the authorization URL uses PKCE S256, a loopback redirect and requests only identity first", () => {
  const pkce = createPkce();
  assert.equal(createHash("sha256").update(pkce.verifier).digest("base64url"), pkce.challenge);
  const url = new URL(authorizationUrl({
    client: { clientId: TEST_CLIENT_ID },
    redirectUri: "http://127.0.0.1:5000/",
    state: "state-1234567890abcdef",
    challenge: pkce.challenge,
    scopes: scopesForRequest([], []),
    loginHint: "ada@example.com",
  }));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:5000/");
  assert.equal(url.searchParams.get("scope"), "email openid profile");
  assert.equal(url.searchParams.get("login_hint"), "ada@example.com");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.has("client_secret"), false);
});

test("the loopback listener completes exactly one valid callback and then closes", async (t) => {
  const { google, flows, connector } = setup({ listen: true });
  t.after(() => flows.dispose());
  const flow = await flows.start({ spaceId: "spc_a", userId: "usr_1", owner: "space", client: connector.oauthClient("spc_a"), scopes: scopesForRequest([], []) });
  assert.match(flow.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const approved = google.approve(flow.url);

  const forged = await get(`${flow.redirectUri}?state=wrong-state&code=${approved.code}`);
  assert.equal(forged.status, 400);
  assert.equal(flows.status("spc_a", "usr_1", flow.state).status, "pending");
  assert.equal((await get(`${flow.redirectUri}favicon.ico`)).status, 404);

  const callback = await get(`${flow.redirectUri}?state=${approved.state}&code=${approved.code}&scope=email`);
  assert.equal(callback.status, 200);
  assert.match(callback.body, /Google account connected/);
  assert.doesNotMatch(callback.body, new RegExp(approved.code));
  const done = flows.status("spc_a", "usr_1", flow.state);
  assert.equal(done.status, "completed");
  assert.equal(done.email, "ada@example.com");
  await assert.rejects(get(`${flow.redirectUri}?state=${approved.state}&code=${approved.code}`));
});

test("a pasted redirect URL completes the flow when the browser is on another device", async () => {
  const { google, flows, connector } = setup();
  const flow = await flows.start({ spaceId: "spc_a", userId: "usr_1", owner: "space", client: connector.oauthClient("spc_a"), scopes: scopesForRequest([], ["calendar.read"]) });
  const approved = google.approve(flow.url);
  const redirect = new URL(approved.redirectUri);

  await assert.rejects(flows.completeFromUrl("spc_a", "usr_1", "not a url"), { code: "invalid-request" });
  await assert.rejects(flows.completeFromUrl("spc_a", "usr_1", `http://127.0.0.1:1/?state=${approved.state}&code=${approved.code}`), { code: "invalid-request" });
  await assert.rejects(flows.completeFromUrl("spc_a", "usr_1", `${redirect.origin}/?state=other-state-value&code=${approved.code}`), { code: "not-found" });
  // Another Space or user cannot redeem or even observe this sign-in.
  await assert.rejects(flows.completeFromUrl("spc_b", "usr_1", `${redirect.origin}/?state=${approved.state}&code=${approved.code}`), { code: "not-found" });
  assert.throws(() => flows.status("spc_a", "usr_2", flow.state), { code: "not-found" });

  const done = await flows.completeFromUrl("spc_a", "usr_1", `${redirect.origin}/?state=${approved.state}&code=${approved.code}&scope=x`);
  assert.equal(done.status, "completed");
  assert.deepEqual(connector.listAccounts("spc_a", { kind: "space" }).map((account) => account.capabilities), [["calendar.read"]]);
  assert.deepEqual(connector.listAccounts("spc_b", { kind: "space" }), []);
});

test("PKCE binds the code to the flow that requested it", async () => {
  const { google, flows, connector } = setup();
  const first = await flows.start({ spaceId: "spc_a", userId: "usr_1", owner: "space", client: connector.oauthClient("spc_a"), scopes: ["openid"] });
  const second = await flows.start({ spaceId: "spc_a", userId: "usr_2", owner: "space", client: connector.oauthClient("spc_a"), scopes: ["openid"] });
  const stolen = google.approve(first.url);
  const redirect = new URL(second.redirectUri);
  // Replaying the first flow's code inside the second flow fails at Google.
  const result = await flows.completeFromUrl("spc_a", "usr_2", `${redirect.origin}/?state=${second.state}&code=${stolen.code}`);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "authorization-required");
  assert.deepEqual(connector.listAccounts("spc_a", { kind: "space" }), []);
});

test("denied consent, cancellation, supersession and expiry settle the flow", async () => {
  let now = 1_000_000;
  const { google, flows, connector } = setup({ now: () => now });
  const client = connector.oauthClient("spc_a");
  const denied = await flows.start({ spaceId: "spc_a", userId: "usr_1", owner: "space", client, scopes: ["openid"] });
  const redirect = new URL(denied.redirectUri);
  const view = await flows.completeFromUrl("spc_a", "usr_1", `${redirect.origin}/?state=${denied.state}&error=access_denied`);
  assert.equal(view.status, "cancelled");

  const superseded = await flows.start({ spaceId: "spc_a", userId: "usr_1", owner: "space", client, scopes: ["openid"] });
  const newer = await flows.start({ spaceId: "spc_a", userId: "usr_1", owner: "space", client, scopes: ["openid"] });
  assert.equal(flows.status("spc_a", "usr_1", superseded.state).status, "cancelled");
  assert.equal(flows.cancel("spc_a", "usr_1", newer.state).status, "cancelled");

  const expiring = await flows.start({ spaceId: "spc_a", userId: "usr_1", owner: "space", client, scopes: ["openid"] });
  google.approve(expiring.url);
  now += 11 * 60_000;
  const expired = flows.status("spc_a", "usr_1", expiring.state);
  assert.equal(expired.status, "failed");
  assert.equal(expired.error?.code, "cancelled");
  flows.dispose();
});

test("starting a flow without an OAuth client reports not-configured", async () => {
  const google = fakeGoogle();
  const tenancy = spaces();
  const connector = createGoogleConnector({ storage: tenancy.storage, vault: tenancy.vault, people: people(), fetch: google.fetch });
  assert.throws(() => connector.oauthClient("spc_a"), { code: "not-configured" });
});

test("a personal sign-in connects the account for the person who started it, and only they can finish it", async () => {
  const { google, flows, connector } = setup();
  const flow = await flows.start({ spaceId: "spc_a", userId: "usr_1", owner: "person", client: connector.oauthClient("spc_a"), scopes: scopesForRequest([], ["gmail.read"]) });
  const approved = google.approve(flow.url);
  const pasted = `${new URL(approved.redirectUri).origin}/?state=${approved.state}&code=${approved.code}`;
  await assert.rejects(flows.completeFromUrl("spc_a", "usr_2", pasted), { code: "not-found" });
  assert.equal((await flows.completeFromUrl("spc_a", "usr_1", pasted)).status, "completed");
  assert.deepEqual(connector.listAccounts("spc_a", { kind: "person", userId: "usr_1" }).map((account) => [account.email, account.enabled]), [["ada@example.com", true]]);
  assert.deepEqual(connector.listAccounts("spc_a", { kind: "person", userId: "usr_2" }), []);
  assert.deepEqual(connector.listAccounts("spc_a", { kind: "space" }), []);
});

test("a Google app without its client secret fails with a plain instruction, not invalid_request", async () => {
  const google = fakeGoogle();
  const tenancy = spaces();
  const connector = createGoogleConnector({ storage: tenancy.storage, vault: tenancy.vault, people: people({ spc_a: ["usr_1"] }), env: { clientId: TEST_CLIENT_ID }, fetch: google.fetch });
  const flows = createOAuthFlows({ complete: (completion) => connector.completeAuthorization(completion), listen: false });
  const flow = await flows.start({ spaceId: "spc_a", userId: "usr_1", owner: "person", client: connector.oauthClient("spc_a"), scopes: ["openid"] });
  const approved = google.approve(flow.url);
  const result = await flows.completeFromUrl("spc_a", "usr_1", `${new URL(approved.redirectUri).origin}/?state=${approved.state}&code=${approved.code}`);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "not-configured");
  assert.match(result.error?.message ?? "", /client secret is missing/);
  assert.doesNotMatch(result.error?.message ?? "", /invalid_request/);
});
