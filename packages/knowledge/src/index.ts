// Project knowledge (WP10): notes, plans, and (dark-by-default) agent memory.
// Server-owned, project-scoped, revisioned, searchable. node:sqlite (WAL).
// Attach-to-chat is a SESSION concern: the caller appends knowledge/attached
// with the exact revision+body to the event log before any model/UI use —
// this package only stores and serves the records.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type KnowledgeKind = "note" | "spec" | "plan" | "memory";

export interface KnowledgeItem {
  id: string;
  projectId: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  tags: string[];
  source: "user" | "agent" | "import";
  sourceSessionId?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** List DTO: bounded snippet instead of the full body. */
export interface KnowledgeListItem extends Omit<KnowledgeItem, "body"> {
  snippet: string;
  bodyBytes: number;
}

export interface KnowledgeCreateInput {
  projectId: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  tags?: string[];
  source?: KnowledgeItem["source"];
  sourceSessionId?: string;
}

export interface KnowledgePatch {
  title?: string;
  body?: string;
  tags?: string[];
  kind?: KnowledgeKind;
}

export interface KnowledgeQuery {
  projectId: string;
  kind?: KnowledgeKind;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface KnowledgeStore {
  list(query: KnowledgeQuery): Promise<{ items: KnowledgeListItem[]; total: number }>;
  get(id: string): Promise<KnowledgeItem | undefined>;
  create(input: KnowledgeCreateInput): Promise<KnowledgeItem>;
  update(id: string, patch: KnowledgePatch, expectedRevision: number): Promise<KnowledgeItem>;
  remove(id: string): Promise<boolean>;
  close(): void;
}

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

const LIMITS = { title: 200, bodyBytes: 256 * 1024, tags: 32, tagLen: 48 };
const KINDS: KnowledgeKind[] = ["note", "spec", "plan", "memory"];
const SOURCES: KnowledgeItem["source"][] = ["user", "agent", "import"];

export const knowledgeDigest = (body: string): string =>
  createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);

/** Case-folded (incl. diacritics), deterministic. Shared by store + snippets. */
const fold = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const snippetOf = (body: string, q?: string): string => {
  const clean = body.replace(/\s+/g, " ").trim();
  if (!q) return clean.slice(0, 160);
  const at = fold(clean).indexOf(fold(q));
  if (at < 0) return clean.slice(0, 160);
  const start = Math.max(0, at - 60);
  return (start > 0 ? "…" : "") + clean.slice(start, at + q.length + 80);
};

const validateTags = (tags: unknown): string[] => {
  if (tags === undefined) return [];
  if (!Array.isArray(tags)) throw err("invalid-input", "tags must be an array of strings");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags) {
    if (typeof t !== "string") throw err("invalid-input", "tags must be strings");
    const tag = t.trim().slice(0, LIMITS.tagLen);
    if (!tag || seen.has(tag)) continue; // duplicates fold silently
    seen.add(tag);
    out.push(tag);
  }
  if (out.length > LIMITS.tags) throw err("invalid-input", `at most ${LIMITS.tags} tags`);
  return out;
};

const validateTitle = (title: unknown): string => {
  if (typeof title !== "string" || !title.trim()) throw err("invalid-input", "title is required");
  if (title.trim().length > LIMITS.title) throw err("invalid-input", `title exceeds ${LIMITS.title} characters`);
  return title.trim();
};

const validateBody = (body: unknown): string => {
  if (typeof body !== "string") throw err("invalid-input", "body must be a string");
  if (Buffer.byteLength(body, "utf8") > LIMITS.bodyBytes) throw err("invalid-input", "body exceeds 256 KiB");
  return body;
};

interface Row {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  body: string;
  tags: string;
  source: string;
  source_session_id: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

const rowToItem = (r: Row): KnowledgeItem => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind as KnowledgeKind,
  title: r.title,
  body: r.body,
  tags: JSON.parse(r.tags) as string[],
  source: r.source as KnowledgeItem["source"],
  ...(r.source_session_id ? { sourceSessionId: r.source_session_id } : {}),
  revision: Number(r.revision),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

export function createKnowledgeStore(file: string, opts: { now?: () => number } = {}): KnowledgeStore {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  const now = opts.now ?? Date.now;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'user',
    source_session_id TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project_id, kind, updated_at)");

