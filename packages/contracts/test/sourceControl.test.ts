import test from "node:test";
import assert from "node:assert/strict";
import {
  SYSTEM_SOURCE_CONTROL_PROFILE_ID,
  inferSourceControlProvider,
  matchingSourceControlProfiles,
  parseSourceControlRemoteUrl,
  resolveSourceControlContext,
  sourceControlProfileMatchesRemote,
  type SourceControlProfile,
} from "@polyth/contracts/source-control";

const work: SourceControlProfile = {
  id: "work",
  label: "Work",
  provider: "gitlab",
  host: "gitlab.company.com",
  account: "Work",
  username: "Max",
  commitAuthor: { name: "Max", email: "Max@company.com" },
  authentication: { mode: "managed", accountRef: "gitlab-account-1" },
};

const personal: SourceControlProfile = {
  id: "personal",
  label: "Personal",
  provider: "github",
  username: "Max",
  commitAuthor: { name: "Max", email: "Max@example.com" },
  authentication: { mode: "provider-cli" },
};

test("source control remote parsing supports HTTPS, SSH, SCP and rejects credential-bearing URLs", () => {
  assert.deepEqual(parseSourceControlRemoteUrl("https://github.com/acme/repo.git"), {
    url: "https://github.com/acme/repo.git",
    hostname: "github.com",
    fullPath: "acme/repo",
    protocol: "https",
  });
  assert.deepEqual(parseSourceControlRemoteUrl("ssh://git@gitlab.company.com/platform/api.git"), {
    url: "ssh://git@gitlab.company.com/platform/api.git",
    hostname: "gitlab.company.com",
    fullPath: "platform/api",
    protocol: "ssh",
  });
  assert.deepEqual(parseSourceControlRemoteUrl("git@gitlab.company.com:platform/api.git"), {
    url: "git@gitlab.company.com:platform/api.git",
    hostname: "gitlab.company.com",
    fullPath: "platform/api",
    protocol: "ssh",
  });
  assert.deepEqual(parseSourceControlRemoteUrl("ada@gitlab.company.com:platform/api.git"), {
    url: "ada@gitlab.company.com:platform/api.git",
    hostname: "gitlab.company.com",
    fullPath: "platform/api",
    protocol: "ssh",
  });
  assert.equal(parseSourceControlRemoteUrl("https://token@github.com/acme/repo.git"), null);
  assert.equal(parseSourceControlRemoteUrl("https://user:secret@github.com/acme/repo.git"), null);
});

test("profile matching is host-safe and understands provider defaults", () => {
  const github = parseSourceControlRemoteUrl("git@github.com:acme/repo.git")!;
  const selfHosted = parseSourceControlRemoteUrl("git@gitlab.company.com:platform/api.git")!;
  assert.equal(sourceControlProfileMatchesRemote(personal, github), true);
  assert.equal(sourceControlProfileMatchesRemote(personal, selfHosted), false);
  assert.equal(sourceControlProfileMatchesRemote(work, selfHosted), true);
  assert.equal(sourceControlProfileMatchesRemote(work, github), false);
  assert.deepEqual(matchingSourceControlProfiles([personal, work], selfHosted).map((profile) => profile.id), ["work"]);
  assert.equal(inferSourceControlProvider(selfHosted, [work]), "gitlab");
});

test("repository override wins and preserves one coherent commit/auth context", () => {
  const remote = parseSourceControlRemoteUrl("git@gitlab.company.com:platform/api.git")!;
  const result = resolveSourceControlContext({
    profiles: [personal, work],
    remote,
    repositoryProfileId: "work",
    projectProfileId: "personal",
    globalProfileId: "personal",
    systemIdentity: { name: "System", email: "system@example.com" },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.source, "repository");
  assert.equal(result.profile?.id, "work");
  assert.equal(result.provider, "gitlab");
  assert.deepEqual(result.commitAuthor, work.commitAuthor);
  assert.deepEqual(result.authentication, work.authentication);
});

test("an explicit incompatible repository profile blocks instead of reusing credentials on another host", () => {
  const remote = parseSourceControlRemoteUrl("git@gitlab.company.com:platform/api.git")!;
  const result = resolveSourceControlContext({
    profiles: [personal, work],
    remote,
    repositoryProfileId: "personal",
    globalProfileId: "work",
  });
  assert.deepEqual(result, {
    ok: false,
    source: "repository",
    profileId: "personal",
    profile: personal,
    provider: "gitlab",
    remote,
    reason: "profile-host-mismatch",
  });
});

test("missing profile references are inspectable rather than silently changing identity", () => {
  const result = resolveSourceControlContext({ profiles: [personal], repositoryProfileId: "deleted-profile" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.source, "repository");
  assert.equal(result.reason, "profile-not-found");
});

test("system Git fallback and explicit overrides preserve their resolution source", () => {
  const remote = parseSourceControlRemoteUrl("git@github.com:acme/repo.git")!;
  const fallback = resolveSourceControlContext({
    profiles: [personal],
    remote,
    systemIdentity: { name: "System User", email: "system@example.com" },
  });
  assert.equal(fallback.ok, true);
  if (fallback.ok) {
    assert.equal(fallback.source, "system");
    assert.equal(fallback.profile, null);
    assert.equal(fallback.provider, "github");
    assert.deepEqual(fallback.authentication, { mode: "system-git" });
  }

  const explicit = resolveSourceControlContext({
    profiles: [personal],
    remote,
    repositoryProfileId: SYSTEM_SOURCE_CONTROL_PROFILE_ID,
    systemIdentity: { name: "System User", email: "system@example.com" },
  });
  assert.equal(explicit.ok, true);
  if (explicit.ok) {
    assert.equal(explicit.source, "repository");
    assert.equal(explicit.profile, null);
    assert.equal(explicit.provider, "github");
    assert.deepEqual(explicit.authentication, { mode: "system-git" });
  }
});
