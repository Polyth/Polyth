/** OC-REAL-019: drop the SSE stream during an active turn while the backend
 *  survives; reconnect after ~0.5s (facade backoff floor), ~5s and ~30s
 *  (proxy refuses /event for the outage window). Asserts: no prompt replay on
 *  the wire, facade reconnects, and reconcile recovers the completed turn
 *  exactly once (or reports explicit uncertainty). */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  attachRuntimeLifecycle,
  createBorrowedExternalEndpointLease,
  createOpenCodeRuntimeFacade,
  createOpenCodeRuntimeLifecycle,
} from "@polyth/backend-opencode";
import type { RuntimeEvent, RuntimeLifecycleNotification } from "@polyth/contracts";
import {
  LIVE_MODEL,
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
  const scratch = await makeScratch("OC-REAL-019");
  const failures: string[] = [];
  const wire = new WireLog(join(scratch.logsDir, "wire.ndjson"));
  const serve = await spawnServe(scratch);
  const proxy = await startFaultProxy(serve.url, wire);
  const runs: Record<string, unknown>[] = [];
  try {
    const lease = await createBorrowedExternalEndpointLease({ url: proxy.url, location: { directory: scratch.project } });
    const lifecycle = await createOpenCodeRuntimeLifecycle({ lease, protocol: "legacy" });
    const facade = attachRuntimeLifecycle(createOpenCodeRuntimeFacade({ lifecycle }), lifecycle);
    const events: Array<{ t: number; sessionId: string; ev: RuntimeEvent }> = [];
    facade.onEvent((sessionId, ev) => events.push({ t: Date.now(), sessionId, ev }));
    const lifecycleEvents: Array<{ t: number; note: RuntimeLifecycleNotification }> = [];
    facade.onLifecycle!((note) => lifecycleEvents.push({ t: Date.now(), note }));

    let ordinal = 0;
    const runOutage = async (name: string, outageMs: number): Promise<void> => {
      const canonical = `sse-drop-${name}`;
      const backendId = await facade.ensureSession({ sessionId: canonical, cwd: scratch.project, title: `OC-REAL-019 ${name}` });
      await sleep(300);
      const marker = `SSE-${name.toUpperCase()}-MARKER`;
      const promptRegex = new RegExp(`POST /session/${backendId}/(prompt_async|message)`);
      await facade.startTurn({
        sessionId: canonical,
        text: `First reply with the word ${marker}, then write two more short sentences about rivers.`,
        model: LIVE_MODEL,
      });
      // Wait for the first streamed delta so the drop lands mid-phase.
      const sawDelta = await (async () => {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          if (events.some((entry) => entry.sessionId === canonical && entry.ev.type === "assistant/chunk")) return true;
          await sleep(50);
        }
        return false;
      })();
      const disconnectAt = Date.now();
      // Refuse new /event connections for the outage window, then drop the
      // live SSE socket. The backend itself keeps running the turn.
      proxy.setRule(/GET \/event/, { kind: "error", status: 503 });
      const killed = proxy.killActiveSockets();
      await sleep(outageMs);
      proxy.setRule(undefined);
      // Wait for the facade to reconnect (stream-connected after the outage).
      const reconnectDeadline = Date.now() + 40_000;
      let reconnectedAt: number | undefined;
      while (Date.now() < reconnectDeadline) {
        const found = lifecycleEvents.find((entry) =>
          entry.t > disconnectAt + outageMs && entry.note.type === "stream-connected");
        if (found) { reconnectedAt = found.t; break; }
        await sleep(100);
      }
      const done = await waitForAssistantCompletion(serve.url, backendId, scratch.project, 60_000);
      await sleep(500);
      ordinal += 1;
      const endpoint = await facade.endpoint!();
      const snapshot = await facade.reconcile!({
        canonicalSessionId: canonical,
        backendSessionId: backendId,
        authorityId: endpoint.authorityId,
        generation: endpoint.generation,
        continuity: "generation-only",
        location: { directory: scratch.project },
        reconciliationOrdinal: ordinal,
      });
      const upstreamAssistant = done.messages
        .filter((message) => (message as { info?: { role?: string } }).info?.role === "assistant")
        .map((message) => ((message as { parts?: Array<{ type?: string; text?: string }> }).parts ?? [])
          .filter((part) => part.type === "text").map((part) => part.text ?? "").join(""))
        .join("\n");
      const promptPosts = proxy.requestCount(promptRegex);
      const snapshotTexts = snapshot.events
        .filter((entry) => entry.event.type === "assistant/message")
        .map((entry) => (entry.event as { text: string }).text);
      const markerCountSnapshot = snapshotTexts.join("\n").split(marker).length - 1;
      const finalizedLive = events.filter((entry) => entry.sessionId === canonical && entry.ev.type === "assistant/message").length;
      runs.push({
        name,
        outageMs,
        sawDeltaBeforeDrop: sawDelta,
        socketsKilled: killed,
        reconnectMs: reconnectedAt ? reconnectedAt - (disconnectAt + outageMs) : null,
        promptPosts,
        upstreamCompleted: done.completed,
        upstreamHasMarker: upstreamAssistant.includes(marker),
        snapshotState: snapshot.state,
        snapshotCompleteness: snapshot.completeness,
        snapshotAssistantMessages: snapshotTexts.length,
        markerCountInSnapshot: markerCountSnapshot,
        liveFinalizedAssistantEvents: finalizedLive,
      });
      if (promptPosts !== 1) failures.push(`${name}: ${promptPosts} prompt POSTs on the wire, expected exactly 1 (no replay)`);
      if (!done.completed) failures.push(`${name}: upstream turn did not complete while SSE was down`);
      if (reconnectedAt === undefined) failures.push(`${name}: facade did not reconnect within 40s after outage end`);
      if (markerCountSnapshot > 1) failures.push(`${name}: reconcile snapshot duplicated the marker (${markerCountSnapshot}x)`);
      if (markerCountSnapshot === 0) failures.push(`${name}: reconcile snapshot did not recover the assistant text`);
    };

    await runOutage("short", 500);
    await runOutage("medium", 5_000);
    await runOutage("long", 30_000);

    const wireRaw = await readFile(wire.path, "utf8");
    const eventConnects = wireRaw.trim().split("\n").map((line) => JSON.parse(line) as { kind: string; path?: string; note?: string })
      .filter((line) => (line.path ?? "").startsWith("/event")).length;
    await writeEvidence(scratch, "sse-reconnect.json", { runs, eventStreamConnections: eventConnects, lifecycleEvents: lifecycleEvents.map((entry) => ({ t: entry.t, type: entry.note.type, reason: (entry.note as { reason?: string }).reason })), failures });
    await writeVerdict(scratch, {
      id: "OC-REAL-019",
      verdict: failures.length === 0 ? "pass" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: runs.map((run) => `${run.name}(${run.outageMs}ms): reconnect+${run.reconnectMs}ms, prompts=${run.promptPosts}, markerInSnapshot=${run.markerCountInSnapshot}`).join("; "),
      expected: "no prompt replay; facts recover once or remain explicit uncertainty",
      attribution: failures.length === 0 ? "NONE" : "AMBIGUITY",
      evidence: [
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-019/sse-reconnect.json",
        "logs/opencode-real-world/phase-1-legacy/OC-REAL-019/wire.ndjson",
      ],
      notes: "Durable cursor/checkpoint admission (no stale-cursor skip) is the session-store layer; this pins real reconnect behavior, single prompt POST, and pull recovery of the missed tail.",
    });
    await facade.dispose();
  } finally {
    await proxy.close();
    await serve.stop();
  }
};

await main();
