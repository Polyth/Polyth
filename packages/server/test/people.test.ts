import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { RouteRequest } from "@polyth/contracts";
import { createAuthService, publicHttpIngress } from "../src/auth.ts";
import { createPeopleStore } from "../src/people.ts";
import { authRoutes } from "../src/routes/auth.ts";

const SPACE_A = "spc_alpha";
const SPACE_B = "spc_beta";
const FOREIGN = "spc_foreign";

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "polyth-people-"));
  const spaceRoots: Record<string, string> = {};
  for (const id of [SPACE_A, SPACE_B, FOREIGN]) {
    spaceRoots[id] = join(dataDir, "spaces", id);
    mkdirSync(spaceRoots[id]!, { recursive: true });
  }
  const members = new Set([`usr_alice:${SPACE_A}`, `usr_alice:${SPACE_B}`, `usr_bob:${SPACE_A}`]);
  const people = createPeopleStore({
    dataDir,
    spaceRoot: (spaceId) => spaceRoots[spaceId],
    isMember: (userId, spaceId) => members.has(`${userId}:${spaceId}`),
  });
  return { dataDir, spaceRoots, members, people };
}

test("person storage lives outside every Space and refuses escapes", () => {
  const { dataDir, people } = fixture();
  const tasks = people.forPackage("tasks");
  const storage = tasks.storage("usr_alice", "tasks");
  assert.ok(storage.root.endsWith(join("people", "usr_alice", "packages", "tasks")));
  assert.ok(!storage.root.includes(join(dataDir, "spaces")));
  assert.ok(existsSync(storage.root));
  assert.equal(storage.path("accounts/github.json"), join(storage.root, "accounts", "github.json"));

  for (const relative of ["../other", "../../usr_bob/packages/tasks", "/etc/passwd", "a/../../x", "x\0y"]) {
    assert.throws(() => storage.path(relative), { code: "invalid-path" }, relative);
  }
  // The package cannot reach its own secrets through its storage root.
  assert.throws(() => storage.path("../../vault/tasks/secure-safe-secrets.json"), { code: "invalid-path" });

  symlinkSync(tmpdir(), join(storage.root, "out"));
  assert.throws(() => storage.path("out/file"), { code: "invalid-path" });

  for (const userId of ["..", ".", "usr/../x", "system:package", "", "a".repeat(200), "usr_al.ice"]) {
    assert.throws(() => tasks.storage(userId, "tasks"), { code: "invalid-input" }, userId);
  }
});

test("a symlinked person directory cannot redirect storage outside people/", () => {
  const { dataDir, people } = fixture();
  mkdirSync(join(dataDir, "people"), { recursive: true });
  const outside = mkdtempSync(join(tmpdir(), "polyth-people-outside-"));
  symlinkSync(outside, join(dataDir, "people", "usr_mallory"));
  assert.throws(() => people.forPackage("tasks").storage("usr_mallory", "tasks"), { code: "invalid-path" });
  assert.deepEqual(readdirSync(outside), []);
});

test("a package only reaches its own person data", () => {
  const { people } = fixture();
  const tasks = people.forPackage("tasks");
  assert.throws(() => tasks.storage("usr_alice", "google"), { code: "forbidden" });
  assert.throws(() => tasks.vault("usr_alice", "google"), { code: "forbidden" });
  assert.throws(() => tasks.enabled("usr_alice", SPACE_A, "google"), { code: "forbidden" });
  assert.throws(() => tasks.setEnabled("usr_alice", SPACE_A, "google", "conn-1", true), { code: "forbidden" });
  assert.throws(() => tasks.servicePolicy(SPACE_A, "google"), { code: "forbidden" });
  assert.throws(() => tasks.setServicePolicy(SPACE_A, "google", { agentsMayUseService: true }), { code: "forbidden" });
  assert.throws(() => people.forPackage("../tasks"), { code: "invalid-input" });
});

