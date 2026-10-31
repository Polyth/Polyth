// The header avatar and the Git view's "GitHub · @login" read who is signed in
// from /api/github/status?passive=true and /api/github/context. That answer
// belongs to the account Polyth acts as for the person, so it must not depend
// on the project, on which surface asked first, or on a passing `gh` failure,
// and it must never be another person's or Space's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteRequest } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { createPersonHostingAccounts } from "@polyth/git/person-accounts";
import { createGithubService, type ExecFn } from "@polyth/github";
import { createGithubPackage } from "../src/serverEntry.ts";
import { createUserCache, type UserCacheOptions } from "../src/userCache.ts";
import { fakePeople } from "../../git/test/fakePeople.ts";

const avatar = (login: string) => `https://avatars.example/${login}`;
const LOGIN_OF_TOKEN: Record<string, string> = { ghp_alice: "alice-gh", ghe_alice: "alice-ghe" };
const HOST_LOGIN = "host-gh";

type Api = "ok" | "network" | "signed-out";
type Who = { userId: string; spaceId?: string; owner?: boolean };

function fixture(cache?: UserCacheOptions) {
  const root = mkdtempSync(join(tmpdir(), "polyth-gh-user-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/demo.git"], { cwd: repo });
  const enterprise = join(root, "enterprise");
  mkdirSync(enterprise);
  execFileSync("git", ["init", "-q"], { cwd: enterprise });
  execFileSync("git", ["remote", "add", "origin", "https://ghe.corp.example/acme/demo.git"], { cwd: enterprise });
  const plain = join(root, "plain");
  mkdirSync(plain);
  const paths: Record<string, string> = { A: repo, B: repo, E: enterprise, plain };

  const script = { api: "ok" as Api };
  const calls: string[][] = [];
  const exec: ExecFn = async (_bin, args, opts) => {
    calls.push(args.slice(0, 2));
    if (args[0] === "--version") return { stdout: "gh version 2", stderr: "" };
    if (args[0] === "auth") return { stdout: "", stderr: "" };
    if (args[0] === "api") {
      if (script.api === "network") throw Object.assign(new Error("exit 1"), { stderr: "error connecting to api.github.com" });
      if (script.api === "signed-out") throw Object.assign(new Error("exit 4"), { stderr: "To get started with GitHub CLI, please run:  gh auth login" });
      const login = LOGIN_OF_TOKEN[opts.env?.GH_TOKEN ?? opts.env?.GH_ENTERPRISE_TOKEN ?? ""] ?? HOST_LOGIN;
      return { stdout: JSON.stringify({ login, avatar_url: avatar(login) }), stderr: "" };
    }
    if (args[0] === "repo") {
      return { stdout: JSON.stringify({ name: "demo", owner: { login: "acme" }, url: "https://github.com/acme/demo", description: null, defaultBranchRef: { name: "main" }, isPrivate: false }), stderr: "" };
    }
    throw Object.assign(new Error("unexpected gh call"), { stderr: args.join(" ") });
  };

  const people = fakePeople(root, { s1: ["alice", "bob", "owner"], s2: ["alice"] });
  const accounts = createPersonHostingAccounts(people, "github");
  const services = new Map<string, unknown>();
  const host = {
    people,
    services: {
      provide: (key: { id: string }, service: unknown) => { services.set(key.id, service); },
      get: (key: { id: string }) => services.get(key.id),
      require: (key: { id: string }) => services.get(key.id) ?? {},
      ids: () => [...services.keys()],
    },
    forSpace: () => ({
      projects: { get: async (id: string) => (paths[id] ? { id, path: paths[id], name: id } : undefined) },
      sessions: {},
    }),
    events: { append: async () => ({}) },
  } as unknown as ServerPackageHost;
  const pkg = createGithubPackage(host, { github: createGithubService({ exec }), users: createUserCache(cache) });

  const ask = async (who: Who, path: string): Promise<any> => {
    let payload: unknown;
    const spaceId = who.spaceId ?? "s1";
    const rc = {
      req: {}, res: {}, principal: { kind: "ui-session" },
      space: { spaceId, spaceSlug: spaceId, userId: who.userId, role: "member", deployment: "local-trusted", storageDir: "/x", instanceOwner: who.owner === true },
      url: new URL(`http://x${path}`), path: path.split("?")[0], method: "GET", body: async () => ({}),
      json: (_status: number, data: unknown) => { payload = data; },
    } as unknown as RouteRequest;
    assert.equal(await pkg.routes!(rc), true);
    return payload;
  };

  return {
    script, calls, pkg, accounts, ask,
    alice: { userId: "alice" } as Who,
    /** Alice's own GitHub account, turned on in Space s1 only. */
    connectAlice: () => accounts.connect("alice", { origin: "https://github.com", login: "alice-gh" }, "ghp_alice", "s1"),
    /** Her second account, on a GitHub Enterprise host. */
    connectAliceEnterprise: () => accounts.connect("alice", { origin: "https://ghe.corp.example", login: "alice-ghe" }, "ghe_alice", "s1"),
    passive: (who: Who, projectId = "A") => ask(who, `/api/github/status?projectId=${projectId}&passive=true`),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Let the lookups a read starts behind its answer finish. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a cold passive read finds the user itself, for every project, without a repository lookup", async () => {
  const f = fixture();
  try {
    f.connectAlice();
    await f.pkg.onEnable!();
    // Nothing opened the GitHub pane first: the header used to get "signed out" here.
    const first = await f.passive(f.alice, "A");
    assert.deepEqual([first.authenticated, first.user], [true, { login: "alice-gh", avatarUrl: avatar("alice-gh") }]);
    const other = await f.passive(f.alice, "B");
    assert.deepEqual(other.user, first.user, "another project, same person, same avatar");
    assert.deepEqual(f.calls, [["api", "user"]], "one `gh api user` served both projects; no --version, auth or repo view");
    assert.ok(!JSON.stringify([first, other]).includes("ghp_alice"), "the token never leaves the gh child");
  } finally {
    f.cleanup();
  }
});

