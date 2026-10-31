// Spaces §14.6: SSH connections have an owner. Installation connections are
// the instance owner's (plus explicit allowlists); a person's own connection
// lives in their person storage, authenticates only with a key they upload
// and is not-found to everyone else.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, ProjectRemote, ProjectService, RouteRequest, SpaceContext } from "@polyth/contracts";
import { createPeopleStore } from "../../server/src/people.ts";
import { resolveRemoteHarnessHost } from "../../harness-runtime/src/remoteHost.ts";
import { createSshService, sshConnectionUsable, type SshRunner } from "../src/index.ts";
import { sshRoutes } from "../src/serverEntry.ts";

const SPACE_A = "spc_alpha";
const SPACE_B = "spc_beta";
const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ==\n-----END OPENSSH PRIVATE KEY-----\n";

/** alice: instance owner, both Spaces. bob: member of A, may add own connections. carol: member of A and B. */
const members: Record<string, string[]> = { alice: [SPACE_A, SPACE_B], bob: [SPACE_A], carol: [SPACE_A, SPACE_B] };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "polyth-ssh-own-"));
  const isMember = (userId: string, spaceId: string) => members[userId]?.includes(spaceId) ?? false;
  const people = createPeopleStore({
    dataDir: join(dir, "data"),
    spaceRoot: () => undefined,
    isMember,
  }).forPackage("ssh");
  const dials: string[][] = [];
  const runner: SshRunner = async (args) => {
    if (args.includes("-O")) return { code: 1, stdout: "", stderr: "" };
    dials.push(args);
    const command = args[args.length - 1]!;
    if (command.startsWith("echo polyth-")) return { code: 0, stdout: `${command.slice(5)}\n`, stderr: "" };
    if (command.includes("$HOME")) return { code: 0, stdout: "/home/dev", stderr: "" };
    if (command.startsWith("cd -- ")) return { code: 0, stdout: "/home/dev\nsrc/\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const ssh = createSshService({
    file: join(dir, "ssh.json"),
    socketDir: join(dir, "sock"),
    runner,
    personStorage: (userId) => people.storage(userId, "ssh"),
    isMember: (userId, spaceId) => people.isMember(userId, spaceId),
  });
  const projectsBySpace = new Map<string, Project[]>();
  const scopedProjects = (space: SpaceContext): Pick<ProjectService, "list" | "addRemote"> => {
    const items = projectsBySpace.get(space.spaceId) ?? [];
    projectsBySpace.set(space.spaceId, items);
    return {
      list: async () => [...items],
      async addRemote(path: string, remote: ProjectRemote, name?: string) {
        const project: Project = { id: `proj_${items.length + 1}`, spaceId: space.spaceId, path, name: name ?? path, createdAt: 1, remote } as Project;
        items.push(project);
        return project;
      },
    };
  };
  const routes = sshRoutes({ ssh, projects: scopedProjects({ spaceId: "spc_none" } as SpaceContext) as ProjectService, scopedProjects });
  const as = (userId: string, spaceId: string, flags: { instanceOwner?: boolean; harnessPersonal?: boolean } = {}) =>
    async (method: string, path: string, body: Record<string, unknown> = {}) => {
      const url = new URL(`http://polyth.test${path}`);
      let status = 0;
      let payload: unknown;
      try {
        await routes({
          req: {}, res: {}, url, path: url.pathname, method,
          space: { spaceId, spaceSlug: spaceId, userId, role: "member", deployment: "local-trusted", storageDir: "/unused", instanceOwner: flags.instanceOwner === true, harnessPersonal: flags.harnessPersonal === true },
          principal: { kind: "ui-session" },
          body: async () => body,
          json: (code: number, value: unknown) => { status = code; payload = value; },
        } as unknown as RouteRequest);
        return { status, payload: payload as any, error: undefined as undefined | string };
      } catch (error) {
        return { status: 0, payload: undefined as any, error: (error as { code?: string }).code };
      }
    };
  return { dir, ssh, people, dials, as, projectsBySpace };
}

test("a person's own connection is stored with them and invisible to everyone else", async () => {
  const { dir, ssh, as } = setup();
  const bob = as("bob", SPACE_A, { harnessPersonal: true });
  const alice = as("alice", SPACE_A, { instanceOwner: true });
  const carol = as("carol", SPACE_A, { harnessPersonal: true });

  const created = await bob("POST", "/api/ssh/connections", { name: "Bob box", host: "bob.example" });
  assert.equal(created.status, 200);
  const id = created.payload.id as string;
  assert.match(id, /^u\.bob\.[0-9a-f-]{36}$/);
  assert.equal(created.payload.owner, "person");
  assert.equal(created.payload.mine, true);
  assert.equal(created.payload.keyUploaded, false);
  assert.equal("ownerUserId" in created.payload, false);
  assert.equal(ssh.list().length, 0, "nothing lands in the installation-wide ssh.json");
  assert.ok(existsSync(join(dir, "data", "people", "bob", "packages", "ssh", "connections.json")));

  assert.equal((await bob("GET", "/api/ssh/connections")).payload.items.length, 1);
  for (const caller of [alice, carol]) {
    assert.deepEqual((await caller("GET", "/api/ssh/connections")).payload.items, []);
    for (const [method, path] of [
      ["PATCH", `/api/ssh/connections/${id}`],
      ["DELETE", `/api/ssh/connections/${id}`],
      ["PUT", `/api/ssh/connections/${id}/key`],
      ["POST", `/api/ssh/connections/${id}/connect`],
      ["POST", `/api/ssh/connections/${id}/test`],
      ["GET", `/api/ssh/connections/${id}/status`],
      ["GET", `/api/ssh/browse?connectionId=${encodeURIComponent(id)}`],
      ["POST", "/api/ssh/projects"],
    ] as const) {
      const result = await caller(method, path, { connectionId: id, path: "/srv", privateKey: KEY });
      assert.equal(result.error, "not-found", `${method} ${path}`);
    }
  }
});