test("vaults are partitioned by person and package and stored like the Space vault", () => {
  const { dataDir, people } = fixture();
  const tasks = people.forPackage("tasks");
  const google = people.forPackage("google");
  tasks.vault("usr_alice", "tasks").putOpaque("token:github", "alice-tasks-secret");
  tasks.vault("usr_bob", "tasks").putOpaque("token:github", "bob-tasks-secret");
  google.vault("usr_alice", "google").putOpaque("token:github", "alice-google-secret");

  assert.equal(tasks.vault("usr_alice", "tasks").getOpaque("token:github"), "alice-tasks-secret");
  assert.equal(tasks.vault("usr_bob", "tasks").getOpaque("token:github"), "bob-tasks-secret");
  assert.equal(google.vault("usr_alice", "google").getOpaque("token:github"), "alice-google-secret");
  assert.equal(google.vault("usr_bob", "google").getOpaque("token:github"), null);

  tasks.vault("usr_alice", "tasks").deleteOpaqueByPrefix("token:");
  assert.equal(tasks.vault("usr_alice", "tasks").getOpaque("token:github"), null);
  assert.equal(tasks.vault("usr_bob", "tasks").getOpaque("token:github"), "bob-tasks-secret");
  assert.equal(google.vault("usr_alice", "google").getOpaque("token:github"), "alice-google-secret");

  // Persisted by the Credential Vault store, outside the package storage root.
  const secrets = join(dataDir, "people", "usr_bob", "vault", "tasks", "secure-safe-secrets.json");
  assert.match(readFileSync(secrets, "utf8"), /bob-tasks-secret/);
  const reopened = createPeopleStore({ dataDir, spaceRoot: () => undefined, isMember: () => false });
  assert.equal(reopened.forPackage("tasks").vault("usr_bob", "tasks").getOpaque("token:github"), "bob-tasks-secret");
});

test("enablement is per person, Space and package and needs membership to turn on", () => {
  const { dataDir, spaceRoots, people } = fixture();
  const tasks = people.forPackage("tasks");
  assert.deepEqual(tasks.enabled("usr_alice", SPACE_A, "tasks"), []);
  tasks.setEnabled("usr_alice", SPACE_A, "tasks", "github:alice", true);
  tasks.setEnabled("usr_alice", SPACE_A, "tasks", "github:alice", true);
  tasks.setEnabled("usr_alice", SPACE_A, "tasks", "jira:alice", true);
  assert.deepEqual(tasks.enabled("usr_alice", SPACE_A, "tasks"), ["github:alice", "jira:alice"]);
  assert.deepEqual(tasks.enabled("usr_alice", SPACE_B, "tasks"), []);
  assert.deepEqual(tasks.enabled("usr_bob", SPACE_A, "tasks"), []);
  assert.deepEqual(people.forPackage("google").enabled("usr_alice", SPACE_A, "google"), []);

  assert.throws(() => tasks.setEnabled("usr_alice", FOREIGN, "tasks", "github:alice", true), { code: "forbidden" });
  assert.throws(() => tasks.setEnabled("usr_alice", "../spc_x", "tasks", "github:alice", true), { code: "invalid-input" });
  assert.throws(() => tasks.setEnabled("usr_alice", SPACE_A, "tasks", "../x", true), { code: "invalid-input" });

  tasks.setEnabled("usr_alice", SPACE_A, "tasks", "github:alice", false);
  assert.deepEqual(tasks.enabled("usr_alice", SPACE_A, "tasks"), ["jira:alice"]);

  // Stored with the person, never in the Space.
  assert.ok(existsSync(join(dataDir, "people", "usr_alice", "connections.json")));
  assert.equal(existsSync(join(spaceRoots[SPACE_A]!, "connected-accounts.json")), false);
});

test("leaving a Space keeps enablement but membership answers false; turning off still works", () => {
  const { members, people } = fixture();
  const tasks = people.forPackage("tasks");
  tasks.setEnabled("usr_bob", SPACE_A, "tasks", "github:bob", true);
  members.delete(`usr_bob:${SPACE_A}`);
  assert.equal(tasks.isMember("usr_bob", SPACE_A), false);
  assert.deepEqual(tasks.enabled("usr_bob", SPACE_A, "tasks"), ["github:bob"]);
  tasks.setEnabled("usr_bob", SPACE_A, "tasks", "github:bob", false);
  assert.deepEqual(tasks.enabled("usr_bob", SPACE_A, "tasks"), []);
  assert.equal(tasks.isMember("../usr_bob", SPACE_A), false);
});

