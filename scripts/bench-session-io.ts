/** Offline, disposable canonical-storage workload; never opens installation data. */
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { cpus, totalmem } from "node:os";
import { createStore } from "../packages/session/src/index.ts";

const root = resolve(".scratch/polyth-performance-reliability");
await mkdir(root, { recursive: true });
const reuse = process.argv[2];
if (reuse && (!resolve(reuse).startsWith(`${root}/io-`) || resolve(reuse).split("/").length !== root.split("/").length + 1)) throw new Error("reuse must name a disposable io fixture under the benchmark scratch root");
const dir = reuse ? resolve(reuse) : await mkdtemp(join(root, "io-"));
const marker = join(dir, ".polyth-synthetic-io");
if (reuse) {
  if ((await lstat(dir)).isSymbolicLink() || await realpath(dir) !== dir || await readFile(marker, "utf8") !== "disposable-session-io-v1") throw new Error("not an owned synthetic fixture");
} else await writeFile(marker, "disposable-session-io-v1", { flag: "wx" });
const dbPath = join(dir, "fixture.db");
if (reuse && (await lstat(dbPath)).isSymbolicLink()) throw new Error("fixture database must not be a symlink");
const samples = 30;
const sessionCount = 650;
const eventCount = Number(process.env.POLYTH_BENCH_EVENTS ?? 2_000_000);
const longSession = Math.min(170_000, eventCount);
let store = createStore(dbPath);
try {
  if (!reuse) for (let i = 0; i < sessionCount; i++) await store.upsertProjection({
    id: `s${String(i).padStart(4, "0")}`, projectId: "project", spaceId: "fixture", title: `Synthetic conversation ${i}`,
    status: "idle", createdAt: i, updatedAt: i, lastTurnAt: i,
    draft: "fixture draft ".repeat(200),
  });
  await store.close();
  const db = new DatabaseSync(dbPath);
  const insert = db.prepare("INSERT INTO events(session_id,seq,id,time,type,data) VALUES(?,?,?,?,?,?)");
  const small = JSON.stringify({ partId: "p", text: "x".repeat(96) });
  const large = JSON.stringify({ callId: "tool", output: "# Synthetic markdown\n```ts\nconst x = 1;\n```\n".repeat(256) });
  let total = reuse ? Number((db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count) : 0;
  if (!reuse) for (let i = 0; i < sessionCount && total < eventCount; i++) {
    const size = i === 0 ? longSession : Math.ceil((eventCount - total) / (sessionCount - i));
    const id = `s${String(i).padStart(4, "0")}`;
    for (let start = 1; start <= size; start += 5_000) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (let seq = start; seq < Math.min(size + 1, start + 5_000); seq++) {
          insert.run(id, seq, `${id}-${seq}`, seq, seq % 1000 ? "assistant/chunk" : "tool/finished", seq % 1000 ? small : large);
          total++;
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      await new Promise<void>((done) => setImmediate(done));
    }
  }
  console.log(JSON.stringify({ phase: "fixture-ready", eventCount: total, sessionCount, longSession }));
  const plans = {
    summaries: db.prepare("EXPLAIN QUERY PLAN SELECT session_id FROM projections WHERE COALESCE(space_id, '') = ? AND project_id = ? ORDER BY CAST(json_extract(data, '$.updatedAt') AS INTEGER) DESC, session_id DESC LIMIT 51").all("fixture", "project"),
    replay: db.prepare("EXPLAIN QUERY PLAN SELECT * FROM events WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?").all("s0000", 0, longSession, 500),
    unread: db.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM events WHERE session_id = ? AND type = 'assistant/message' AND seq > ?").all("s0000", 0),
  };
  db.close();
  store = createStore(dbPath);
  const measure = async (operation: () => Promise<unknown>) => {
    await operation(); // warm-up, excluded
    const durations: number[] = [];
    for (let i = 0; i < samples; i++) {
      const start = performance.now();
      await operation();
      durations.push(performance.now() - start);
      await new Promise<void>((done) => setImmediate(done));
    }
    durations.sort((a, b) => a - b);
    return { samples, minMs: durations[0], medianMs: durations[Math.floor(samples / 2)], p95Ms: durations[Math.ceil(samples * .95) - 1], maxMs: durations.at(-1) };
  };
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const before = await measure(async () => (await store.events("s0000", 0)).slice(0, 500));
  delay.reset();
  console.log(JSON.stringify({ phase: "legacy-replay-measured", result: before }));
  const after = await measure(() => store.events("s0000", 0, { direction: "forward", throughSeq: longSession, limit: 500 }));
  const window = await measure(() => store.events("s0000", 0, { limit: 400 }));
  const list = await measure(() => store.projections("project"));
  const summary = await measure(() => store.summaries!({ projectId: "project", spaceId: "fixture", limit: 50 }));
  delay.disable();
  const page = await store.summaries!({ projectId: "project", spaceId: "fixture", limit: 50 });
  console.log(JSON.stringify({ node: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(),
    workload: { sessionCount, eventCount: total, longSession, samples, cache: "warm after one excluded warm-up", concurrency: 1, provider: "none", ui: "not measured" },
    databaseBytes: (await stat(dbPath)).size, replayFirstPage: { before, after }, persistedWindow: window, projections: list, summaries: summary,
    summaryBytes: Buffer.byteLength(JSON.stringify(page)), eventLoopP99Ms: delay.percentile(99) / 1e6, plans }, null, 2));
} finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
