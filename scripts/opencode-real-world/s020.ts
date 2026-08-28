/** OC-REAL-020: complete a turn normally, then rebuild the adapter stack
 *  (Polyth-restart analogue at the runtime seam) and reconcile.
 *  Pins the central real-legacy break: real `session.idle` / `/session/status`
 *  carry NO revision field, so the adapter never emits turn/stopped and the
 *  reconcile state can never become "idle" — upstream completion is missed.
 *  The deterministic fake invents `properties.revision` on session.idle
 *  (fakeOpenCode.ts finishTurn), which is why every in-repo test passes. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  attachRuntimeLifecycle,
  createBorrowedExternalEndpointLease,
  createOpenCodeRuntimeFacade,
  createOpenCodeRuntimeLifecycle,
} from "@polyth/backend-opencode";
import type { RuntimeEvent } from "@polyth/contracts";
import {
  LIVE_MODEL,
  collectSse,
  httpJson,
  makeScratch,
  sleep,
  spawnServe,
  startFaultProxy,
  waitForAssistantCompletion,
  writeEvidence,
  writeVerdict,
  WireLog,
  OPENCODE_VERSION,
} from "./lib.ts";

const main = async (): Promise<void> => {
  const scratch = await makeScratch("OC-REAL-020");
  const failures: string[] = [];
  const wire = new WireLog(join(scratch.logsDir, "wire.ndjson"));
  const serve = await spawnServe(scratch);
  const proxy = await startFaultProxy(serve.url, wire);
  try {
    const sse = collectSse(serve.url, `/event?directory=${encodeURIComponent(scratch.project)}`, join(scratch.logsDir, "sse.ndjson"));
    const lease = await createBorrowedExternalEndpointLease({ url: proxy.url, location: { directory: scratch.project } });
    const lifecycle = await createOpenCodeRuntimeLifecycle({ lease, protocol: "legacy" });
    const facade = attachRuntimeLifecycle(createOpenCodeRuntimeFacade({ lifecycle }), lifecycle);
    const events: Array<{ t: number; ev: RuntimeEvent }> = [];
    facade.onEvent((_sessionId, ev) => events.push({ t: Date.now(), ev }));

    const marker = "DONE-MARKER-020";
    const backendId = await facade.ensureSession({ sessionId: "complete-1", cwd: scratch.project, title: "OC-REAL-020" });
    await sleep(300);
    await facade.startTurn({
      sessionId: "complete-1",
      text: `Reply with exactly the words ${marker} and nothing else. No tools.`,
      model: LIVE_MODEL,
    });
    const done = await waitForAssistantCompletion(serve.url, backendId, scratch.project, 90_000);
    const idleOnWire = await sse.waitFor((event) =>
      event.type === "session.idle"
      && (event.data as { properties?: { sessionID?: string } }).properties?.sessionID === backendId, 15_000);
    // Grace period: if the adapter can terminalize, turn/stopped must arrive now.
    await sleep(3_000);

    const rawIdle = sse.events.find((event) =>
      event.type === "session.idle"
      && (event.data as { properties?: { sessionID?: string } }).properties?.sessionID === backendId);
    const turnStarted = events.filter((entry) => entry.ev.type === "turn/started").length;
    const turnStopped = events.filter((entry) => entry.ev.type === "turn/stopped");
    const finalized = events.filter((entry) => entry.ev.type === "assistant/message")
      .map((entry) => (entry.ev as { text: string }).text);
    const statusRaw = await httpJson(serve.url, "GET", `/session/status?directory=${encodeURIComponent(scratch.project)}`);
    const endpoint = await facade.endpoint!();
    const snapshot1 = await facade.reconcile!({
      canonicalSessionId: "complete-1",
      backendSessionId: backendId,
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
      continuity: "generation-only",
      location: { directory: scratch.project },
      reconciliationOrdinal: 1,
    });

    if (!done.completed) failures.push("upstream turn did not complete");
    if (!idleOnWire) failures.push("no session.idle observed on the wire");
    if (turnStarted !== 1) failures.push(`turn/started emitted ${turnStarted} times`);
    // THE BREAK: ordered idle evidence was on the wire but the adapter cannot
    // terminalize because real payloads carry no comparable revision.
    if (turnStopped.length === 0) {
      failures.push("MISSED COMPLETION: upstream idle on the wire but the facade never emitted turn/stopped (real session.idle has no revision field; terminalStateEvidenceOf requires one)");
    }
    if (snapshot1.state.value !== "idle") {
      failures.push(`reconcile after completion reports state=${snapshot1.state.value}, expected idle (raw /session/status = ${JSON.stringify(statusRaw.body).slice(0, 100)})`);
    }

    // ---- Polyth-restart analogue: fresh lifecycle + facade, same backend ----
    await facade.dispose();
    const lease2 = await createBorrowedExternalEndpointLease({ url: proxy.url, location: { directory: scratch.project } });
    const lifecycle2 = await createOpenCodeRuntimeLifecycle({ lease: lease2, protocol: "legacy" });
    const facade2 = attachRuntimeLifecycle(createOpenCodeRuntimeFacade({ lifecycle: lifecycle2 }), lifecycle2);
    const endpoint2 = await facade2.endpoint!();
    const snapshot2 = await facade2.reconcile!({
      canonicalSessionId: "complete-1",
      backendSessionId: backendId,
      authorityId: endpoint2.authorityId,
      generation: endpoint2.generation,
      continuity: "generation-only",
      location: { directory: scratch.project },
      reconciliationOrdinal: 1,
    });
    const snapshotTexts = (snapshot: typeof snapshot2): string[] =>
      snapshot.events.filter((entry) => entry.event.type === "assistant/message")
        .map((entry) => (entry.event as { text: string }).text);
    const markerCount1 = snapshotTexts(snapshot1).join("\n").split(marker).length - 1;
    const markerCount2 = snapshotTexts(snapshot2).join("\n").split(marker).length - 1;
    if (markerCount2 !== 1) failures.push(`post-restart snapshot carries the final answer ${markerCount2} times, expected exactly once`);
    if (markerCount1 !== 1) failures.push(`pre-restart snapshot carries the final answer ${markerCount1} times`);

    await facade2.dispose();
    sse.close();

    await writeEvidence(scratch, "completion.json", {
      upstreamCompleted: done.completed,
      idleOnWire,
      rawSessionIdlePayload: rawIdle?.data ?? null,
      rawStatusEndpointAfterCompletion: statusRaw.body,
      liveTurnStarted: turnStarted,
      liveTurnStopped: turnStopped.map((entry) => entry.ev),
      liveFinalizedTexts: finalized,
      snapshot1State: snapshot1.state,
      snapshot1Completeness: snapshot1.completeness,
      markerCountSnapshot1: markerCount1,
      snapshot2State: snapshot2.state,
      markerCountSnapshot2: markerCount2,
      fakeContrast: "packages/backend-opencode/test/fakeOpenCode.ts finishTurn emits session.idle with properties.revision; real 1.18.18 emits only {sessionID}",
      failures,
    });
    await writeVerdict(scratch, {
      id: "OC-REAL-020",
      verdict: failures.length === 0 ? "pass" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `upstream completed + session.idle on wire; facade emitted turn/stopped ${turnStopped.length} times (expected 1: reason completed); reconcile state=${snapshot1.state.value} pre-restart and ${snapshot2.state.value} post-restart; final answer recovered ${markerCount2}x post-restart`,
      expected: "final answer and terminal fact survive once; completion not missed",
      attribution: failures.some((entry) => entry.startsWith("MISSED COMPLETION")) ? "POLYTH" : failures.length === 0 ? "NONE" : "AMBIGUITY",
      evidence: [
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-020/completion.json",
        "logs/opencode-real-world/phase-1-legacy/OC-REAL-020/sse.ndjson",
      ],
      notes: "Real legacy session.idle/session.error/session.status carry no revision/version/seq/updatedAt, so terminalStateEvidenceOf() never returns evidence and statusFor() never yields idle: turns can never terminalize against real OpenCode 1.18.18. Deterministic suites pass only because fakeOpenCode invents properties.revision. Queue dispatch and projection idle in the server layer depend on turn/stopped.",
    });
  } finally {
    await proxy.close();
    await serve.stop();
  }
};

await main();