test("service policy defaults off and is stored in the Space", () => {
  const { spaceRoots, people } = fixture();
  const tasks = people.forPackage("tasks");
  assert.deepEqual(tasks.servicePolicy(SPACE_A, "tasks"), { agentsMayUseService: false });
  assert.deepEqual(tasks.servicePolicy("spc_unknown", "tasks"), { agentsMayUseService: false });

  tasks.setServicePolicy(SPACE_A, "tasks", { agentsMayUseService: true });
  assert.deepEqual(tasks.servicePolicy(SPACE_A, "tasks"), { agentsMayUseService: true });
  assert.deepEqual(tasks.servicePolicy(SPACE_B, "tasks"), { agentsMayUseService: false });
  assert.deepEqual(people.forPackage("google").servicePolicy(SPACE_A, "google"), { agentsMayUseService: false });
  assert.ok(existsSync(join(spaceRoots[SPACE_A]!, "connected-accounts.json")));

  assert.throws(() => tasks.setServicePolicy("spc_unknown", "tasks", { agentsMayUseService: true }), { code: "not-found" });
  assert.throws(
    () => tasks.setServicePolicy(SPACE_A, "tasks", { agentsMayUseService: "yes" } as never),
    { code: "invalid-input" },
  );

  writeFileSync(join(spaceRoots[SPACE_B]!, "connected-accounts.json"), "{not json");
  assert.deepEqual(tasks.servicePolicy(SPACE_B, "tasks"), { agentsMayUseService: false });
});

test("removing an account deletes that person's storage, secrets and enablement only", async () => {
  const { dataDir, people } = fixture();
  const tasks = people.forPackage("tasks");
  writeFileSync(tasks.storage("usr_alice", "tasks").path("account.json"), "{}");
  tasks.vault("usr_alice", "tasks").putOpaque("token:github", "alice-secret");
  tasks.setEnabled("usr_alice", SPACE_A, "tasks", "github:alice", true);
  tasks.vault("usr_bob", "tasks").putOpaque("token:github", "bob-secret");

  const auth = createAuthService({ file: join(dataDir, "auth.json"), ownerUserId: "usr_owner" });
  auth.setPassword("usr_owner", "owner-password");
  auth.setPassword("usr_alice", "alice-password");
  const owner = auth.login("owner-password", "127.0.0.1", "Owner", "usr_owner");
  assert.ok(owner.ok);
  if (!owner.ok) return;
  const req = {
    headers: { cookie: `polyth_auth=${owner.token}`, "user-agent": "people-test" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  const ingress = publicHttpIngress(req);
  let status = 0;
  const rc = {
    req,
    res: { setHeader() {} },
    url: new URL("http://polyth/api/auth/accounts/usr_alice"),
    path: "/api/auth/accounts/usr_alice",
    method: "DELETE",
    ingress,
    principal: auth.resolve(req, ingress).principal,
    requireCapability: () => undefined,
    body: async () => ({}),
    json: (code: number) => { status = code; },
  } as unknown as RouteRequest;
  // Same hook shape as the composition root's onAccountRemoved.
  await authRoutes(auth, { onAccountRemoved: async (userId) => people.removePerson(userId) })(rc);
  assert.equal(status, 200);

  assert.equal(existsSync(join(dataDir, "people", "usr_alice")), false);
  // A recreated account with the same id starts empty, including in memory.
  assert.equal(tasks.vault("usr_alice", "tasks").getOpaque("token:github"), null);
  assert.deepEqual(tasks.enabled("usr_alice", SPACE_A, "tasks"), []);
  assert.equal(tasks.vault("usr_bob", "tasks").getOpaque("token:github"), "bob-secret");
  assert.throws(() => people.removePerson("../usr_bob"), { code: "invalid-input" });
  assert.ok(existsSync(join(dataDir, "people", "usr_bob")));
});

test("removing a person whose directory is a symlink removes only the link", () => {
  const { dataDir, people } = fixture();
  mkdirSync(join(dataDir, "people"), { recursive: true });
  const outside = mkdtempSync(join(tmpdir(), "polyth-people-target-"));
  writeFileSync(join(outside, "keep.txt"), "keep");
  symlinkSync(outside, join(dataDir, "people", "usr_mallory"));
  people.removePerson("usr_mallory");
  assert.equal(existsSync(join(dataDir, "people", "usr_mallory")), false);
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep");
});
