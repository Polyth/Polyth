import test from "node:test";
import assert from "node:assert/strict";
import { parseSourceControlProfileState } from "../widgets/sourceControlProfiles.ts";

test("legacy Git personas migrate deterministically into source control profiles", () => {
  const state = parseSourceControlProfileState(null, JSON.stringify([
    { id: "work", label: "Work", name: "Ada Lovelace", email: "ada@example.com" },
  ]));
  assert.deepEqual(state, {
    profiles: [{
      id: "work",
      label: "Work",
      provider: "generic",
      commitAuthor: { name: "Ada Lovelace", email: "ada@example.com" },
      authentication: { mode: "system-git" },
    }],
    globalDefaultProfileId: null,
    repositoryProfileIds: {},
    repositorySystemIdentities: {},
  });
});

test("invalid stored references are removed instead of resolving to stale identities", () => {
  const state = parseSourceControlProfileState(JSON.stringify({
    profiles: [{
      id: "work",
      label: "Work",
      provider: "gitlab",
      host: "gitlab.company.com",
      commitAuthor: { name: "Ada", email: "ada@company.com" },
      authentication: { mode: "managed", accountRef: "account-1" },
    }],
    globalDefaultProfileId: "deleted",
    repositoryProfileIds: {
      a: "work",
      b: "deleted",
      c: "system-git",
    },
    repositorySystemIdentities: {
      a: { name: "System Ada", email: "system@example.com" },
      broken: { name: "Missing email" },
    },
  }));
  assert.equal(state.globalDefaultProfileId, null);
  assert.deepEqual(state.repositoryProfileIds, { a: "work", c: "system-git" });
  assert.deepEqual(state.repositorySystemIdentities, {
    a: { name: "System Ada", email: "system@example.com" },
  });
});

test("profile parser keeps opaque credential references but never invents secret fields", () => {
  const state = parseSourceControlProfileState(JSON.stringify({
    profiles: [{
      id: "self-hosted",
      label: "Company GitLab",
      provider: "gitlab",
      host: "gitlab.company.com",
      username: "ada",
      authentication: { mode: "managed", credentialRef: "secure:42", accountRef: "gitlab:42" },
    }],
    globalDefaultProfileId: "self-hosted",
    repositoryProfileIds: {},
    repositorySystemIdentities: {},
  }));
  assert.deepEqual(state.profiles[0]?.authentication, {
    mode: "managed",
    credentialRef: "secure:42",
    accountRef: "gitlab:42",
  });
  assert.equal("token" in (state.profiles[0] as unknown as Record<string, unknown>), false);
});

test("profile metadata is normalized to string-only values", () => {
  const state = parseSourceControlProfileState(JSON.stringify({
    profiles: [{
      id: "work",
      label: "Work",
      provider: "generic",
      authentication: { mode: "system-git" },
      metadata: {
        team: " platform ",
        retries: 3,
        nested: { name: "platform" },
        blank: "   ",
      },
    }],
    globalDefaultProfileId: null,
    repositoryProfileIds: {},
    repositorySystemIdentities: {},
  }));
  assert.deepEqual(state.profiles[0]?.metadata, { team: "platform" });
});
