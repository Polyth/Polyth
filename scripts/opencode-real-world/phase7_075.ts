/**
 * OC-REAL-075 (R+H): one client edits/reorders/removes queued items while a
 * second client watches and the active turn completes. Expected: the composer
 * edit hold (reservation) blocks dispatch that would corrupt the edit, edits
 * apply to dispatch text (never stale), the removed item never dispatches,
 * dispatch follows the final order, nothing dispatches twice, and both
 * clients converge to one canonical durable order.
 *
 * R: all mutations over two independent HTTP clients + two WS observers.
 * H: deterministic hold-vs-completion race — the queue head is held via
 *    queueEditStart BEFORE the active turn completes, proving the completed
 *    turn cannot dispatch a row that is open in a composer.
 */
import { join } from "node:path";
import {
  HttpClient, MODEL, OPENCODE_VERSION, WsClient, closeRuntime, createIdleSession,
  databaseSnapshot, duplicateSeqs, makeChecks, makeScratch, manifest, openRuntime,
  orderFingerprint, restEvents, restoreEnvironment, serveForProject, sleep,
  snapshotOf, upstreamMessages, upstreamUserTextCount, waitFor, writeJson,
  writeOpencodeConfig, writeVerdict,
  type RuntimeHandle,
} from "./phase7lib.ts";

const ID = "OC-REAL-075";
const { checks, check } = makeChecks();
const details: Record<string, unknown> = {};