test("personal connections use only an uploaded key, never the server's agent, keys or ssh_config", async () => {
  const { dir, as, dials } = setup();
  const bob = as("bob", SPACE_A, { harnessPersonal: true });
  assert.equal((await bob("POST", "/api/ssh/connections", { host: "b.example", authMode: "agent" })).error, "invalid-input");
  assert.equal((await bob("POST", "/api/ssh/connections", { host: "b.example", authMode: "identity-file", identityFile: "/home/server/.ssh/id_ed25519" })).error, "invalid-input");
  assert.equal((await as("carol", SPACE_A)("POST", "/api/ssh/connections", { host: "c.example" })).error, "forbidden", "needs harnesses.personal");

  const id = (await bob("POST", "/api/ssh/connections", { host: "b.example", user: "bob" })).payload.id as string;
  assert.equal((await bob("POST", `/api/ssh/connections/${id}/connect`)).error, "invalid-input", "no key yet: no dial");
  assert.equal(dials.length, 0);
  assert.equal((await bob("PUT", `/api/ssh/connections/${id}/key`, { privateKey: "not a key" })).error, "invalid-input");
  assert.equal((await bob("PUT", `/api/ssh/connections/${id}/key`, { privateKey: KEY.replace("OPENSSH PRIVATE", "ENCRYPTED PRIVATE") })).error, "invalid-input");

  const uploaded = await bob("PUT", `/api/ssh/connections/${id}/key`, { privateKey: KEY });
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.payload.keyUploaded, true);
  assert.ok(!JSON.stringify(uploaded.payload).includes("PRIVATE KEY"), "the key never comes back");
  assert.equal("identityFile" in uploaded.payload, false);
  const keyFile = join(dir, "data", "people", "bob", "packages", "ssh", "keys", id);
  assert.equal(readFileSync(keyFile, "utf8"), KEY);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);

  assert.equal((await bob("POST", `/api/ssh/connections/${id}/test`)).payload.state, "connected");
  const args = dials.at(-1)!;
  const flag = (name: string) => args[args.indexOf(name) + 1];
  assert.equal(flag("-F"), "/dev/null");
  assert.equal(flag("-i"), keyFile);
  assert.ok(args.includes("IdentityAgent=none"));
  assert.ok(args.includes("IdentitiesOnly=yes"));
  assert.ok(args.includes(`UserKnownHostsFile=${join(dir, "data", "people", "bob", "packages", "ssh", "known_hosts")}`));

  assert.equal((await bob("DELETE", `/api/ssh/connections/${id}`)).status, 200);
  assert.equal(existsSync(keyFile), false, "removing the connection removes its key");
});

test("an uploaded key cannot be written outside the person's storage", async () => {
  const { dir, ssh, as } = setup();
  const bob = as("bob", SPACE_A, { harnessPersonal: true });
  const id = (await bob("POST", "/api/ssh/connections", { host: "b.example" })).payload.id as string;
  // Ids are never paths: anything but `u.<user>.<uuid>` is an installation id.
  assert.equal((await bob("PUT", `/api/ssh/connections/${encodeURIComponent(`u.bob.../../../x`)}/key`, { privateKey: KEY })).error, "not-found");
  // A planted symlink out of the person's tree is refused.
  const outside = mkdtempSync(join(tmpdir(), "polyth-ssh-outside-"));
  const storage = join(dir, "data", "people", "bob", "packages", "ssh");
  mkdirSync(storage, { recursive: true });
  symlinkSync(outside, join(storage, "keys"));
  assert.throws(() => ssh.putKey(id, KEY), (error: Error & { code?: string }) => error.code === "invalid-path" || /escape|outside|symlink/i.test(error.message));
  assert.equal(existsSync(join(outside, id)), false);
});

