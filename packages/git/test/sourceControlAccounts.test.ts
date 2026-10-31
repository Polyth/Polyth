import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectService, SessionService, SpaceContext, SpaceStorage } from "@polyth/contracts";
import type { SourceControlCredentialProvider, SourceControlHostingAccount } from "@polyth/contracts/source-control";
import { gitRoutes } from "../src/serverEntry.ts";
import type { GitService } from "../src/index.ts";
import {
  createSourceControlAccountService,
  createSourceControlCredentialRegistry,
  gitTransportInvocation,
  withGitCommitIdentity,
  withGitTransportAuth,
} from "../src/sourceControlAccounts.ts";
import type { GitActor } from "../src/actingPerson.ts";

const SECRET = "tok-placeholder-123";
const space = (role: SpaceContext["role"] = "owner"): SpaceContext => ({
  spaceId: "s1", spaceSlug: "s1", userId: "u1", role, deployment: "local-trusted", storageDir: "/unused",
});

function storageAt(root: string): SpaceStorage {
  return { root, packageDir: (id) => join(root, "packages", id), path: (rel) => join(root, rel) };
}

const github = (login: string, extra: Partial<SourceControlHostingAccount> = {}): SourceControlHostingAccount => ({
  provider: "fake", accountId: `github.com/${login}`, providerLabel: "Fake", login, origin: "https://github.com", transport: "token", ...extra,
});

function fakeProvider(accounts: SourceControlHostingAccount[], calls: string[] = []): SourceControlCredentialProvider {
  return {
    id: "fake",
    accounts: async () => accounts,
    credential: async (_space, id) => { calls.push(`credential:${id}`); return { username: id.split("/").pop()!, password: SECRET }; },
    bindProject: async (_space, input) => { calls.push(`bind:${input.projectId}:${input.accountId}:${input.repository}`); },
  };
}

test("transport args apply only to remote-talking Git commands inside an auth context", async () => {
  assert.deepEqual(gitTransportInvocation(["push", "origin"]), { args: ["push", "origin"], env: {} });
  await withGitTransportAuth({ origin: "https://github.com", credential: { username: "alice", password: SECRET } }, async () => {
    const push = gitTransportInvocation(["push", "--set-upstream", "origin", "main"]);
    assert.equal(push.args.at(-4), "push");
    assert.deepEqual(push.args.slice(0, 2), ["-c", "credential.https://github.com.helper="]);
    assert.match(push.args[3]!, /^credential\.https:\/\/github\.com\.helper=!f\(\)/);
    // The secret travels only through the child environment, never argv.
    assert.ok(!push.args.join(" ").includes(SECRET));
    assert.deepEqual(push.env, { POLYTH_GIT_CREDENTIAL_USERNAME: "alice", POLYTH_GIT_CREDENTIAL_PASSWORD: SECRET });
    const pinned = gitTransportInvocation(["-c", "core.hooksPath=/dev/null", "fetch", "origin"]);
    assert.equal(pinned.args.length, 8);
    assert.deepEqual(gitTransportInvocation(["status", "--porcelain"]), { args: ["status", "--porcelain"], env: {} });
    assert.deepEqual(gitTransportInvocation(["config", "credential.helper"]), { args: ["config", "credential.helper"], env: {} });
  });
  assert.deepEqual(gitTransportInvocation(["fetch"]).env, {}, "context does not leak after the call");
});

test("transport auth rejects credentials that could inject helper lines", async () => {
  await assert.rejects(
    withGitTransportAuth({ origin: "https://github.com", credential: { username: "a\nb", password: SECRET } }, async () => undefined),
    { code: "auth-required" },
  );
  await assert.rejects(
    withGitTransportAuth({ origin: "https://github.com/path", credential: { username: "a", password: SECRET } }, async () => undefined),
    { code: "auth-required" },
  );
});

