// OC-REAL-049 (R+H): kill the real OpenCode child after its listen line while
// Polyth's readiness/protocol probe is in flight (deterministic via the fault
// proxy: the first readiness probe request SIGKILLs the exact child).
// Expected: the failed generation is never exposed; later recovery builds a
// fresh generation; no dead-URL reuse or leaked stream.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  api, procIdentity, readPidRecord, scenarioSetup, sleep, startPolyth,
  stopPolyth, timeline, waitFor, writeDetails, writeManifest, writeVerdict,
  REAL_BIN, TOOLS,
} from "./lib.mjs";

const ctx = scenarioSetup("OC-REAL-049", 15142);
const details = { checks: [], observations: [] };
const check = (name, pass, observed) => {
  details.checks.push({ name, pass, observed });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${observed}`);
};
const ndjson = (file) => existsSync(file)
  ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : [];

writeFileSync(join(ctx.dirs.proxy, "rules.json"), JSON.stringify({
  rules: [{ id: "kill-during-probe", mode: "kill-on-request", pathRe: "^/global/health", oneshot: true }],
}, null, 2));

const polyth = await startPolyth(ctx, {
  label: "polyth",
  bin: join(TOOLS, "shim-proxy.mjs"),
  startupDeadlineMs: 10000,
  env: { OC_PROXY_DIR: ctx.dirs.proxy, OC_REAL_BIN: REAL_BIN },
});
try {
  const project = (await api(ctx, "POST", "/api/projects", { path: ctx.dirs.project, name: "s049" })).json;
  writeManifest(ctx, {
    faultSeed: "OC-REAL-049-kill-on-first-readiness-probe",
    projectId: project.id,
    proxy: { dir: ctx.dirs.proxy, rule: "kill-on-request ^/global/health oneshot" },
    startupDeadlineMs: 10000,
  });

  const t0 = Date.now();
  const create = await api(ctx, "POST", "/api/sessions", { projectId: project.id, title: "s049" }, { timeoutMs: 120000 });
  const elapsedMs = Date.now() - t0;
  details.observations.push({ create, elapsedMs });

  const events = ndjson(join(ctx.dirs.proxy, "timeline.ndjson"));
  const kills = events.filter((e) => e.event === "fault-kill-real-child");
  const proxyStarts = events.filter((e) => e.event === "proxy-listening");
  check("exactly one probe-window kill fired", kills.length === 1, JSON.stringify(kills));
  check("first generation candidate existed (listen line before kill)",
    proxyStarts.length >= 1 && kills[0] !== undefined,
    `proxy generations=${proxyStarts.length}`);

  // The failed generation must never be exposed: the triggering call fails
  // bounded (probe deadline) with an honest unavailable error and no session.
  check("probe failure is bounded and never exposed as ready",
    create.status === 503 && elapsedMs < 30000,
    `status=${create.status} elapsed=${elapsedMs}ms body=${JSON.stringify(create.json).slice(0, 200)}`);

  const wireEntries = ndjson(join(ctx.dirs.proxy, "wire.ndjson"));
  const killedChildPid = kills[0]?.pid;

  // Leaked stream check: the killed generation must not carry an SSE stream.
  const sseToDeadGen = wireEntries.filter((e) =>
    e.event === "proxied" && /^\/event/.test(e.path ?? "")
    && new Date(e.ts).getTime() < new Date(kills[0].ts).getTime());
  check("no stream was connected to the failed generation", sseToDeadGen.length === 0, JSON.stringify(sseToDeadGen));

  // Later recovery: a subsequent request builds one fresh generation.
  const models = await api(ctx, "GET", "/api/models", undefined, { timeoutMs: 60000 });
  check("later recovery builds a generation that serves the catalog",
    models.status === 200 && Array.isArray(models.json) && models.json.length > 0,
    `models=${Array.isArray(models.json) ? models.json.length : models.status}`);
  const retryCreate = await api(ctx, "POST", "/api/sessions", { projectId: project.id, title: "s049-recovery" }, { timeoutMs: 120000 });
  check("later recovery serves session create",
    retryCreate.status === 200 && typeof retryCreate.json.id === "string",
    `status=${retryCreate.status} body=${JSON.stringify(retryCreate.json).slice(0, 200)}`);

  const record = readPidRecord(ctx.dirs.project);
  const state = JSON.parse(readFileSync(join(ctx.dirs.proxy, "state.json"), "utf8"));
  details.observations.push({ proxyStarts, kills, record, state, wireHead: wireEntries.slice(0, 20), retryCreate });
  check("fresh generation uses a fresh child (no dead URL reuse)",
    record !== undefined && state.childPid !== killedChildPid && procIdentity(state.childPid) !== undefined,
    `killed=${killedChildPid} live=${state.childPid} record=${JSON.stringify(record?.child ?? null)}`);

  const failed = details.checks.filter((c) => !c.pass);
  writeDetails(ctx, details);
  writeVerdict(ctx, {
    verdict: failed.length === 0 ? "pass" : "fail",
    engine: "R+H",
    observed: failed.length === 0
      ? "probe-window kill was bounded; failed generation was never exposed; one fresh generation recovered and serves work"
      : `failed checks: ${failed.map((c) => c.name).join("; ")}`,
    expected: "failed generation never exposed; later recovery builds fresh generation",
    attribution: failed.length === 0 ? "NONE" : "POLYTH",
    blockers: [],
    evidence: [
      `artifacts/opencode-real-world/phase-4/${ctx.id}/details.json`,
      `logs/opencode-real-world/phase-4/${ctx.id}/fault-timeline.ndjson`,
      `logs/opencode-real-world/phase-4/${ctx.id}/polyth.log`,
      `logs/opencode-real-world/phase-4/${ctx.id}/proxy-wire.ndjson`,
    ],
  });
} finally {
  await stopPolyth(ctx, polyth);
  for (const file of ["wire.ndjson", "timeline.ndjson", "opencode.log"]) {
    const src = join(ctx.dirs.proxy, file);
    if (existsSync(src)) writeFileSync(join(ctx.dirs.logs, `proxy-${file}`), readFileSync(src));
  }
}
