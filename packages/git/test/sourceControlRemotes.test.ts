import test from "node:test";
import assert from "node:assert/strict";
import { resolveSourceControlContext } from "@polyth/contracts/source-control";
import { api } from "@polyth/session/web-api";
import {
  inspectGitSourceControlRemotes,
  type GitRemoteExec,
} from "../src/sourceControlRemotes.ts";
import {
  removeSourceControlProfile,
  saveSourceControlProfile,
  setRepositorySourceControlProfile,
} from "../widgets/sourceControlProfiles.ts";
import { selectRepositorySourceControlRemote } from "../widgets/sourceControlRemote.ts";
import { reconcileSourceControlIdentity } from "../widgets/sourceControlRuntime.ts";

test("source-control remote selection prefers origin push over origin fetch", () => {
  const remote = selectRepositorySourceControlRemote({
    remotes: [
      {
        remoteName: "origin",
        direction: "fetch",
        url: "https://github.com/acme/repo.git",
        hostname: "ignored.example",
        fullPath: "ignored/path",
        protocol: "https",
      },
      {
        remoteName: "origin",
        direction: "push",
        url: "git@gitlab.com:acme/repo.git",
        hostname: "ignored.example",
        fullPath: "ignored/path",
        protocol: "ssh",
      },
    ],
    rejected: [],
  });

  assert.equal(remote?.hostname, "gitlab.com");
  assert.equal(remote?.protocol, "ssh");

  const resolution = resolveSourceControlContext({
    profiles: [{
      id: "github-work",
      label: "GitHub Work",
      provider: "github",
      authentication: { mode: "provider-cli" },
    }],
    repositoryProfileId: "github-work",
    remote,
  });
  assert.equal(resolution.ok, false);
  if (!resolution.ok) assert.equal(resolution.reason, "profile-host-mismatch");
});

test("source-control remote selection fails closed when origin contains an unsafe URL", () => {
  assert.throws(() => selectRepositorySourceControlRemote({
    remotes: [{
      remoteName: "origin",
      direction: "push",
      url: "git@github.com:acme/repo.git",
      hostname: "github.com",
      fullPath: "acme/repo",
      protocol: "ssh",
    }],
    rejected: [{ remoteName: "origin", direction: "fetch" }],
  }), /origin cannot be safely validated/i);
});

test("source-control remote selection permits repositories with no configured remotes", () => {
  assert.equal(selectRepositorySourceControlRemote({ remotes: [], rejected: [] }), null);
});

test("Git remote inspection never returns credential-bearing URLs", async () => {
  const exec: GitRemoteExec = async (_cwd, args) => {
    if (args.length === 1 && args[0] === "remote") return { stdout: "origin\n", stderr: "" };
    if (args.includes("--push")) {
      return { stdout: "git@github.com:acme/repo.git\n", stderr: "" };
    }
    return { stdout: "https://token@github.com/acme/repo.git\n", stderr: "" };
  };

  const inspection = await inspectGitSourceControlRemotes("/repo", exec);
  assert.deepEqual(inspection.rejected, [{ remoteName: "origin", direction: "fetch" }]);
  assert.equal(inspection.remotes.length, 1);
  assert.equal(inspection.remotes[0]?.direction, "push");
  assert.equal(inspection.remotes[0]?.hostname, "github.com");
  assert.equal(inspection.remotes.some((remote) => remote.url.includes("token@")), false);
});

test("runtime rejects a mismatched existing repository before changing Git identity", async () => {
  const projectId = "source-control-host-mismatch-project";
  const profileId = "source-control-host-mismatch-profile";
  saveSourceControlProfile({
    id: profileId,
    label: "GitHub Work",
    provider: "github",
    commitAuthor: { name: "Work Author", email: "work@example.com" },
    authentication: { mode: "provider-cli" },
  });
  setRepositorySourceControlProfile(projectId, profileId);

  const previousFetch = globalThis.fetch;
  const previousIdentity = api.gitIdentity;
  const previousIdentitySet = api.gitIdentitySet;
  let identityWrites = 0;
  api.gitIdentity = async () => ({ name: "System Author", email: "system@example.com" });
  api.gitIdentitySet = async (_projectId, identity) => {
    identityWrites += 1;
    return identity;
  };
  globalThis.fetch = (async () => new Response(JSON.stringify({
    remotes: [
      {
        remoteName: "origin",
        direction: "fetch",
        url: "https://gitlab.com/acme/repo.git",
        hostname: "gitlab.com",
        fullPath: "acme/repo",
        protocol: "https",
      },
      {
        remoteName: "origin",
        direction: "push",
        url: "git@gitlab.com:acme/repo.git",
        hostname: "gitlab.com",
        fullPath: "acme/repo",
        protocol: "ssh",
      },
    ],
    rejected: [],
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

  try {
    const state = await reconcileSourceControlIdentity(projectId);
    assert.equal(state.resolution.ok, false);
    if (!state.resolution.ok) assert.equal(state.resolution.reason, "profile-host-mismatch");
    assert.equal(identityWrites, 0);
    assert.deepEqual(state.identity, { name: "System Author", email: "system@example.com" });
  } finally {
    globalThis.fetch = previousFetch;
    api.gitIdentity = previousIdentity;
    api.gitIdentitySet = previousIdentitySet;
    removeSourceControlProfile(profileId);
    setRepositorySourceControlProfile(projectId, null);
  }
});
