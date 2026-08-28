/**
 * OC-REAL-074 (R+H): two clients answer ONE pending permission with different
 * choices. Expected: exactly one CAS winner, exactly one upstream answer
 * (side-effect executed at most once, consistent with the winner), the loser
 * gets a typed error (never shown as success), and both clients converge.
 *
 * R: two independent HTTP clients POST different replies in one macrotask.
 * H: deterministic same-tick double `sessions.replyPermission` in-process.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  HttpClient, MODEL, OPENCODE_VERSION, WsClient, closeRuntime, createIdleSession,
  databaseSnapshot, dbRows, duplicateSeqs, errorCode, makeChecks, makeScratch,
  manifest, openRuntime, orderFingerprint, restEvents, restoreEnvironment,
  serveForProject, sleep, snapshotOf, upstreamMessages, waitFor, writeJson,
  writeOpencodeConfig, writeVerdict,
  type RuntimeHandle, type Scratch,
} from "./phase7lib.ts";

const ID = "OC-REAL-074";
const { checks, check } = makeChecks();
const details: Record<string, unknown> = {};

type Fired = [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>];

const runRound = async (
  scratch: Scratch,
  runtime: RuntimeHandle,
  label: "real" | "harness",
  observer: HttpClient,
  fire: (sessionId: string, requestId: string) => Promise<Fired>,
): Promise<Record<string, unknown>> => {
  const { projectId, sessionId } = await createIdleSession(observer, scratch.project, `s074-${label}`);
  const wsA = await WsClient.open(`A-${label}`, runtime.baseUrl, join(scratch.logsDir, `ws-a-${label}.ndjson`));
  const wsB = await WsClient.open(`B-${label}`, runtime.baseUrl, join(scratch.logsDir, `ws-b-${label}.ndjson`));
  wsA.subscribe(sessionId, projectId);
  wsB.subscribe(sessionId, projectId);
  await wsA.waitForEvent((e) => e.sessionId === sessionId && e.type === "session/created", 10_000, "gap-fill A");
  await wsB.waitForEvent((e) => e.sessionId === sessionId && e.type === "session/created", 10_000, "gap-fill B");

  const marker = `marker-074-${label}.txt`;
  const send = await observer.call("POST", `/api/sessions/${sessionId}/message`, {
    text: `Use the bash tool to run exactly this command: printf WINNER >> ${marker}\n`
      + "If the command is rejected or fails, do NOT retry and do NOT use any other tool; reply with the single word GAVE-UP.",
    model: MODEL,
  }, 120_000);
  check(`${label}: prompt admitted`, send.status === 200, `status=${send.status} ${send.raw.slice(0, 120)}`);

  // BOTH independent clients observe the same open permission request.
  const requestedA = await wsA.waitForEvent(
    (e) => e.sessionId === sessionId && e.type === "permission/requested", 120_000, "permission on A");
  const requestedB = await wsB.waitForEvent(
    (e) => e.sessionId === sessionId && e.type === "permission/requested", 15_000, "permission on B");
  const requestId = String((requestedA.data as { requestId?: unknown }).requestId ?? "");
  check(`${label}: one open request visible to both clients`,
    requestId.length > 0 && requestId === String((requestedB.data as { requestId?: unknown }).requestId ?? ""),
    `requestId=${requestId}`);

  const [resultA, resultB] = await fire(sessionId, requestId);
  const settled = { a: resultA, b: resultB };

  // Both turns settle: the gated tool either runs (once won) or errors (reject won).
  // A legitimate model retry after rejection opens a NEW request id; answer it
  // reject so the turn can settle (recorded, never counted as a duplicate).
  const retriesAnswered: string[] = [];
  await waitFor(async () => {
    const events = await restEvents(observer, sessionId);
    if (events.some((e) => e.type === "turn/stopped")) return true;
    const open = new Map<string, string>();
    for (const e of events) {
      const rid = String((e.data as { requestId?: unknown }).requestId ?? "");
      if (!rid) continue;
      if (e.type === "permission/requested") open.set(rid, rid);
      if (e.type === "permission/resolved") open.delete(rid);
    }
    for (const rid of open.keys()) {
      if (rid === requestId || retriesAnswered.includes(rid)) continue;
      retriesAnswered.push(rid);
      await observer.call("POST", `/api/sessions/${sessionId}/permission/${rid}`, { reply: "reject" });
    }
    return false;
  }, 180_000, 500, `${label}: turn settled after answer`);
  await waitFor(async () => (await snapshotOf(observer, sessionId)).status === "idle",
    60_000, 300, `${label}: idle`);
  await sleep(1_500);

  const events = await restEvents(observer, sessionId);
  const requestedThis = events.filter((e) =>
    e.type === "permission/requested" && (e.data as { requestId?: unknown }).requestId === requestId);
  const resolvedThis = events.filter((e) =>
    e.type === "permission/resolved" && (e.data as { requestId?: unknown }).requestId === requestId);
  check(`${label}: the contested request was asked once and resolved exactly once (no duplicate reply)`,
    requestedThis.length === 1 && resolvedThis.length === 1,
    `requested=${requestedThis.length} resolved=${resolvedThis.length} retriesAnswered=${retriesAnswered.length}`);
  const winnerReply = String((resolvedThis[0]?.data as { reply?: unknown } | undefined)?.reply ?? "");

  // Exactly one client won; the loser saw a typed error, never success.
  const okA = resultA.status === "fulfilled";
  const okB = resultB.status === "fulfilled";
  check(`${label}: exactly one CAS winner (one success, one typed loser)`,
    okA !== okB,
    `a=${okA ? "ok" : errorCode(resultA.reason)} b=${okB ? "ok" : errorCode(resultB.reason)} durableWinner=${winnerReply}`);
  const winnerIntent = okA ? "once" : "reject";
  check(`${label}: durable resolution matches the winning client's choice (no last-writer overwrite)`,
    winnerReply === winnerIntent,
    `durable=${winnerReply} winnerChoice=${winnerIntent}`);

  // Effect oracle: the gated side effect ran exactly once iff "once" won.
  const markerPath = join(scratch.project, marker);
  const markerContent = existsSync(markerPath) ? readFileSync(markerPath, "utf8") : null;
  if (winnerReply === "once") {
    check(`${label}: gated side effect executed exactly once (winner=once)`,
      markerContent === "WINNER",
      `marker=${JSON.stringify(markerContent)}`);
  } else {
    check(`${label}: gated side effect never executed (winner=reject)`,
      markerContent === null,
      `marker=${JSON.stringify(markerContent)}`);
  }

  // D: exactly one chosen response intent for this request.
  const intents = (await dbRows(scratch, "response_intents"))
    .filter((row) => JSON.stringify(row).includes(requestId));
  check(`${label}: exactly one durable response intent for the request`,
    intents.length === 1,
    `intents=${intents.length}`);

  // Convergence: both WS clients hold the identical canonical order.
  const canonical = orderFingerprint(events);
  const eventsA = wsA.eventsFor(sessionId);
  const eventsB = wsB.eventsFor(sessionId);
  check(`${label}: both clients converge to one canonical order`,
    orderFingerprint(eventsA) === canonical && orderFingerprint(eventsB) === canonical
      && duplicateSeqs(eventsA).length === 0 && duplicateSeqs(eventsB).length === 0,
    `A=${eventsA.length} B=${eventsB.length} rest=${events.length}`);

  // O: upstream durable history shows the tool once, in the winner-consistent state.
  const serve = serveForProject(scratch.project);
  let upstream: Record<string, unknown> = { unavailable: true };
  if (serve?.port) {
    const snap = await snapshotOf(observer, sessionId);
    const backendId = String(snap.backendSessionId ?? "");
    if (backendId) {
      const messages = await upstreamMessages(
        `http://127.0.0.1:${serve.port}`, backendId, scratch.project,
        join(scratch.logsDir, `upstream-${label}.ndjson`));
      const toolParts = messages.flatMap((message) =>
        (Array.isArray(message.parts) ? message.parts as Array<Record<string, unknown>> : [])
          .filter((part) => part.type === "tool" && String(part.tool ?? "") === "bash"));
      const states = toolParts.map((part) => String((part.state as { status?: unknown } | undefined)?.status ?? ""));
      const completed = states.filter((state) => state === "completed").length;
      check(`${label}: upstream executed the gated bash tool exactly once iff the winner allowed it (one upstream answer)`,
        completed === (winnerReply === "once" ? 1 : 0)
          && toolParts.length <= 1 + retriesAnswered.length,
        `bash tool parts=${toolParts.length} completed=${completed} states=${JSON.stringify(states)} winner=${winnerReply}`);
      upstream = { backendId, servePid: serve.pid, bashToolParts: toolParts.length, states };
    }
  }

  wsA.close();
  wsB.close();
  return {
    sessionId, requestId, winnerReply, settled: {
      a: okA ? settled.a : { rejected: errorCode(resultA.reason) },
      b: okB ? settled.b : { rejected: errorCode(resultB.reason) },
    }, markerContent, intentRows: intents.length, retriesAnswered, upstream,
  };
};

const scratch = await makeScratch(ID);
await writeOpencodeConfig(scratch, { bash: "ask" });
let runtime: RuntimeHandle | undefined;
try {
  runtime = await openRuntime(scratch);
  const admin = new HttpClient("admin", runtime.baseUrl, join(scratch.logsDir, "admin.ndjson"));
  await manifest(scratch, { scenario: "two clients answer one pending permission", engine: "R+H" });

  // ---- R round: two independent HTTP clients answer in one macrotask.
  const httpA = new HttpClient("client-a", runtime.baseUrl, join(scratch.logsDir, "client-a.ndjson"));
  const httpB = new HttpClient("client-b", runtime.baseUrl, join(scratch.logsDir, "client-b.ndjson"));
  details.real = await runRound(scratch, runtime, "real", admin, (sessionId, requestId) => {
    const pA = httpA.call("POST", `/api/sessions/${sessionId}/permission/${requestId}`, { reply: "once" }, 120_000)
      .then((r) => { if (r.status !== 200) throw Object.assign(new Error(r.raw), { code: `http-${r.status}` }); return r.body; });
    const pB = httpB.call("POST", `/api/sessions/${sessionId}/permission/${requestId}`, { reply: "reject" }, 120_000)
      .then((r) => { if (r.status !== 200) throw Object.assign(new Error(r.raw), { code: `http-${r.status}` }); return r.body; });
    return Promise.allSettled([pA, pB]) as Promise<Fired>;
  });

  // ---- H round: deterministic same-tick double answer on the service surface.
  details.harness = await runRound(scratch, runtime, "harness", admin, (sessionId, requestId) => {
    const sessions = runtime!.app.sessions;
    const pA = sessions.replyPermission(sessionId, requestId, "once");
    const pB = sessions.replyPermission(sessionId, requestId, "reject");
    return Promise.allSettled([pA, pB]) as Promise<Fired>;
  });

  const db = await databaseSnapshot(scratch, "db-final");
  check("sqlite integrity ok",
    (db.integrityCheck as Array<{ integrity_check?: string }>)?.[0]?.integrity_check === "ok",
    JSON.stringify(db.integrityCheck));

  const failures = checks.filter((c) => !c.pass);
  const dupFailure = failures.some((c) => /duplicate reply|one CAS winner|exactly once|one upstream answer/.test(c.name));
  await writeJson(join(scratch.artifactsDir, "details.json"), { checks, ...details });
  await writeVerdict(scratch, {
    id: ID,
    verdict: failures.length === 0 ? "pass" : "fail",
    engine: "R+H",
    opencodeVersion: OPENCODE_VERSION,
    protocol: "legacy",
    observed: failures.length === 0
      ? "double answer to one pending permission (real HTTP race + deterministic in-process tick): exactly one CAS winner, one durable resolution matching the winner, gated side effect consistent with the winner, loser got a typed conflict, both clients converged"
      : `failed checks: ${failures.map((c) => c.name).join("; ")}`,
    expected: "both clients converge; exactly one upstream answer; loser never shown as success",
    attribution: failures.length === 0 ? "NONE" : "POLYTH",
    multiClientBlocker: dupFailure,
    identifiers: {
      realSessionId: (details.real as { sessionId?: unknown })?.sessionId,
      realRequestId: (details.real as { requestId?: unknown })?.requestId,
      harnessSessionId: (details.harness as { sessionId?: unknown })?.sessionId,
      harnessRequestId: (details.harness as { requestId?: unknown })?.requestId,
    },
    evidence: [
      `artifacts/opencode-real-world/phase-7/${ID}/details.json`,
      `logs/opencode-real-world/phase-7/${ID}/ws-a-real.ndjson`,
      `logs/opencode-real-world/phase-7/${ID}/ws-b-real.ndjson`,
      `logs/opencode-real-world/phase-7/${ID}/client-a.ndjson`,
      `logs/opencode-real-world/phase-7/${ID}/client-b.ndjson`,
      `logs/opencode-real-world/phase-7/${ID}/upstream-real.ndjson`,
      `logs/opencode-real-world/phase-7/${ID}/db-final.json`,
    ],
    failures: failures.map((c) => `${c.name}: ${c.observed}`),
  });
} finally {
  await closeRuntime(runtime);
  restoreEnvironment();
}
