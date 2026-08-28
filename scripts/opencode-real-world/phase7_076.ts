/**
 * OC-REAL-076 (H): client A switches rapidly among sessions while gap-fill is
 * in flight; client B stays subscribed to the busy session and live events
 * keep arriving. Expected: the newest subscribe wins (no old-subscription
 * revival), gap-fill + live events are seq-deduped and session-bound within a
 * subscription, and the staying client loses nothing.
 *
 * H determinism: s2/s3 histories are padded with >500 durable events so every
 * gap-fill spans multiple batched frames and outlives the same-tick subscribe
 * burst; the burst itself is issued with no awaits between frames.
 */
import { join } from "node:path";
import {
  HttpClient, MODEL, OPENCODE_VERSION, WsClient, closeRuntime, createIdleSession,
  databaseSnapshot, duplicateSeqs, makeChecks, makeScratch, manifest, openRuntime,
  orderFingerprint, restEvents, restoreEnvironment, sleep, snapshotOf, waitFor,
  writeJson, writeOpencodeConfig, writeVerdict,
  type RuntimeHandle, type TracedMessage,
} from "./phase7lib.ts";
import type { SessionEvent } from "@polyth/contracts";

const ID = "OC-REAL-076";
const { checks, check } = makeChecks();
const details: Record<string, unknown> = {};

/** Events grouped by the frame kind they arrived in, preserving arrival order. */
const framesOf = (messages: TracedMessage[]): Array<{ kind: "gap" | "live"; events: SessionEvent[] }> => {
  const out: Array<{ kind: "gap" | "live"; events: SessionEvent[] }> = [];
  for (const entry of messages) {
    const m = entry.message as { type?: string; event?: SessionEvent; events?: SessionEvent[] };
    if (m?.type === "events" && Array.isArray(m.events)) out.push({ kind: "gap", events: m.events });
    else if (m?.type === "event" && m.event) out.push({ kind: "live", events: [m.event] });
  }
  return out;
};

