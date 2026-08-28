/**
 * OC-REAL-073 (R+H): two clients send DIFFERENT messages from idle within one
 * scheduler tick. Expected: one admitted, one queued (fallback turn-active or
 * FIFO), both clients converge to one identical durable order, the loser is
 * never lost, and neither prompt is dispatched upstream twice.
 *
 * R: two independent HTTP clients POST /message concurrently (same macrotask).
 * H: deterministic same-tick double `sessions.send` on the in-process service
 *    (both invocations issued synchronously in one tick, no await between).
 */
import { join } from "node:path";
import {
  HttpClient, MODEL, OPENCODE_VERSION, WsClient, closeRuntime, createIdleSession,
  databaseSnapshot, duplicateSeqs, errorCode, makeChecks, makeScratch, manifest,
  openRuntime, orderFingerprint, restEvents, restoreEnvironment, serveForProject,
  sleep, snapshotOf, upstreamMessages, upstreamUserTextCount, waitFor,
  writeJson, writeOpencodeConfig, writeVerdict,
  type RuntimeHandle, type Scratch,
} from "./phase7lib.ts";

const ID = "OC-REAL-073";
const { checks, check } = makeChecks();
const details: Record<string, unknown> = {};

const runRound = async (
  scratch: Scratch,
  runtime: RuntimeHandle,
  label: "real" | "harness",
  sessionInfo: { projectId: string; sessionId: string },
  fire: (textA: string, textB: string) => Promise<[PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]>,
): Promise<Record<string, unknown>> => {
  const { projectId, sessionId } = sessionInfo;
  const observer = new HttpClient(`observer-${label}`, runtime.baseUrl, join(scratch.logsDir, `observer-${label}.ndjson`));
  const wsA = await WsClient.open(`A-${label}`, runtime.baseUrl, join(scratch.logsDir, `ws-a-${label}.ndjson`));
  const wsB = await WsClient.open(`B-${label}`, runtime.baseUrl, join(scratch.logsDir, `ws-b-${label}.ndjson`));
  wsA.subscribe(sessionId, projectId);
  wsB.subscribe(sessionId, projectId);
  await wsA.waitForEvent((e) => e.sessionId === sessionId && e.type === "session/created", 10_000, "gap-fill");
  await wsB.waitForEvent((e) => e.sessionId === sessionId && e.type === "session/created", 10_000, "gap-fill");

  const textA = `Reply with exactly the single word ALPHA-${label.toUpperCase()} and nothing else.`;
  const textB = `Reply with exactly the single word BRAVO-${label.toUpperCase()} and nothing else.`;
  const [resultA, resultB] = await fire(textA, textB);

  // Both texts must eventually run: two turn/started + two turn/stopped.
  // A stall here is itself evidence — record it instead of crashing.
  let stalled: string | null = null;
  try {
    await waitFor(async () => {
      const events = await restEvents(observer, sessionId);
      return events.filter((e) => e.type === "turn/stopped").length >= 2;
    }, 240_000, 500, `${label}: both turns complete`);
    await waitFor(async () => {
      const snap = await snapshotOf(observer, sessionId);
      return snap.status === "idle";
    }, 60_000, 300, `${label}: idle after both turns`);
  } catch (error) {
    stalled = String(error);
  }
  // Let the WS tails flush.
  await sleep(1_500);
  {
    const events = await restEvents(observer, sessionId);
    const snap = await snapshotOf(observer, sessionId);
    check(`${label}: both admitted turns terminalize (no stall)`,
      stalled === null,
      stalled === null
        ? "both turns reached turn/stopped and the session settled idle"
        : `${stalled}; started=${events.filter((e) => e.type === "turn/started").length} `
          + `stopped=${events.filter((e) => e.type === "turn/stopped").length} `
          + `lastEvent=${events.at(-1)?.seq}:${events.at(-1)?.type} status=${String(snap.status)}`);
  }

  const events = await restEvents(observer, sessionId);
  const started = events.filter((e) => e.type === "turn/started");
  const stopped = events.filter((e) => e.type === "turn/stopped");
  const enqueued = events.filter((e) => e.type === "queue/enqueued");
  const fallback = events.filter((e) => e.type === "delivery/fallback-queued");
  const userMessages = events.filter((e) => e.type === "user/message");

  // Admission shape: exactly one send admitted directly, the other queued
  // exactly once (never two immediate admissions, never a lost loser).
  const firstStopSeq = stopped[0]?.seq ?? Number.MAX_SAFE_INTEGER;
  const startedBeforeFirstStop = started.filter((e) => e.seq < firstStopSeq);
  check(`${label}: exactly one admission before the first turn completes`,
    startedBeforeFirstStop.length === 1,
    `turn/started before first turn/stopped: ${startedBeforeFirstStop.length}; total started=${started.length}`);
  // Loser loss = it never re-entered the stream; terminalization has its own
  // check above, so a stalled-but-dispatched loser is not "lost".
  check(`${label}: loser queued exactly once, never lost`,
    enqueued.length === 1 && started.length === 2,
    `queue/enqueued=${enqueued.length} turn/started=${started.length} turn/stopped=${stopped.length} fallback=${fallback.length}`);
  const userTexts = userMessages.map((e) => String((e.data as { text?: unknown }).text ?? ""));
  check(`${label}: both texts entered the durable log exactly once`,
    userTexts.filter((t) => t === textA).length === 1 && userTexts.filter((t) => t === textB).length === 1,
    JSON.stringify(userTexts.map((t) => t.slice(0, 40))));

  // Convergence: both WS clients hold one identical durable order == REST.
  const canonical = orderFingerprint(events);
  const clientAEvents = wsA.eventsFor(sessionId);
  const clientBEvents = wsB.eventsFor(sessionId);
  check(`${label}: client A converges to canonical durable order`,
    orderFingerprint(clientAEvents) === canonical && duplicateSeqs(clientAEvents).length === 0,
    `A events=${clientAEvents.length} dupSeqs=${JSON.stringify(duplicateSeqs(clientAEvents))}`);
  check(`${label}: client B converges to canonical durable order`,
    orderFingerprint(clientBEvents) === canonical && duplicateSeqs(clientBEvents).length === 0,
    `B events=${clientBEvents.length} dupSeqs=${JSON.stringify(duplicateSeqs(clientBEvents))}`);
  check(`${label}: no client-specific order (A == B frame-for-frame on seqs)`,
    JSON.stringify(clientAEvents.map((e) => e.seq)) === JSON.stringify(clientBEvents.map((e) => e.seq)),
    `A seqs=${clientAEvents.length} B seqs=${clientBEvents.length}`);

  // Upstream: each text once, never twice (no double dispatch).
  const serve = serveForProject(scratch.project);
  let upstream: Record<string, unknown> = { unavailable: true };
  if (serve?.port) {
    const snap = await snapshotOf(observer, sessionId);
    const backendId = String(snap.backendSessionId ?? "");
    if (backendId) {
      const messages = await upstreamMessages(
        `http://127.0.0.1:${serve.port}`, backendId, scratch.project,
        join(scratch.logsDir, `upstream-${label}.ndjson`));
      const countA = upstreamUserTextCount(messages, textA);
      const countB = upstreamUserTextCount(messages, textB);
      check(`${label}: upstream saw each prompt exactly once`,
        countA === 1 && countB === 1,
        `upstream user-message counts: A=${countA} B=${countB} total=${messages.length}`);
      upstream = { backendId, countA, countB, totalMessages: messages.length, servePid: serve.pid };
    }
  }

  const queueRows = await observer.call("GET", `/api/sessions/${sessionId}/queue`);
  check(`${label}: queue fully drained`,
    Array.isArray(queueRows.body) && queueRows.body.length === 0,
    JSON.stringify(queueRows.body).slice(0, 200));

  wsA.close();
  wsB.close();
  return {
    sessionId,
    sendResults: {
      a: resultA.status === "fulfilled" ? resultA.value : { rejected: errorCode(resultA.reason) },
      b: resultB.status === "fulfilled" ? resultB.value : { rejected: errorCode(resultB.reason) },
    },
    admission: {
      startedSeqs: started.map((e) => e.seq),
      stoppedSeqs: stopped.map((e) => e.seq),
      enqueued: enqueued.map((e) => ({ seq: e.seq, data: e.data })),
      fallback: fallback.map((e) => ({ seq: e.seq, data: e.data })),
    },
    canonicalFingerprintLength: events.length,
    upstream,
  };
};

