// memory.native-harness: Polyth memory in Automatic mode replaces a harness's
// own memory files, and their notes move in once, only to the host owner.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionPrivacy, SpaceContext } from "@polyth/contracts";
import { createMemoryService, createNativeHarnessMemory } from "../src/service.ts";
import { createMemoryStore } from "../src/store.ts";

const SPACE = "space-a";
const OWNER = "usr_owner";
const MEMBER = "usr_member";
const person = (userId: string, role: SpaceContext["role"] = "member"): SpaceContext => ({
  spaceId: SPACE, spaceSlug: SPACE, userId, role, deployment: "local-trusted", storageDir: join(tmpdir(), SPACE),
});
const readers = (...ids: string[]) => ids.map((userId) => ({ userId }));
const PRIVACY: Record<string, SessionPrivacy> = {
  ownerChat: { privateTo: OWNER, audience: readers(OWNER), projectAudience: 2 },
  memberChat: { privateTo: MEMBER, audience: readers(MEMBER), projectAudience: 2 },
  shared: { audience: readers(OWNER, MEMBER), projectAudience: 2 },
};
const NOTES = [
  { file: "fridge.md", title: "Keep the kitchen inventory from photos", body: "Ask for new photos after shopping.", type: "feedback" },
  { file: "cat.md", title: "Cat diet", body: "Wet food twice a day.", type: "user" },
];

function fixture() {
  const store = createMemoryStore(new DatabaseSync(":memory:"), SPACE);
  let enabled = true;
  const host = {
    forSpace: () => ({ projects: { get: async () => ({ id: "wellness", name: "Wellness" }) } }),
    systemSpaceContext: () => person("system:polyth-runtime", "owner"),
    personSpaceContext: (userId: string) => person(userId, userId === OWNER ? "owner" : "member"),
    sessionPrivacy: (_space: string, sessionId: string) => PRIVACY[sessionId],
    services: { get: () => undefined },
  } as never;
  const service = createMemoryService(host, { async prepareProject() { return { memory: store }; } });
  const native = createNativeHarnessMemory(host, service, () => enabled);
  const scope = { spaceId: SPACE, projectId: "wellness", principalId: "system:polyth-runtime" };
  const setMode = (mode: "auto" | "read-only" | "off") => store.updatePolicy(scope, { projectId: "wellness", expectedSettingsRevision: store.getPolicy(scope).settingsRevision, patch: { mode } });
  const ownerNotes = () => store.list({ ...scope, layers: [{ layer: "person", userId: OWNER, projectId: "wellness" }] }, { limit: 50 }).items.filter((item) => item.layer === "person");
  const adopt = (sessionId: string) => native.adopt({ spaceId: SPACE, projectId: "wellness", sessionId, harness: "claude-code", notes: NOTES });
  return { native, setMode, ownerNotes, adopt, store, scope, disable: () => { enabled = false; } };
}

test("replaces native memory only while project memory is Automatic and the package is on", async () => {
  const f = fixture();
  const replaces = () => f.native.replaces({ spaceId: SPACE, projectId: "wellness" });
  assert.equal(await replaces(), false, "memory starts off");
  f.setMode("auto");
  assert.equal(await replaces(), true);
  f.setMode("read-only");
  assert.equal(await replaces(), false);
  f.setMode("auto");
  f.disable();
  assert.equal(await replaces(), false, "a disabled package hands nothing over");
});

test("notes move once into the owner's personal notes; other chats take nothing", async () => {
  const f = fixture();
  f.setMode("auto");
  assert.deepEqual(await f.adopt("shared"), { imported: 0, deferred: true }, "never into a chat others read");
  assert.deepEqual(await f.adopt("memberChat"), { imported: 0, deferred: true }, "the host's files are not another member's");
  assert.deepEqual(await f.adopt("ownerChat"), { imported: 2 });
  const notes = f.ownerNotes();
  assert.deepEqual(notes.map((note) => note.title).sort(), ["Cat diet", "Keep the kitchen inventory from photos"]);
  assert.equal(notes.find((note) => note.title === "Cat diet")!.lifecycle, "active", "recalled right away");
  assert.equal(notes.find((note) => note.title.startsWith("Keep"))!.category, "convention");
  assert.deepEqual(await f.adopt("ownerChat"), { imported: 0 }, "a second launch adds nothing");

  // A note the person forgot stays forgotten on the next launch.
  const cat = notes.find((note) => note.title === "Cat diet")!;
  const ownerScope = { ...f.scope, layers: [{ layer: "person" as const, userId: OWNER, projectId: "wellness" }] };
  f.store.forget(ownerScope, { id: cat.id, projectId: "wellness", expectedRevision: cat.revision });
  assert.deepEqual(await f.adopt("ownerChat"), { imported: 0 });
  assert.equal(f.ownerNotes().filter((note) => note.title === "Cat diet" && note.lifecycle !== "forgotten").length, 0);
});

test("nothing moves while memory is not Automatic", async () => {
  const f = fixture();
  f.setMode("read-only");
  assert.deepEqual(await f.adopt("ownerChat"), { imported: 0, deferred: true });
});
