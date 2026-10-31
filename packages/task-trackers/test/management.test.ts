import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RouteRequest,
  SessionProjection,
  SpaceContext,
  SpaceRole,
  SpaceStorage,
} from "@polyth/contracts";
import {
  normalizeJiraSite,
  normalizePreferences,
  trelloAuthorizeUrl,
} from "@polyth/task-trackers";
import { createTaskTrackerManagement, type TaskTrackerVault } from "../src/management.ts";
import { taskTrackerRoutes } from "../src/serverEntry.ts";
import { fakePeople } from "./peopleHost.ts";

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fixture(options: { vault?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tt-manage-"));
  const storage: SpaceStorage = {
    root,
    packageDir: (id) => join(root, "packages", id),
    path: (relative) => join(root, relative),
  };
  const secrets = new Map<string, string>();
  const vault: TaskTrackerVault = {
    putOpaque: (key, value) => { secrets.set(key, value); },
    getOpaque: (key) => secrets.get(key) ?? null,
    deleteOpaque: (key) => { secrets.delete(key); },
  };
  const requests: string[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
    if (url.pathname === "/rest/api/3/myself") {
      if (!auth.includes(Buffer.from("dev@acme.test:good-token").toString("base64"))) {
        return response({ errorMessages: ["no"] }, 401);
      }
      return response({ displayName: "Ada Dev", emailAddress: "dev@acme.test", avatarUrls: { "48x48": "https://a/ada.png" } });
    }
    if (url.pathname === "/1/members/me") {
      if (url.searchParams.get("token") !== "t".repeat(64)) return response({}, 401);
      return response({ fullName: "Theo Board", username: "theo" });
    }
    if (url.pathname === "/rest/api/3/project/search") return response({ values: [{ id: "1", key: "ACME", name: "Acme" }] });
    return response([]);
  }) as typeof fetch;
  const space = (role: SpaceRole = "admin"): SpaceContext => ({
    spaceId: "space-a",
    spaceSlug: "a",
    userId: "u",
    role,
    deployment: "local-trusted",
    storageDir: root,
  } as SpaceContext);
  const management = createTaskTrackerManagement({
    storage: () => storage,
    vault: () => options.vault === false ? undefined : vault,
    env: {},
    fetchImpl,
  });
  return {
    management,
    secrets,
    requests,
    space,
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("site, preference, and Trello authorize helpers normalize user input", () => {
  assert.equal(normalizeJiraSite("acme"), "https://acme.atlassian.net");
  assert.equal(normalizeJiraSite("acme.atlassian.net/jira/your-work"), "https://acme.atlassian.net");
  assert.equal(normalizeJiraSite("https://jira.example.com/"), "https://jira.example.com");
  assert.equal(normalizeJiraSite("http://jira.example.com"), null);
  assert.equal(normalizeJiraSite("https://user:pw@acme.atlassian.net"), null);
  assert.equal(normalizeJiraSite(""), null);

  const prefs = normalizePreferences({ providers: { jira: false, extra: true }, demo: "yes", widgets: { "task-trackers.overview": false } });
  assert.deepEqual(prefs.providers, { jira: false, trello: true, linear: true });
  assert.equal(prefs.demo, true, "invalid values fall back to defaults");
  assert.equal(prefs.widgets["task-trackers.overview"], false);
  assert.equal(prefs.widgets["task-trackers.board"], true);

  const url = new URL(trelloAuthorizeUrl("abc123", "https://polyth.test"));
  assert.equal(url.origin, "https://trello.com");
  assert.equal(url.searchParams.get("callback_method"), "postMessage");
  assert.equal(url.searchParams.get("return_url"), "https://polyth.test");
  assert.equal(url.searchParams.get("scope"), "read,write");
});

test("connecting Jira verifies the account and keeps the token only in the vault", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  await assert.rejects(
    f.management.connectJira(f.space(), { site: "acme", email: "dev@acme.test", apiToken: "bad-token" }),
    (error: Error & { code?: string }) => error.code === "invalid-input" && /rejected/.test(error.message),
  );
  assert.equal(f.secrets.size, 0, "a rejected token is never stored");

  const state = await f.management.connectJira(f.space(), { site: "acme", email: "dev@acme.test", apiToken: "good-token" });
  assert.ok(f.requests.includes("GET https://acme.atlassian.net/rest/api/3/myself"));
  assert.equal(state.connections[0]?.account.name, "Ada Dev");
  assert.equal(state.connections[0]?.account.site, "https://acme.atlassian.net");
  const jira = state.providers.find((item) => item.provider === "jira");
  assert.equal(jira?.source, "connection");
  assert.equal(jira?.mode, "live");
  assert.equal(jira?.account?.name, "Ada Dev");

  assert.doesNotMatch(JSON.stringify(state), /good-token/);
  const persisted = readFileSync(join(f.root, "packages", "task-trackers", "state.json"), "utf8");
  assert.doesNotMatch(persisted, /good-token/, "public metadata never contains the credential");
  assert.match(f.secrets.get("task-trackers:space-a:jira") ?? "", /good-token/);

  const projects = await f.management.trackers(f.space("member")).listProjects("jira");
  assert.equal(projects[0]?.key, "ACME", "the stored connection drives live requests");

  const after = f.management.disconnect(f.space(), "jira");
  assert.equal(after.connections.length, 0);
  assert.equal(f.secrets.size, 0);
  assert.equal(after.providers.find((item) => item.provider === "jira")?.source, "demo");
});

test("Trello connects with a key and authorized token", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  await assert.rejects(
    f.management.connectTrello(f.space(), { apiKey: "not a key!", token: "t".repeat(64) }),
    /letters and digits/,
  );
  const state = await f.management.connectTrello(f.space(), { apiKey: "abc123", token: "t".repeat(64) });
  assert.equal(state.connections[0]?.method, "authorize");
  assert.equal(state.connections[0]?.account.email, "@theo");
  const verified = await f.management.verify(f.space(), "trello");
  assert.ok((verified.connections[0]?.verifiedAt ?? 0) >= (state.connections[0]?.verifiedAt ?? 0));
});

