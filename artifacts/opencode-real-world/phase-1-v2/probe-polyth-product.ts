import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { pidFileForDirectory } from "@polyth/backend-opencode";
import { boot } from "../../../packages/server/src/index.ts";

const protocol = (process.env.PROBE_PROTOCOL ?? "auto") as "auto" | "v2";
const port = Number(process.env.PROBE_PORT ?? (protocol === "auto" ? "45140" : "45141"));
const root = `/tmp/polyth-oc-phase1-v2/product-${protocol}`;
const projectPath = `${root}/project`;
const dataDir = `${root}/polyth-data`;
const openCodeDataDir = `${root}/opencode-config`;
const output = process.env.PROBE_OUTPUT
  ?? `logs/opencode-real-world/phase-1-v2/polyth-product-${protocol}.json`;
await mkdir(projectPath, { recursive: true });
await mkdir(dataDir, { recursive: true });
await mkdir(openCodeDataDir, { recursive: true });

const app = await boot({
  port,
  hostname: "127.0.0.1",
  dataDir,
  opencode: {
    bin: "/home/ubuntu/.local/bin/opencode",
    dataDir: openCodeDataDir,
    protocol,
  },
});
const base = `http://127.0.0.1:${port}`;

const call = async (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) => {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Preserve the bounded raw body.
  }
  return {
    method,
    path,
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: parsed,
  };
};

const health = await call("GET", "/api/health");
const project = await call("POST", "/api/projects", {
  path: projectPath,
  name: `Phase 1 V2 ${protocol}`,
});
const projectId = (
  project.body
  && typeof project.body === "object"
  && "id" in project.body
) ? String(project.body.id) : "";
const models = await call(
  "GET",
  `/api/models?projectId=${encodeURIComponent(projectId)}`,
);
const sessionCreate = await call("POST", "/api/sessions", {
  projectId,
  title: `OC-REAL-026 ${protocol}`,
});
const sessions = await call(
  "GET",
  `/api/sessions?projectId=${encodeURIComponent(projectId)}`,
);

let child: {
  pid: number;
  startIdentity: string;
  executable: string;
  command: string;
} | undefined;
try {
  const record = JSON.parse(
    await readFile(pidFileForDirectory(projectPath), "utf8"),
  ) as { child: typeof child };
  child = record.child;
} catch {
  // A bounded startup failure may leave no PID record.
}

await app.shutdown();

const aliveAfterShutdown = (() => {
  if (!child) return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
})();

const db = new DatabaseSync(`${dataDir}/sessions.db`);
const tableNames = [
  "events",
  "projections",
  "runtime_operations",
  "session_queue",
  "response_intents",
  "observations",
  "observation_checkpoints",
  "observation_cursors",
  "session_reconciliations",
  "deletion_tombstones",
];
const present = new Set(
  (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all() as Array<{ name: string }>).map((row) => row.name),
);
const tables: Record<string, unknown> = {};
for (const name of tableNames) {
  tables[name] = present.has(name)
    ? db.prepare(`SELECT * FROM ${name} ORDER BY rowid LIMIT 100`).all()
    : { unavailable: "table does not exist" };
}
const integrityCheck = db.prepare("PRAGMA integrity_check").all();
const walCheckpoint = db.prepare("PRAGMA wal_checkpoint(PASSIVE)").all();
db.close();

const result = {
  capturedAt: new Date().toISOString(),
  protocol,
  base,
  projectPath,
  dataDir,
  calls: { health, project, models, sessionCreate, sessions },
  ownedOpenCode: {
    child,
    aliveAfterPolythShutdown: aliveAfterShutdown,
  },
  sqlite: {
    integrityCheck,
    walCheckpoint,
    tables,
  },
};

await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