  const rowOf = (id: string): Row | undefined =>
    db.prepare("SELECT * FROM knowledge WHERE id = ?").get(id) as unknown as Row | undefined;

  return {
    async list(query: KnowledgeQuery) {
      if (!query.projectId) throw err("invalid-input", "projectId is required");
      const limit = Math.max(1, Math.min(query.limit ?? 50, 200));
      const offset = Math.max(0, query.offset ?? 0);
      let rows = (query.kind
        ? db.prepare("SELECT * FROM knowledge WHERE project_id = ? AND kind = ? ORDER BY updated_at DESC").all(query.projectId, query.kind)
        : db.prepare("SELECT * FROM knowledge WHERE project_id = ? ORDER BY updated_at DESC").all(query.projectId)
      ) as unknown as Row[];
      if (query.q?.trim()) {
        const q = fold(query.q.trim());
        rows = rows.filter((r) =>
          fold(r.title).includes(q) || fold(r.body).includes(q) ||
          (JSON.parse(r.tags) as string[]).some((t) => fold(t).includes(q)));
      }
      const total = rows.length;
      const items = rows.slice(offset, offset + limit).map((r) => {
        const { body: _omit, ...rest } = rowToItem(r);
        return {
          ...rest,
          snippet: snippetOf(r.body, query.q),
          bodyBytes: Buffer.byteLength(r.body, "utf8"),
        };
      });
      return { items, total };
    },

    async get(id: string) {
      const r = rowOf(id);
      return r ? rowToItem(r) : undefined;
    },

    async create(input: KnowledgeCreateInput) {
      if (!input.projectId?.trim()) throw err("invalid-input", "projectId is required");
      if (!KINDS.includes(input.kind)) throw err("invalid-input", `kind must be one of: ${KINDS.join(", ")}`);
      const source = input.source ?? "user";
      if (!SOURCES.includes(source)) throw err("invalid-input", "invalid source");
      const title = validateTitle(input.title);
      const body = validateBody(input.body);
      const tags = validateTags(input.tags);
      const t = now();
      const item: KnowledgeItem = {
        id: randomUUID(), projectId: input.projectId, kind: input.kind,
        title, body, tags, source,
        ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
        revision: 1, createdAt: t, updatedAt: t,
      };
      db.prepare(`INSERT INTO knowledge (id, project_id, kind, title, body, tags, source, source_session_id, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
        item.id, item.projectId, item.kind, item.title, item.body, JSON.stringify(item.tags),
        item.source, input.sourceSessionId ?? null, t, t,
      );
      return item;
    },

    async update(id: string, patch: KnowledgePatch, expectedRevision: number) {
      const r = rowOf(id);
      if (!r) throw err("not-found", "knowledge item not found");
      if (Number(r.revision) !== expectedRevision) {
        throw err("conflict", "item changed since you loaded it");
      }
      const title = patch.title !== undefined ? validateTitle(patch.title) : r.title;
      const body = patch.body !== undefined ? validateBody(patch.body) : r.body;
      const tags = patch.tags !== undefined ? validateTags(patch.tags) : (JSON.parse(r.tags) as string[]);
      const kind = patch.kind !== undefined ? patch.kind : (r.kind as KnowledgeKind);
      if (!KINDS.includes(kind)) throw err("invalid-input", "invalid kind");
      const t = now();
      db.prepare("UPDATE knowledge SET title = ?, body = ?, tags = ?, kind = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(title, body, JSON.stringify(tags), kind, t, id);
      return rowToItem(rowOf(id)!);
    },

    async remove(id: string) {
      const res = db.prepare("DELETE FROM knowledge WHERE id = ?").run(id);
      return Number(res.changes) > 0;
    },

    close() {
      db.close();
    },
  };
}

export * from "./tracks.ts";