test("preferences turn providers and the sandbox off, and only admins may change them", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  assert.throws(
    () => f.management.updatePreferences(f.space("member"), { demo: false }),
    (error: Error & { code?: string }) => error.code === "forbidden",
  );
  assert.equal(f.management.state(f.space("member")).canManage, false);

  f.management.updatePreferences(f.space(), { providers: { trello: false }, demo: false });
  const state = f.management.state(f.space());
  assert.equal(state.preferences.providers.trello, false);
  const trello = state.providers.find((item) => item.provider === "trello");
  assert.equal(trello?.enabled, false);
  assert.equal(state.providers.find((item) => item.provider === "jira")?.source, "none");
  await assert.rejects(f.management.trackers(f.space()).listBoards("trello"), /turned off/);
  await assert.rejects(f.management.trackers(f.space()).listBoards("jira"), /not connected/);
});

test("connections report a missing Credential Vault instead of storing elsewhere", async (t) => {
  const f = fixture({ vault: false });
  t.after(f.cleanup);
  assert.equal(f.management.state(f.space()).vaultAvailable, false);
  await assert.rejects(
    f.management.connectJira(f.space(), { site: "acme", email: "dev@acme.test", apiToken: "good-token" }),
    /Credential Vault is unavailable/,
  );
  assert.equal(f.requests.length, 0, "no credential leaves Polyth when it cannot be stored");
});

