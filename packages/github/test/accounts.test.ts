import test from "node:test";
import assert from "node:assert/strict";
import type { SpaceContext } from "@polyth/contracts";
import { createGithubCredentialProvider, parseGhAuthStatus, type GhAccountExec } from "../src/accounts.ts";

const space = { spaceId: "s1", spaceSlug: "s1", userId: "u1", role: "owner", deployment: "local-trusted", storageDir: "/x" } as SpaceContext;

const MULTI = [
  "github.com",
  "  ✓ Logged in to github.com account alice (keyring)",
  "  - Active account: true",
  "  - Git operations protocol: https",
  "  - Token: gho_************************************",
  "",
  "  ✓ Logged in to github.com account bob (keyring)",
  "  - Active account: false",
  "",
  "ghe.corp.example",
  "  X Failed to log in to ghe.corp.example account carol (default)",
  "  - Active account: true",
].join("\n");

test("gh auth status parsing covers single- and multi-account output and skips failed logins", () => {
  assert.deepEqual(parseGhAuthStatus("github.com\n  ✓ Logged in to github.com as devmaxer (/home/u/.config/gh/hosts.yml)\n  ✓ Git operations for github.com configured to use ssh protocol."), [
    { host: "github.com", login: "devmaxer", active: true },
  ]);
  assert.deepEqual(parseGhAuthStatus(MULTI), [
    { host: "github.com", login: "alice", active: true },
    { host: "github.com", login: "bob", active: false },
  ]);
  assert.deepEqual(parseGhAuthStatus("You are not logged into any GitHub hosts. Run gh auth login to authenticate."), []);
});

function exec(responses: Record<string, { ok: boolean; stdout?: string; stderr?: string }>, calls: string[][] = []): GhAccountExec {
  return async (args) => {
    calls.push(args);
    const hit = responses[args.join(" ")] ?? { ok: false, stderr: "unknown command" };
    return { ok: hit.ok, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
  };
}

test("GitHub accounts come from gh logins and only in local-trusted deployments", async () => {
  const provider = createGithubCredentialProvider({ exec: exec({ "auth status": { ok: true, stderr: MULTI } }), allowed: () => true });
  assert.deepEqual((await provider.accounts(space)).map((row) => [row.accountId, row.origin, row.active]), [
    ["github.com/alice", "https://github.com", true],
    ["github.com/bob", "https://github.com", false],
  ]);
  const hosted = createGithubCredentialProvider({ exec: exec({ "auth status": { ok: true, stderr: MULTI } }), allowed: () => false });
  assert.deepEqual(await hosted.accounts(space), []);
});

test("GitHub credentials use the exact account token, fall back only for the active login", async () => {
  const calls: string[][] = [];
  const multi = createGithubCredentialProvider({ allowed: () => true, exec: exec({
    "auth status": { ok: true, stdout: MULTI },
    "auth token --hostname github.com --user bob": { ok: true, stdout: "gho_bob\n" },
  }, calls) });
  assert.deepEqual(await multi.credential(space, "github.com/bob"), { username: "bob", password: "gho_bob" });

  // Older gh: no --user flag. The active login can still use its token…
  const older = createGithubCredentialProvider({ allowed: () => true, exec: exec({
    "auth status": { ok: true, stdout: MULTI },
    "auth token --hostname github.com": { ok: true, stdout: "gho_alice\n" },
  }) });
  assert.deepEqual(await older.credential(space, "github.com/alice"), { username: "alice", password: "gho_alice" });
  // …but an inactive login is never silently swapped for the active one.
  await assert.rejects(older.credential(space, "github.com/bob"), { code: "account-inactive" });

  // gh too old to print tokens: Git's gh credential helper serves the active login.
  const oldest = createGithubCredentialProvider({ allowed: () => true, exec: exec({ "auth status": { ok: true, stdout: MULTI } }) });
  assert.equal(await oldest.credential(space, "github.com/alice"), null);
  await assert.rejects(oldest.credential(space, "github.com/nobody"), { code: "not-found" });
});

test("personal GitHub accounts are listed and resolved only for their owner, where they turned them on", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fakePeople } = await import("../../git/test/fakePeople.ts");
  const { createPersonHostingAccounts } = await import("@polyth/git/person-accounts");
  const root = mkdtempSync(join(tmpdir(), "polyth-gh-people-"));
  try {
    const people = createPersonHostingAccounts(fakePeople(root, { s1: ["alice", "bob"], s2: ["alice"] }), "github");
    const mine = people.connect("alice", { origin: "https://github.com", login: "alice-gh" }, "ghp_alice", "s1");
    const as = (userId: string, spaceId = "s1", instanceOwner = false) =>
      ({ ...space, userId, spaceId, role: "member", instanceOwner }) as SpaceContext;
    const ghCalls: string[][] = [];
    const provider = createGithubCredentialProvider({
      exec: exec({ "auth status": { ok: true, stdout: MULTI } }, ghCalls),
      allowed: (ctx) => (ctx as SpaceContext & { instanceOwner?: boolean }).instanceOwner === true,
      people,
    });
    assert.deepEqual((await provider.accounts(as("alice"))).map((row) => [row.accountId, row.login, row.owner]), [[mine.id, "alice-gh", "personal"]]);
    assert.deepEqual(await provider.credential(as("alice"), mine.id), { username: "alice-gh", password: "ghp_alice" });
    // Bob neither sees nor resolves Alice's account, and never the host's gh logins.
    assert.deepEqual(await provider.accounts(as("bob")), []);
    await assert.rejects(provider.credential(as("bob"), mine.id), { code: "not-found" });
    await assert.rejects(provider.credential(as("bob"), "github.com/alice"), { code: "not-found" });
    assert.equal(ghCalls.length, 0, "gh is never asked on Bob's behalf");
    // Alice's account is off in a Space she did not turn it on in.
    assert.deepEqual(await provider.accounts(as("alice", "s2")), []);
    await assert.rejects(provider.credential(as("alice", "s2"), mine.id), { code: "not-found" });
    // The instance owner sees the host's logins as installation accounts.
    assert.deepEqual((await provider.accounts(as("owner", "s1", true))).map((row) => [row.accountId, row.owner]), [
      ["github.com/alice", "installation"], ["github.com/bob", "installation"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