test("the Git view's context reads the same memory as the header", async () => {
  const f = fixture();
  try {
    f.connectAlice();
    await f.pkg.onEnable!();
    await f.passive(f.alice);
    const context = await f.ask(f.alice, "/api/github/context?projectId=A");
    assert.equal(context.ok, true);
    assert.equal(context.data.user.login, "alice-gh");
    assert.deepEqual(context.data.remotes.map((remote: { hostname: string }) => remote.hostname), ["github.com"]);
    assert.equal(f.calls.length, 1);
  } finally {
    f.cleanup();
  }
});

test("a live status call feeds the memory, so a later passive read asks gh nothing", async () => {
  const f = fixture();
  try {
    f.connectAlice();
    await f.pkg.onEnable!();
    const live = await f.ask(f.alice, "/api/github/status?projectId=A");
    assert.equal(live.user.login, "alice-gh");
    // The auth probe and the repository lookup run side by side.
    assert.deepEqual(f.calls.map((call) => call[0]).sort(), ["--version", "api", "auth", "repo"]);
    const before = f.calls.length;
    const passive = await f.passive(f.alice, "B");
    assert.deepEqual(passive.user, live.user);
    assert.equal(f.calls.length, before);
  } finally {
    f.cleanup();
  }
});

test("a passing gh failure keeps the avatar; gh saying signed out removes it", async () => {
  const clock = { now: 1_000 };
  const f = fixture({ now: () => clock.now, freshMs: 1_000, retryMs: 100, coldWaitMs: 200 });
  try {
    f.connectAlice();
    await f.pkg.onEnable!();
    assert.equal((await f.passive(f.alice)).user.login, "alice-gh");

    f.script.api = "network";
    clock.now += 1_000;
    assert.equal((await f.passive(f.alice)).user.login, "alice-gh");
    await settle();
    clock.now += 1_000;
    assert.equal((await f.passive(f.alice)).user.login, "alice-gh", "an offline moment never turns the avatar into the placeholder");
    await settle();

    f.script.api = "signed-out";
    clock.now += 1_000;
    await f.passive(f.alice);
    await settle();
    clock.now += 1_000;
    const gone = await f.passive(f.alice);
    assert.deepEqual([gone.authenticated, gone.user], [false, null]);
  } finally {
    f.cleanup();
  }
});

