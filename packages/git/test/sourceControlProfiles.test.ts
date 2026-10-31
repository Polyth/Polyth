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

test("ssh-key mode keeps identityFile only for ssh-key", () => {
  const row = (authentication: unknown) => parseSourceControlProfileState(JSON.stringify({
    profiles: [{ id: "a", label: "A", provider: "github", authentication }],
  })).profiles[0]?.authentication;
  assert.deepEqual(row({ mode: "ssh-key", identityFile: "/h/.ssh/k" }), { mode: "ssh-key", identityFile: "/h/.ssh/k" });
  assert.deepEqual(row({ mode: "ssh-agent", identityFile: "/h/.ssh/k" }), { mode: "ssh-agent" });
});

test("server persistence: migrate at revision 0, save with revision, retry a 409 once", async () => {
  const store = new Map<string, string>([["polyth.sourceControlProfiles.v1", JSON.stringify({
    profiles: [{ id: "a", label: "A", provider: "generic", authentication: { mode: "system-git" } }],
  })]]);
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const m = (await import(`../widgets/sourceControlProfiles.ts?${"persist"}`)) as typeof import("../widgets/sourceControlProfiles.ts");
  let server = { state: m.parseSourceControlProfileState(null), revision: 0 };
  const saves: number[] = [];
  let conflictOnce = false;
  m.setSourceControlProfileTransport({
    load: async () => structuredClone(server),
    save: async (state, rev) => {
      saves.push(rev);
      if (conflictOnce) {
        conflictOnce = false;
        server = { state: { ...server.state, repositoryProfileIds: { other: "system-git" } }, revision: server.revision + 1 };
      }
      if (rev !== server.revision) throw Object.assign(new Error("conflict"), { status: 409 });
      server = { state, revision: rev + 1 };
      return structuredClone(server);
    },
  });
  await m.refreshSourceControlProfiles();
  assert.deepEqual(saves, [0]); // migration PUT
  assert.equal(server.state.profiles[0]?.id, "a");
  conflictOnce = true;
  m.setRepositorySourceControlProfile("p1", "a");
  assert.equal(m.getSourceControlProfileState().repositoryProfileIds.p1, "a"); // optimistic, synchronous
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(saves, [0, 1, 2]); // stale 1 → 409 → refetch → 2
  assert.deepEqual(server.state.repositoryProfileIds, { other: "system-git", p1: "a" });
});
