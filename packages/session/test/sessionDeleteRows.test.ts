import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "@polyth/session";

test("deleteSession removes session-keyed rows and keeps tombstone/runtime/backend identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-session-delete-"));
  const path = join(dir, "t.db");
  const store = createStore(path);
  try {
    await store.append("s1", "session/created", { projectId: "p1" });
    await store.append("s1", "user/message", { text: "hi" });
    await store.enqueue("s1", "queued text", "queue");
    await store.setReadCursor("s1", 1);
    await store.prepareOperation({
      sessionId: "s1",
      mutationKind: "turn-submit",
      intentEvent: { type: "user/message", data: { text: "run" } },
    });
    await store.close();

    const db = new DatabaseSync(path);
    db.exec(`
      INSERT INTO attention_open (session_id, kind, request_id) VALUES ('s1', 'permission', 'req-1');
      INSERT INTO response_intents (session_id, kind, request_id, operation_id, payload, created_at)
        VALUES ('s1', 'permission', 'req-1', 'op-intent', '{}', 1);
      INSERT INTO observations (
        authority_id, directory, workspace, backend_session_id, artifact_kind, entity_id, revision,
        session_id, observed_generation, reconciliation_ordinal, canonical_seqs, observed_at
      ) VALUES (
        'auth', '/proj', 'ws', 'be-1', 'message', 'm1', '1',
        's1', 1, 1, '[]', 1
      );
      INSERT INTO session_reconciliations (session_id, ordinal, state, reason, updated_at)
        VALUES ('s1', 1, 'ready', NULL, 1);
      INSERT INTO observation_checkpoints (
        authority_id, directory, workspace, backend_session_id, artifact_kind, entity_id,
        revision, state_rank, value, updated_at
      ) VALUES ('auth', '/proj', 'ws', 'be-1', 'message', 'm1', '1', 1, '{}', 1);
      INSERT INTO observation_cursors (
        authority_id, directory, workspace, backend_session_id, channel, cursor_after, updated_at
      ) VALUES ('auth', '/proj', 'ws', 'be-1', 'messages', 'c1', 1);
      INSERT INTO deletion_tombstones (
        canonical_session_id, authority_id, endpoint_generation, directory, workspace,
        backend_session_id, operation_id, created_at
      ) VALUES ('s1', 'auth', 1, '/proj', 'ws', 'be-1', 'tomb-op', 1);
      INSERT INTO folders (id, project_id, parent_id, name, position, revision)
        VALUES ('folder-1', 'p1', NULL, 'Work', 0, 1);
      INSERT INTO labels (id, name, color, position, revision)
        VALUES ('label-1', 'Hot', '#f00', 0, 1);
      INSERT INTO agent_profiles (id, name, provider_id, model_id, features, created_at, updated_at)
        VALUES ('profile-1', 'Default', 'openai', 'gpt', '{}', 1, 1);
    `);
    const runtimeBefore = db.prepare("SELECT COUNT(*) AS n FROM runtime_operations WHERE session_id = 's1'").get() as { n: number };
    assert.ok(Number(runtimeBefore.n) > 0);
    db.close();

    const reopened = createStore(path);
    await reopened.deleteSession("s1");
    await reopened.close();

    const after = new DatabaseSync(path);
    const count = (sql: string): number =>
      Number((after.prepare(sql).get() as { n: number }).n);
    const tables = (after.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);

    const sessionOwned = new Set([
      "events", "projections", "session_queue", "attention_open",
      "response_intents", "session_read", "observations", "session_reconciliations",
    ]);
    const backendIdentity = new Set([
      "runtime_operations", "observation_checkpoints", "observation_cursors", "deletion_tombstones",
    ]);
    const global = new Set(["folders", "labels", "agent_profiles", "schema_meta"]);
    for (const name of tables) {
      assert.ok(
        sessionOwned.has(name) || backendIdentity.has(name) || global.has(name),
        `unclassified table ${name} — classify it as session-owned, backend identity, or global`,
      );
    }

    assert.equal(count("SELECT COUNT(*) AS n FROM events WHERE session_id = 's1'"), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM projections WHERE session_id = 's1'"), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM session_queue WHERE session_id = 's1'"), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM attention_open WHERE session_id = 's1'"), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM response_intents WHERE session_id = 's1'"), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM session_read WHERE session_id = 's1'"), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM observations WHERE session_id = 's1'"), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM session_reconciliations WHERE session_id = 's1'"), 0);
    assert.ok(count("SELECT COUNT(*) AS n FROM runtime_operations WHERE session_id = 's1'") > 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM observation_checkpoints"), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM observation_cursors"), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM deletion_tombstones WHERE canonical_session_id = 's1'"), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM folders"), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM labels"), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM agent_profiles"), 1);
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
