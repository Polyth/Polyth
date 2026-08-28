// OC-REAL-048 (R+H): kill the owned OpenCode child after spawn but before the
// listen line. Expected: bounded startup failure, exact child cleaned, no
// ready generation installed; later recovery builds a fresh child.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  api, killExact, pidFileFor, procIdentity, readPidRecord, scenarioSetup,
  sleep, startPolyth, stopPolyth, timeline, waitFor, writeDetails,
  writeManifest, writeVerdict, REAL_BIN, TOOLS,
} from "./lib.mjs";

const ctx = scenarioSetup("OC-REAL-048", 15141);
const details = { checks: [], observations: [] };
const check = (name, pass, observed) => {
  details.checks.push({ name, pass, observed });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${observed}`);
};

const polyth = await startPolyth(ctx, {
  label: "polyth",
  bin: join(TOOLS, "shim-delay.sh"),
  env: {
    OC_SHIM_DIR: ctx.dirs.shim,
    OC_SHIM_DELAY_S: "12",
    OC_REAL_BIN: REAL_BIN,
  },
});
try {
  const project = (await api(ctx, "POST", "/api/projects", { path: ctx.dirs.project, name: "s048" })).json;
  writeManifest(ctx, { faultSeed: "OC-REAL-048-delay-12s-kill-pre-listen", projectId: project.id });

  // Trigger the lazy owned spawn; the create call blocks on it.
  const t0 = Date.now();
  const createPromise = api(ctx, "POST", "/api/sessions", { projectId: project.id, title: "s048" }, { timeoutMs: 120000 });

  // Barrier: the spawned child exists (shim recorded its own PID) but the
  // listen line cannot have been printed (shim sleeps 12s before exec).
  const shimPidFile = join(ctx.dirs.shim, "wrapper-pids.txt");
  const childPid = await waitFor(() => {
    if (!existsSync(shimPidFile)) return undefined;
    const pids = readFileSync(shimPidFile, "utf8").trim().split("\n");
    return Number(pids[pids.length - 1]);
  }, { timeoutMs: 20000, what: "spawned child pid" });
  const preKillIdentity = procIdentity(childPid);
  const pidfileExistsPreListen = existsSync(pidFileFor(ctx.dirs.project));
  check("no PID record before listen", !pidfileExistsPreListen, `pidfile exists=${pidfileExistsPreListen}`);
  timeline(ctx, { event: "barrier", barrier: "spawned-before-listen", childPid, identity: preKillIdentity });
  await sleep(1000);
  killExact(ctx, childPid, "shim-delay.sh", "SIGKILL");

  const createResult = await createPromise;
  const elapsedMs = Date.now() - t0;
  details.observations.push({ createResult, elapsedMs });
  check("startup failure is bounded", elapsedMs < 30000, `create settled in ${elapsedMs}ms status=${createResult.status}`);
  check("no false ready (create failed)", createResult.status >= 500,
    `status=${createResult.status} body=${JSON.stringify(createResult.json).slice(0, 200)}`);

  await sleep(500);
  const childGone = procIdentity(childPid) === undefined;
  check("exact child is cleaned (no orphan)", childGone, `pid ${childPid} alive=${!childGone}`);
  const pidfileAfter = existsSync(pidFileFor(ctx.dirs.project));
  check("no stale PID record left", !pidfileAfter, `pidfile exists=${pidfileAfter}`);

  // No ready generation must have been installed: the models catalog for this
  // project's runtime never came up, and no opencode child of polyth exists.
  const children = readFileSync(`/proc/${polyth.pid}/task/${polyth.pid}/children`, "utf8").trim();
  const liveChildren = children ? children.split(/\s+/).map(Number).map((pid) => ({ pid, identity: procIdentity(pid) })) : [];
  const runtimeChildren = liveChildren.filter((c) => c.identity && /opencode|shim-delay/.test(c.identity.cmdline));
  check("no leaked runtime child", runtimeChildren.length === 0, JSON.stringify(runtimeChildren));
  details.observations.push({ liveChildren });

  // Recovery: disable the delay window; a later request builds a fresh child.
  writeFileSync(join(ctx.dirs.shim, "nodelay"), "1");
  timeline(ctx, { event: "recovery-enabled" });
  const retry = await api(ctx, "POST", "/api/sessions", { projectId: project.id, title: "s048-recovery" }, { timeoutMs: 120000 });
  check("later recovery builds a fresh generation", retry.status === 200 && retry.json.id !== undefined,
    `status=${retry.status} session=${retry.json.id ?? JSON.stringify(retry.json).slice(0, 200)}`);
  const record = readPidRecord(ctx.dirs.project);
  details.observations.push({ recoveryPidRecord: record });
  check("fresh child has a valid identity-complete PID record",
    record !== undefined && record.child?.pid !== childPid && procIdentity(record.child?.pid) !== undefined,
    JSON.stringify(record));

  const failed = details.checks.filter((c) => !c.pass);
  writeDetails(ctx, details);
  writeVerdict(ctx, {
    verdict: failed.length === 0 ? "pass" : "fail",
    engine: "R+H",
    observed: failed.length === 0
      ? "pre-listen kill produced a bounded startup failure with exact-child cleanup and later fresh-generation recovery"
      : `failed checks: ${failed.map((c) => c.name).join("; ")}`,
    expected: "one child cleaned inside deadline; no ready generation; recovery builds fresh generation",
    attribution: failed.length === 0 ? "NONE" : "POLYTH",
    blockers: [],
    evidence: [
      `artifacts/opencode-real-world/phase-4/${ctx.id}/details.json`,
      `logs/opencode-real-world/phase-4/${ctx.id}/fault-timeline.ndjson`,
      `logs/opencode-real-world/phase-4/${ctx.id}/polyth.log`,
    ],
  });
} finally {
  await stopPolyth(ctx, polyth);
}
