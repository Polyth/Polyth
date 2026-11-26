import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  FeedbackConsent, FeedbackBasics, FeedbackKind, FeedbackPayload, FeedbackProfile, FeedbackTechnical,
} from "@polyth/contracts/feedback";

/** The team's collected feedback: one SQLite file in the relay's data folder.
 *  Nothing here is public: the intake route only writes, and the inbox routes
 *  that read it need the inbox token (`inbox.scrypt`). */

export const FEEDBACK_STATUSES = ["new", "seen", "planned", "done", "dropped", "keep"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const NOTE_CHARS = 2_000;
const DAY = 86_400_000;

export interface InboxItem {
  ref: number;
  id: string;
  receivedAt: number;
  createdAt: string;
  kind: FeedbackKind;
  status: FeedbackStatus;
  text: string;
  contact: string;
  /** The pseudonym the sender chose: per-day, or the one they can reset. */
  install: string;
  consent: FeedbackConsent;
  basics: FeedbackBasics;
  profile: FeedbackProfile | null;
  hasScreenshot: boolean;
  githubIssue: number | null;
  note: string;
}

export interface InboxDetail extends InboxItem {
  technical: FeedbackTechnical | null;
}

export interface InboxQuery {
  kind?: FeedbackKind;
  status?: FeedbackStatus;
  role?: string;
  /** Epoch ms: only feedback received at or after it. */
  since?: number;
  limit: number;
  offset: number;
}

export interface InboxSummary {
  total: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  byRole: Record<string, number>;
  byChannel: Record<string, number>;
  /** Distinct `install` pseudonyms: people who agreed to a stable one count once. */
  installs: number;
}

type Row = Record<string, unknown>;

const hashText = (text: string): string =>
  createHash("sha256").update(text.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex").slice(0, 32);

const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;

function item(row: Row): InboxItem {
  return {
    ref: Number(row.ref),
    id: String(row.id),
    receivedAt: Number(row.received_at),
    createdAt: String(row.created_at),
    kind: row.kind as FeedbackKind,
    status: row.status as FeedbackStatus,
    text: String(row.text),
    contact: String(row.contact),
    install: String(row.install),
    consent: parse<FeedbackConsent>(row.consent),
    basics: parse<FeedbackBasics>(row.basics),
    profile: row.profile === null ? null : parse<FeedbackProfile>(row.profile),
    hasScreenshot: Number(row.has_screenshot) === 1,
    githubIssue: row.github_issue === null ? null : Number(row.github_issue),
    note: String(row.note),
  };
}

const COLUMNS = "ref, id, received_at, created_at, kind, status, text, contact, install, consent, basics, profile, github_issue, note, screenshot IS NOT NULL AS has_screenshot";

export class FeedbackStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS feedback (
        ref INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        received_at INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new',
        text TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        contact TEXT NOT NULL,
        install TEXT NOT NULL,
        consent TEXT NOT NULL,
        basics TEXT NOT NULL,
        technical TEXT,
        profile TEXT,
        role TEXT,
        screenshot BLOB,
        github_issue INTEGER,
        note TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS feedback_received ON feedback (received_at);
      CREATE INDEX IF NOT EXISTS feedback_dup ON feedback (install, text_hash, received_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Stores one feedback. A repeat of the same `feedbackId`, or the same
   *  install sending the same words within a day, answers the first one's
   *  `ref` and stores nothing. */
  insert(payload: FeedbackPayload, now: number): { ref: number; duplicate: boolean } {
    const known = this.db.prepare("SELECT ref FROM feedback WHERE id = ?").get(payload.feedbackId) as Row | undefined;
    if (known) return { ref: Number(known.ref), duplicate: true };
    const textHash = hashText(payload.text);
    const same = this.db.prepare("SELECT ref FROM feedback WHERE install = ? AND text_hash = ? AND received_at >= ?")
      .get(payload.install, textHash, now - DAY) as Row | undefined;
    if (same) return { ref: Number(same.ref), duplicate: true };
    const result = this.db.prepare(`INSERT INTO feedback
      (id, received_at, created_at, kind, text, text_hash, contact, install, consent, basics, technical, profile, role, screenshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      payload.feedbackId, now, payload.createdAt, payload.kind, payload.text, textHash, payload.contact, payload.install,
      JSON.stringify(payload.consent), JSON.stringify(payload.basics),
      payload.technical ? JSON.stringify(payload.technical) : null,
      payload.profile ? JSON.stringify(payload.profile) : null,
      payload.profile?.role ?? null,
      payload.screenshot ? Buffer.from(payload.screenshot.data, "base64") : null,
    );
    return { ref: Number(result.lastInsertRowid), duplicate: false };
  }

  /** How many were stored since `since` (epoch ms): the service-wide budget. */
  countSince(since: number): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE received_at >= ?").get(since) as Row).n);
  }

  list(query: InboxQuery): { items: InboxItem[]; total: number } {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (query.kind) { where.push("kind = ?"); args.push(query.kind); }
    if (query.status) { where.push("status = ?"); args.push(query.status); }
    if (query.role) { where.push("role = ?"); args.push(query.role); }
    if (query.since !== undefined) { where.push("received_at >= ?"); args.push(query.since); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM feedback ${clause}`).get(...args) as Row).n);
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM feedback ${clause} ORDER BY ref DESC LIMIT ? OFFSET ?`)
      .all(...args, query.limit, query.offset) as Row[];
    return { items: rows.map(item), total };
  }

  get(ref: number): InboxDetail | null {
    const row = this.db.prepare(`SELECT ${COLUMNS}, technical FROM feedback WHERE ref = ?`).get(ref) as Row | undefined;
    if (!row) return null;
    return { ...item(row), technical: row.technical === null ? null : parse<FeedbackTechnical>(row.technical) };
  }

  screenshot(ref: number): Buffer | null {
    const row = this.db.prepare("SELECT screenshot FROM feedback WHERE ref = ?").get(ref) as Row | undefined;
    const data = row?.screenshot;
    return data instanceof Uint8Array ? Buffer.from(data) : null;
  }

  update(ref: number, change: { status?: FeedbackStatus; note?: string }): boolean {
    const row = this.db.prepare("SELECT ref FROM feedback WHERE ref = ?").get(ref);
    if (!row) return false;
    if (change.status) this.db.prepare("UPDATE feedback SET status = ? WHERE ref = ?").run(change.status, ref);
    if (change.note !== undefined) this.db.prepare("UPDATE feedback SET note = ? WHERE ref = ?").run(change.note.slice(0, NOTE_CHARS), ref);
    return true;
  }

  setIssue(ref: number, issue: number): void {
    this.db.prepare("UPDATE feedback SET github_issue = ? WHERE ref = ?").run(issue, ref);
  }

  summary(since?: number): InboxSummary {
    const clause = since === undefined ? "" : "WHERE received_at >= ?";
    const args = since === undefined ? [] : [since];
    const group = (column: string): Record<string, number> => {
      const rows = this.db.prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM feedback ${clause} GROUP BY ${column}`).all(...args) as Row[];
      return Object.fromEntries(rows.filter((row) => row.k !== null).map((row) => [String(row.k), Number(row.n)]));
    };
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM feedback ${clause}`).get(...args) as Row).n);
    const installs = Number((this.db.prepare(`SELECT COUNT(DISTINCT install) AS n FROM feedback ${clause}`).get(...args) as Row).n);
    const channels = this.db.prepare(`SELECT json_extract(basics, '$.channel') AS k, COUNT(*) AS n FROM feedback ${clause} GROUP BY k`).all(...args) as Row[];
    return {
      total, installs,
      byKind: group("kind"), byStatus: group("status"), byRole: group("role"),
      byChannel: Object.fromEntries(channels.map((row) => [String(row.k), Number(row.n)])),
    };
  }

  /** Deletes what is older than `cutoff` (epoch ms), except status `keep`.
   *  Returns how many rows went. */
  prune(cutoff: number): number {
    const result = this.db.prepare("DELETE FROM feedback WHERE received_at < ? AND status != 'keep'").run(cutoff);
    return Number(result.changes);
  }

  /** The person asked to delete what they sent: by their install pseudonym. */
  deleteInstall(install: string): number {
    return Number(this.db.prepare("DELETE FROM feedback WHERE install = ?").run(install).changes);
  }
}