const scratch = await makeScratch(ID);
await writeOpencodeConfig(scratch, { bash: "allow" });
let runtime: RuntimeHandle | undefined;
try {
  runtime = await openRuntime(scratch);
  const admin = new HttpClient("admin", runtime.baseUrl, join(scratch.logsDir, "admin.ndjson"));
  await manifest(scratch, { scenario: "two same-tick sends from idle", engine: "R+H" });

  // ---- R round: two independent HTTP clients, POSTs fired in one macrotask.
  const realSession = await createIdleSession(admin, scratch.project, "s073-real");
  const httpA = new HttpClient("client-a", runtime.baseUrl, join(scratch.logsDir, "client-a.ndjson"));
  const httpB = new HttpClient("client-b", runtime.baseUrl, join(scratch.logsDir, "client-b.ndjson"));
  details.real = await runRound(scratch, runtime, "real", realSession, (textA, textB) => {
    const pA = httpA.call("POST", `/api/sessions/${realSession.sessionId}/message`, { text: textA, model: MODEL }, 120_000);
    const pB = httpB.call("POST", `/api/sessions/${realSession.sessionId}/message`, { text: textB, model: MODEL }, 120_000);
    return Promise.allSettled([pA, pB]) as Promise<[PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]>;
  });

  // ---- H round: deterministic same-tick double send on the service surface.
  const harnessSession = await createIdleSession(admin, scratch.project, "s073-harness");
  details.harness = await runRound(scratch, runtime, "harness", harnessSession, (textA, textB) => {
    const sessions = runtime!.app.sessions;
    // Same synchronous tick: no await between the two invocations.
    const pA = sessions.send(harnessSession.sessionId, { text: textA, model: MODEL });
    const pB = sessions.send(harnessSession.sessionId, { text: textB, model: MODEL });
    return Promise.allSettled([pA, pB]) as Promise<[PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]>;
  });

  const db = await databaseSnapshot(scratch, "db-final");
  check("sqlite integrity ok",
    (db.integrityCheck as Array<{ integrity_check?: string }>)?.[0]?.integrity_check === "ok",
    JSON.stringify(db.integrityCheck));

  const failures = checks.filter((c) => !c.pass);
  const dupFailure = failures.some((c) => /exactly once|one admission|queued exactly once/.test(c.name));
  await writeJson(join(scratch.artifactsDir, "details.json"), { checks, ...details });
  await writeVerdict(scratch, {
    id: ID,
    verdict: failures.length === 0 ? "pass" : "fail",
    engine: "R+H",
    opencodeVersion: OPENCODE_VERSION,
    protocol: "legacy",
    observed: failures.length === 0
      ? "same-tick double send from idle (real HTTP race + deterministic in-process tick): one admission, loser queued once, both WS clients converged to one canonical order, upstream saw each prompt exactly once"
      : `failed checks: ${failures.map((c) => c.name).join("; ")}`,
    expected: "one admitted, one queued; both clients converge to identical durable order; no double admission, no lost loser",
    attribution: failures.length === 0 ? "NONE" : "POLYTH",
    multiClientBlocker: dupFailure,
    identifiers: {
      realSessionId: (details.real as { sessionId?: unknown })?.sessionId,
      harnessSessionId: (details.harness as { sessionId?: unknown })?.sessionId,
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