test("routes expose settings and enforce agent handoff and status-update switches", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const sends: string[] = [];
  const routes = taskTrackerRoutes({
    trackers: (request) => f.management.trackers(request.space),
    management: f.management,
    snapshot: async (sessionId): Promise<SessionProjection> => ({
      id: sessionId, projectId: "p", title: "S", status: "idle", createdAt: 1, updatedAt: 1,
    } as SessionProjection),
    events: async () => [],
    append: async (sessionId, type, data) => ({ id: "e", sessionId, seq: 1, time: 1, type, data, v: 1 }),
    send: async (sessionId) => { sends.push(sessionId); return { turnId: "t" }; },
  });
  const call = async (method: string, path: string, body: Record<string, unknown> = {}, role: SpaceRole = "admin") => {
    const url = new URL(`http://polyth.test${path}`);
    let status = 0;
    let payload: unknown;
    try {
      await routes({
        url, path: url.pathname, method, space: f.space(role),
        body: async () => body,
        json: (code: number, value: unknown) => { status = code; payload = value; },
      } as unknown as RouteRequest);
    } catch (error) {
      return { status: 0, payload: undefined, error: error as Error & { code?: string } };
    }
    return { status, payload, error: null };
  };

  const settings = await call("GET", "/api/task-trackers/settings");
  assert.equal(settings.status, 200);
  assert.equal((settings.payload as { canManage: boolean }).canManage, true);

  const denied = await call("PATCH", "/api/task-trackers/settings", { demo: false }, "viewer");
  assert.equal(denied.error?.code, "forbidden");

  const off = await call("PATCH", "/api/task-trackers/settings", { agentHandoff: false, statusUpdates: false, providers: { jira: "nope" } });
  assert.equal((off.payload as { preferences: { agentHandoff: boolean; providers: { jira: boolean } } }).preferences.agentHandoff, false);
  assert.equal((off.payload as { preferences: { providers: { jira: boolean } } }).preferences.providers.jira, true, "non-boolean flags are ignored");

  const start = await call("POST", "/api/task-trackers/jira/tasks/POL-101/link", { sessionId: "s1" });
  assert.match(start.error?.message ?? "", /Agent handoff is turned off/);
  const linkOnly = await call("POST", "/api/task-trackers/jira/tasks/POL-101/link", { sessionId: "s1", startAgent: false });
  assert.equal(linkOnly.status, 200);
  assert.deepEqual(sends, []);

  const move = await call("PATCH", "/api/task-trackers/jira/tasks/POL-101", { sessionId: "s1", statusId: "demo-done" });
  assert.match(move.error?.message ?? "", /status updates are turned off/);
});

