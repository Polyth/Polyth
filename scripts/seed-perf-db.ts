// Synthetic dataset generator for Polyth performance work.
//
// Usage (from the repo root):
//   POLYTH_DATA_DIR=/tmp/polyth-perf node --experimental-strip-types scripts/seed-perf-db.ts
//   POLYTH_DATA_DIR=/tmp/polyth-perf node --experimental-strip-types scripts/seed-perf-db.ts wide deep
//
// Datasets (all by default, or pass a subset as arguments):
//   wide  — 5000 sessions × 30 events across 20 projects  (session-list scale)
//   deep  — 1 session × 300,000 events, realistic turn mix (timeline scale)
//   mixed — 500 sessions × 2000 events; 10% of sessions keep one unresolved
//           permission                                     (attention scale)
//
// The schema is created by the REAL createStore() (so migrations always
// match production), but events are then inserted over a second connection
// with batched transactions — one COMMIT per 1000 rows — because the store's
// append() intentionally commits per event. attention_open bookkeeping
// mirrors the store's applyAttention exactly, and projects.json entries are
// merged in so the seeded projects show up in the UI.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "@polyth/session";
import type { Project, SessionProjection } from "@polyth/contracts";

const BATCH = 1000;

const dataDir = process.env.POLYTH_DATA_DIR ?? "./data";
const requested = process.argv.slice(2);
const datasets = requested.length > 0 ? requested : ["wide", "deep", "mixed"];
for (const name of datasets) {
  if (name !== "wide" && name !== "deep" && name !== "mixed") {
    console.error(`unknown dataset "${name}" (expected: wide, deep, mixed)`);
    process.exit(1);
  }
}

mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, "sessions.db");

// Run the real schema + migrations, then seed over a raw connection.
createStore(dbPath);
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");

const insertEvent = db.prepare(
  `INSERT INTO events (session_id, seq, id, time, type, data, ignorable, surface_op, source_seqs, producer, v)
   VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, 1)`,
);
const insertAttention = db.prepare(
  "INSERT OR IGNORE INTO attention_open (session_id, kind, request_id) VALUES (?, ?, ?)",
);
const deleteAttention = db.prepare(
  "DELETE FROM attention_open WHERE session_id = ? AND kind = ? AND request_id = ?",
);
const upsertProjection = db.prepare(
  `INSERT INTO projections (session_id, data) VALUES (?, ?)
   ON CONFLICT(session_id) DO UPDATE SET data = excluded.data`,
);

// ---------------------------------------------------------------- batching

let inTx = false;
let sinceCommit = 0;
function begin(): void {
  if (!inTx) {
    db.exec("BEGIN IMMEDIATE");
    inTx = true;
  }
}
function commit(): void {
  if (inTx) {
    db.exec("COMMIT");
    inTx = false;
    sinceCommit = 0;
  }
}
function tick(): void {
  sinceCommit += 1;
  if (sinceCommit >= BATCH) {
    commit();
    begin();
  }
}

// ---------------------------------------------------------------- event mix

type Data = Record<string, unknown>;

interface Session {
  id: string;
  seq: number;
  time: number;
}

function appendRaw(session: Session, type: string, data: Data): void {
  session.seq += 1;
  session.time += 500 + Math.floor(Math.random() * 4_000);
  insertEvent.run(
    session.id, session.seq, randomUUID(), session.time, type, JSON.stringify(data),
  );
  // Mirror of the store's applyAttention: open/close attention rows travel in
  // the same transaction as the event row.
  if (type === "permission/requested" || type === "question/asked") {
    const kind = type === "permission/requested" ? "permission" : "question";
    insertAttention.run(session.id, kind, String(data.requestId));
  } else if (type === "permission/resolved" || type === "question/answered") {
    const kind = type === "permission/resolved" ? "permission" : "question";
    deleteAttention.run(session.id, kind, String(data.requestId));
  }
  tick();
}

const WORDS = "refactor the session store to use keyset pagination and add generated columns for project scoped lookups while keeping the append only event log intact".split(" ");

function sentence(words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i += 1) out.push(WORDS[Math.floor(Math.random() * WORDS.length)]!);
  return out.join(" ");
}

/** One realistic turn: prompt, a few tool calls, sometimes an approval or a
 *  question, and a final assistant answer. Returns the events appended. */
function appendTurn(session: Session, opts: { unresolvedPermission?: boolean } = {}): void {
  appendRaw(session, "user/message", { text: sentence(6 + Math.floor(Math.random() * 20)) });
  const tools = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < tools; i += 1) {
    const callId = randomUUID();
    const shell = Math.random() < 0.5;
    appendRaw(session, "tool/call", {
      callId,
      tool: shell ? "bash" : "read",
      input: shell ? { command: `rg -n "${sentence(2)}" src/` } : { filePath: `src/${sentence(1)}.ts` },
    });
    appendRaw(session, "tool/result", {
      callId,
      output: sentence(10 + Math.floor(Math.random() * 60)),
      metadata: shell ? { exit: 0 } : {},
    });
  }
  if (Math.random() < 0.08) {
    const requestId = randomUUID();
    appendRaw(session, "permission/requested", {
      requestId,
      tool: "bash",
      preview: { title: "Run command", lines: [sentence(4)], risk: "medium" },
    });
    if (!opts.unresolvedPermission) {
      appendRaw(session, "permission/resolved", { requestId, reply: "once" });
    }
  } else if (opts.unresolvedPermission) {
    appendRaw(session, "permission/requested", {
      requestId: randomUUID(),
      tool: "bash",
      preview: { title: "Run command", lines: [sentence(4)], risk: "medium" },
    });
  }
  if (Math.random() < 0.04) {
    const requestId = randomUUID();
    appendRaw(session, "question/asked", {
      requestId,
      questions: [{ text: `${sentence(8)}?` }],
    });
    appendRaw(session, "question/answered", { requestId, answers: { 0: sentence(3) } });
  }
  appendRaw(session, "assistant/message", {
    partId: randomUUID(),
    text: sentence(30 + Math.floor(Math.random() * 120)),
    reasoning: Math.random() < 0.3 ? sentence(20) : "",
    tokens: { input: 1_000 + Math.floor(Math.random() * 20_000), output: 200 + Math.floor(Math.random() * 2_000) },
    cost: Math.random() * 0.2,
  });
}