test("installation connections: owner only, plus the people and Spaces the owner allows", async () => {
  const { as } = setup();
  const alice = as("alice", SPACE_A, { instanceOwner: true });
  const id = (await alice("POST", "/api/ssh/connections", { host: "shared.example" })).payload.id as string;
  const carolA = as("carol", SPACE_A);
  const carolB = as("carol", SPACE_B);
  const bobA = as("bob", SPACE_A);

  for (const caller of [carolA, carolB, bobA]) assert.equal((await caller("POST", `/api/ssh/connections/${id}/test`)).error, "not-found");

  // A person on the list may use it in every Space.
  assert.equal((await alice("PUT", `/api/ssh/connections/${id}/access`, { allowedUserIds: ["carol"] })).status, 200);
  assert.equal((await carolA("POST", `/api/ssh/connections/${id}/test`)).payload.state, "connected");
  assert.equal((await carolB("POST", `/api/ssh/connections/${id}/test`)).payload.state, "connected");
  assert.equal((await bobA("POST", `/api/ssh/connections/${id}/test`)).error, "not-found");

  // A Space on the list admits its members there only; the foreign Space stays closed.
  assert.equal((await alice("PUT", `/api/ssh/connections/${id}/access`, { allowedSpaceIds: [SPACE_B] })).status, 200);
  assert.equal((await carolB("POST", `/api/ssh/connections/${id}/test`)).payload.state, "connected");
  assert.equal((await carolA("POST", `/api/ssh/connections/${id}/test`)).error, "not-found");
  assert.equal((await carolA("POST", "/api/ssh/projects", { connectionId: id, path: "/srv/app" })).error, "not-found");
  assert.equal((await carolB("POST", "/api/ssh/projects", { connectionId: id, path: "/srv/app" })).status, 200);
  assert.deepEqual(
    (await alice("GET", "/api/ssh/connections")).payload.items.map((item: any) => [item.allowedUserIds, item.allowedSpaceIds]),
    [[[], [SPACE_B]]],
  );
  assert.equal((await alice("PUT", `/api/ssh/connections/${id}/access`, { allowedUserIds: ["../x"] })).error, "invalid-input");
  assert.equal((await alice("PUT", `/api/ssh/connections/${id}/key`, { privateKey: KEY })).error, "invalid-input", "shared connections take no uploaded key");
});

test("the usability rule for work with no person follows the project binding", () => {
  const isMember = (userId: string, spaceId: string) => members[userId]?.includes(spaceId) ?? false;
  const installation = { kind: "installation" } as const;
  const bobs = { kind: "person", userId: "bob" } as const;
  assert.equal(sshConnectionUsable(installation, undefined, { kind: "binding", spaceId: SPACE_A }, isMember), true);
  assert.equal(sshConnectionUsable(bobs, undefined, { kind: "binding", spaceId: SPACE_A }, isMember), true);
  assert.equal(sshConnectionUsable(bobs, undefined, { kind: "binding", spaceId: SPACE_B }, isMember), false, "owner left / never joined");
  assert.equal(sshConnectionUsable(bobs, undefined, { kind: "person", userId: "alice", spaceId: SPACE_A, instanceOwner: true }, isMember), false, "not even the instance owner");
  assert.equal(sshConnectionUsable(installation, { allowedUserIds: "carol" as never, allowedSpaceIds: [] }, { kind: "person", userId: "carol", spaceId: SPACE_A, instanceOwner: false }, isMember), false, "malformed list admits nobody");
});

test("a remote harness runs on a personal connection only for its owner's turns", async () => {
  const { ssh, as } = setup();
  const bob = as("bob", SPACE_A, { harnessPersonal: true });
  const id = (await bob("POST", "/api/ssh/connections", { host: "b.example" })).payload.id as string;
  await bob("PUT", `/api/ssh/connections/${id}/key`, { privateKey: KEY });
  const project = { id: "proj_1", spaceId: SPACE_A, path: "/srv/app", name: "App", createdAt: 1, remote: { kind: "ssh", connectionId: id } };
  const actors: Record<string, string | undefined> = { "bob-turn": "bob", "carol-turn": "carol", "nobody-turn": undefined };
  const host = {
    projects: { get: async () => project },
    forSpace: () => ({ projects: { get: async () => project } }),
    services: { get: () => ssh },
    store: { projection: async (sessionId: string) => (actors[sessionId] ? { actor: { userId: actors[sessionId] } } : {}) },
    personSpaceContext: (userId: string, spaceId: string) =>
      members[userId]?.includes(spaceId) ? { spaceId, userId, instanceOwner: userId === "alice" } : undefined,
  };
  const resolve = (sessionId?: string) => resolveRemoteHarnessHost(host as never, {
    remote: true, projectId: "proj_1", spaceId: SPACE_A, ...(sessionId ? { sessionId } : {}),
  });
  assert.ok(await resolve("bob-turn"));
  await assert.rejects(resolve("carol-turn"), (error: Error & { code?: string }) => error.code === "not-found");
  assert.ok(await resolve("nobody-turn"), "no actor: the owner's binding in this Space");
  assert.ok(await resolve(), "probe without a session");
  // Bob leaves the Space: the binding no longer carries his connection.
  members.bob = [];
  try {
    await assert.rejects(resolve(), (error: Error & { code?: string }) => error.code === "not-found");
  } finally {
    members.bob = [SPACE_A];
  }
});