test("the inline helper answers Git ahead of URL-scoped global helpers and leaves other hosts alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-cred-"));
  try {
    const globalConfig = join(dir, "gitconfig");
    writeFileSync(globalConfig, [
      '[credential "https://github.com"]',
      '\thelper = "!f() { echo username=GLOBAL; echo password=GLOBALPW; }; f"',
      '[credential "https://gitlab.com"]',
      '\thelper = "!f() { echo username=OTHER; echo password=OTHERPW; }; f"',
      "",
    ].join("\n"));
    const fill = async (host: string) => withGitTransportAuth(
      { origin: "https://github.com", credential: { username: "alice", password: SECRET } },
      async () => {
        const invocation = gitTransportInvocation(["fetch"]);
        const args = [...invocation.args.slice(0, -1), "credential", "fill"];
        const result = spawnSync("git", args, {
          input: `protocol=https\nhost=${host}\npath=o/r.git\n\n`,
          env: { ...process.env, ...invocation.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
          encoding: "utf8",
        });
        return result.stdout;
      },
    );
    const github = await fill("github.com");
    assert.match(github, /^username=alice$/m);
    assert.match(github, new RegExp(`^password=${SECRET}$`, "m"));
    const gitlab = await fill("gitlab.com");
    assert.match(gitlab, /^username=OTHER$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account service filters by host, refuses foreign hosts and persists one binding per project", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-accounts-"));
  try {
    const registry = createSourceControlCredentialRegistry();
    const calls: string[] = [];
    registry.register(fakeProvider([github("alice", { active: true }), github("bob"), { ...github("carol"), accountId: "lab/carol", origin: "https://gitlab.example.com" }], calls));
    const service = createSourceControlAccountService({ registry, storage: () => storageAt(root) });

    const listed = await service.accounts(space(), "https://github.com/o/r.git");
    assert.deepEqual(listed.accounts.map((row) => row.login), ["alice", "bob"]);
    const ssh = await service.accounts(space(), "git@gitlab.example.com:team/r.git");
    assert.deepEqual(ssh.accounts.map((row) => row.login), ["carol"]);

    await assert.rejects(service.account(space(), { provider: "fake", accountId: "lab/carol" }, "https://github.com/o/r.git"), { code: "account-not-applicable" });
    await assert.rejects(service.account(space(), { provider: "missing", accountId: "x" }, "https://github.com/o/r.git"), { code: "not-found" });

    assert.equal(await service.transportAuth(space(), { provider: "fake", accountId: "lab/carol" }, "git@gitlab.example.com:team/r.git"), null, "SSH never carries a token");
    assert.deepEqual(await service.transportAuth(space(), { provider: "fake", accountId: "github.com/bob" }, "https://github.com/o/r.git"), {
      origin: "https://github.com", credential: { username: "bob", password: SECRET },
    });

    const binding = await service.bind(space(), { projectId: "p1", provider: "fake", accountId: "github.com/bob", repository: "https://github.com/o/r.git" });
    assert.equal(binding.login, "bob");
    await service.bind(space(), { projectId: "p1", provider: "fake", accountId: "github.com/alice", repository: "https://github.com/o/r.git" });
    const stored = JSON.parse(readFileSync(join(root, "packages", "git", "source-control-accounts.json"), "utf8")) as unknown[];
    assert.equal(stored.length, 1);
    assert.ok(!JSON.stringify(stored).includes(SECRET), "bindings never store credentials");
    assert.equal(service.binding(space(), "p1")?.login, "alice");

    assert.ok(await service.projectTransportAuth(space(), "p1", "https://github.com/o/r.git"));
    assert.equal(await service.projectTransportAuth(space(), "p1", "https://gitlab.example.com/o/r.git"), null, "another host keeps the user's helpers");
    assert.equal(await service.projectTransportAuth(space(), "p1", "git@github.com:o/r.git"), null);
    assert.equal(await service.projectTransportAuth(space(), "p2", "https://github.com/o/r.git"), null);

    assert.equal(service.unbind(space(), "p1"), true);
    assert.equal(service.binding(space(), "p1"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function routeHarness(options: { role?: SpaceContext["role"]; repo?: string } = {}) {
  const storage = mkdtempSync(join(tmpdir(), "polyth-account-routes-"));
  const registry = createSourceControlCredentialRegistry();
  const calls: string[] = [];
  registry.register(fakeProvider([github("alice", { active: true }), github("bob")], calls));
  const accounts = createSourceControlAccountService({ registry, storage: () => storageAt(storage) });
  const transport: Array<Record<string, string | undefined>> = [];
  const recordTransport = async () => { transport.push(gitTransportInvocation(["fetch"]).env); };
  const git = {
    isRepo: async () => true,
    fetch: recordTransport, pull: recordTransport, push: recordTransport, rebase: recordTransport, sync: recordTransport,
  } as unknown as GitService;
  const project = options.repo ? { id: "p1", name: "Repo", path: options.repo } : undefined;
  const routes = gitRoutes({
    projects: { get: async (id: string) => id === "p1" ? project : undefined } as unknown as ProjectService,
    sessions: { snapshot: async () => undefined } as unknown as SessionService,
    git,
    commitMessage: async () => "",
    accounts,
  });
  const call = async (method: string, path: string, body: Record<string, unknown> = {}, query: Record<string, string> = {}) => {
    let payload: unknown;
    const url = new URL(`http://x${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    await routes({
      req: {}, res: {}, space: space(options.role), url, path: url.pathname, method,
      body: async () => body, json: (_status: number, data: unknown) => { payload = data; },
    } as never);
    return payload;
  };
  return { call, calls, transport, cleanup: () => rmSync(storage, { recursive: true, force: true }) };
}

test("clone refuses an account for members, SSH targets and foreign hosts before touching the disk", async () => {
  const h = routeHarness({ role: "member" });
  try {
    const parent = mkdtempSync(join(tmpdir(), "polyth-clone-parent-"));
    const clone = (extra: Record<string, unknown>, role?: SpaceContext["role"]) => (role ? routeHarness({ role }) : h).call("POST", "/api/projects/clone", {
      repository: "https://github.com/o/r.git", parentPath: parent, account: { provider: "fake", accountId: "github.com/alice" }, ...extra,
    });
    await assert.rejects(clone({}), { code: "permission-denied" });
    await assert.rejects(clone({ remote: { kind: "ssh", connectionId: "c1" } }, "owner"), (error: Error & { code?: string }) =>
      error.code === "invalid-input" || error.code === "unavailable");
    await assert.rejects(clone({ repository: "https://gitlab.com/o/r.git" }, "owner"), { code: "account-not-applicable" });
    await assert.rejects(clone({ account: { provider: "fake" } }, "owner"), { code: "invalid-input" });
    assert.deepEqual(execFileSync("ls", ["-A", parent], { encoding: "utf8" }), "");
    rmSync(parent, { recursive: true, force: true });
  } finally {
    h.cleanup();
  }
});

test("a project's account can be bound, read, cleared and authenticates its own host's transport", async () => {
  const repo = mkdtempSync(join(tmpdir(), "polyth-account-repo-"));
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/o/r.git"]);
  execFileSync("git", ["-C", repo, "remote", "add", "lab", "https://gitlab.com/o/r.git"]);
  const h = routeHarness({ repo });
  try {
    assert.deepEqual(await h.call("GET", "/api/git/account", {}, { projectId: "p1" }), { binding: null });
    await assert.rejects(h.call("GET", "/api/git/account", {}, { projectId: "foreign" }), { code: "not-found" });
    const put = await h.call("PUT", "/api/git/account", { projectId: "p1", provider: "fake", accountId: "github.com/bob" }) as { binding: { login: string } };
    assert.equal(put.binding.login, "bob");
    assert.deepEqual(h.calls.filter((c) => c.startsWith("bind:")), ["bind:p1:github.com/bob:https://github.com/o/r.git"]);
    assert.equal(execFileSync("git", ["-C", repo, "config", "--local", "credential.https://github.com.username"], { encoding: "utf8" }).trim(), "bob");
    await assert.rejects(h.call("PUT", "/api/git/account", { projectId: "p1", provider: "fake", accountId: "github.com/bob", remote: "lab" }), { code: "account-not-applicable" });

    await h.call("POST", "/api/git/push", { projectId: "p1" });
    await h.call("POST", "/api/git/fetch", { projectId: "p1", remote: "lab" });
    assert.deepEqual(h.transport, [
      { POLYTH_GIT_CREDENTIAL_USERNAME: "bob", POLYTH_GIT_CREDENTIAL_PASSWORD: SECRET },
      {},
    ]);

    assert.deepEqual(await h.call("DELETE", "/api/git/account", {}, { projectId: "p1" }), { binding: null });
    await h.call("POST", "/api/git/pull", { projectId: "p1" });
    assert.deepEqual(h.transport.at(-1), {});
    const accounts = await h.call("GET", "/api/git/accounts", {}, { repository: "https://github.com/x/y.git" }) as { accounts: Array<{ login: string }> };
    assert.deepEqual(accounts.accounts.map((row) => row.login), ["alice", "bob"]);
  } finally {
    h.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("members can read but not change a project's account", async () => {
  const repo = mkdtempSync(join(tmpdir(), "polyth-account-member-"));
  mkdirSync(repo, { recursive: true });
  const h = routeHarness({ role: "member", repo });
  try {
    assert.deepEqual(await h.call("GET", "/api/git/account", {}, { projectId: "p1" }), { binding: null });
    await assert.rejects(h.call("PUT", "/api/git/account", { projectId: "p1", provider: "fake", accountId: "github.com/bob" }), { code: "permission-denied" });
    await assert.rejects(h.call("DELETE", "/api/git/account", {}, { projectId: "p1" }), { code: "permission-denied" });
  } finally {
    h.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

/** Smart-HTTP Git server over `git http-backend` that demands Basic auth. */
async function authenticatedGitServer(projectRoot: string, user: string, password: string) {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const expected = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    seen.push(auth ? (auth === expected ? "ok" : "wrong") : "none");
    if (auth !== expected) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="test"' });
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://x");
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: projectRoot, GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: req.method ?? "GET", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: String(req.headers["content-type"] ?? ""), REMOTE_USER: user, REMOTE_ADDR: "127.0.0.1",
      },
    });
    req.pipe(cgi.stdin);
    const chunks: Buffer[] = [];
    cgi.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    cgi.on("close", () => {
      const output = Buffer.concat(chunks);
      const split = output.indexOf("\r\n\r\n");
      const head = output.subarray(0, split).toString("utf8");
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.split("\r\n")) {
        const [name, ...rest] = line.split(":");
        const value = rest.join(":").trim();
        if (name!.toLowerCase() === "status") status = Number.parseInt(value, 10);
        else if (name) headers[name] = value;
      }
      res.writeHead(status, headers);
      res.end(output.subarray(split + 4));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${address.port}`, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("clone authenticates as the chosen account, binds it, and leaves no secret in the repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-clone-auth-"));
  const served = join(root, "served");
  mkdirSync(served);
  mkdirSync(join(served, "team"));
  execFileSync("git", ["init", "-q", "--bare", join(served, "team", "repo.git")]);
  const seed = join(root, "seed");
  execFileSync("git", ["init", "-q", seed]);
  execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  execFileSync("git", ["-C", seed, "push", "-q", join(served, "team", "repo.git"), "HEAD:refs/heads/main"]);
  execFileSync("git", ["--git-dir", join(served, "team", "repo.git"), "symbolic-ref", "HEAD", "refs/heads/main"]);
  const server = await authenticatedGitServer(served, "alice", SECRET);
  const parent = join(root, "projects");
  mkdirSync(parent);
  const storage = join(root, "space");
  const registry = createSourceControlCredentialRegistry();
  const calls: string[] = [];
  registry.register(fakeProvider([{ ...github("alice"), accountId: "local/alice", origin: server.origin }], calls));
  const accounts = createSourceControlAccountService({ registry, storage: () => storageAt(storage) });
  const added: Array<{ path: string; name?: string }> = [];
  const routes = gitRoutes({
    projects: {
      add: async (path: string, name?: string) => { added.push({ path, name }); return { id: "cloned", name: name ?? "repo", path }; },
    } as unknown as ProjectService,
    sessions: {} as SessionService,
    git: {} as GitService,
    commitMessage: async () => "",
    accounts,
  });
  const clone = async (body: Record<string, unknown>) => {
    let payload: unknown;
    await routes({
      req: {}, res: {}, space: space(), url: new URL("http://x/api/projects/clone"), path: "/api/projects/clone", method: "POST",
      body: async () => body, json: (_status: number, data: unknown) => { payload = data; },
    } as never);
    return payload as { id: string; path: string };
  };
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = join(root, "empty-global-config");
  try {
    const repository = `${server.origin}/team/repo.git`;
    await assert.rejects(clone({ repository, parentPath: parent, name: "anon" }), { code: "git-failed" });
    assert.deepEqual(server.seen, ["none"], "without an account Git has no credential to offer");

    const project = await clone({ repository, parentPath: parent, account: { provider: "fake", accountId: "local/alice" } });
    assert.equal(project.id, "cloned");
    assert.ok(server.seen.includes("ok"));
    assert.ok(!server.seen.includes("wrong"));
    const config = readFileSync(join(parent, "repo", ".git", "config"), "utf8");
    assert.ok(!config.includes(SECRET), "the token is never written to the cloned repository");
    assert.ok(!config.includes("helper"), "no credential helper is left behind");
    assert.match(config, /username = alice/);
    assert.equal(accounts.binding(space(), "cloned")?.login, "alice");
    assert.ok(calls.includes(`bind:cloned:local/alice:${repository}`));
  } finally {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a commit identity reaches only commit-writing Git commands of its own context", async () => {
  await withGitCommitIdentity({ name: "Ada Lovelace", email: "ada@example.com" }, async () => {
    const commit = gitTransportInvocation(["commit", "-m", "x"]);
    assert.deepEqual(commit.args, ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com", "commit", "-m", "x"]);
    assert.equal(commit.env.GIT_COMMITTER_NAME, "Ada Lovelace");
    assert.equal(commit.env.GIT_COMMITTER_EMAIL, "ada@example.com");
    assert.ok("GIT_AUTHOR_NAME" in commit.env && commit.env.GIT_AUTHOR_NAME === undefined, "a server-wide author never overrides the actor");
    assert.equal(gitTransportInvocation(["commit-tree", "t", "-p", "p"]).args[1], "user.name=Ada Lovelace");
    assert.equal(gitTransportInvocation(["merge", "--no-edit", "x"]).args[1], "user.name=Ada Lovelace");
    assert.deepEqual(gitTransportInvocation(["status"]), { args: ["status"], env: {} });
    assert.deepEqual(gitTransportInvocation(["config", "--local", "--get", "user.name"]), { args: ["config", "--local", "--get", "user.name"], env: {} });
    // Transport and identity compose: a pull gets both.
    await withGitTransportAuth({ origin: "https://github.com", credential: { username: "ada", password: SECRET } }, async () => {
      const pull = gitTransportInvocation(["pull"]);
      assert.equal(pull.args[1], "user.name=Ada Lovelace");
      assert.equal(pull.env.POLYTH_GIT_CREDENTIAL_USERNAME, "ada");
    });
  });
  assert.deepEqual(gitTransportInvocation(["commit", "-m", "x"]), { args: ["commit", "-m", "x"], env: {} }, "no identity outside the context");
  await assert.rejects(withGitCommitIdentity({ name: "a\nb", email: "a@b" }, async () => undefined), { code: "invalid-input", mutationOutcome: "not-started" });
  await assert.rejects(withGitCommitIdentity({ name: "Ada", email: "not-an-email" }, async () => undefined), { code: "invalid-input" });
});

// ---- acting person (Spaces §14.4) ---------------------------------------------

const personSpace = (userId: string, instanceOwner = false, deployment: SpaceContext["deployment"] = "local-trusted"): SpaceContext =>
  ({ spaceId: "s1", spaceSlug: "s1", userId, role: "member", deployment, storageDir: "/unused", instanceOwner }) as SpaceContext;

/** Provider whose personal accounts depend on who asks, like the real ones. */
function peopleProvider(calls: string[] = []): SourceControlCredentialProvider {
  const personal: Record<string, SourceControlHostingAccount[]> = {
    alice: [{ ...github("alice"), accountId: "p-alice", owner: "personal" }],
  };
  const service: SourceControlHostingAccount = { ...github("svc-bot"), accountId: "svc", owner: "service" };
  const installation: SourceControlHostingAccount = { ...github("host-gh"), accountId: "gh/host", owner: "installation" };
  const ownerOf = (space: SpaceContext) => (space as SpaceContext & { instanceOwner?: boolean }).instanceOwner === true;
  return {
    id: "fake",
    accounts: async (space) => [...(personal[space.userId] ?? []), service, ...(ownerOf(space) ? [installation] : [])],
    credential: async (space, id) => {
      if (id.startsWith("p-") && id !== `p-${space.userId}`) throw Object.assign(new Error("GitHub account not found."), { code: "not-found" });
      if (id === "gh/host" && !ownerOf(space)) throw Object.assign(new Error("no"), { code: "permission-denied" });
      calls.push(`credential:${space.userId}:${id}`);
      return { username: id, password: `${SECRET}-${id}` };
    },
  };
}

function actingHarness(options: { policy?: boolean; members?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "polyth-acting-accounts-"));
  const registry = createSourceControlCredentialRegistry();
  const calls: string[] = [];
  registry.register(peopleProvider(calls));
  const members = options.members ?? ["alice", "bob", "owner"];
  const service = createSourceControlAccountService({
    registry,
    storage: () => storageAt(root),
    isMember: (userId) => members.includes(userId),
    servicePolicy: () => ({ agentsMayUseService: options.policy === true }),
  });
  const actor = (userId: string | undefined, extra: Partial<GitActor> = {}): GitActor => ({
    spaceId: "s1", ...(userId ? { userId } : {}), origin: userId ? "person-ui" : "system", ambient: false, ...extra,
  });
  const auth = (a: GitActor, remoteUrl: string | null, more: { projectId?: string; account?: { provider: string; accountId: string } } = {}) =>
    service.actorTransportAuth({ actor: a, space: personSpace(a.userId ?? "system:polyth-runtime", a.ambient), remoteUrl, ...more });
  return { service, calls, actor, auth, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const REPO = "https://github.com/o/r.git";
const refused = (reason: string) => ({ code: "git-account-required", status: 409, mutationOutcome: "not-started", reason });

test("transport for an actor: own account, then the Space account, then the owner's host helpers, else refused", async () => {
  const h = actingHarness();
  try {
    await h.service.bind(personSpace("owner", true), { projectId: "p1", provider: "fake", accountId: "svc", repository: REPO });
    // Alice's own account wins over the project's Space account.
    assert.equal((await h.auth(h.actor("alice"), REPO, { projectId: "p1" }))?.credential.username, "p-alice");
    // Bob has none: in the UI he may use the project's Space account…
    assert.equal((await h.auth(h.actor("bob"), REPO, { projectId: "p1" }))?.credential.username, "svc");
    // …but an agent turn he started may not, unless the Space allows it: he
    // is asked to connect his own.
    await assert.rejects(h.auth(h.actor("bob", { origin: "agent" }), REPO, { projectId: "p1" }), refused("connect-your-account"));
    // Without a Space account there is nothing Bob may use: never Alice's, never the host's.
    await assert.rejects(h.auth(h.actor("bob"), REPO), refused("connect-your-account"));
    await assert.rejects(h.auth(h.actor("bob"), REPO, { account: { provider: "fake", accountId: "p-alice" } }), { code: "not-found" });
    await assert.rejects(h.auth(h.actor("bob"), REPO, { account: { provider: "fake", accountId: "gh/host" } }), { code: "not-found" });
    assert.ok(!h.calls.some((call) => call.startsWith("credential:bob:p-alice")), "Bob never reaches Alice's token");
    // System work only under the policy.
    await assert.rejects(h.auth(h.actor(undefined), REPO, { projectId: "p1" }), refused("service-not-allowed"));
    // Someone who left the Space gets nothing, even their own account.
    await assert.rejects(h.auth(h.actor("mallory"), REPO, { projectId: "p1" }), refused("not-a-member"));
  } finally {
    h.cleanup();
  }
  const allowed = actingHarness({ policy: true });
  try {
    await allowed.service.bind(personSpace("owner", true), { projectId: "p1", provider: "fake", accountId: "svc", repository: REPO });
    assert.equal((await allowed.auth(allowed.actor("bob", { origin: "agent" }), REPO, { projectId: "p1" }))?.credential.username, "svc");
    assert.equal((await allowed.auth(allowed.actor(undefined), REPO, { projectId: "p1" }))?.credential.username, "svc");
  } finally {
    allowed.cleanup();
  }
});

test("only the instance owner on local-trusted falls back to the host's helpers, gh logins and SSH keys", async () => {
  const h = actingHarness();
  try {
    const owner = h.actor("owner", { ambient: true });
    assert.equal(await h.auth(owner, REPO), null, "the owner keeps the host's own helpers");
    assert.equal(await h.auth(owner, "git@github.com:o/r.git"), null);
    await assert.rejects(h.auth(h.actor("bob"), "git@github.com:o/r.git"), refused("ssh"));
    // A project bound to one of the host's gh logins keeps using it for the owner only.
    await h.service.bind(personSpace("owner", true), { projectId: "p2", provider: "fake", accountId: "gh/host", repository: REPO });
    assert.equal((await h.auth(owner, REPO, { projectId: "p2" }))?.credential.username, "gh/host");
    await assert.rejects(h.auth(h.actor("bob"), REPO, { projectId: "p2" }), refused("connect-your-account"));
    // A local path needs no credential; an address Polyth cannot attribute is refused.
    assert.equal(await h.auth(h.actor("bob"), "/srv/repos/r.git"), null);
    assert.equal(await h.auth(h.actor("bob"), null), null);
    await assert.rejects(h.auth(h.actor("bob"), "https://example.com"), { code: "git-account-required" });
    assert.equal(await h.auth(owner, "https://example.com"), null);
  } finally {
    h.cleanup();
  }
});

test("UI fetch/pull/push run as the signed-in person and refuse before Git runs without an account", async () => {
  const repo = mkdtempSync(join(tmpdir(), "polyth-acting-route-"));
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", REPO]);
  const storage = mkdtempSync(join(tmpdir(), "polyth-acting-route-space-"));
  const registry = createSourceControlCredentialRegistry();
  registry.register(peopleProvider());
  const accounts = createSourceControlAccountService({ registry, storage: () => storageAt(storage), isMember: () => true });
  const transport: Array<Record<string, string | undefined>> = [];
  const record = async () => { transport.push(gitTransportInvocation(["push"]).env); };
  const routes = gitRoutes({
    projects: { get: async (id: string) => id === "p1" ? { id, name: "Repo", path: repo } : undefined } as unknown as ProjectService,
    sessions: {} as SessionService,
    git: { isRepo: async () => true, push: record, fetch: record, pull: record, sync: record, rebase: record } as unknown as GitService,
    commitMessage: async () => "",
    accounts,
  });
  const call = (userId: string, path: string, owner = false) => routes({
    req: {}, res: {}, space: personSpace(userId, owner), principal: { kind: "ui-session" }, url: new URL(`http://x${path}`), path, method: "POST",
    body: async () => ({ projectId: "p1" }), json: () => {},
  } as never);
  try {
    await call("alice", "/api/git/push");
    assert.equal(transport.at(-1)?.POLYTH_GIT_CREDENTIAL_USERNAME, "p-alice");
    await assert.rejects(call("bob", "/api/git/fetch"), refused("connect-your-account"));
    assert.equal(transport.length, 1, "Git never ran for Bob");
    await call("owner", "/api/git/pull", true);
    assert.equal(transport.at(-1)?.POLYTH_GIT_CREDENTIAL_USERNAME, undefined, "the owner keeps the host's helpers");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(storage, { recursive: true, force: true });
  }
});

test("without host credentials no helper, askpass or SSH key of the host answers any remote", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-cred-off-"));
  try {
    const globalConfig = join(dir, "gitconfig");
    writeFileSync(globalConfig, [
      "[credential]",
      '\thelper = "!f() { echo username=HOSTWIDE; echo password=HOSTPW; }; f"',
      '[credential "https://gitlab.com"]',
      '\thelper = "!f() { echo username=OTHER; echo password=OTHERPW; }; f"',
      "",
    ].join("\n"));
    const fill = (host: string) => {
      const invocation = gitTransportInvocation(["fetch"]);
      const args = [...invocation.args.slice(0, -1), "credential", "fill"];
      return spawnSync("git", args, {
        input: `protocol=https\nhost=${host}\npath=o/r.git\n\n`,
        env: { ...process.env, ...invocation.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" },
        encoding: "utf8",
      }).stdout;
    };
    // The owner (host credentials on) still gets the host's helpers.
    assert.match(await withGitTransportAuth(null, async () => fill("github.com")), /^username=HOSTWIDE$/m);
    // Anyone else: only the account Polyth resolved, for its own origin.
    const own = await withGitTransportAuth({ origin: "https://github.com", credential: { username: "alice", password: SECRET } }, async () => ({
      github: fill("github.com"), gitlab: fill("gitlab.com"), ssh: gitTransportInvocation(["push"]).env.GIT_SSH_COMMAND,
    }), { hostCredentials: false });
    assert.match(own.github, /^username=alice$/m);
    assert.doesNotMatch(own.gitlab, /OTHER|HOSTWIDE/);
    assert.match(own.ssh ?? "", /IdentityAgent=none/);
    const none = await withGitTransportAuth(null, async () => fill("github.com"), { hostCredentials: false });
    assert.doesNotMatch(none, /HOSTWIDE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