/** Fill a session up to exactly `target` events (turns, padded with tool pairs). */
function fillSession(session: Session, target: number, opts: { unresolvedPermission?: boolean } = {}): void {
  // Every session opens with at least one full prompt/answer turn (session
  // titles and deriveMessages depend on a first user message existing).
  appendTurn(session);
  // The unresolved permission (when requested) goes into the FINAL turn so it
  // stays pending at the log tail, like a real waiting session.
  while (session.seq < target - 40) appendTurn(session);
  if (opts.unresolvedPermission) appendTurn(session, { unresolvedPermission: true });
  while (session.seq < target - 1) {
    const callId = randomUUID();
    appendRaw(session, "tool/call", { callId, tool: "read", input: { filePath: `src/${sentence(1)}.ts` } });
    if (session.seq < target) appendRaw(session, "tool/result", { callId, output: sentence(20) });
  }
  while (session.seq < target) appendRaw(session, "assistant/message", { partId: randomUUID(), text: sentence(40) });
}

function writeProjection(session: Session, projectId: string, title: string): void {
  const projection: SessionProjection = {
    id: session.id,
    projectId,
    title,
    status: "idle",
    createdAt: session.time - 60_000,
    updatedAt: session.time,
  };
  upsertProjection.run(session.id, JSON.stringify(projection));
  tick();
}

function newSession(prefix: string, index: number, baseTime: number): Session {
  return { id: `${prefix}-${String(index).padStart(5, "0")}`, seq: 0, time: baseTime };
}

// ---------------------------------------------------------------- projects.json

function registerProjects(entries: Array<{ id: string; name: string }>): void {
  const file = join(dataDir, "projects.json");
  let existing: Project[] = [];
  try {
    existing = JSON.parse(readFileSync(file, "utf8")) as Project[];
  } catch { /* first run */ }
  const known = new Set(existing.map((p) => p.id));
  for (const entry of entries) {
    if (known.has(entry.id)) continue;
    const path = join(dataDir, "checkouts", entry.id);
    mkdirSync(path, { recursive: true });
    existing.push({ id: entry.id, path, name: entry.name, createdAt: Date.now() });
  }
  writeFileSync(file, JSON.stringify(existing, null, 2));
}

// ---------------------------------------------------------------- datasets

function seedWide(): void {
  const t0 = Date.now();
  const projects = Array.from({ length: 20 }, (_, i) => ({
    id: `perf-wide-p${String(i).padStart(2, "0")}`,
    name: `Perf wide ${i}`,
  }));
  registerProjects(projects);
  begin();
  for (let i = 0; i < 5000; i += 1) {
    const session = newSession("perf-wide", i, Date.now() - (5000 - i) * 90_000);
    fillSession(session, 30);
    writeProjection(session, projects[i % projects.length]!.id, `Wide session ${i}: ${sentence(4)}`);
  }
  commit();
  console.log(`wide:  5000 sessions × 30 events, 20 projects  (${Date.now() - t0}ms)`);
}

function seedDeep(): void {
  const t0 = Date.now();
  const project = { id: "perf-deep-p00", name: "Perf deep" };
  registerProjects([project]);
  begin();
  const session = newSession("perf-deep", 0, Date.now() - 30 * 24 * 3_600_000);
  fillSession(session, 300_000);
  writeProjection(session, project.id, "Deep session: 300k events");
  commit();
  console.log(`deep:  1 session × ${session.seq} events           (${Date.now() - t0}ms)`);
}

function seedMixed(): void {
  const t0 = Date.now();
  const project = { id: "perf-mixed-p00", name: "Perf mixed" };
  registerProjects([project]);
  begin();
  for (let i = 0; i < 500; i += 1) {
    const session = newSession("perf-mixed", i, Date.now() - (500 - i) * 600_000);
    fillSession(session, 2000, { unresolvedPermission: i % 10 === 0 });
    writeProjection(session, project.id, `Mixed session ${i}: ${sentence(4)}`);
  }
  commit();
  console.log(`mixed: 500 sessions × 2000 events, 10% unresolved permissions (${Date.now() - t0}ms)`);
}

const start = Date.now();
console.log(`seeding ${datasets.join(", ")} into ${dbPath}`);
if (datasets.includes("wide")) seedWide();
if (datasets.includes("deep")) seedDeep();
if (datasets.includes("mixed")) seedMixed();

const totals = db.prepare(
  "SELECT (SELECT COUNT(*) FROM events) AS events, (SELECT COUNT(*) FROM projections) AS sessions, (SELECT COUNT(*) FROM attention_open) AS attention",
).get() as { events: number; sessions: number; attention: number };
console.log(`done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${totals.events} events, ${totals.sessions} sessions, ${totals.attention} open attention rows`);
db.close();
