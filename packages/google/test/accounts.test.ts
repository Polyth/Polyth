import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createGoogleConnector, type GoogleAccountOwner } from "../src/accounts.ts";
import { createOAuthFlows, type OAuthFlowOwner } from "../src/oauth.ts";
import { BUILTIN_CLIENT_CAPABILITIES, GOOGLE_CAPABILITIES, grantedCapabilities, OWN_CLIENT_CAPABILITIES, scopesForRequest, type GoogleCapability } from "../src/scopes.ts";
import { fakeGoogle, people, spaces, TEST_CLIENT_ID } from "./fakeGoogle.ts";

const SCOPE = "https://www.googleapis.com/auth/";
const SPACE: GoogleAccountOwner = { kind: "space" };
const person = (userId: string): GoogleAccountOwner => ({ kind: "person", userId });

function setup(options: { env?: boolean; now?: () => number; grantedScopes?: (requested: string[]) => string[] } = {}) {
  const google = fakeGoogle(options.grantedScopes ? { grantedScopes: options.grantedScopes } : {});
  const tenancy = spaces();
  const folks = people({ spc_a: ["usr_1", "usr_2"], spc_b: ["usr_1"] });
  const connector = createGoogleConnector({
    storage: tenancy.storage,
    vault: tenancy.vault,
    people: folks,
    ...(options.env === false ? {} : { env: { clientId: TEST_CLIENT_ID, clientSecret: "desktop-secret" } }),
    fetch: google.fetch,
    ...(options.now ? { now: options.now } : {}),
  });
  const flows = createOAuthFlows({ complete: (completion) => connector.completeAuthorization(completion), listen: false });
  const signIn = async (spaceId: string, input: { owner?: OAuthFlowOwner; userId?: string; capabilities?: GoogleCapability[]; accountId?: string } = {}) => {
    const userId = input.userId ?? "usr_1";
    const flowOwner = input.owner ?? "space";
    const owner = flowOwner === "space" ? SPACE : person(userId);
    const account = input.accountId ? connector.account(spaceId, owner, input.accountId) : undefined;
    const flow = await flows.start({ spaceId, userId, owner: flowOwner, client: connector.oauthClient(spaceId), scopes: scopesForRequest(account?.scopes ?? [], input.capabilities ?? []), ...(input.accountId ? { accountId: input.accountId } : {}) });
    const approved = google.approve(flow.url);
    return flows.completeFromUrl(spaceId, userId, `${new URL(approved.redirectUri).origin}/?state=${approved.state}&code=${approved.code}`);
  };
  const connect = async (spaceId: string, capabilities: GoogleCapability[] = [], accountId?: string, input: { owner?: OAuthFlowOwner; userId?: string } = {}) => {
    const result = await signIn(spaceId, { ...input, capabilities, ...(accountId ? { accountId } : {}) });
    if (result.status !== "completed") throw new Error(result.error?.message ?? result.status);
    return result;
  };
  const connectPersonal = (spaceId: string, userId: string, capabilities: GoogleCapability[] = [], accountId?: string) =>
    connect(spaceId, capabilities, accountId, { owner: "person", userId });
  return { google, tenancy, folks, connector, connect, connectPersonal, signIn };
}

const filesUnder = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));

const refusal = (code: string, pattern: RegExp, foreign: RegExp = /@/) => (error: { code?: string; message?: string }) => {
  assert.equal(error.code, code, error.message);
  assert.match(error.message ?? "", pattern);
  assert.doesNotMatch(error.message ?? "", foreign, "the error names no account the actor cannot use");
  return true;
};