test("nobody gets another person's or another Space's user", async () => {
  const f = fixture();
  try {
    f.connectAlice();
    await f.pkg.onEnable!();
    assert.equal((await f.passive(f.alice)).user.login, "alice-gh");

    const bob = await f.passive({ userId: "bob" });
    assert.deepEqual([bob.authenticated, bob.user, bob.code], [false, null, "git-account-required"]);
    const bobContext = await f.ask({ userId: "bob" }, "/api/github/context?projectId=A");
    assert.equal(bobContext.data.user, null);

    const owner = await f.passive({ userId: "owner", owner: true });
    assert.equal(owner.user.login, HOST_LOGIN, "the instance owner is the host's own gh login, not Alice");
    assert.equal((await f.passive(f.alice)).user.login, "alice-gh");

    const elsewhere = await f.passive({ userId: "alice", spaceId: "s2" });
    assert.deepEqual([elsewhere.authenticated, elsewhere.user], [false, null], "her account is not turned on in the Work Space");
    assert.deepEqual(f.calls, [["api", "user"], ["api", "user"]], "only Alice (own token) and the owner (host login) ever ran gh");
  } finally {
    f.cleanup();
  }
});

test("a person with two accounts sees the one that answers for each project's host", async () => {
  const f = fixture();
  try {
    f.connectAlice();
    f.connectAliceEnterprise();
    await f.pkg.onEnable!();
    assert.equal((await f.passive(f.alice, "A")).user.login, "alice-gh");
    assert.equal((await f.passive(f.alice, "E")).user.login, "alice-ghe", "the enterprise project is answered by the enterprise account");
    assert.equal((await f.passive(f.alice, "A")).user.login, "alice-gh", "and the first answer was not overwritten");
    assert.equal(f.calls.length, 2, "each account was asked once");
  } finally {
    f.cleanup();
  }
});

test("turning the account off stops its avatar from answering", async () => {
  const f = fixture();
  try {
    const account = f.connectAlice();
    await f.pkg.onEnable!();
    assert.equal((await f.passive(f.alice)).user.login, "alice-gh");
    f.accounts.setEnabled("alice", "s1", account.id, false);
    const off = await f.passive(f.alice);
    assert.deepEqual([off.authenticated, off.user], [false, null]);
    f.accounts.setEnabled("alice", "s1", account.id, true);
    assert.equal((await f.passive(f.alice)).user.login, "alice-gh");
  } finally {
    f.cleanup();
  }
});

test("a folder that is not a Git repository still reports who is signed in", async () => {
  const f = fixture();
  try {
    f.connectAlice();
    await f.pkg.onEnable!();
    const status = await f.passive(f.alice, "plain");
    assert.equal(status.user.login, "alice-gh");
  } finally {
    f.cleanup();
  }
});

test("disabling the package forgets the user, and a re-enabled one asks again", async () => {
  const f = fixture();
  try {
    f.connectAlice();
    await f.pkg.onEnable!();
    await f.passive(f.alice);
    assert.equal(f.calls.length, 1);
    await f.pkg.onDisable!();
    assert.equal(await f.pkg.routes!({ path: "/api/github/status" } as RouteRequest), false, "a disabled package answers nothing");
    await f.pkg.onEnable!();
    assert.equal((await f.passive(f.alice)).user.login, "alice-gh");
    assert.equal(f.calls.length, 2, "the first answer did not survive the disable");
  } finally {
    f.cleanup();
  }
});
