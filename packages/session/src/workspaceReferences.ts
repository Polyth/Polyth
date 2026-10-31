import type { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import type { SessionProjection } from "@polyth/contracts";

function visitReferences(projection: SessionProjection, visit: (path: string, kind: "isolation" | "usage") => void): void {
  const add = (path: unknown, kind: "isolation" | "usage") => { if (typeof path === "string" && path) visit(resolve(path), kind); };
  add(projection.worktreePath, "usage");
  add(projection.runtimeBinding?.location.directory, "usage");
  for (const row of projection.workspace?.repositories ?? []) add(row.path, "usage");
  for (const isolation of [projection.isolation, ...(projection.workspace?.repositories.map((row) => row.isolation) ?? [])]) {
    if (isolation?.kind === "git-worktree") add(isolation.worktreePath, "isolation");
  }
}

export function projectionUsesWorkspace(projection: SessionProjection, projectId: string, cwd: string): boolean {
  if (projection.projectId === projectId && !projection.workspace && !projection.worktreePath) return true;
  const path = resolve(cwd);
  let found = false;
  visitReferences(projection, (candidate) => { if (candidate === path) found = true; });
  return found;
}

/** Host-internal physical checkout index. Deliberately spans Spaces: a
 * foreign tenant must not borrow an occupied local checkout. Never exposed
 * as a tenant lookup API or included in conflict diagnostics. */
export function workspaceReferences(db: DatabaseSync) {
  const clear = db.prepare("DELETE FROM workspace_references WHERE session_id = ?");
  const insert = db.prepare("INSERT OR IGNORE INTO workspace_references(session_id, path, kind) VALUES(?, ?, ?)");
  const dirty = db.prepare("SELECT 1 FROM workspace_reference_dirty WHERE session_id = ?");
  const clean = db.prepare("DELETE FROM workspace_reference_dirty WHERE session_id = ?");
  const batch = db.prepare("SELECT p.data FROM workspace_reference_dirty d JOIN projections p ON p.session_id = d.session_id LIMIT 128");
  const lookup = db.prepare(`SELECT p.data FROM workspace_references r JOIN projections p ON p.session_id = r.session_id
    WHERE r.path = ? AND r.kind = ? AND r.session_id <> ? LIMIT 1`);
  const legacy = db.prepare(`SELECT data FROM projections WHERE project_id = ?
    AND json_extract(data, '$.workspace') IS NULL AND json_extract(data, '$.worktreePath') IS NULL AND session_id <> ? LIMIT 1`);
  const replace = (projection: SessionProjection, force = false): void => {
    if (!force && !dirty.get(projection.id)) return;
    clear.run(projection.id);
    visitReferences(projection, (path, kind) => { insert.run(projection.id, path, kind); });
    clean.run(projection.id);
  };
  return {
    replace,
    // Only old binaries/direct writers can leave dirty rows. Repair bounded
    // batches before lookup; ordinary create/rebind/update repairs in its
    // existing projection transaction. SQL-only triggers survive rollback.
    repairBatch(): number {
      const rows = batch.all() as Array<{ data: string }>;
      for (const row of rows) replace(JSON.parse(row.data) as SessionProjection);
      return rows.length;
    },
    find(path: string, kind: "isolation" | "usage", except = ""): SessionProjection | undefined {
      const row = lookup.get(resolve(path), kind, except) as { data: string } | undefined;
      return row ? JSON.parse(row.data) as SessionProjection : undefined;
    },
    legacy(projectId: string, except: string): SessionProjection | undefined {
      const row = legacy.get(projectId, except) as { data: string } | undefined;
      return row ? JSON.parse(row.data) as SessionProjection : undefined;
    },
  };
}

/** Called only inside the existing controlled schema migration transaction. */
export function installWorkspaceReferences(db: DatabaseSync): void {
  db.exec(`CREATE TABLE workspace_references(session_id TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL,
      PRIMARY KEY(session_id, path, kind));
    CREATE INDEX idx_workspace_reference_path ON workspace_references(path, kind, session_id);
    CREATE TABLE workspace_reference_dirty(session_id TEXT PRIMARY KEY);
    CREATE INDEX idx_legacy_workspace_project ON projections(project_id)
      WHERE json_extract(data, '$.workspace') IS NULL AND json_extract(data, '$.worktreePath') IS NULL;
    CREATE TRIGGER workspace_reference_insert AFTER INSERT ON projections BEGIN
      INSERT OR IGNORE INTO workspace_reference_dirty VALUES(new.session_id); END;
    CREATE TRIGGER workspace_reference_update AFTER UPDATE ON projections WHEN
      json_extract(old.data, '$.workspace') IS NOT json_extract(new.data, '$.workspace') OR
      json_extract(old.data, '$.worktreePath') IS NOT json_extract(new.data, '$.worktreePath') OR
      json_extract(old.data, '$.isolation') IS NOT json_extract(new.data, '$.isolation') OR
      json_extract(old.data, '$.runtimeBinding.location.directory') IS NOT json_extract(new.data, '$.runtimeBinding.location.directory')
      BEGIN INSERT OR IGNORE INTO workspace_reference_dirty VALUES(new.session_id); END;
    CREATE TRIGGER workspace_reference_delete AFTER DELETE ON projections BEGIN
      DELETE FROM workspace_references WHERE session_id = old.session_id;
      DELETE FROM workspace_reference_dirty WHERE session_id = old.session_id; END;`);
  const index = workspaceReferences(db);
  for (const row of db.prepare("SELECT data FROM projections").iterate()) index.replace(JSON.parse(row.data as string) as SessionProjection, true);
}
