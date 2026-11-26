// A Space of another Polyth server is open (Polyth Link, "Joined Spaces"):
// this device's cached Git profiles — a person's names and emails on this
// server — must never be uploaded there, and that server's never cached here.
import test from "node:test";
import assert from "node:assert/strict";

const cached = JSON.stringify({
  profiles: [{ id: "me", label: "Me", provider: "generic", commitAuthor: { name: "Local Person", email: "local@example.test" }, authentication: { mode: "system-git" } }],
  globalDefaultProfileId: "me",
});
const storage = new Map<string, string>([["polyth.sourceControlProfiles.v1", cached]]);
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  },
  document: { cookie: "polyth_session=x; polyth_space=rmt_0123456789abcdef01234567" },
});

test("in a joined Space the cache stays out: nothing migrates up, nothing remote is cached", async () => {
  const profiles = await import("../widgets/sourceControlProfiles.ts");
  assert.deepEqual(profiles.getSourceControlProfileState().profiles, [], "this server's cached profiles are not shown there");
  const saved: unknown[] = [];
  const remote = {
    profiles: [{ id: "them", label: "Them", provider: "generic", commitAuthor: { name: "Remote Person", email: "remote@example.test" }, authentication: { mode: "system-git" } }],
    globalDefaultProfileId: "them",
  };
  // An empty, never-used server is exactly when a device migrates its cache up.
  let loads = 0;
  profiles.setSourceControlProfileTransport({
    load: async () => (loads++ === 0 ? { state: { profiles: [], globalDefaultProfileId: null }, revision: 0 } : { state: remote, revision: 3 }),
    save: async (state: unknown, revision: number) => { saved.push(state); return { state, revision: revision + 1 }; },
  } as never);
  await profiles.refreshSourceControlProfiles();
  assert.equal(saved.length, 0, "no migration writes this device's profiles to the other server");
  profiles.setSourceControlProfileTransport({
    load: async () => ({ state: remote, revision: 3 }),
    save: async (state: unknown, revision: number) => { saved.push(state); return { state, revision: revision + 1 }; },
  } as never);
  await profiles.refreshSourceControlProfiles();
  assert.equal(storage.get("polyth.sourceControlProfiles.v1"), cached, "the other server's profiles are not cached here");
});

test("in a joined Space the account's synced profiles neither replace that server's nor get saved there", async () => {
  const profiles = await import("../widgets/sourceControlProfiles.ts");
  const saved: unknown[] = [];
  profiles.setSourceControlProfileTransport({
    load: async () => ({ state: { profiles: [], globalDefaultProfileId: null }, revision: 5 }),
    save: async (state: unknown, revision: number) => { saved.push(state); return { state, revision: revision + 1 }; },
  } as never);
  // What account preference sync does when settings arrive or apply on boot.
  profiles.replaceSourceControlProfileState(JSON.parse(cached));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(saved.length, 0, "this server's person's profiles are not written to the other server");
  assert.ok(
    !profiles.getSourceControlProfileState().profiles.some((profile) => profile.id === "me"),
    "the account's profiles do not replace the other server's",
  );
});
