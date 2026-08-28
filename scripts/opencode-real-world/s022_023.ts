/** OC-REAL-022: interruption evidence — abort mid-turn (upstream aborted) and
 *  SIGKILL of the exact owned serve PID mid-turn; verify nothing invents a
 *  terminal state and unversioned evidence stays "unknown". Also pins the
 *  exact upstream tool-part payload for a bash tool killed mid-run (seen as
 *  status "completed" in OC-REAL-017).
 *  OC-REAL-023: raw /session/status + reconcile-normalized state across
 *  idle-fresh, busy, permission-pending, question-pending, failed, aborted. */
import { mkdir, writeFile, readFile } from "node:fs/promises";
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
  LIVE_MODEL_ALT,
  collectSse,
  httpJson,
  makeScratch,
  sleep,
  spawnServe,
  startFaultProxy,
  waitForAssistantCompletion,
  writeEvidence,
  writeJson,
  writeVerdict,
  WireLog,
  OPENCODE_VERSION,
} from "./lib.ts";

const main = async (): Promise<void> => {
  const scratch22 = await makeScratch("OC-REAL-022");
  const scratch23 = await makeScratch("OC-REAL-023");
  const failures22: string[] = [];
  const failures23: string[] = [];

  // Main serve: bash=ask so permission/question phases are reachable.
  const configHome = join(scratch22.root, "cfg");
  await mkdir(join(configHome, "opencode"), { recursive: true });
  await writeFile(join(configHome, "opencode", "opencode.json"), JSON.stringify({
    permission: { bash: "ask" },
  }));
  const wire = new WireLog(join(scratch22.logsDir, "wire.ndjson"));
  const serve = await spawnServe(scratch22, { extraEnv: { XDG_CONFIG_HOME: configHome } });
  const proxy = await startFaultProxy(serve.url, wire);
  // Dedicated serve for the SIGKILL case (killing it must not disturb others).
  const killServe = await spawnServe(scratch22, { logName: "opencode-kill.log" });
  const killWire = new WireLog(join(scratch22.logsDir, "wire-kill.ndjson"));
  const killProxy = await startFaultProxy(killServe.url, killWire);

  const statusSamples: Array<Record<string, unknown>> = [];
  try {
    const sse = collectSse(serve.url, `/event?directory=${encodeURIComponent(scratch22.project)}`, join(scratch22.logsDir, "sse.ndjson"));
    const lease = await createBorrowedExternalEndpointLease({ url: proxy.url, location: { directory: scratch22.project } });
    const lifecycle = await createOpenCodeRuntimeLifecycle({ lease, protocol: "legacy" });
    const facade = attachRuntimeLifecycle(createOpenCodeRuntimeFacade({ lifecycle }), lifecycle);
    const events: Array<{ t: number; sessionId: string; ev: RuntimeEvent }> = [];
    facade.onEvent((sessionId, ev) => events.push({ t: Date.now(), sessionId, ev }));

    let ordinal = 0;
    const sample = async (phase: string, canonical: string, backendId: string): Promise<Record<string, unknown>> => {
      const raw = await httpJson(serve.url, "GET", `/session/status?directory=${encodeURIComponent(scratch22.project)}`);
      ordinal += 1;
      const endpoint = await facade.endpoint!();
      const snapshot = await facade.reconcile!({
        canonicalSessionId: canonical,
        backendSessionId: backendId,
        authorityId: endpoint.authorityId,
        generation: endpoint.generation,
        continuity: "generation-only",
        location: { directory: scratch22.project },
        reconciliationOrdinal: ordinal,
      });
      const entry = {
        phase,
        backendId,
        rawStatus: raw.body,
        normalizedState: snapshot.state,
        openPermissions: snapshot.permissions.length,
        openQuestions: snapshot.questions.length,
      };
      statusSamples.push(entry);
      return entry;
    };

    // ---- 023 idle-fresh ----
    const freshId = await facade.ensureSession({ sessionId: "st-fresh", cwd: scratch22.project, title: "023 fresh" });
    await sleep(300);
    const fresh = await sample("idle-fresh", "st-fresh", freshId);
    if ((fresh.normalizedState as { value: string }).value !== "idle") {
      failures23.push(`fresh session state=${(fresh.normalizedState as { value: string }).value}, expected causal idle`);
    }

    // ---- 022 abort mid-turn + 023 busy/aborted ----
    const abortId = await facade.ensureSession({ sessionId: "int-abort", cwd: scratch22.project, title: "022 abort" });
    await sleep(200);
    await facade.startTurn({ sessionId: "int-abort", text: "Count from 1 to 800, one number per line. No tools.", model: LIVE_MODEL });
    const busySeen = await sse.waitFor((event) =>
      event.type === "session.status"
      && (event.data as { properties?: { sessionID?: string; status?: { type?: string } } }).properties?.sessionID === abortId
      && (event.data as { properties?: { status?: { type?: string } } }).properties?.status?.type === "busy", 60_000);
    const busy = await sample("busy", "int-abort", abortId);
    if ((busy.normalizedState as { value: string }).value !== "running") {
      failures23.push(`busy session state=${(busy.normalizedState as { value: string }).value}, expected running (positive evidence)`);
    }
    const abortsBefore = proxy.requestCount(new RegExp(`POST /session/${abortId}/abort`));
    await facade.abort("int-abort");
    await waitForAssistantCompletion(serve.url, abortId, scratch22.project, 30_000);
    await sleep(1_000);
    const abortPosts = proxy.requestCount(new RegExp(`POST /session/${abortId}/abort`)) - abortsBefore;
    const aborted = await sample("aborted", "int-abort", abortId);
    const abortMessages = await httpJson(serve.url, "GET", `/session/${abortId}/message?directory=${encodeURIComponent(scratch22.project)}`);
    const abortError = (Array.isArray(abortMessages.body) ? abortMessages.body : [])
      .map((message) => (message as { info?: { error?: { name?: string } } }).info?.error).filter(Boolean).at(-1);
    const rawIdleForAbort = sse.events.filter((event) =>
      (event.type === "session.idle" || event.type === "session.status")
      && (event.data as { properties?: { sessionID?: string } }).properties?.sessionID === abortId)
      .map((event) => event.data).slice(-3);
    if (abortPosts !== 1) failures22.push(`${abortPosts} abort POSTs, expected 1`);
    if ((aborted.normalizedState as { value: string }).value === "idle"
      || (aborted.normalizedState as { value: string }).value === "interrupted") {
      failures22.push(`aborted session terminalized to ${(aborted.normalizedState as { value: string }).value} without comparable evidence (unversioned terminal accepted)`);
    }
    const completedStops = events.filter((entry) => entry.sessionId === "int-abort"
      && entry.ev.type === "turn/stopped" && (entry.ev as { reason: string }).reason === "completed");
    if (completedStops.length > 0) failures22.push("abort produced a turn/stopped(completed) lie");
    if ((abortError as { name?: string })?.name !== "MessageAbortedError") {
      failures22.push(`durable abort evidence missing (got ${JSON.stringify(abortError)})`);
    }

    // ---- 022/017 followup: exact payload of a bash tool killed mid-run ----
    const bashId = await facade.ensureSession({ sessionId: "int-bash", cwd: scratch22.project, title: "022 bash kill" });
    await sleep(200);
    const markerPath = join(scratch22.project, "bash-side-effect.txt");
    await facade.startTurn({
      sessionId: "int-bash",
      text: `Run exactly this bash command using the bash tool: sleep 20 && echo DONE > ${markerPath}`,
      model: LIVE_MODEL,
    });
    const permForBash = await sse.waitFor((event) =>
      event.type === "permission.asked"
      && (event.data as { properties?: { sessionID?: string } }).properties?.sessionID === bashId, 90_000);
    let killedBashPart: unknown = null;
    let bashSideEffect: string | null = null;
    if (permForBash) {
      const permEvent = sse.events.findLast((event) => event.type === "permission.asked"
        && (event.data as { properties?: { sessionID?: string } }).properties?.sessionID === bashId)!;
      const permId = (permEvent.data as { properties?: { id?: string } }).properties?.id ?? "";
      await facade.replyPermission("int-bash", permId, "once");
      const runningSeen = await sse.waitFor((event) => {
        if (event.type !== "message.part.updated") return false;
        const properties = (event.data as { properties?: { part?: { type?: string; tool?: string; state?: { status?: string } }; sessionID?: string } }).properties;
        return properties?.part?.type === "tool" && properties.part.tool === "bash" && properties.part.state?.status === "running"
          && (properties.part as { sessionID?: string }).sessionID !== undefined ? true : properties?.part?.type === "tool" && properties.part.tool === "bash" && properties.part.state?.status === "running";
      }, 60_000);
      if (runningSeen) {
        await sleep(1_000);
        await facade.abort("int-bash");
        await waitForAssistantCompletion(serve.url, bashId, scratch22.project, 30_000);
        await sleep(1_000);
        const bashMessages = await httpJson(serve.url, "GET", `/session/${bashId}/message?directory=${encodeURIComponent(scratch22.project)}`);
        killedBashPart = (Array.isArray(bashMessages.body) ? bashMessages.body : [])
          .flatMap((message) => ((message as { parts?: Array<Record<string, unknown>> }).parts ?? []))
          .filter((part) => part.type === "tool");
        try {
          bashSideEffect = await readFile(markerPath, "utf8");
        } catch {
          bashSideEffect = null;
        }
        const parts = killedBashPart as Array<{ state?: { status?: string } }>;
        if (parts.some((part) => part.state?.status === "completed") && bashSideEffect === null) {
          failures22.push("OPENCODE: bash tool killed mid-run reports terminal status=completed although its side effect never happened (hidden interrupted tool)");
        }
      } else {
        failures22.push("bash tool never reached running after approval");
      }
    } else {
      failures22.push("no permission for bash kill case");
    }

    // ---- 023 permission-pending ----
    const permSess = await facade.ensureSession({ sessionId: "st-perm", cwd: scratch22.project, title: "023 permission" });
    await sleep(200);
    await facade.startTurn({ sessionId: "st-perm", text: "Run exactly this bash command using the bash tool: printf STATUS-PERM", model: LIVE_MODEL_ALT });
    const permAsked = await sse.waitFor((event) =>
      event.type === "permission.asked"
      && (event.data as { properties?: { sessionID?: string } }).properties?.sessionID === permSess, 90_000);
    if (permAsked) {
      await sleep(500);
      const perm = await sample("permission-pending", "st-perm", permSess);
      if ((perm.openPermissions as number) < 1) failures23.push("permission-pending sample missed the open permission");
      const permEvent = sse.events.findLast((event) => event.type === "permission.asked"
        && (event.data as { properties?: { sessionID?: string } }).properties?.sessionID === permSess)!;
      await facade.replyPermission("st-perm", (permEvent.data as { properties?: { id?: string } }).properties?.id ?? "", "reject");
      await waitForAssistantCompletion(serve.url, permSess, scratch22.project, 45_000);
    } else failures23.push("no permission raised for the permission-pending sample");

    // ---- 023 question-pending ----
    const questionSess = await facade.ensureSession({ sessionId: "st-question", cwd: scratch22.project, title: "023 question" });
    await sleep(200);
    await facade.startTurn({ sessionId: "st-question", text: "Use the question tool to ask me whether to continue. Options exactly: yes, no. Wait for my answer.", model: LIVE_MODEL_ALT });
    const questionAsked = await sse.waitFor((event) =>
      event.type === "question.asked"
      && (event.data as { properties?: { sessionID?: string } }).properties?.sessionID === questionSess, 90_000);
    if (questionAsked) {
      await sleep(500);
      const question = await sample("question-pending", "st-question", questionSess);
      if ((question.openQuestions as number) < 1) failures23.push("question-pending sample missed the open question");
      const questionEvent = sse.events.findLast((event) => event.type === "question.asked"
        && (event.data as { properties?: { sessionID?: string } }).properties?.sessionID === questionSess)!;
      await facade.replyQuestion("st-question", (questionEvent.data as { properties?: { id?: string } }).properties?.id ?? "", { action: "reject" } as never);
      await waitForAssistantCompletion(serve.url, questionSess, scratch22.project, 45_000);
    } else failures23.push("no question raised for the question-pending sample");

    // ---- 023 failed (bad model -> session.error) ----
    const failedSess = await facade.ensureSession({ sessionId: "st-failed", cwd: scratch22.project, title: "023 failed" });
    await sleep(200);
    await facade.startTurn({ sessionId: "st-failed", text: "Say hi.", model: { providerID: "google", modelID: "no-such-model-023" } }).catch(() => undefined);
    await sse.waitFor((event) => event.type === "session.error"
      && (event.data as { properties?: { sessionID?: string } }).properties?.sessionID === failedSess, 30_000);
    await sleep(500);
    const failed = await sample("failed", "st-failed", failedSess);
    if ((failed.normalizedState as { value: string }).value === "failed") {
      // A positive failed claim would need comparable evidence; record it.
      failures23.push("failed state was terminalized without comparable revision — check evidence");
    }

    // ---- 022 SIGKILL the dedicated serve mid-turn ----
    const killLease = await createBorrowedExternalEndpointLease({ url: killProxy.url, location: { directory: scratch22.project } });
    const killLifecycle = await createOpenCodeRuntimeLifecycle({ lease: killLease, protocol: "legacy" });
    const killFacade = attachRuntimeLifecycle(createOpenCodeRuntimeFacade({ lifecycle: killLifecycle }), killLifecycle);
    const killLifecycleEvents: Array<{ t: number; note: RuntimeLifecycleNotification }> = [];
    killFacade.onLifecycle!((note) => killLifecycleEvents.push({ t: Date.now(), note }));
    const killSess = await killFacade.ensureSession({ sessionId: "int-kill", cwd: scratch22.project, title: "022 kill" });
    await sleep(200);
    await killFacade.startTurn({ sessionId: "int-kill", text: "Count from 1 to 800, one number per line. No tools.", model: LIVE_MODEL_ALT });
    const killBusy = await (async () => {
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        const status = await httpJson(killServe.url, "GET", `/session/status?directory=${encodeURIComponent(scratch22.project)}`).catch(() => ({ body: {} as unknown }));
        const map = status.body as Record<string, { type?: string }>;
        if (map && map[killSess]?.type === "busy") return true;
        await sleep(400);
      }
      return false;
    })();
    const killPid = killServe.pid;
    process.kill(killPid, "SIGKILL");
    const killAt = Date.now();
    await sleep(2_500);
    let killReconcile: Record<string, unknown>;
    try {
      const endpoint = await killFacade.endpoint!();
      const snapshot = await killFacade.reconcile!({
        canonicalSessionId: "int-kill",
        backendSessionId: killSess,
        authorityId: endpoint.authorityId,
        generation: endpoint.generation,
        continuity: "generation-only",
        location: { directory: scratch22.project },
        reconciliationOrdinal: 1,
      });
      killReconcile = { kind: "snapshot", state: snapshot.state, completeness: snapshot.completeness, events: snapshot.events.length };
      if (snapshot.state.value === "idle" || snapshot.state.value === "interrupted" || snapshot.state.value === "failed") {
        failures22.push(`dead-backend reconcile invented terminal state ${snapshot.state.value}`);
      }
    } catch (error) {
      killReconcile = { kind: "error", code: (error as { code?: string }).code, message: String(error).slice(0, 200) };
    }
    const disconnects = killLifecycleEvents.filter((entry) => entry.note.type === "stream-disconnected" && entry.t >= killAt).length;
    await killFacade.dispose();

    await writeEvidence(scratch22, "interruption.json", {
      abortCase: {
        busySeenOnWire: busySeen,
        abortPosts,
        stateAfterAbort: aborted.normalizedState,
        durableError: abortError,
        lastRawStatusEvents: rawIdleForAbort,
      },
      killedBashCase: { toolParts: killedBashPart, sideEffectFile: bashSideEffect },
      sigkillCase: {
        killedPid: killPid,
        busyBeforeKill: killBusy,
        reconcileAfterKill: killReconcile,
        streamDisconnectsAfterKill: disconnects,
      },
      comparableRevisionBranch: "not exercisable live: no 1.18.18 legacy payload carries revision/version/seq/updatedAt, so the 'comparable interruption terminalizes' branch cannot run against the real server",
      failures: failures22,
    });
    await writeVerdict(scratch22, {
      id: "OC-REAL-022",
      verdict: failures22.length === 0 ? "partial" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `abort: 1 POST, durable MessageAbortedError, state stayed ${JSON.stringify((aborted.normalizedState as { value: string }).value)} (unversioned never terminalized); SIGKILL: reconcile -> ${JSON.stringify(killReconcile.kind)} without invented terminal; killed bash tool part: ${JSON.stringify(killedBashPart).slice(0, 120)}`,
      expected: "comparable interruption terminalizes; unversioned evidence blocks as unknown",
      attribution: failures22.some((entry) => entry.startsWith("OPENCODE")) ? "OPENCODE" : failures22.length === 0 ? "NONE" : "AMBIGUITY",
      evidence: [
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-022/interruption.json",
        "logs/opencode-real-world/phase-1-legacy/OC-REAL-022/wire.ndjson",
      ],
      notes: "partial: real 1.18.18 never emits ANY comparable revision, so only the unversioned branch is exercisable — interruption can never terminalize (same evidence family as OC-REAL-020). Queue-release ordering is server-layer scope.",
    });

    await writeJson(join(scratch23.artifactsDir, "status-matrix.json"), { samples: statusSamples, failures: failures23 });
    await writeVerdict(scratch23, {
      id: "OC-REAL-023",
      verdict: failures23.length === 0 ? "partial" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: statusSamples.map((entry) => `${entry.phase}: raw=${JSON.stringify(entry.rawStatus).slice(0, 60)} -> ${(entry.normalizedState as { value: string }).value}`).join("; "),
      expected: "busy positive; terminal values require comparable ordered evidence",
      attribution: failures23.length === 0 ? "OPENCODE" : "AMBIGUITY",
      evidence: ["artifacts/opencode-real-world/phase-1-legacy/OC-REAL-023/status-matrix.json"],
      notes: "Real /session/status only lists busy sessions ({} when idle/failed/aborted) and carries no revision anywhere: idle/failed/interrupted can NEVER be normalized from live status. Fresh sessions get causal idle from the create receipt only. Product effect: after the first turn a real legacy session can never be proven idle again (see OC-REAL-020 failure report).",
    });

    sse.close();
    await facade.dispose();
  } finally {
    await proxy.close();
    await killProxy.close();
    await serve.stop();
    await killServe.stop();
  }
};

await main();
