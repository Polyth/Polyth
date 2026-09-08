// WP8: server-owned agent profiles — CRUD, revision conflicts, immutable
// model identity, optional-field clearing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/index.ts";

const freshStore = () => createStore(join(mkdtempSync(join(tmpdir(), "polyth-prof-")), "s.db"));

test("profile create/list/get round-trips all fields", async () => {
  const store = freshStore();
  const p = await store.profileCreate({
    name: "Fast reviewer",
    providerID: "anthropic",
    modelID: "claude-4",
    agent: "review",
    thinking: "low",
    features: { web: true },
    notes: "cheap loops",
    color: "#7aa2f7",
  });
  assert.ok(p.id);
  assert.equal(p.revision, 1);
  assert.equal(p.agent, "review");
  assert.equal(p.harnessId, "opencode");
  assert.deepEqual(p.features, { web: true });

  const listed = await store.profileList();
  assert.equal(listed.length, 1);
  assert.deepEqual(await store.profileGet(p.id), listed[0]);
  assert.equal(await store.profileGet("nope"), undefined);
});

test("new profiles persist explicit harness identity and can change it deliberately", async () => {
  const store = freshStore();
  const profile = await store.profileCreate({ name: "Codex review", harnessId: "codex", providerID: "openai", modelID: "gpt-5", features: {} });
  assert.equal(profile.harnessId, "codex");
  const updated = await store.profileUpdate(profile.id, { harnessId: "opencode" }, profile.revision);
  assert.equal(updated.harnessId, "opencode");
});

test("profile update bumps revision, rejects stale revision and empty name", async () => {
  const store = freshStore();
  const p = await store.profileCreate({ name: "A", providerID: "x", modelID: "m", features: {} });

  const up = await store.profileUpdate(p.id, { name: "B", thinking: "high" }, p.revision);
  assert.equal(up.name, "B");
  assert.equal(up.thinking, "high");
  assert.equal(up.revision, p.revision + 1);

  await assert.rejects(
    () => store.profileUpdate(p.id, { name: "C" }, p.revision),
    (err: Error & { code?: string }) => err.code === "conflict",
  );
  await assert.rejects(() => store.profileCreate({ name: "  ", providerID: "x", modelID: "m", features: {} }));
});

test("optional fields clear back to undefined; remove is idempotent", async () => {
  const store = freshStore();
  const p = await store.profileCreate({
    name: "A", providerID: "x", modelID: "m", agent: "build", notes: "n", features: {},
  });
  // Explicit empty string clears the column (route maps null → "").
  const cleared = await store.profileUpdate(p.id, { agent: "", notes: "" }, p.revision);
  assert.equal(cleared.agent, undefined);
  assert.equal(cleared.notes, undefined);

  assert.equal(await store.profileRemove(p.id), true);
  assert.equal(await store.profileRemove(p.id), false);
  assert.deepEqual(await store.profileList(), []);
});
