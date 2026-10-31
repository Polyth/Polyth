import assert from "node:assert/strict";
import test from "node:test";
import {
  detectGitRemotes,
  normalizeGitlabInstance,
  parseGitRemoteUrl,
  requireCurrentRemote,
  validateGitlabInstance,
  type GitExec,
} from "../src/remote.ts";

test("instance normalization accepts only a bare secure origin", () => {
  assert.deepEqual(normalizeGitlabInstance("https://GitLab.Example:8443/"), {
    origin: "https://gitlab.example:8443",
    host: "gitlab.example:8443",
    hostname: "gitlab.example",
    apiBaseUrl: "https://gitlab.example:8443/api/v4/",
  });
  assert.throws(() => normalizeGitlabInstance("https://gitlab.example/group"), /must not include a path/);
  assert.throws(() => normalizeGitlabInstance("https://user:pass@gitlab.example"), /without credentials/);
  assert.throws(() => normalizeGitlabInstance("http://gitlab.example"), /HTTPS/);
  assert.equal(parseGitRemoteUrl("https://user:secret@gitlab.example/group/repo.git"), null);
  assert.equal(parseGitRemoteUrl("https://gitlab.example/group/repo.git?private_token=secret"), null);
  assert.equal(parseGitRemoteUrl("https://gitlab.example/group/repo.git#token"), null);
  assert.equal(parseGitRemoteUrl(" https://gitlab.example/group/repo.git"), null);
  assert.equal(parseGitRemoteUrl("https://gitlab.example/repo.git"), null);
  assert.equal(parseGitRemoteUrl("git@gitlab.example:repo.git"), null);
  assert.equal(parseGitRemoteUrl("git@gitlab.example:group/repo.git\nsecret"), null);
  assert.equal(parseGitRemoteUrl(`https://gitlab.example/group/${"r".repeat(8_193)}.git`), null);
  assert.equal(parseGitRemoteUrl("user:secret@gitlab.example:group/repo.git"), null);
});

test("private instances require a local-trusted deployment and metadata remains blocked", async () => {
  const instance = normalizeGitlabInstance("https://gitlab.internal");
  const privateDns = async () => ["10.0.0.8"];
  await assert.rejects(() => validateGitlabInstance(instance, "server-trusted", privateDns), /private/);
  assert.equal((await validateGitlabInstance(instance, "local-trusted", privateDns)).origin, instance.origin);
  await assert.rejects(
    () => validateGitlabInstance(instance, "local-trusted", async () => ["169.254.169.254"]),
    /metadata|link-local/,
  );
});

test("remote detection is local, returns every URL, and stale bindings fail", async () => {
  const calls: string[][] = [];
  const exec: GitExec = async (_bin, args) => {
    calls.push(args);
    if (args.length === 1) return { stdout: "origin\nupstream\n", stderr: "" };
    if (args.at(-1) === "origin") {
      return { stdout: "git@gitlab.com:group/repo.git\nhttps://gitlab.com/group/repo.git\n", stderr: "" };
    }
    return { stdout: "ssh://git@gitlab.example/team/upstream.git\n", stderr: "" };
  };
  const remotes = await detectGitRemotes("/repo", exec);
  assert.equal(remotes.length, 3);
  assert.deepEqual(parseGitRemoteUrl("git@gitlab.com:group/repo.git"), {
    url: "git@gitlab.com:group/repo.git", hostname: "gitlab.com", fullPath: "group/repo", protocol: "ssh",
  });
  assert.deepEqual(calls[0], ["remote"]);
  const binding = {
    projectId: "p1", remoteName: "origin", observedUrl: "git@gitlab.com:group/repo.git",
    instanceId: "i1", accountId: "a1",
  };
  assert.equal(requireCurrentRemote(binding, remotes).fullPath, "group/repo");
  assert.throws(() => requireCurrentRemote({ ...binding, observedUrl: "git@gitlab.com:other/repo.git" }, remotes), /changed/);
});
