/**
 * OC-REAL-077 (R): disconnect EVERY UI while a turn/tool runs and while a
 * permission request is pending; reconnect a brand-new UI afterwards.
 * Expected: the backend keeps working with zero WS clients attached (no abort
 * on UI loss), durable state catches up on reconnect (no missing completion,
 * no duplicate prompt, no stale sending indicator), and a pending request
 * survives the UI-less window and is answerable by the new UI.
 *
 * During each no-UI window this harness touches ONLY the upstream opencode
 * serve process directly (never Polyth), so backend progress is proven
 * independent of any Polyth-side observer.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  HttpClient, MODEL, OPENCODE_VERSION, WsClient, closeRuntime, createIdleSession,
  databaseSnapshot, duplicateSeqs, makeChecks, makeScratch, manifest, messageRole,
  messageText, openRuntime, orderFingerprint, restEvents, restoreEnvironment,
  serveForProject, sleep, snapshotOf, upstreamMessages, upstreamUserTextCount,
  waitFor, writeJson, writeOpencodeConfig, writeVerdict,
  type RuntimeHandle,
} from "./phase7lib.ts";

const ID = "OC-REAL-077";
const { checks, check } = makeChecks();
const details: Record<string, unknown> = {};

const scratch = await makeScratch(ID);
// bash=ask for both rounds: round 1 approves its permission BEFORE the UIs
// disconnect (so the disconnect happens mid-running-tool), round 2 leaves the
// request pending across the no-UI window.
await writeOpencodeConfig(scratch, { bash: "ask" });
let runtime: RuntimeHandle | undefined;
try {
  runtime = await openRuntime(scratch);
  await manifest(scratch, { scenario: "all UIs disconnect during turn/tool and during pending permission; new UI reconnects", engine: "R" });
  const admin = new HttpClient("admin", runtime.baseUrl, join(scratch.logsDir, "admin.ndjson"));

  // ================= Round 1: disconnect mid-turn/tool =====================
  const r1 = await createIdleSession(admin, scratch.project, "s077-turn");
  const ws1a = await WsClient.open("A-turn", runtime.baseUrl, join(scratch.logsDir, "ws-a-turn.ndjson"));
  const ws1b = await WsClient.open("B-turn", runtime.baseUrl, join(scratch.logsDir, "ws-b-turn.ndjson"));
  ws1a.subscribe(r1.sessionId, r1.projectId);
  ws1b.subscribe(r1.sessionId, r1.projectId);
  await ws1a.waitForEvent((e) => e.sessionId === r1.sessionId && e.type === "session/created", 10_000, "gap-fill A");
  await ws1b.waitForEvent((e) => e.sessionId === r1.sessionId && e.type === "session/created", 10_000, "gap-fill B");

  const marker1 = "marker-077-turn.txt";
  const text1 = `Use the bash tool to run exactly: sleep 15; printf UI-LESS-DONE >> ${marker1} — then reply with the single word FINISHED-077.`;
  const send1 = await admin.call("POST", `/api/sessions/${r1.sessionId}/message`, { text: text1, model: MODEL }, 120_000);
  check("round1: turn admitted", send1.status === 200, `status=${send1.status}`);
  const requested1 = await ws1a.waitForEvent(
    (e) => e.sessionId === r1.sessionId && e.type === "permission/requested", 120_000, "bash permission");
  const rid1 = String((requested1.data as { requestId?: unknown }).requestId ?? "");
  // Approve so the 15s tool runs, then drop every UI while it is mid-flight.
  const approve1 = await admin.call("POST", `/api/sessions/${r1.sessionId}/permission/${rid1}`, { reply: "once" });
  check("round1: permission approved", approve1.status === 200, `status=${approve1.status}`);
  await ws1a.waitForEvent((e) => e.sessionId === r1.sessionId && e.type === "tool/started"
    && (e.data as { tool?: unknown }).tool === "bash", 60_000, "bash tool started");

  const serve1 = serveForProject(scratch.project);
  const backend1 = String((await snapshotOf(admin, r1.sessionId)).backendSessionId ?? "");
  ws1a.close();
  ws1b.close();
  const disconnectAt1 = Date.now();
  details.round1Disconnect = { at: disconnectAt1, servePid: serve1?.pid, backendSessionId: backend1 };

  // NO Polyth contact during the window: watch completion on upstream only.
  await waitFor(async () => {
    if (!serve1?.port || !backend1) return false;
    const messages = await upstreamMessages(`http://127.0.0.1:${serve1.port}`, backend1, scratch.project,
      join(scratch.logsDir, "upstream-turn-window.ndjson"));
    return messages.some((message) =>
      messageRole(message) === "assistant" && messageText(message).includes("FINISHED-077"));
  }, 180_000, 1_000, "upstream completed with zero UIs attached");
  const uiLessMs1 = Date.now() - disconnectAt1;
  const serveAfter1 = serveForProject(scratch.project);
  const marker1Content = existsSync(join(scratch.project, marker1))
    ? readFileSync(join(scratch.project, marker1), "utf8")
    : null;
  check("round1: backend survived and completed the turn with zero UIs attached",
    serveAfter1?.pid === serve1?.pid && marker1Content !== null,
    `pid=${serve1?.pid}->${serveAfter1?.pid} uiLessMs=${uiLessMs1} marker=${JSON.stringify(marker1Content)}`);
  check("round1: tool side effect executed exactly once during the no-UI window",
    marker1Content === "UI-LESS-DONE",
    JSON.stringify(marker1Content));

  // Fresh UI rehydrates from the durable log.
  const ws1c = await WsClient.open("C-turn-reconnect", runtime.baseUrl, join(scratch.logsDir, "ws-c-turn.ndjson"));
  ws1c.subscribe(r1.sessionId, r1.projectId, 0);
  await ws1c.waitForEvent((e) => e.sessionId === r1.sessionId && e.type === "turn/stopped", 60_000, "rehydrated completion");
  await waitFor(async () => (await snapshotOf(admin, r1.sessionId)).status === "idle", 60_000, 300, "round1 idle");
  await sleep(1_000);
  const rest1 = await restEvents(admin, r1.sessionId);
  const c1Events = ws1c.eventsFor(r1.sessionId);
  check("round1: new UI caught up to the full durable order (no missing completion)",
    orderFingerprint(c1Events) === orderFingerprint(rest1) && duplicateSeqs(c1Events).length === 0
      && c1Events.some((e) => e.type === "turn/stopped"),
    `c=${c1Events.length} rest=${rest1.length}`);
  check("round1: user prompt exactly once durably (no duplicate prompt)",
    rest1.filter((e) => e.type === "user/message").length === 1,
    `user/message=${rest1.filter((e) => e.type === "user/message").length}`);
  const snap1 = await snapshotOf(admin, r1.sessionId);
  check("round1: no stale sending indicator after reconnect",
    snap1.status === "idle",
    `status=${String(snap1.status)}`);
  if (serve1?.port && backend1) {
    const messages = await upstreamMessages(`http://127.0.0.1:${serve1.port}`, backend1, scratch.project,
      join(scratch.logsDir, "upstream-turn-final.ndjson"));
    check("round1: upstream saw the prompt exactly once",
      upstreamUserTextCount(messages, "FINISHED-077") === 1,
      `count=${upstreamUserTextCount(messages, "FINISHED-077")}`);
  }
  ws1c.close();
  details.round1 = { sessionId: r1.sessionId, uiLessMs: uiLessMs1, events: rest1.length };

  // ============== Round 2: disconnect with a pending permission ============
  const r2 = await createIdleSession(admin, scratch.project, "s077-pending");
  const ws2a = await WsClient.open("A-pending", runtime.baseUrl, join(scratch.logsDir, "ws-a-pending.ndjson"));
  const ws2b = await WsClient.open("B-pending", runtime.baseUrl, join(scratch.logsDir, "ws-b-pending.ndjson"));
  ws2a.subscribe(r2.sessionId, r2.projectId);
  ws2b.subscribe(r2.sessionId, r2.projectId);
  await ws2a.waitForEvent((e) => e.sessionId === r2.sessionId && e.type === "session/created", 10_000, "gap-fill A");
  await ws2b.waitForEvent((e) => e.sessionId === r2.sessionId && e.type === "session/created", 10_000, "gap-fill B");

  const marker2 = "marker-077-pending.txt";
  const text2 = `Use the bash tool to run exactly this command: printf PENDING-ANSWERED >> ${marker2}\n`
    + "If the command is rejected or fails, do NOT retry; reply with the single word GAVE-UP.";
  const send2 = await admin.call("POST", `/api/sessions/${r2.sessionId}/message`, { text: text2, model: MODEL }, 120_000);
  check("round2: turn admitted", send2.status === 200, `status=${send2.status}`);
  const requested2 = await ws2a.waitForEvent(
    (e) => e.sessionId === r2.sessionId && e.type === "permission/requested", 120_000, "pending permission");
  await ws2b.waitForEvent(
    (e) => e.sessionId === r2.sessionId && e.type === "permission/requested", 15_000, "pending permission on B");
  const rid2 = String((requested2.data as { requestId?: unknown }).requestId ?? "");

  const serve2 = serveForProject(scratch.project);
  ws2a.close();
  ws2b.close();
  const disconnectAt2 = Date.now();
  await sleep(12_000); // UI-less waiting window: nobody touches Polyth
  const serveAfter2 = serveForProject(scratch.project);
  check("round2: backend survived the UI-less window while a request stayed pending",
    serveAfter2?.pid === serve2?.pid,
    `pid=${serve2?.pid}->${serveAfter2?.pid} windowMs=${Date.now() - disconnectAt2}`);

  // Fresh UI rehydrates: the pending request must still be open and answerable.
  const ws2c = await WsClient.open("C-pending-reconnect", runtime.baseUrl, join(scratch.logsDir, "ws-c-pending.ndjson"));
  ws2c.subscribe(r2.sessionId, r2.projectId, 0);
  const rehydratedRequest = await ws2c.waitForEvent(
    (e) => e.sessionId === r2.sessionId && e.type === "permission/requested"
      && (e.data as { requestId?: unknown }).requestId === rid2,
    30_000, "rehydrated pending request");
  const snap2Waiting = await snapshotOf(admin, r2.sessionId);
  const debug2 = await admin.call("GET", `/api/agent/sessions/${r2.sessionId}/debug`);
  const pending2 = ((debug2.body as { debug?: { pending?: { permissions?: string[] } } })
    ?.debug?.pending ?? {}) as { permissions?: string[] };
  check("round2: pending request survived UI loss (rehydrated open, never auto-resolved)",
    Boolean(rehydratedRequest) && String(snap2Waiting.status) === "waiting"
      && Array.isArray(pending2.permissions) && pending2.permissions.includes(rid2),
    `status=${String(snap2Waiting.status)} pending=${JSON.stringify(pending2)}`);
  const rest2Mid = await restEvents(admin, r2.sessionId);
  check("round2: exactly one request, zero resolutions during the no-UI window (no abort on UI loss)",
    rest2Mid.filter((e) => e.type === "permission/requested").length === 1
      && rest2Mid.filter((e) => e.type === "permission/resolved").length === 0
      && !rest2Mid.some((e) => e.type === "turn/stopped"),
    `requested=${rest2Mid.filter((e) => e.type === "permission/requested").length} resolved=${rest2Mid.filter((e) => e.type === "permission/resolved").length}`);

  // The NEW UI answers; the gated work must complete normally.
  const answer2 = await admin.call("POST", `/api/sessions/${r2.sessionId}/permission/${rid2}`, { reply: "once" });
  check("round2: new UI's answer accepted", answer2.status === 200, `status=${answer2.status}`);
  await ws2c.waitForEvent((e) => e.sessionId === r2.sessionId && e.type === "turn/stopped", 180_000, "turn completed after reconnect answer");
  await waitFor(async () => (await snapshotOf(admin, r2.sessionId)).status === "idle", 60_000, 300, "round2 idle");
  await sleep(1_000);
  check("round2: gated side effect executed exactly once after the reconnect answer",
    existsSync(join(scratch.project, marker2)) && readFileSync(join(scratch.project, marker2), "utf8") === "PENDING-ANSWERED",
    `marker=${existsSync(join(scratch.project, marker2)) ? JSON.stringify(readFileSync(join(scratch.project, marker2), "utf8")) : "absent"}`);
  const rest2 = await restEvents(admin, r2.sessionId);
  const c2Events = ws2c.eventsFor(r2.sessionId);
  check("round2: new UI converged to the full durable order",
    orderFingerprint(c2Events) === orderFingerprint(rest2) && duplicateSeqs(c2Events).length === 0,
    `c=${c2Events.length} rest=${rest2.length}`);
  check("round2: user prompt exactly once durably (no duplicate prompt)",
    rest2.filter((e) => e.type === "user/message").length === 1,
    `user/message=${rest2.filter((e) => e.type === "user/message").length}`);
  ws2c.close();
  details.round2 = { sessionId: r2.sessionId, requestId: rid2, events: rest2.length };

  const db = await databaseSnapshot(scratch, "db-final");
  check("sqlite integrity ok",
    (db.integrityCheck as Array<{ integrity_check?: string }>)?.[0]?.integrity_check === "ok",
    JSON.stringify(db.integrityCheck));

  const failures = checks.filter((c) => !c.pass);
  const blocker = failures.some((c) => /duplicate prompt|exactly once|abort on UI loss/.test(c.name));
  await writeJson(join(scratch.artifactsDir, "details.json"), { checks, ...details });
  await writeVerdict(scratch, {
    id: ID,
    verdict: failures.length === 0 ? "pass" : "fail",
    engine: "R",
    opencodeVersion: OPENCODE_VERSION,
    protocol: "legacy",
    observed: failures.length === 0
      ? "zero-UI windows mid-tool and mid-pending-permission: backend kept working (upstream-only observation), side effects ran exactly once, the pending request survived and was answerable by a brand-new UI, rehydration matched durable truth with no duplicate prompt and no stale sending state"
      : `failed checks: ${failures.map((c) => c.name).join("; ")}`,
    expected: "backend remains active; durable state catches up; no work depends on UI presence",
    attribution: failures.length === 0 ? "NONE" : "POLYTH",
    multiClientBlocker: blocker,
    identifiers: {
      turnSessionId: (details.round1 as { sessionId?: unknown })?.sessionId,
      pendingSessionId: (details.round2 as { sessionId?: unknown })?.sessionId,
      pendingRequestId: (details.round2 as { requestId?: unknown })?.requestId,
    },
    evidence: [
      `artifacts/opencode-real-world/phase-7/${ID}/details.json`,
      `logs/opencode-real-world/phase-7/${ID}/ws-c-turn.ndjson`,
      `logs/opencode-real-world/phase-7/${ID}/ws-c-pending.ndjson`,
      `logs/opencode-real-world/phase-7/${ID}/upstream-turn-window.ndjson`,
      `logs/opencode-real-world/phase-7/${ID}/upstream-turn-final.ndjson`,
      `logs/opencode-real-world/phase-7/${ID}/admin.ndjson`,
      `logs/opencode-real-world/phase-7/${ID}/db-final.json`,
    ],
    failures: failures.map((c) => `${c.name}: ${c.observed}`),
  });
} finally {
  await closeRuntime(runtime);
  restoreEnvironment();
}