test("legacy per-Space personal accounts move to their person once, enabled where they were", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tt-migrate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storageOf = (spaceId: string): SpaceStorage => {
    const dir = join(root, "spaces", spaceId);
    return { root: dir, packageDir: (id) => join(dir, "packages", id), path: (relative) => join(dir, relative) };
  };
  const secrets = new Map<string, string>();
  const vault: TaskTrackerVault = {
    putOpaque: (key, value) => { secrets.set(key, value); },
    getOpaque: (key) => secrets.get(key) ?? null,
    deleteOpaque: (key) => { secrets.delete(key); },
  };
  // u-gone left Space A; u-ghost has metadata but no secret (never usable).
  const people = fakePeople(root, { spc_a: ["u-ada", "u-bob"], spc_b: ["u-ada"] });
  const legacy = (provider: "jira" | "trello", name: string) => ({
    provider, method: provider === "jira" ? "api-token" : "authorize", account: { name }, connectedAt: 1, verifiedAt: 2, revision: 3,
  });
  const seed = (spaceId: string, personal: Record<string, unknown[]>) => {
    mkdirSync(storageOf(spaceId).packageDir("task-trackers"), { recursive: true });
    writeFileSync(join(storageOf(spaceId).packageDir("task-trackers"), "state.json"), JSON.stringify({
      preferences: {}, connections: [legacy("jira", "Ops Bot")], personal,
    }));
    secrets.set(`task-trackers:${spaceId}:jira`, JSON.stringify({ provider: "jira", baseUrl: "https://acme.atlassian.net", email: "ops@acme.test", apiToken: "ops" }));
  };
  const jiraSecret = (token: string) => JSON.stringify({ provider: "jira", baseUrl: "https://acme.atlassian.net", email: "a@acme.test", apiToken: token });
  seed("spc_a", {
    "u-ada": [legacy("jira", "Ada A")],
    "u-bob": [legacy("trello", "Bob")],
    "u-gone": [legacy("jira", "Gone")],
    "u-ghost": [legacy("jira", "Ghost")],
  });
  seed("spc_b", { "u-ada": [legacy("jira", "Ada B")] });
  secrets.set("task-trackers:spc_a:user:u-ada:jira", jiraSecret("ada-a"));
  secrets.set("task-trackers:spc_a:user:u-bob:trello", JSON.stringify({ provider: "trello", apiKey: "k", apiToken: "bob" }));
  secrets.set("task-trackers:spc_a:user:u-gone:jira", jiraSecret("gone"));
  secrets.set("task-trackers:spc_b:user:u-ada:jira", jiraSecret("ada-b"));

  const management = createTaskTrackerManagement({
    storage: (space) => storageOf(space.spaceId),
    vault: () => vault,
    people: () => people,
    env: {},
  });
  const ctx = (userId: string, spaceId: string): SpaceContext => ({
    spaceId, spaceSlug: spaceId, userId, role: "member", deployment: "local-trusted", storageDir: storageOf(spaceId).root,
  } as SpaceContext);

  const adaA = management.state(ctx("u-ada", "spc_a"));
  const adaB = management.state(ctx("u-ada", "spc_b"));
  // Same person, same service, two Spaces: two connections, never merged.
  const all = adaB.personalConnections ?? [];
  assert.deepEqual(all.map((item) => item.account.name).sort(), ["Ada A", "Ada B"]);
  assert.notEqual(all[0]?.id, all[1]?.id);
  const fromA = all.find((item) => item.account.name === "Ada A")!;
  const fromB = all.find((item) => item.account.name === "Ada B")!;
  assert.deepEqual(adaA.personalConnections?.filter((item) => item.enabled).map((item) => item.id), [fromA.id]);
  assert.deepEqual(adaB.personalConnections?.filter((item) => item.enabled).map((item) => item.id), [fromB.id]);
  assert.equal(fromA.revision, 3, "metadata moves unchanged");
  assert.equal(people.secrets.get("u-ada")?.get(`connection:${fromA.id}`), jiraSecret("ada-a"));
  assert.equal(people.secrets.get("u-ada")?.get(`connection:${fromB.id}`), jiraSecret("ada-b"));
  assert.equal(adaA.providers.find((item) => item.provider === "jira")?.source, "personal");

  // Bob moved too; the leaver moved but is not enabled anywhere; the ghost had nothing to move.
  assert.deepEqual(people.enabled("u-bob", "spc_a", "task-trackers").length, 1);
  assert.equal(people.secrets.get("u-gone")?.size, 1);
  assert.deepEqual(people.enabled("u-gone", "spc_a", "task-trackers"), []);
  assert.equal(people.secrets.has("u-ghost"), false);

  // Old Space-vault keys are gone after the copy; the service accounts stay.
  assert.deepEqual([...secrets.keys()].sort(), ["task-trackers:spc_a:jira", "task-trackers:spc_b:jira"]);
  const persisted = JSON.parse(readFileSync(join(storageOf("spc_a").packageDir("task-trackers"), "state.json"), "utf8"));
  assert.deepEqual(persisted.personal, {});
  assert.equal(typeof persisted.personalMigratedAt, "number", "the migration marker is persisted");
  assert.equal(persisted.connections.length, 1);

  // Idempotent: a crash before the Space save leaves the legacy entry; a re-run reuses the copy.
  persisted.personal = { "u-ada": [legacy("jira", "Ada A")] };
  writeFileSync(join(storageOf("spc_a").packageDir("task-trackers"), "state.json"), JSON.stringify(persisted));
  const again = management.state(ctx("u-ada", "spc_a"));
  assert.equal(again.personalConnections?.length, 2, "no duplicate connection");
  assert.equal(people.secrets.get("u-ada")?.get(`connection:${fromA.id}`), jiraSecret("ada-a"));
});

test("without a person store, legacy accounts wait in the Space and are never used", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  mkdirSync(join(f.root, "packages", "task-trackers"), { recursive: true });
  writeFileSync(join(f.root, "packages", "task-trackers", "state.json"), JSON.stringify({
    personal: { u: [{ provider: "jira", method: "api-token", account: { name: "Mine" }, connectedAt: 1, verifiedAt: 1, revision: 1 }] },
  }));
  f.secrets.set("task-trackers:space-a:user:u:jira", JSON.stringify({ provider: "jira", baseUrl: "https://acme.atlassian.net", email: "e", apiToken: "t" }));
  const state = f.management.state(f.space("member"));
  assert.equal(state.personalAvailable, false);
  assert.deepEqual(state.personalConnections, []);
  assert.equal(state.providers.find((item) => item.provider === "jira")?.source, "demo");
  assert.ok(f.secrets.has("task-trackers:space-a:user:u:jira"), "nothing is deleted until it can move");
});