const scratch = await makeScratch(ID);
await writeOpencodeConfig(scratch, { bash: "allow" });
let runtime: RuntimeHandle | undefined;
try {
  runtime = await openRuntime(scratch);
  await manifest(scratch, { scenario: "rapid session switching during in-flight gap-fill, second client stays live", engine: "H" });

  const http = new HttpClient("driver", runtime.baseUrl, join(scratch.logsDir, "driver.ndjson"));
  const s1 = await createIdleSession(http, scratch.project, "s076-one");
  const s2 = await createIdleSession(http, scratch.project, "s076-two");
  const s3 = await createIdleSession(http, scratch.project, "s076-three");

  // Pad s2/s3 with real durable events so their gap-fill spans multiple
  // batched frames (>500 events -> >1 chunk) and stays in flight long enough
  // for the burst to land while it runs. queue/reordered is a real durable
  // ignorable event that needs no model turn.
  const PAD = 620;
  for (const target of [s2, s3]) {
    for (let i = 0; i < PAD; i += 1) {
      await runtime.app.sessions.queueReorder!(target.sessionId, []);
    }
  }
  const restS2 = await restEvents(http, s2.sessionId);
  const restS3 = await restEvents(http, s3.sessionId);
  check("s2/s3 gap-fill payloads span multiple batched frames",
    restS2.length > 500 && restS3.length > 500,
    `s2=${restS2.length} s3=${restS3.length}`);

  const wsA = await WsClient.open("A", runtime.baseUrl, join(scratch.logsDir, "ws-a.ndjson"));
  const wsB = await WsClient.open("B", runtime.baseUrl, join(scratch.logsDir, "ws-b.ndjson"));
  wsA.subscribe(s1.sessionId, s1.projectId);
  wsB.subscribe(s1.sessionId, s1.projectId);
  await wsA.waitForEvent((e) => e.sessionId === s1.sessionId && e.type === "session/created", 10_000, "gap-fill A");
  await wsB.waitForEvent((e) => e.sessionId === s1.sessionId && e.type === "session/created", 10_000, "gap-fill B");

  // Busy session: live events flow on s1 while A switches around.
  const sendLive = await http.call("POST", `/api/sessions/${s1.sessionId}/message`, {
    text: "Use the bash tool to run exactly: sleep 12; printf LIVE-076 — then reply with the single word LIVE-DONE-076.",
    model: MODEL,
  }, 120_000);
  check("live turn admitted on s1", sendLive.status === 200, `status=${sendLive.status}`);
  await wsB.waitForEvent((e) => e.sessionId === s1.sessionId && e.type === "turn/started", 60_000, "s1 turn started on B");

  // Same-tick burst: s2, s3, s2 — then, while those gap-fills are still in
  // flight, the FINAL subscribe to s3. Latest must win.
  const burstAt = Date.now();
  wsA.subscribe(s2.sessionId, s1.projectId);
  wsA.subscribe(s3.sessionId, s1.projectId);
  wsA.subscribe(s2.sessionId, s1.projectId);
  await sleep(15);
  wsA.subscribe(s3.sessionId, s1.projectId);
  details.burst = { at: burstAt, order: ["s2", "s3", "s2", "(15ms)", "s3-final"] };

  // A converges on s3: its final segment (all frames after the last frame
  // carrying any non-s3 event) must contain the complete s3 history.
  const s3Fingerprint = orderFingerprint(restS3);
  const finalSegmentOf = (): SessionEvent[] => {
    const frames = framesOf(wsA.messages);
    let start = 0;
    for (let i = 0; i < frames.length; i += 1) {
      if (frames[i]!.events.some((event) => event.sessionId !== s3.sessionId)) start = i + 1;
    }
    return frames.slice(start).flatMap((frame) => frame.events);
  };
  await waitFor(
    () => finalSegmentOf().length >= restS3.length,
    30_000, 200, "A converged on final s3 gap-fill");

  // Meanwhile B stays on s1 through the whole live turn.
  await wsB.waitForEvent((e) => e.sessionId === s1.sessionId && e.type === "turn/stopped", 240_000, "s1 turn stopped on B");
  await waitFor(async () => (await snapshotOf(http, s1.sessionId)).status === "idle", 60_000, 300, "s1 idle");

  // Post-convergence probe: one more full s1 turn. B must see all of it live;
  // A (subscribed to s3) must see none of it (the old subscription never wins).
  const probe = await http.call("POST", `/api/sessions/${s1.sessionId}/message`, {
    text: "Reply with exactly the single word AFTERBURST-076 and nothing else.", model: MODEL,
  }, 120_000);
  check("post-burst probe admitted on s1", probe.status === 200, `status=${probe.status}`);
  // The oracle needs the probe's live events to FLOW (to B, never to A); a
  // second-turn terminalization stall (seen in OC-REAL-073) must not crash
  // the scenario, so wait on the probe's assistant output, then settle.
  await wsB.waitForEvent((e) => e.sessionId === s1.sessionId && e.type === "assistant/message"
    && String((e.data as { text?: unknown }).text ?? "").includes("AFTERBURST-076"),
    240_000, "probe assistant output on B");
  let probeStalled: string | null = null;
  try {
    await wsB.waitForEvent((e) => e.sessionId === s1.sessionId && e.type === "turn/stopped"
      && e.seq > (wsB.eventsFor(s1.sessionId).find((x) => x.type === "turn/stopped")?.seq ?? 0),
      90_000, "probe turn stopped on B");
    await waitFor(async () => (await snapshotOf(http, s1.sessionId)).status === "idle", 30_000, 300, "s1 idle again");
  } catch (error) {
    probeStalled = String(error);
  }
  details.probeStalled = probeStalled;
  await sleep(2_000);

  // ---- Oracles -----------------------------------------------------------
  const restS1 = await restEvents(http, s1.sessionId);
  const bEvents = wsB.eventsFor(s1.sessionId);
  check("B (staying client) lost nothing and duplicated nothing across gap-fill+live",
    orderFingerprint(bEvents) === orderFingerprint(restS1) && duplicateSeqs(bEvents).length === 0,
    `B=${bEvents.length} rest=${restS1.length} dup=${JSON.stringify(duplicateSeqs(bEvents))}`);
  const bForeign = wsB.events().filter((event) => event.sessionId !== s1.sessionId);
  check("B received zero cross-session events",
    bForeign.length === 0,
    `foreign=${bForeign.length} ${JSON.stringify(bForeign.slice(0, 3).map((e) => `${e.sessionId}:${e.type}`))}`);

  // Newest subscribe wins iff the trailing segment (everything after the last
  // non-s3 event A ever received) is exactly the complete deduped s3 history —
  // any post-convergence s1/s2 leak would shrink or pollute this segment.
  const finalSegment = finalSegmentOf();
  check("A's final segment is the complete seq-deduped s3 view (newest subscribe wins, session-bound)",
    orderFingerprint(finalSegment) === s3Fingerprint && duplicateSeqs(finalSegment).length === 0,
    `segment=${finalSegment.length} rest=${restS3.length} dup=${JSON.stringify(duplicateSeqs(finalSegment))}`);
  const aProbeLeak = wsA.events().filter((event) =>
    event.sessionId === s1.sessionId && event.time >= burstAt + 2_000);
  check("A received no s1 live events after converging on s3 (old subscription never revived)",
    aProbeLeak.length === 0,
    `leaked=${aProbeLeak.length} ${JSON.stringify(aProbeLeak.slice(0, 3).map((e) => `${e.seq}:${e.type}`))}`);
  const aSessions = [...new Set(wsA.events().map((event) => event.sessionId))];
  check("A only ever saw sessions it subscribed to",
    aSessions.every((sid) => [s1.sessionId, s2.sessionId, s3.sessionId].includes(sid)),
    JSON.stringify(aSessions));
  details.frameSummary = {
    aFrames: framesOf(wsA.messages)
      .map((frame) => `${frame.kind}:${frame.events.length}:${frame.events[0]?.sessionId?.slice(0, 8) ?? "-"}`),
    finalSegmentLength: finalSegment.length,
  };

  wsA.close();
  wsB.close();

  const db = await databaseSnapshot(scratch, "db-final");
  check("sqlite integrity ok",
    (db.integrityCheck as Array<{ integrity_check?: string }>)?.[0]?.integrity_check === "ok",
    JSON.stringify(db.integrityCheck));

  const failures = checks.filter((c) => !c.pass);
  const blocker = failures.some((c) => /cross-session|never revived|lost nothing|session-bound/.test(c.name));
  await writeJson(join(scratch.artifactsDir, "details.json"), {
    checks, s1: s1.sessionId, s2: s2.sessionId, s3: s3.sessionId, ...details,
  });
  await writeVerdict(scratch, {
    id: ID,
    verdict: failures.length === 0 ? "pass" : "fail",
    engine: "H",
    opencodeVersion: OPENCODE_VERSION,
    protocol: "legacy",
    observed: failures.length === 0
      ? "same-tick subscribe burst across three sessions with >500-event gap-fills in flight: newest subscribe won, A's final s3 view was complete/deduped/session-bound, no old-subscription revival, and the staying client B missed nothing on the live session"
      : `failed checks: ${failures.map((c) => c.name).join("; ")}`,
    expected: "gap-fill/live events are seq-deduped and session-bound; no cross-session event, dropped live event, duplicate, or old subscription winning",
    attribution: failures.length === 0 ? "NONE" : "POLYTH",
    multiClientBlocker: blocker,
    identifiers: { s1: s1.sessionId, s2: s2.sessionId, s3: s3.sessionId },
    evidence: [
      `artifacts/opencode-real-world/phase-7/${ID}/details.json`,
      `logs/opencode-real-world/phase-7/${ID}/ws-a.ndjson`,
      `logs/opencode-real-world/phase-7/${ID}/ws-b.ndjson`,
      `logs/opencode-real-world/phase-7/${ID}/driver.ndjson`,
      `logs/opencode-real-world/phase-7/${ID}/db-final.json`,
    ],
    failures: failures.map((c) => `${c.name}: ${c.observed}`),
  });
} finally {
  await closeRuntime(runtime);
  restoreEnvironment();
}
