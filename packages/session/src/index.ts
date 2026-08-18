// Polyth session log: append-only event store on node:sqlite (WAL).
// Erasable TS only. Local imports use explicit .ts.

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { MODEL_VISIBLE_TYPES } from "@polyth/contracts";
import type {
  JsonObject,
  ModelMessage,
  SessionEvent,
  SessionPersistence,
  SessionProjection,
} from "@polyth/contracts";

export interface Store extends SessionPersistence {
  exportJsonl(sessionId: string): Promise<string>;
}

const EVENTS_COLS = [
  "session_id",
  "seq",
  "id",
  "time",
  "type",
  "data",
  "ignorable",
  "surface_op",
  "source_seqs",
  "producer",
  "v",
] as const;

export function createStore(dbPath: string): Store {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT NOT NULL,
      seq       INTEGER NOT NULL,
      id        TEXT NOT NULL,
      time      INTEGER NOT NULL,
      type      TEXT NOT NULL,
      data      TEXT NOT NULL,
      ignorable INTEGER NOT NULL DEFAULT 0,
      surface_op TEXT,
      source_seqs TEXT,
      producer  TEXT,
      v         INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (session_id, seq)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS projections (
      session_id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    )
  `);

  // ------------------------------------------------------------- append

  function append(
    sessionId: string,
    type: string,
    data: JsonObject,
    opts: Partial<
      Pick<SessionEvent, "ignorable" | "surfaceOp" | "sourceEventSeqs" | "producerPlugin">
    > = {},
  ): Promise<SessionEvent> {
    const id = randomUUID();
    const time = Date.now();
    let seq = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE session_id = ?")
        .get(sessionId) as { next: number };
      seq = Number(row.next);
      db.prepare(
        `INSERT INTO events (session_id, seq, id, time, type, data, ignorable, surface_op, source_seqs, producer, v)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        sessionId,
        seq,
        id,
        time,
        type,
        JSON.stringify(data),
        opts.ignorable ? 1 : 0,
        opts.surfaceOp ?? null,
        opts.sourceEventSeqs ? JSON.stringify(opts.sourceEventSeqs) : null,
        opts.producerPlugin ?? null,
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    const event: SessionEvent = {
      id,
      sessionId,
      seq,
      time,
      type,
      data,
      ignorable: opts.ignorable,
      surfaceOp: opts.surfaceOp,
      sourceEventSeqs: opts.sourceEventSeqs,
      producerPlugin: opts.producerPlugin,
      v: 1,
    };
    return Promise.resolve(event);
  }

  // ------------------------------------------------------------- reads

  function events(sessionId: string, afterSeq = 0): Promise<SessionEvent[]> {
    const rows = db
      .prepare(
        "SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq",
      )
      .all(sessionId, afterSeq) as unknown as Row[];
    return Promise.resolve(rows.map(rowToEvent));
  }

  function latestSeq(sessionId: string): Promise<number> {
    const row = db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE session_id = ?")
      .get(sessionId) as { s: number };
    return Promise.resolve(Number(row.s));
  }

  // ------------------------------------------------------------- fork copy

  function copyTo(srcSessionId: string, dstSessionId: string, upToSeq?: number): Promise<void> {
    db.exec("BEGIN IMMEDIATE");
    try {
      const limit = upToSeq === undefined ? Number.MAX_SAFE_INTEGER : upToSeq;
      const src = db
        .prepare(
          "SELECT * FROM events WHERE session_id = ? AND seq <= ? ORDER BY seq",
        )
        .all(srcSessionId, limit) as unknown as Row[];

      const next = db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE session_id = ?")
        .get(dstSessionId) as { m: number };
      let seq = Number(next.m);

      const ins = db.prepare(
        `INSERT INTO events (session_id, seq, id, time, type, data, ignorable, surface_op, source_seqs, producer, v)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of src) {
        seq += 1;
        ins.run(
          dstSessionId,
          seq,
          r.id,
          r.time,
          r.type,
          r.data,
          r.ignorable,
          r.surface_op,
          r.source_seqs,
          r.producer,
          r.v,
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return Promise.resolve();
  }

  // ------------------------------------------------------------- projections

  function upsertProjection(p: SessionProjection): Promise<void> {
    db.prepare(
      `INSERT INTO projections (session_id, data) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET data = excluded.data`,
    ).run(p.id, JSON.stringify(p));
    return Promise.resolve();
  }

  function projection(sessionId: string): Promise<SessionProjection | undefined> {
    const row = db
      .prepare("SELECT data FROM projections WHERE session_id = ?")
      .get(sessionId) as { data: string } | undefined;
    return Promise.resolve(row ? (JSON.parse(row.data) as SessionProjection) : undefined);
  }

  function projections(projectId?: string): Promise<SessionProjection[]> {
    const rows = projectId === undefined
      ? (db.prepare("SELECT data FROM projections").all() as { data: string }[])
      : (db
          .prepare("SELECT data FROM projections WHERE json_extract(data, '$.projectId') = ?")
          .all(projectId) as { data: string }[]);
    return Promise.resolve(rows.map((r) => JSON.parse(r.data) as SessionProjection));
  }

  // ------------------------------------------------------------- export

  function exportJsonl(sessionId: string): Promise<string> {
    const rows = db
      .prepare("SELECT data FROM events WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as { data: string }[];
    return Promise.resolve(rows.map((r) => r.data).join("\n"));
  }

  function close(): Promise<void> {
    db.close();
    return Promise.resolve();
  }

  return {
    append,
    events,
    latestSeq,
    copyTo,
    upsertProjection,
    projection,
    projections,
    exportJsonl,
    close,
  };
}

// ------------------------------------------------------------- row mapping

interface Row {
  session_id: string;
  seq: number;
  id: string;
  time: number;
  type: string;
  data: string;
  ignorable: number;
  surface_op: string | null;
  source_seqs: string | null;
  producer: string | null;
  v: number;
}

function rowToEvent(r: Row): SessionEvent {
  const event: SessionEvent = {
    id: r.id,
    sessionId: r.session_id,
    seq: Number(r.seq),
    time: Number(r.time),
    type: r.type,
    data: JSON.parse(r.data) as JsonObject,
    v: 1,
  };
  if (r.ignorable) event.ignorable = true;
  if (r.surface_op !== null) event.surfaceOp = r.surface_op as "append" | "replace";
  if (r.source_seqs !== null) event.sourceEventSeqs = JSON.parse(r.source_seqs) as number[];
  if (r.producer !== null) event.producerPlugin = r.producer;
  return event;
}

// ------------------------------------------------------------- deriveMessages

export function deriveMessages(events: SessionEvent[]): ModelMessage[] {
  const out: ModelMessage[] = [];

  const pushText = (role: "user" | "assistant" | "tool", text: string) => {
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.parts.push({ type: "text", text });
    } else {
      out.push({ role, parts: [{ type: "text", text }] });
    }
  };

  const pushReasoning = (text: string) => {
    const last = out[out.length - 1];
    if (last && last.role === "assistant") {
      last.parts.push({ type: "reasoning", text });
    } else {
      out.push({ role: "assistant", parts: [{ type: "reasoning", text }] });
    }
  };

  const pushToolCall = (
    callId: string,
    tool: string,
    input: JsonObject,
  ) => {
    const last = out[out.length - 1];
    if (last && last.role === "assistant") {
      last.parts.push({ type: "tool-call", callId, tool, input });
    } else {
      out.push({ role: "assistant", parts: [{ type: "tool-call", callId, tool, input }] });
    }
  };

  const pushToolResult = (
    callId: string,
    tool: string,
    output: string,
    isError: boolean,
  ) => {
    const last = out[out.length - 1];
    if (last && last.role === "tool") {
      last.parts.push({ type: "tool-result", callId, tool, output, isError });
    } else {
      out.push({ role: "tool", parts: [{ type: "tool-result", callId, tool, output, isError }] });
    }
  };

  for (const ev of events) {
    if (!MODEL_VISIBLE_TYPES.includes(ev.type as (typeof MODEL_VISIBLE_TYPES)[number])) {
      continue;
    }
    if (ev.ignorable) continue;

    const d = ev.data as Record<string, JsonObject>;
    switch (ev.type) {
      case "user/message":
        pushText("user", String(d.text ?? ""));
        break;
      case "assistant/message": {
        const text = String(d.text ?? "");
        const reasoning = d.reasoning === undefined ? undefined : String(d.reasoning);
        if (reasoning) pushReasoning(reasoning);
        pushText("assistant", text);
        break;
      }
      case "tool/call":
        pushToolCall(String(d.callId ?? ""), String(d.tool ?? ""), (d.input as JsonObject) ?? {});
        break;
      case "tool/result":
        pushToolResult(
          String(d.callId ?? ""),
          String(d.tool ?? ""),
          String(d.output ?? ""),
          false,
        );
        break;
      case "tool/error":
        pushToolResult(
          String(d.callId ?? ""),
          String(d.tool ?? ""),
          String(d.error ?? ""),
          true,
        );
        break;
      case "question/asked": {
        const questions = Array.isArray(d.questions) ? (d.questions as JsonObject[]) : [];
        const summary = questions.map((q) => String(q.text ?? q.question ?? "")).filter(Boolean).join("; ");
        if (summary) pushText("assistant", summary);
        break;
      }
      case "question/answered": {
        const answers = d.answers as JsonObject | undefined;
        const text = answers !== undefined ? JSON.stringify(answers) : "";
        if (text) pushText("user", text);
        break;
      }
    }
  }

  return out;
}