const scratch = await makeScratch(ID);
await writeOpencodeConfig(scratch, { bash: "allow" });
let runtime: RuntimeHandle | undefined;
try {
  runtime = await openRuntime(scratch);
  await manifest(scratch, { scenario: "queue edit/reorder/remove during an active turn, second client watching", engine: "R+H" });

  const editor = new HttpClient("editor", runtime.baseUrl, join(scratch.logsDir, "editor.ndjson"));
  const watcherHttp = new HttpClient("watcher", runtime.baseUrl, join(scratch.logsDir, "watcher-http.ndjson"));
  const { projectId, sessionId } = await createIdleSession(editor, scratch.project, "s075");

  const wsEditor = await WsClient.open("editor", runtime.baseUrl, join(scratch.logsDir, "ws-editor.ndjson"));
  const wsWatcher = await WsClient.open("watcher", runtime.baseUrl, join(scratch.logsDir, "ws-watcher.ndjson"));
  wsEditor.subscribe(sessionId, projectId);
  wsWatcher.subscribe(sessionId, projectId);
  await wsEditor.waitForEvent((e) => e.sessionId === sessionId && e.type === "session/created", 10_000, "gap-fill editor");
  await wsWatcher.waitForEvent((e) => e.sessionId === sessionId && e.type === "session/created", 10_000, "gap-fill watcher");

  // Active turn: a real bash sleep long enough to mutate the queue meanwhile.
  const textM0 = "Use the bash tool to run exactly: sleep 25; printf M0-DONE-075 — then reply with the single word DONE.";
  const sendM0 = await editor.call("POST", `/api/sessions/${sessionId}/message`, { text: textM0, model: MODEL }, 120_000);
  check("active turn admitted", sendM0.status === 200, `status=${sendM0.status}`);
  await wsWatcher.waitForEvent((e) => e.sessionId === sessionId && e.type === "turn/started", 60_000, "turn started");

  // Three queued items while the turn is active.
  const textQ1 = "Reply with exactly the single word QUEUE-ONE-075 and nothing else.";
  const textQ2 = "Reply with exactly the single word QUEUE-TWO-STALE-075 and nothing else.";
  const textQ2Edited = "Reply with exactly the single word QUEUE-TWO-EDITED-075 and nothing else.";
  const textQ3 = "Reply with exactly the single word QUEUE-THREE-075 and nothing else.";
  const q1 = await editor.call("POST", `/api/sessions/${sessionId}/message`, { text: textQ1, model: MODEL, delivery: "queue" });
  const q2 = await editor.call("POST", `/api/sessions/${sessionId}/message`, { text: textQ2, model: MODEL, delivery: "queue" });
  const q3 = await editor.call("POST", `/api/sessions/${sessionId}/message`, { text: textQ3, model: MODEL, delivery: "queue" });
  const q1Id = String((q1.body as { queueId?: unknown }).queueId ?? "");
  const q2Id = String((q2.body as { queueId?: unknown }).queueId ?? "");
  const q3Id = String((q3.body as { queueId?: unknown }).queueId ?? "");
  check("three items queued while turn active",
    [q1, q2, q3].every((r) => r.status === 200) && Boolean(q1Id && q2Id && q3Id),
    `q1=${q1Id} q2=${q2Id} q3=${q3Id}`);

  // Watcher sees every enqueue.
  await wsWatcher.waitForEvent((e) => e.sessionId === sessionId && e.type === "queue/enqueued"
    && (e.data as { queueId?: unknown }).queueId === q3Id, 15_000, "watcher saw q3 enqueue");

  // Edit Q2's text (hold -> save), reorder to [Q3, Q2, Q1], remove Q1.
  const editStart = await editor.call("POST", `/api/sessions/${sessionId}/queue/${q2Id}/edit`);
  const editSave = await editor.call("PATCH", `/api/sessions/${sessionId}/queue/${q2Id}`, { text: textQ2Edited });
  const reorder = await editor.call("PATCH", `/api/sessions/${sessionId}/queue/order`, { ids: [q3Id, q2Id, q1Id] });
  const removal = await editor.call("DELETE", `/api/sessions/${sessionId}/queue/${q1Id}`);
  check("edit + reorder + remove all accepted",
    editStart.status === 200 && editSave.status === 200 && reorder.status === 200 && removal.status === 200,
    `edit=${editStart.status}/${editSave.status} reorder=${reorder.status} remove=${removal.status}`);
  const queueAfterMutations = await watcherHttp.call("GET", `/api/sessions/${sessionId}/queue`);
  const afterIds = (queueAfterMutations.body as Array<{ id?: unknown }>).map((item) => String(item.id));
  check("watcher sees final queue order [Q3, Q2-edited]",
    JSON.stringify(afterIds) === JSON.stringify([q3Id, q2Id]),
    JSON.stringify(afterIds));

  // H determinism: hold the head (Q3) BEFORE the active turn completes. The
  // completed turn must NOT dispatch a row that is open in a composer.
  const holdHead = await editor.call("POST", `/api/sessions/${sessionId}/queue/${q3Id}/edit`);
  check("head hold accepted before turn completion", holdHead.status === 200, `status=${holdHead.status}`);

  await wsWatcher.waitForEvent((e) => e.sessionId === sessionId && e.type === "turn/stopped", 240_000, "active turn completed");
  await sleep(2_500); // any (wrong) dispatch would start here
  const startedDuringHold = (await restEvents(watcherHttp, sessionId)).filter((e) => e.type === "turn/started");
  const queueDuringHold = await watcherHttp.call("GET", `/api/sessions/${sessionId}/queue`);
  check("held head did not dispatch after turn completion (reservation blocks corrupting dispatch)",
    startedDuringHold.length === 1
      && Array.isArray(queueDuringHold.body) && (queueDuringHold.body as unknown[]).length === 2,
    `turn/started=${startedDuringHold.length} queueLen=${(queueDuringHold.body as unknown[]).length}`);
  details.holdWindow = { startedDuringHold: startedDuringHold.length, queueDuringHold: queueDuringHold.body };

  // Release the hold -> FIFO resumes: Q3 then Q2 (edited).
  const cancelHold = await editor.call("DELETE", `/api/sessions/${sessionId}/queue/${q3Id}/edit`);
  check("hold cancel accepted", cancelHold.status === 200, `status=${cancelHold.status}`);

  // A dispatch/terminalization stall here is evidence, not a harness crash.
  let stalled: string | null = null;
  try {
    await waitFor(async () => {
      const events = await restEvents(watcherHttp, sessionId);
      return events.filter((e) => e.type === "turn/stopped").length >= 3;
    }, 300_000, 500, "all three turns completed");
    await waitFor(async () => (await snapshotOf(watcherHttp, sessionId)).status === "idle", 60_000, 300, "idle");
  } catch (error) {
    stalled = String(error);
  }
  await sleep(1_500);
  {
    const events = await restEvents(watcherHttp, sessionId);
    const snap = await snapshotOf(watcherHttp, sessionId);
    check("all queued dispatches terminalize (no stall)",
      stalled === null,
      stalled === null
        ? "three turn/stopped events observed and session settled idle"
        : `${stalled}; started=${events.filter((e) => e.type === "turn/started").length} `
          + `stopped=${events.filter((e) => e.type === "turn/stopped").length} `
          + `lastEvent=${events.at(-1)?.seq}:${events.at(-1)?.type} status=${String(snap.status)}`);
  }

  // Editing an already-dispatched row must be a typed rejection, not silence.
  const editDispatched = await editor.call("PATCH", `/api/sessions/${sessionId}/queue/${q3Id}`, { text: "too late" });
  check("editing an already-dispatched item is refused typed",
    editDispatched.status === 404 || editDispatched.status === 409,
    `status=${editDispatched.status} body=${editDispatched.raw.slice(0, 120)}`);

  const events = await restEvents(watcherHttp, sessionId);
  const userTexts = events.filter((e) => e.type === "user/message")
    .map((e) => String((e.data as { text?: unknown }).text ?? ""));
  check("dispatch order matches final queue order with edited text (no stale dispatch, no lost item)",
    JSON.stringify(userTexts) === JSON.stringify([textM0, textQ3, textQ2Edited]),
    JSON.stringify(userTexts.map((t) => t.slice(0, 44))));
  check("removed item never dispatched and stale text never dispatched",
    !userTexts.includes(textQ1) && !userTexts.includes(textQ2),
    `q1Present=${userTexts.includes(textQ1)} staleQ2Present=${userTexts.includes(textQ2)}`);
  const queueEvents = events.filter((e) => e.type.startsWith("queue/")).map((e) => `${e.seq}:${e.type}`);
  details.queueEvents = queueEvents;
  check("durable queue mutation trail complete (3 enqueued, 1 edited, 1 reordered, 1 removed)",
    events.filter((e) => e.type === "queue/enqueued").length === 3
      && events.filter((e) => e.type === "queue/edited").length === 1
      && events.filter((e) => e.type === "queue/reordered").length === 1
      && events.filter((e) => e.type === "queue/removed").length === 1,
    JSON.stringify(queueEvents));
  const finalQueue = await watcherHttp.call("GET", `/api/sessions/${sessionId}/queue`);
  check("queue fully drained", Array.isArray(finalQueue.body) && (finalQueue.body as unknown[]).length === 0,
    JSON.stringify(finalQueue.body));

  // Convergence: both WS clients hold the identical canonical order.
  const canonical = orderFingerprint(events);
  const editorEvents = wsEditor.eventsFor(sessionId);
  const watcherEvents = wsWatcher.eventsFor(sessionId);
  check("editor and watcher converge to one canonical order",
    orderFingerprint(editorEvents) === canonical && orderFingerprint(watcherEvents) === canonical
      && duplicateSeqs(editorEvents).length === 0 && duplicateSeqs(watcherEvents).length === 0,
    `editor=${editorEvents.length} watcher=${watcherEvents.length} rest=${events.length}`);

  // O: upstream saw each surviving text exactly once, removed/stale never.
  let upstreamDuplicate = false;
  const serve = serveForProject(scratch.project);
  if (serve?.port) {
    const snap = await snapshotOf(watcherHttp, sessionId);
    const backendId = String(snap.backendSessionId ?? "");
    if (backendId) {
      const messages = await upstreamMessages(
        `http://127.0.0.1:${serve.port}`, backendId, scratch.project,
        join(scratch.logsDir, "upstream.ndjson"));
      const counts = {
        m0: upstreamUserTextCount(messages, "M0-DONE-075"),
        q3: upstreamUserTextCount(messages, "QUEUE-THREE-075"),
        q2edited: upstreamUserTextCount(messages, "QUEUE-TWO-EDITED-075"),
        q2stale: upstreamUserTextCount(messages, "QUEUE-TWO-STALE-075"),
        q1removed: upstreamUserTextCount(messages, "QUEUE-ONE-075"),
      };
      upstreamDuplicate = Object.values(counts).some((count) => count > 1);
      check("upstream: surviving texts exactly once, removed and stale texts never (no duplicate dispatch)",
        counts.m0 === 1 && counts.q3 === 1 && counts.q2edited === 1 && counts.q2stale === 0 && counts.q1removed === 0,
        JSON.stringify(counts));
      details.upstream = { backendId, servePid: serve.pid, counts, totalMessages: messages.length };
    }
  }

  wsEditor.close();
  wsWatcher.close();

  const db = await databaseSnapshot(scratch, "db-final");
  check("sqlite integrity ok",
    (db.integrityCheck as Array<{ integrity_check?: string }>)?.[0]?.integrity_check === "ok",
    JSON.stringify(db.integrityCheck));

  const failures = checks.filter((c) => !c.pass);
  // BLOCKER = actual duplication/corruption between clients — a dispatch that
  // never happened because of a terminalization stall is a FAIL, not a BLOCKER.
  const dupFailure = upstreamDuplicate || failures.some((c) =>
    c.name === "removed item never dispatched and stale text never dispatched"
    || c.name === "editor and watcher converge to one canonical order"
    || c.name === "held head did not dispatch after turn completion (reservation blocks corrupting dispatch)");
  await writeJson(join(scratch.artifactsDir, "details.json"), { checks, sessionId, q1Id, q2Id, q3Id, ...details });
  await writeVerdict(scratch, {
    id: ID,
    verdict: failures.length === 0 ? "pass" : "fail",
    engine: "R+H",
    opencodeVersion: OPENCODE_VERSION,
    protocol: "legacy",
    observed: failures.length === 0
      ? "queue edit/reorder/remove during an active turn with a second watching client: composer hold blocked dispatch after turn completion, released hold resumed FIFO in the final order with edited text, removed/stale texts never dispatched, both clients converged"
      : `failed checks: ${failures.map((c) => c.name).join("; ")}`,
    expected: "reservation blocks edits that would corrupt dispatch; both clients converge; no lost item, stale dispatch text, reorder mismatch, or duplicate",
    attribution: failures.length === 0 ? "NONE" : "POLYTH",
    multiClientBlocker: dupFailure,
    identifiers: { sessionId, q1Id, q2Id, q3Id },
    evidence: [
      `artifacts/opencode-real-world/phase-7/${ID}/details.json`,
      `logs/opencode-real-world/phase-7/${ID}/ws-editor.ndjson`,
      `logs/opencode-real-world/phase-7/${ID}/ws-watcher.ndjson`,
      `logs/opencode-real-world/phase-7/${ID}/editor.ndjson`,
      `logs/opencode-real-world/phase-7/${ID}/watcher-http.ndjson`,
      `logs/opencode-real-world/phase-7/${ID}/upstream.ndjson`,
      `logs/opencode-real-world/phase-7/${ID}/db-final.json`,
    ],
    failures: failures.map((c) => `${c.name}: ${c.observed}`),
  });
} finally {
  await closeRuntime(runtime);
  restoreEnvironment();
}
