// Current-code rerun for OC-REAL-060 and OC-REAL-061.
// Usage: node rerun.mjs 060|061
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  api,
  dumpDb,
  eventsOf,
  killExact,
  pidFileFor,
  procIdentity,
  readPidRecord,
  scenarioSetup,
  sleep,
  snapshotOf,
  startPolyth,
  stopPolyth,
  timeline,
  waitFor,
  writeDetails,
  writeManifest,
  writeVerdict,
  REAL_BIN,
  TOOLS,
} from "../tools/lib.mjs";

const scenario = process.argv[2];
if (scenario !== "060" && scenario !== "061") {
  throw new Error("usage: node rerun.mjs 060|061");
}

const id = `OC-REAL-${scenario}-RERUN`;
const ctx = scenarioSetup(id, scenario === "060" ? 15260 : 15261);
const details = { checks: [], observations: [] };
const check = (name, pass, observed) => {
  details.checks.push({ name, pass, observed });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${observed}`);
};
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const ndjson = (path) => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : [];

writeFileSync(join(ctx.dirs.ocConfig, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  permission: { bash: "allow" },
}, null, 2));
writeFileSync(join(ctx.dirs.proxy, "rules.json"), JSON.stringify({ rules: [] }));

const effectPath = join(ctx.dirs.project, `effect-${scenario}-rerun.txt`);
const effectLines = () => existsSync(effectPath)
  ? readFileSync(effectPath, "utf8").split("\n").filter(Boolean)
  : [];
const leaseStatePath = `${pidFileFor(ctx.dirs.project)}.lease.json`;
const modelName = process.env.S_MODEL ?? "google/gemini-3.6-flash";
const slash = modelName.indexOf("/");
const model = {
  providerID: modelName.slice(0, slash),
  modelID: modelName.slice(slash + 1),
};

const first = await startPolyth(ctx, {
  label: "polyth",
  bin: join(TOOLS, "shim-proxy.mjs"),
  env: { OC_PROXY_DIR: ctx.dirs.proxy, OC_REAL_BIN: REAL_BIN },
});
let second;
try {
  const projectResult = await api(ctx, "POST", "/api/projects", {
    path: ctx.dirs.project,
    name: `s${scenario}-rerun`,
  });
  const project = projectResult.json;
  const sessionResult = await api(ctx, "POST", "/api/sessions", {
    projectId: project.id,
    title: `s${scenario}-rerun`,
    model,
  });
  const session = sessionResult.json;
  writeManifest(ctx, {
    originalScenario: `OC-REAL-${scenario}`,
    faultSeed: scenario === "060"
      ? "OC-REAL-060-RERUN-polyth-killed-child-alive"
      : "OC-REAL-061-RERUN-double-crash-polyth-first",
    projectId: project.id,
    canonicalSessionId: session.id,
    providerModel: model,
  });

  const promptText = `Run exactly this single bash command and nothing else: echo running >> effect-${scenario}-rerun.txt && sleep 60`;
  const sent = await api(ctx, "POST", `/api/sessions/${session.id}/message`, {
    text: promptText,
  }, { timeoutMs: 60_000 });
  check("prompt admitted", sent.status === 200, `status=${sent.status}`);

  await waitFor(async () => {
    const events = await eventsOf(ctx, session.id);
    if (events.some((event) => event.type === "turn/stopped")) {
      throw new Error("turn ended before crash barrier");
    }
    return effectLines().length === 1 ? true : undefined;
  }, { timeoutMs: 180_000, intervalMs: 150, what: "mid-turn side effect" });

  const stateBefore = readJson(join(ctx.dirs.proxy, "state.json"));
  const pidRecordBefore = readPidRecord(ctx.dirs.project);
  const leaseStateBefore = readJson(leaseStatePath);
  details.observations.push({ stateBefore, pidRecordBefore, leaseStateBefore });

  if (scenario === "061") {
    killExact(ctx, stateBefore.childPid, "opencode serve", "SIGKILL");
    await sleep(150);
  }
  killExact(ctx, first.pid, "boot-polyth.mjs", "SIGKILL");
  await sleep(1_500);

  if (scenario === "060") {
    check(
      "owned OpenCode wrapper and child survived Polyth crash",
      procIdentity(stateBefore.wrapperPid) !== undefined
        && procIdentity(stateBefore.childPid) !== undefined,
      JSON.stringify({
        wrapperAlive: procIdentity(stateBefore.wrapperPid) !== undefined,
        childAlive: procIdentity(stateBefore.childPid) !== undefined,
      }),
    );
  } else {
    check(
      "owned OpenCode child died before Polyth restart",
      procIdentity(stateBefore.childPid) === undefined,
      `childAlive=${procIdentity(stateBefore.childPid) !== undefined}`,
    );
  }

  second = await startPolyth(ctx, {
    label: "polyth-2",
    bin: join(TOOLS, "shim-proxy.mjs"),
    env: { OC_PROXY_DIR: ctx.dirs.proxy, OC_REAL_BIN: REAL_BIN },
  });

  const snapshotBeforeWire = await snapshotOf(ctx, session.id);
  const modelsTouch = await api(ctx, "GET", "/api/models", undefined, { timeoutMs: 60_000 });
  const leaseStateAfter = readJson(leaseStatePath);
  details.observations.push({
    snapshotBeforeWire: { status: snapshotBeforeWire.status },
    modelsTouchStatus: modelsTouch.status,
    leaseStateAfter,
  });
  check(
    "owned authority is stable and generation advances across Polyth restart",
    leaseStateAfter.authorityId === leaseStateBefore.authorityId
      && leaseStateAfter.generation > leaseStateBefore.generation,
    JSON.stringify({ before: leaseStateBefore, after: leaseStateAfter }),
  );

  const wireStart = Date.now();
  let firstWire;
  try {
    firstWire = await api(
      ctx,
      "POST",
      `/api/sessions/${session.id}/abort`,
      undefined,
      { timeoutMs: 90_000 },
    );
  } catch (error) {
    firstWire = { status: -1, json: { timeoutError: String(error) } };
  }
  const wireElapsedMs = Date.now() - wireStart;
  details.observations.push({ firstWire, wireElapsedMs });
  const bindingMismatch =
    firstWire.status === 500 && firstWire.json?.error === "binding-mismatch";
  check(
    "first wire does not fail binding-mismatch",
    !bindingMismatch,
    `status=${firstWire.status} body=${JSON.stringify(firstWire.json).slice(0, 240)} elapsedMs=${wireElapsedMs}`,
  );
  check(
    "persisted session remains operable after restart",
    firstWire.status === 200,
    `abort status=${firstWire.status}`,
  );

  const statusTrace = [];
  let previousStatus;
  const traceDeadline = Date.now() + 30_000;
  while (Date.now() < traceDeadline) {
    const snapshot = await snapshotOf(ctx, session.id);
    if (snapshot.status !== previousStatus) {
      previousStatus = snapshot.status;
      statusTrace.push({ ts: new Date().toISOString(), status: snapshot.status });
    }
    if (snapshot.status !== "working" && snapshot.status !== "sending") break;
    await sleep(1_000);
  }
  details.observations.push({ statusTrace });
  check(
    "restart does not leave session stuck sending or working",
    previousStatus !== "sending" && previousStatus !== "working",
    `final status=${previousStatus}`,
  );

  const wireEntries = ndjson(join(ctx.dirs.proxy, "wire.ndjson"));
  const promptPosts = wireEntries.filter((entry) =>
    entry.event === "proxied"
      && entry.method === "POST"
      && /prompt_async/.test(entry.path ?? ""));
  check("no duplicate prompt", promptPosts.length === 1, `prompt POST count=${promptPosts.length}`);
  check("no duplicate side effect", effectLines().length === 1, `effect lines=${effectLines().length}`);

  const finalEvents = await eventsOf(ctx, session.id);
  const userMessages = finalEvents.filter((event) => event.type === "user/message");
  const falseStops = finalEvents.filter((event) =>
    event.type === "turn/stopped" && event.data?.reason === "completed");
  check("user intent remains exactly once", userMessages.length === 1, `user/message count=${userMessages.length}`);
  check("no false completed terminal", falseStops.length === 0, `false completed count=${falseStops.length}`);

  const pidRecordAfter = readPidRecord(ctx.dirs.project);
  const oldWrapperAlive = procIdentity(stateBefore.wrapperPid) !== undefined;
  const oldChildAlive = procIdentity(stateBefore.childPid) !== undefined;
  check(
    "old owned generation is gone and successor PID record is identity-complete",
    !oldWrapperAlive
      && !oldChildAlive
      && pidRecordAfter?.child?.pid !== stateBefore.wrapperPid
      && procIdentity(pidRecordAfter?.child?.pid) !== undefined,
    JSON.stringify({
      oldWrapperAlive,
      oldChildAlive,
      before: pidRecordBefore?.child ?? null,
      after: pidRecordAfter?.child ?? null,
    }),
  );

  const finalDb = dumpDb(ctx, "final", session.id);
  check(
    "sqlite integrity ok",
    finalDb.integrityCheck?.[0]?.integrity_check === "ok",
    JSON.stringify(finalDb.integrityCheck),
  );
  details.observations.push({
    promptPosts: promptPosts.map((entry) => ({ ts: entry.ts, path: entry.path, status: entry.status })),
    finalStatus: previousStatus,
    pidRecordAfter,
    turnStops: finalEvents
      .filter((event) => event.type === "turn/stopped")
      .map((event) => ({ seq: event.seq, data: event.data })),
  });

  const failures = details.checks.filter((item) => !item.pass);
  writeDetails(ctx, details);
  writeVerdict(ctx, {
    verdict: failures.length === 0 ? "pass" : "fail",
    engine: scenario === "060" ? "R" : "R+H",
    observed: failures.length === 0
      ? `durable authority ${leaseStateAfter.authorityId} advanced generation ${leaseStateBefore.generation}->${leaseStateAfter.generation}; first wire ${firstWire.status}; one prompt/intent/side effect; final ${previousStatus}`
      : `failed checks: ${failures.map((item) => item.name).join("; ")}`,
    expected: "stable authority; advancing generation; usable first wire; no duplicate prompt; no stuck active projection",
    attribution: failures.length === 0 ? "NONE" : "POLYTH",
    identifiers: { canonicalSessionIds: [session.id] },
    blockers: [],
    evidence: [
      `artifacts/opencode-real-world/phase-4/${ctx.id}/details.json`,
      `logs/opencode-real-world/phase-4/${ctx.id}/proxy-wire.ndjson`,
      `logs/opencode-real-world/phase-4/${ctx.id}/fault-timeline.ndjson`,
      `logs/opencode-real-world/phase-4/${ctx.id}/db-final.json`,
    ],
  });
  timeline(ctx, {
    event: "rerun-verdict",
    scenario,
    pass: failures.length === 0,
    failedChecks: failures.map((item) => item.name),
  });
} finally {
  if (second) await stopPolyth(ctx, second);
  for (const file of ["wire.ndjson", "timeline.ndjson", "opencode.log"]) {
    const source = join(ctx.dirs.proxy, file);
    if (existsSync(source)) {
      writeFileSync(join(ctx.dirs.logs, `proxy-${file}`), readFileSync(source));
    }
  }
}
