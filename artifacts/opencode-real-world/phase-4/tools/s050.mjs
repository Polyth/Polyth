// OC-REAL-050 (R+H): the real child commits the session create, then dies
// before Polyth receives the response (proxy captures the committed response,
// SIGKILLs the exact child, and swallows the bytes).
// Expected: canonical shell + unknown operation survive; no automatic second
// create; no shell deletion; no similarity adoption.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  api, dumpDb, scenarioSetup, sleep, startPolyth, stopPolyth, timeline,
  waitFor, writeDetails, writeManifest, writeVerdict, REAL_BIN, TOOLS,
} from "./lib.mjs";

const ctx = scenarioSetup("OC-REAL-050", 15143);
const details = { checks: [], observations: [] };
const check = (name, pass, observed) => {
  details.checks.push({ name, pass, observed });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${observed}`);
};
const ndjson = (file) => existsSync(file)
  ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : [];

writeFileSync(join(ctx.dirs.proxy, "rules.json"), JSON.stringify({
  rules: [{ id: "swallow-create", mode: "swallow-kill", method: "POST", pathRe: "^/session$", oneshot: true }],
}, null, 2));

const polyth = await startPolyth(ctx, {
  label: "polyth",
  bin: join(TOOLS, "shim-proxy.mjs"),
  env: { OC_PROXY_DIR: ctx.dirs.proxy, OC_REAL_BIN: REAL_BIN },
});
try {
  const project = (await api(ctx, "POST", "/api/projects", { path: ctx.dirs.project, name: "s050" })).json;
  writeManifest(ctx, {
    faultSeed: "OC-REAL-050-swallow-create-response-kill",
    projectId: project.id,
    proxy: { rule: "swallow-kill POST ^/session$ oneshot" },
  });

  const create = await api(ctx, "POST", "/api/sessions", {
    projectId: project.id,
    title: "s050 ambiguous create",
  }, { timeoutMs: 120000 });
  details.observations.push({ create });
  check("create settles as an error, not fake success", create.status >= 500,
    `status=${create.status} body=${JSON.stringify(create.json).slice(0, 200)}`);

  const captured = JSON.parse(readFileSync(join(ctx.dirs.proxy, "captured-swallow-create.json"), "utf8"));
  const upstreamSessionId = JSON.parse(captured.response.body).id;
  details.observations.push({ captured: { status: captured.response.status, upstreamSessionId } });
  check("upstream committed exactly one session before the kill",
    captured.response.status === 200 && /^ses_/.test(upstreamSessionId),
    `status=${captured.response.status} upstream=${upstreamSessionId}`);

  // Canonical shell must survive with an unknown operation and no binding.
  const shells = (await api(ctx, "GET", `/api/sessions?projectId=${project.id}`)).json;
  const shell = shells[0];
  details.observations.push({ shells });
  check("canonical shell survives", shells.length === 1 && shell !== undefined,
    `shells=${shells.length} status=${shell?.status}`);
  check("shell is not falsely bound or terminal",
    shell?.backendSessionId === undefined && (shell?.status === "unknown" || shell?.status === "reconciling"),
    `backendSessionId=${shell?.backendSessionId} status=${shell?.status}`);

  const dbAfterFault = dumpDb(ctx, "after-fault", shell?.id);
  const createOp = dbAfterFault.runtime_operations.find((op) => op.mutation_kind === "session-create");
  check("session-create operation is durably unknown", createOp?.state === "unknown",
    JSON.stringify(createOp ?? null));

  // Let the natural-death recovery respawn a fresh child, then touch the
  // session (events read triggers reconciliation) and reload state.
  await sleep(6000);
  const events = await api(ctx, "GET", `/api/sessions/${shell.id}/events?afterSeq=0`);
  await sleep(3000);
  const shellsAfter = (await api(ctx, "GET", `/api/sessions?projectId=${project.id}`)).json;
  details.observations.push({ eventsStatus: events.status, shellsAfter });

  const wireEntries = ndjson(join(ctx.dirs.proxy, "wire.ndjson"));
  const createPosts = wireEntries.filter((e) =>
    (e.event === "proxied" || e.event === "fault-swallowed-response")
    && e.method === "POST" && (e.path ?? "").replace(/\?.*$/, "") === "/session");
  check("no automatic second create was sent upstream", createPosts.length === 1,
    `POST /session count=${createPosts.length}`);

  const after = shellsAfter[0];
  check("shell was not deleted on ambiguity", shellsAfter.length === 1 && after?.id === shell.id,
    `shells=${shellsAfter.length}`);
  check("no similarity adoption of the orphan upstream session",
    after?.backendSessionId === undefined || after?.backendSessionId !== upstreamSessionId
      ? after?.backendSessionId === undefined
      : false,
    `backendSessionId=${after?.backendSessionId ?? "unset"} orphan=${upstreamSessionId}`);

  // The orphan session exists upstream in the fresh child (shared data dir).
  const state = JSON.parse(readFileSync(join(ctx.dirs.proxy, "state.json"), "utf8"));
  const upstreamList = await fetch(`http://127.0.0.1:${state.realPort}/session?directory=${encodeURIComponent(ctx.dirs.project)}`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  // Observation only: SIGKILL immediately after the wire response can race
  // OpenCode's own async storage flush, so the upstream session is "possible",
  // not guaranteed ("Create executing -> possible upstream session").
  const orphanVisible = Array.isArray(upstreamList) && upstreamList.some((s) => s.id === upstreamSessionId);
  details.observations.push({
    upstreamListCount: Array.isArray(upstreamList) ? upstreamList.length : upstreamList,
    orphanVisible,
    note: "orphan visibility after SIGKILL is upstream-durability dependent; wire capture proves the 200 commit",
  });
  console.log(`OBSERVE orphan upstream visibility after respawn: ${orphanVisible}`);

  const dbFinal = dumpDb(ctx, "final", shell.id);
  check("sqlite integrity ok", dbFinal.integrityCheck?.[0]?.integrity_check === "ok",
    JSON.stringify(dbFinal.integrityCheck));

  const failed = details.checks.filter((c) => !c.pass);
  writeDetails(ctx, details);
  writeVerdict(ctx, {
    verdict: failed.length === 0 ? "pass" : "fail",
    engine: "R+H",
    observed: failed.length === 0
      ? "committed-then-killed create left one canonical shell with a durable unknown operation, one upstream POST, no second create, and no adoption"
      : `failed checks: ${failed.map((c) => c.name).join("; ")}`,
    expected: "canonical shell and unknown operation survive; no automatic second create",
    attribution: failed.length === 0 ? "NONE" : "POLYTH",
    identifiers: { canonicalSessionIds: [shell?.id], upstreamSessionIds: [upstreamSessionId] },
    blockers: [],
    evidence: [
      `artifacts/opencode-real-world/phase-4/${ctx.id}/details.json`,
      `logs/opencode-real-world/phase-4/${ctx.id}/fault-timeline.ndjson`,
      `logs/opencode-real-world/phase-4/${ctx.id}/proxy-wire.ndjson`,
      `logs/opencode-real-world/phase-4/${ctx.id}/db-final.json`,
    ],
  });
} finally {
  await stopPolyth(ctx, polyth);
  for (const file of ["wire.ndjson", "timeline.ndjson", "opencode.log", "captured-swallow-create.json"]) {
    const src = join(ctx.dirs.proxy, file);
    if (existsSync(src)) writeFileSync(join(ctx.dirs.logs, `proxy-${file}`), readFileSync(src));
  }
}