test("a service account stores public metadata in the Space and the refresh token only in the Space vault", async () => {
  const { tenancy, folks, connector, connect } = setup();
  await connect("spc_a");
  const [account] = connector.listAccounts("spc_a", SPACE);
  assert.equal(account?.email, "ada@example.com");
  assert.equal(account?.status, "connected");
  assert.deepEqual(account?.capabilities, []);
  const stored = filesUnder(tenancy.storage("spc_a").root).join("\n");
  assert.doesNotMatch(stored, /refresh-|access-|desktop-secret/);
  const secret = tenancy.vaults.get("spc_a")!.values.get("google:spc_a:account:1001");
  assert.match(secret ?? "", /"refreshToken":"refresh-/);
  assert.equal(JSON.stringify(connector.listAccounts("spc_a", SPACE)).includes("refresh-"), false);
  assert.deepEqual(connector.listAccounts("spc_a", person("usr_1")), [], "a service account is nobody's personal account");
  assert.equal(folks.vaults.size, 0);
});

test("a personal account lives with the person, outside every Space, and is turned on where it was connected", async () => {
  const { tenancy, folks, connector, connectPersonal } = setup();
  await connectPersonal("spc_a", "usr_1", ["gmail.read"]);
  const [account] = connector.listAccounts("spc_a", person("usr_1"));
  assert.equal(account?.email, "ada@example.com");
  assert.equal(account?.enabled, true);
  assert.equal(connector.listAccounts("spc_b", person("usr_1"))[0]?.enabled, false, "another Space does not silently get it");
  assert.deepEqual(connector.listAccounts("spc_a", SPACE), []);
  assert.deepEqual(connector.listAccounts("spc_a", person("usr_2")), [], "nobody else sees it");
  // Nothing in the Space: no metadata, no secret.
  assert.equal(filesUnder(tenancy.storage("spc_a").root).some((text) => text.includes("ada@example.com")), false);
  assert.equal(tenancy.vaults.get("spc_a")?.values.size ?? 0, 0);
  const personFiles = filesUnder(folks.roots.get("usr_1")!).join("\n");
  assert.match(personFiles, /ada@example\.com/);
  assert.doesNotMatch(personFiles, /refresh-|access-|desktop-secret/);
  assert.match(folks.vaults.get("usr_1")!.values.get("account:1001") ?? "", /"refreshToken":"refresh-/);
});

test("agent calls use only the acting person's enabled accounts", async () => {
  const { connector, connectPersonal } = setup();
  await connectPersonal("spc_a", "usr_1", ["gmail.read"]);
  const own = connector.resolveAccount("spc_a", "usr_1", "gmail.read");
  assert.deepEqual(own.owner, person("usr_1"));
  assert.equal(own.account.email, "ada@example.com");

  // Member B, system work, a non-member and a foreign Space never reach A's account.
  assert.throws(() => connector.resolveAccount("spc_a", "usr_2", "gmail.read"), refusal("not-connected", /Connect your Google account in Settings → Google/));
  assert.throws(() => connector.resolveAccount("spc_a", "usr_2", "gmail.read", "ada@example.com"), refusal("not-connected", /Connect your Google account/, /ada@example\.com/));
  assert.throws(() => connector.resolveAccount("spc_a", undefined, "gmail.read"), refusal("not-connected", /does not let agents use its Google service accounts/));
  assert.throws(() => connector.resolveAccount("spc_a", "usr_3", "gmail.read"), refusal("permission-denied", /not a member of this Space/));
  assert.throws(() => connector.resolveAccount("spc_c", "usr_1", "gmail.read"), refusal("permission-denied", /not a member of this Space/));
  assert.throws(() => connector.setEnabled("spc_c", "usr_1", own.account.id, true), { code: "permission-denied" });

  // A Space the person belongs to but has not turned the account on in.
  assert.throws(() => connector.resolveAccount("spc_b", "usr_1", "gmail.read"), refusal("not-connected", /turn it on for this Space/));
  assert.equal(connector.setEnabled("spc_b", "usr_1", own.account.id, true).enabled, true);
  assert.equal(connector.resolveAccount("spc_b", "usr_1", "gmail.read").account.email, "ada@example.com");
  // Turning it off in A leaves B alone.
  assert.equal(connector.setEnabled("spc_a", "usr_1", own.account.id, false).enabled, false);
  assert.throws(() => connector.resolveAccount("spc_a", "usr_1", "gmail.read"), { code: "not-connected" });
  assert.equal(connector.resolveAccount("spc_b", "usr_1", "gmail.read").account.email, "ada@example.com");
  // Another person cannot toggle an account that is not theirs.
  assert.throws(() => connector.setEnabled("spc_a", "usr_2", own.account.id, true), { code: "not-found" });
});

test("service accounts serve agents only under the Space policy, and a person's own account always wins", async () => {
  const { google, connector, connect, connectPersonal } = setup();
  google.setUser({ sub: "3003", email: "team@example.com", name: "Team" });
  await connect("spc_a", ["gmail.read"]);
  assert.deepEqual(connector.policy("spc_a"), { agentsMayUseService: false }, "off by default");
  assert.throws(() => connector.resolveAccount("spc_a", "usr_2", "gmail.read"), refusal("not-connected", /Connect your Google account/));
  assert.throws(() => connector.resolveAccount("spc_a", undefined, "gmail.read"), refusal("not-connected", /service accounts/));

  connector.setPolicy("spc_a", { agentsMayUseService: true });
  const member = connector.resolveAccount("spc_a", "usr_2", "gmail.read");
  assert.deepEqual([member.owner, member.account.email], [SPACE, "team@example.com"]);
  const system = connector.resolveAccount("spc_a", undefined, "gmail.read");
  assert.deepEqual([system.owner, system.account.email], [SPACE, "team@example.com"]);
  // Policy is per Space.
  assert.throws(() => connector.resolveAccount("spc_b", undefined, "gmail.read"), { code: "not-connected" });

  google.setUser({ sub: "1001", email: "ada@example.com" });
  await connectPersonal("spc_a", "usr_1", ["drive.read"]);
  const own = connector.resolveAccount("spc_a", "usr_1", "drive.read");
  assert.deepEqual(own.owner, person("usr_1"));
  // The service account is not a candidate for someone who has their own.
  assert.throws(() => connector.resolveAccount("spc_a", "usr_1", "gmail.read"), refusal("insufficient-scope", /ada@example\.com has not|No Google account you can use here/, /team@example\.com/));
  assert.throws(() => connector.resolveAccount("spc_a", "usr_1", "gmail.read", "team@example.com"), refusal("not-connected", /Available: ada@example\.com/, /team@example\.com/));
  assert.throws(() => connector.setPolicy("spc_a", { agentsMayUseService: "yes" as never }), { code: "invalid-request" });
});

test("members see service accounts only as a label", async () => {
  const { google, connector, connect } = setup();
  google.setUser({ sub: "3003", email: "team@example.com", name: "Team" });
  await connect("spc_a", ["gmail.read"]);
  const labels = connector.serviceLabels("spc_a");
  assert.deepEqual(labels, [{ label: "Team", status: "connected", capabilities: ["gmail.read"] }]);
  assert.doesNotMatch(JSON.stringify(labels), /team@example\.com|3003/);
});

test("access tokens are cached per owner: one owner's disconnect never touches another's", async () => {
  const { google, connector, connect, connectPersonal } = setup();
  // The same Google account connected three times: as a service account and by two people.
  await connect("spc_a", ["drive.read"]);
  await connectPersonal("spc_a", "usr_1", ["drive.read"]);
  await connectPersonal("spc_a", "usr_2", ["drive.read"]);
  const about = { url: "https://www.googleapis.com/drive/v3/about" };
  const tokenRequests = () => google.log.filter((line) => line.endsWith("/token")).length;
  const before = tokenRequests();
  await connector.client("spc_a", person("usr_1"), "1001").json(about);
  await connector.client("spc_a", person("usr_2"), "1001").json(about);
  await connector.client("spc_a", SPACE, "1001").json(about);
  assert.equal(tokenRequests(), before, "each owner reuses its own exchanged token");

  assert.deepEqual(await connector.disconnect("spc_a", person("usr_1"), "1001"), { removed: true, revoked: true });
  await assert.rejects(connector.client("spc_a", person("usr_1"), "1001").json(about), { code: "not-connected" });
  assert.deepEqual(await connector.client("spc_a", person("usr_2"), "1001").json(about), { path: "/drive/v3/about", user: "ada@example.com" });
  assert.deepEqual(await connector.client("spc_a", SPACE, "1001").json(about), { path: "/drive/v3/about", user: "ada@example.com" });
  assert.equal(tokenRequests(), before);
  assert.equal(connector.listAccounts("spc_a", SPACE).length, 1);
  assert.equal(connector.listAccounts("spc_a", person("usr_2")).length, 1);
});

test("reconnecting after a disconnect turns the account on only where it was connected again", async () => {
  const { connector, connectPersonal } = setup();
  await connectPersonal("spc_a", "usr_1", ["gmail.read"]);
  connector.setEnabled("spc_b", "usr_1", "1001", true);
  await connector.disconnect("spc_a", person("usr_1"), "1001");
  await connectPersonal("spc_a", "usr_1", ["gmail.read"]);
  assert.equal(connector.listAccounts("spc_a", person("usr_1"))[0]?.enabled, true);
  assert.equal(connector.listAccounts("spc_b", person("usr_1"))[0]?.enabled, false, "stale enablement in another Space does not come back");
});

test("a person who is not a member cannot connect a personal account through the Space", async () => {
  const { folks, connector, signIn } = setup();
  const result = await signIn("spc_a", { owner: "person", userId: "usr_3" });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "permission-denied");
  assert.deepEqual(connector.listAccounts("spc_a", person("usr_3")), []);
  assert.equal(folks.vaults.get("usr_3")?.values.size ?? 0, 0);
});

test("a personal account issued through another OAuth client must be reconnected in a Space using a different one", async () => {
  const { connector, connectPersonal } = setup();
  await connectPersonal("spc_a", "usr_1", ["gmail.read"]);
  connector.setEnabled("spc_b", "usr_1", "1001", true);
  connector.setClientConfig("spc_b", { clientId: "999-other.apps.googleusercontent.com", clientSecret: "other-secret" });
  assert.equal(connector.listAccounts("spc_b", person("usr_1"))[0]?.status, "reauthorization-required");
  assert.equal(connector.listAccounts("spc_a", person("usr_1"))[0]?.status, "connected");
  await assert.rejects(connector.client("spc_b", person("usr_1"), "1001").json({ url: "https://gmail.googleapis.com/gmail/v1/users/me/profile" }), (error: { code?: string; message?: string }) =>
    error.code === "authorization-revoked" && /different Google OAuth client/.test(error.message ?? ""));
});

test("tools are offered where someone could use them: an OAuth client, or a service account's grants", async () => {
  const none = setup({ env: false });
  assert.deepEqual([...none.connector.toolCapabilities("spc_a")], []);
  none.connector.setClientConfig("spc_a", { clientId: TEST_CLIENT_ID, clientSecret: "desktop-secret" });
  assert.deepEqual([...none.connector.toolCapabilities("spc_a")].sort(), [...GOOGLE_CAPABILITIES].sort());
  assert.deepEqual([...none.connector.toolCapabilities("spc_b")], []);
  await none.connect("spc_a", ["drive.read"]);
  none.connector.clearClientConfig("spc_a");
  assert.deepEqual([...none.connector.toolCapabilities("spc_a")], ["drive.read"]);
});

test("incremental authorization keeps earlier scopes and only adds what the user granted", async () => {
  // Granular consent: the user unticks Drive write on the consent screen.
  const { connector, connect } = setup({ grantedScopes: (requested) => requested.filter((scope) => scope !== `${SCOPE}drive`) });
  await connect("spc_a", ["gmail.read"]);
  const first = connector.listAccounts("spc_a", SPACE)[0]!;
  assert.deepEqual(first.capabilities, ["gmail.read"]);
  await connect("spc_a", ["calendar.read", "calendar.write", "drive.write"], first.id);
  const next = connector.listAccounts("spc_a", SPACE)[0]!;
  assert.deepEqual(next.capabilities, ["gmail.read", "calendar.read", "calendar.write"]);
  assert.equal(next.connectedAt, first.connectedAt);
  assert.equal(connector.listAccounts("spc_a", SPACE).length, 1);
});

test("a personal reauthorization keeps the owner's per-Space choice", async () => {
  const { connector, connectPersonal } = setup();
  await connectPersonal("spc_a", "usr_1", ["gmail.read"]);
  connector.setEnabled("spc_a", "usr_1", "1001", false);
  await connectPersonal("spc_a", "usr_1", ["drive.read"], "1001");
  const [account] = connector.listAccounts("spc_a", person("usr_1"));
  assert.deepEqual([account?.capabilities, account?.enabled], [["gmail.read", "drive.read"], false]);
});

test("access tokens refresh transparently, once, when expired", async () => {
  let now = 1_000_000;
  const { google, connector, connect } = setup({ now: () => now });
  await connect("spc_a", ["drive.read"]);
  const account = connector.listAccounts("spc_a", SPACE)[0]!;
  const client = connector.client("spc_a", SPACE, account.id);
  assert.deepEqual(await client.json({ url: "https://www.googleapis.com/drive/v3/about" }), { path: "/drive/v3/about", user: "ada@example.com" });
  assert.equal(google.log.filter((line) => line.endsWith("/token")).length, 1, "the exchanged access token is reused");
  now += 3_600_000;
  const results = await Promise.all([1, 2, 3].map(() => client.json({ url: "https://www.googleapis.com/drive/v3/about" })));
  assert.equal(results.length, 3);
  assert.equal(google.log.filter((line) => line.endsWith("/token")).length, 2, "concurrent callers share one refresh");
});

test("a personal token refreshes with the Space's client and stays in the person's vault", async () => {
  let now = 1_000_000;
  const { google, folks, tenancy, connector, connectPersonal } = setup({ now: () => now });
  await connectPersonal("spc_a", "usr_1", ["drive.read"]);
  now += 3_600_000;
  await connector.client("spc_a", person("usr_1"), "1001").json({ url: "https://www.googleapis.com/drive/v3/about" });
  assert.equal(google.log.filter((line) => line.endsWith("/token")).length, 2);
  google.refreshTokens.clear();
  now += 3_600_000;
  await assert.rejects(connector.client("spc_a", person("usr_1"), "1001").json({ url: "https://www.googleapis.com/drive/v3/about" }), { code: "authorization-revoked" });
  assert.equal(connector.listAccounts("spc_a", person("usr_1"))[0]!.status, "reauthorization-required");
  assert.equal(folks.vaults.get("usr_1")!.values.size, 0);
  assert.equal(tenancy.vaults.get("spc_a")?.values.size ?? 0, 0);
});

test("a revoked refresh token marks the account for reauthorization and drops the secret", async () => {
  let now = 1_000_000;
  const { google, tenancy, connector, connect } = setup({ now: () => now });
  await connect("spc_a", ["gmail.read"]);
  const account = connector.listAccounts("spc_a", SPACE)[0]!;
  google.refreshTokens.clear();
  now += 3_600_000;
  await assert.rejects(connector.client("spc_a", SPACE, account.id).json({ url: "https://gmail.googleapis.com/gmail/v1/users/me/profile" }), { code: "authorization-revoked" });
  assert.equal(connector.listAccounts("spc_a", SPACE)[0]!.status, "reauthorization-required");
  assert.equal(tenancy.vaults.get("spc_a")!.values.has(`google:spc_a:account:${account.id}`), false);
  await assert.rejects(connector.client("spc_a", SPACE, account.id).json({ url: "https://gmail.googleapis.com/gmail/v1/users/me/profile" }), { code: "authorization-revoked" });
  // Reconnecting restores the account.
  await connect("spc_a", [], account.id);
  assert.equal(connector.listAccounts("spc_a", SPACE)[0]!.status, "connected");
});

test("a rejected OAuth client is reported as not-configured, not as a revoked account", async () => {
  let now = 1_000_000;
  const { google, connector, connect } = setup({ now: () => now });
  await connect("spc_a", ["gmail.read"]);
  google.failRefresh("invalid_client");
  now += 3_600_000;
  const account = connector.listAccounts("spc_a", SPACE)[0]!;
  await assert.rejects(connector.client("spc_a", SPACE, account.id).json({ url: "https://gmail.googleapis.com/gmail/v1/users/me/profile" }), { code: "not-configured" });
  assert.equal(connector.listAccounts("spc_a", SPACE)[0]!.status, "connected");
});

test("disconnect revokes at Google and removes all local state", async () => {
  const { google, tenancy, connector, connect } = setup({ env: false });
  connector.setClientConfig("spc_a", { clientId: TEST_CLIENT_ID, clientSecret: "desktop-secret" });
  await connect("spc_a", ["drive.read"]);
  const account = connector.listAccounts("spc_a", SPACE)[0]!;
  connector.clearClientConfig("spc_a");
  assert.deepEqual([...connector.toolCapabilities("spc_a")], ["drive.read"]);
  assert.deepEqual(await connector.disconnect("spc_a", SPACE, account.id), { removed: true, revoked: true });
  assert.equal(google.refreshTokens.size, 0);
  assert.deepEqual(connector.listAccounts("spc_a", SPACE), []);
  assert.equal(tenancy.vaults.get("spc_a")!.values.size, 0);
  assert.equal(connector.toolCapabilities("spc_a").size, 0);
  await assert.rejects(connector.client("spc_a", SPACE, account.id).json({ url: "https://www.googleapis.com/drive/v3/about" }), { code: "not-connected" });
  assert.deepEqual(await connector.disconnect("spc_a", SPACE, account.id), { removed: false, revoked: false });
});

test("disconnect still removes the account when Google cannot confirm the revocation", async () => {
  const { google, connector, connect } = setup();
  await connect("spc_a");
  google.failRevoke(503);
  const account = connector.listAccounts("spc_a", SPACE)[0]!;
  assert.deepEqual(await connector.disconnect("spc_a", SPACE, account.id), { removed: true, revoked: false });
  assert.deepEqual(connector.listAccounts("spc_a", SPACE), []);
});

test("service accounts are Space-scoped and agent account selection is unambiguous", async () => {
  const { google, connector, connect } = setup();
  await connect("spc_a", ["gmail.read", "gmail.write"]);
  connector.setPolicy("spc_a", { agentsMayUseService: true });
  connector.setPolicy("spc_b", { agentsMayUseService: true });
  assert.throws(() => connector.resolveAccount("spc_b", undefined, "gmail.read"), { code: "not-connected" });
  assert.equal(connector.resolveAccount("spc_a", undefined, "gmail.read").account.email, "ada@example.com");
  assert.throws(() => connector.resolveAccount("spc_a", undefined, "drive.read"), { code: "insufficient-scope" });

  google.setUser({ sub: "2002", email: "bob@example.com" });
  await connect("spc_a", ["gmail.read"]);
  assert.throws(() => connector.resolveAccount("spc_a", undefined, "gmail.read"), (error: { code?: string; message?: string }) =>
    error.code === "account-ambiguous" && /ada@example\.com/.test(error.message ?? "") && /bob@example\.com/.test(error.message ?? ""));
  assert.equal(connector.resolveAccount("spc_a", undefined, "gmail.write").account.email, "ada@example.com");
  assert.equal(connector.resolveAccount("spc_a", undefined, "gmail.read", "BOB@example.com").account.id, "2002");
  assert.throws(() => connector.resolveAccount("spc_a", undefined, "gmail.write", "bob@example.com"), { code: "insufficient-scope" });
  assert.throws(() => connector.resolveAccount("spc_a", undefined, "gmail.read", "eve@example.com"), { code: "not-connected" });
  // An account id from another Space is unknown here.
  assert.equal(connector.account("spc_b", SPACE, "1001"), undefined);
});

test("the OAuth client comes from the Space or the server environment; secrets stay in the vault", () => {
  const { tenancy, connector } = setup({ env: false });
  assert.deepEqual(connector.clientConfig("spc_a"), { configured: false, hasSecret: false, capabilities: [] });
  assert.throws(() => connector.setClientConfig("spc_a", { clientId: "not-a-client" }), { code: "invalid-request" });
  // Google refuses a Desktop app client without its secret, so it is required.
  assert.throws(() => connector.setClientConfig("spc_a", { clientId: TEST_CLIENT_ID }), { code: "invalid-request", message: /client secret/ });
  assert.equal(connector.clientConfig("spc_a").configured, false);
  const saved = connector.setClientConfig("spc_a", { clientId: TEST_CLIENT_ID, clientSecret: "GOCSPX-secret" });
  assert.deepEqual(saved, { configured: true, source: "space", clientId: TEST_CLIENT_ID, hasSecret: true, capabilities: [...OWN_CLIENT_CAPABILITIES] });
  // Saving the same client again keeps the stored secret; another client needs its own.
  assert.equal(connector.setClientConfig("spc_a", { clientId: TEST_CLIENT_ID }).hasSecret, true);
  assert.throws(() => connector.setClientConfig("spc_a", { clientId: "456-own-client.apps.googleusercontent.com" }), { code: "invalid-request" });
  assert.equal(connector.clientConfig("spc_a").clientId, TEST_CLIENT_ID);
  assert.doesNotMatch(filesUnder(tenancy.storage("spc_a").root).join("\n"), /GOCSPX/);
  assert.deepEqual(connector.oauthClient("spc_a"), { clientId: TEST_CLIENT_ID, clientSecret: "GOCSPX-secret" });
  assert.equal(connector.clientConfig("spc_b").configured, false);
  assert.deepEqual(connector.clearClientConfig("spc_a"), { configured: false, hasSecret: false, capabilities: [] });
  assert.equal(tenancy.vaults.get("spc_a")!.values.size, 0);

  const withEnv = setup();
  assert.deepEqual(withEnv.connector.clientConfig("spc_a"), { configured: true, source: "environment", clientId: TEST_CLIENT_ID, hasSecret: true, capabilities: [...OWN_CLIENT_CAPABILITIES] });
});

test("Polyth's built-in app is the fallback client and asks only for its own scopes", () => {
  const tenancy = spaces();
  const connector = createGoogleConnector({ storage: tenancy.storage, vault: tenancy.vault, people: people({ spc_a: ["usr_1"], spc_b: ["usr_1"] }), env: { clientId: TEST_CLIENT_ID, clientSecret: "builtin-secret", builtin: true } });
  assert.deepEqual(connector.clientConfig("spc_a"), { configured: true, source: "builtin", clientId: TEST_CLIENT_ID, hasSecret: true, capabilities: [...BUILTIN_CLIENT_CAPABILITIES] });
  // A Space's own client still wins.
  assert.equal(connector.setClientConfig("spc_a", { clientId: "456-own-client.apps.googleusercontent.com", clientSecret: "own-secret" }).source, "space");
  assert.equal(connector.clientConfig("spc_b").source, "builtin");

  // One consent covers the whole built-in set; nothing restricted rides along
  // from a grant made through another client.
  const granted = [`${SCOPE}gmail.modify`, `${SCOPE}drive`, `${SCOPE}calendar.readonly`, "openid"];
  assert.deepEqual(scopesForRequest(granted, BUILTIN_CLIENT_CAPABILITIES, BUILTIN_CLIENT_CAPABILITIES), [
    "email",
    ...["calendar.events", "calendar.readonly", "drive.file", "gmail.send"].map((scope) => `${SCOPE}${scope}`),
    "openid", "profile",
  ]);
  assert.ok(scopesForRequest(granted, []).includes(`${SCOPE}gmail.modify`), "without a limit every granted scope is kept");
  assert.deepEqual(grantedCapabilities([`${SCOPE}gmail.send`, `${SCOPE}drive.file`]), ["gmail.send", "drive.file"]);
  assert.deepEqual(grantedCapabilities([`${SCOPE}gmail.modify`, `${SCOPE}drive`]), ["gmail.read", "gmail.send", "gmail.write", "drive.file", "drive.read", "drive.write"]);
});

test("reconnecting an account must sign in as that same Google account", async () => {
  const { google, connector, connect } = setup();
  await connect("spc_a", ["gmail.read"]);
  google.setUser({ sub: "2002", email: "bob@example.com" });
  await assert.rejects(connect("spc_a", ["drive.read"], "1001"), /signed in to Google as bob@example\.com, but this was a request for ada@example\.com/);
  assert.deepEqual(connector.listAccounts("spc_a", SPACE).map((account) => [account.email, account.capabilities]), [["ada@example.com", ["gmail.read"]]]);
});

test("a refresh still in flight when the account is disconnected cannot bring it back", async () => {
  let now = 1_000_000;
  const { google, tenancy, connector, connect } = setup({ now: () => now });
  await connect("spc_a", ["drive.read"]);
  const account = connector.listAccounts("spc_a", SPACE)[0]!;
  now += 3_600_000;
  const release = google.holdRefresh();
  const call = connector.client("spc_a", SPACE, account.id).json({ url: "https://www.googleapis.com/drive/v3/about" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const disconnect = connector.disconnect("spc_a", SPACE, account.id);
  release();
  await disconnect;
  await assert.rejects(call, { code: "not-connected" });
  assert.equal(tenancy.vaults.get("spc_a")!.values.size, 0);
  assert.deepEqual(connector.listAccounts("spc_a", SPACE), []);
});
