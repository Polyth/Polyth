import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createMemoryStore, type MemoryScope } from "../src/memory.ts";

const scope: MemoryScope = { spaceId: "space-a", projectId: "project-a", principalId: "user-a" };

test("memory recall prepares bounded bytes for an adapter transport and honors the policy fence", () => {
  const db = new DatabaseSync(":memory:");
  const store = createMemoryStore(db, scope.spaceId, () => 100);
  const policy = store.getPolicy(scope);
  store.updatePolicy(scope, {
    projectId: scope.projectId,
    expectedSettingsRevision: policy.settingsRevision,
    patch: { mode: "auto", contextBudget: { maxRecords: 6, maxBytes: 6 * 1024 } },
  });
  store.create(scope, {
    projectId: scope.projectId,
    title: "Transport contract",
    body: "Persist memory before runtime delivery and keep the project scope.",
    category: "convention",
    lifecycle: "active",
    evidence: "user-stated",
  });

  const contribution = store.recall(scope, {
    projectId: scope.projectId,
    intent: "runtime delivery project scope",
  });
  assert.equal(contribution.status, "selected");
  assert.ok(contribution.modelVisibleText);
  assert.ok(contribution.estimate.bytes <= 6 * 1024);

  const adapter = { received: "", send(text: string) { this.received = text; } };
  adapter.send(contribution.modelVisibleText!);
  assert.match(adapter.received, /Transport contract/);
  assert.ok(Buffer.byteLength(adapter.received, "utf8") <= 6 * 1024);

  const admittedFence = store.getPolicy(scope);
  assert.equal(
    admittedFence.generation === contribution.generation
      && admittedFence.settingsRevision === contribution.settingsRevision,
    true,
  );
  const changed = store.updatePolicy(scope, {
    projectId: scope.projectId,
    expectedSettingsRevision: admittedFence.settingsRevision,
    patch: { mode: "off" },
  });
  assert.notEqual(changed.generation, contribution.generation);
  assert.equal(store.recall(scope, { projectId: scope.projectId, intent: "runtime delivery" }).status, "blocked");
  assert.throws(() => store.recall({ ...scope, spaceId: "space-b" }, { projectId: scope.projectId, intent: "scope" }), /Space scope/);
  db.close();
});
