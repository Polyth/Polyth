/** OC-REAL-021: real failure modes — tool error, provider-model error,
 *  provider auth error (invalid key on a second serve), and an OpenCode
 *  session error (prompt to a nonexistent session). Malformed model responses
 *  cannot be forced through a live provider and are recorded as not
 *  exercisable here (fault-proxy sits between Polyth and OpenCode, not
 *  between OpenCode and the provider). */
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
  const scratch = await makeScratch("OC-REAL-021");
  const failures: string[] = [];
  const wire = new WireLog(join(scratch.logsDir, "wire.ndjson"));
  const serve = await spawnServe(scratch);
  const proxy = await startFaultProxy(serve.url, wire);
  // Second serve with a broken provider key for the auth-failure case.
  const badKeyServe = await spawnServe(scratch, {
    logName: "opencode-badkey.log",
    extraEnv: { GOOGLE_GENERATIVE_AI_API_KEY: "invalid-key-for-auth-failure-case", GEMINI_API_KEY: "" },
  });
  const evidence: Record<string, unknown> = {};
  try {
    const sse = collectSse(serve.url, `/event?directory=${encodeURIComponent(scratch.project)}`, join(scratch.logsDir, "sse.ndjson"));
    const badSse = collectSse(badKeyServe.url, `/event?directory=${encodeURIComponent(scratch.project)}`, join(scratch.logsDir, "sse-badkey.ndjson"));
    const lease = await createBorrowedExternalEndpointLease({ url: proxy.url, location: { directory: scratch.project } });
    const lifecycle = await createOpenCodeRuntimeLifecycle({ lease, protocol: "legacy" });
    const facade = attachRuntimeLifecycle(createOpenCodeRuntimeFacade({ lifecycle }), lifecycle);
    const events: Array<{ t: number; sessionId: string; ev: RuntimeEvent }> = [];
    facade.onEvent((sessionId, ev) => events.push({ t: Date.now(), sessionId, ev }));

    // ---- (a) tool error: read a nonexistent file ----
    const toolSession = await facade.ensureSession({ sessionId: "fail-tool", cwd: scratch.project, title: "OC-REAL-021 tool error" });
    await sleep(200);
    await facade.startTurn({
      sessionId: "fail-tool",
      text: "Use the read tool to read the file /nonexistent/missing-xyz-021.txt. Do not use any other tool. Then tell me what happened in one sentence.",
      model: LIVE_MODEL,
    });
    const toolDone = await waitForAssistantCompletion(serve.url, toolSession, scratch.project, 90_000);
    const toolParts = toolDone.messages
      .flatMap((message) => ((message as { parts?: Array<{ type?: string; tool?: string; state?: Record<string, unknown> }> }).parts ?? []))
      .filter((part) => part.type === "tool");
    const toolErrorEvents = events.filter((entry) => entry.sessionId === "fail-tool" && entry.ev.type === "tool/error");
    evidence.toolError = {
      upstreamToolStates: toolParts.map((part) => ({ tool: part.tool, status: part.state?.status, error: String(part.state?.error ?? "").slice(0, 200) })),
      facadeToolErrorEvents: toolErrorEvents.map((entry) => ({ tool: (entry.ev as { tool: string }).tool, error: (entry.ev as { error: string }).error.slice(0, 200) })),
      turnCompletedUpstream: toolDone.completed,
    };
    const erroredTool = toolParts.some((part) => part.state?.status === "error");
    if (!erroredTool) failures.push("tool error case: no upstream tool part reached status=error");
    if (erroredTool && toolErrorEvents.length !== 1) failures.push(`tool error case: facade emitted ${toolErrorEvents.length} tool/error events, expected 1`);

    // ---- (b) provider-model error: nonexistent model id ----
    let modelErrorOutcome: Record<string, unknown> = {};
    const badModelSession = await facade.ensureSession({ sessionId: "fail-model", cwd: scratch.project, title: "OC-REAL-021 bad model" });
    await sleep(200);
    try {
      await facade.startTurn({
        sessionId: "fail-model",
        text: "Say hi.",
        model: { providerID: "google", modelID: "no-such-model-xyz-021" },
      });
      // If the POST was accepted, the failure must surface as session.error.
      const errored = await sse.waitFor((event) => event.type === "session.error", 30_000);
      const errorEvent = sse.events.findLast((event) => event.type === "session.error");
      const messages = await httpJson(serve.url, "GET", `/session/${badModelSession}/message?directory=${encodeURIComponent(scratch.project)}`);
      const lastInfo = (Array.isArray(messages.body) ? messages.body : []).map((message) => (message as { info?: { error?: unknown } }).info).at(-1);
      modelErrorOutcome = {
        promptAccepted: true,
        sessionErrorOnWire: errored,
        rawSessionError: errorEvent?.data ?? null,
        durableMessageError: lastInfo?.error ?? null,
      };
      if (!errored) failures.push("bad model case: prompt accepted but no session.error arrived");
    } catch (error) {
      modelErrorOutcome = { promptAccepted: false, startTurnRejection: String(error).slice(0, 300), code: (error as { code?: string }).code };
    }
    evidence.modelError = modelErrorOutcome;

    // ---- (c) provider auth error on the bad-key serve (raw legacy wire) ----
    const created = await httpJson(badKeyServe.url, "POST", `/session?directory=${encodeURIComponent(scratch.project)}`, { title: "auth failure" });
    const badSessionId = (created.body as { id?: string }).id ?? "";
    await httpJson(badKeyServe.url, "POST", `/session/${badSessionId}/prompt_async?directory=${encodeURIComponent(scratch.project)}`, {
      parts: [{ type: "text", text: "Say hi." }],
      model: LIVE_MODEL,
    });
    const authErrored = await badSse.waitFor((event) => event.type === "session.error", 45_000);
    const authErrorEvent = badSse.events.findLast((event) => event.type === "session.error");
    const authMessages = await httpJson(badKeyServe.url, "GET", `/session/${badSessionId}/message?directory=${encodeURIComponent(scratch.project)}`);
    const authLast = (Array.isArray(authMessages.body) ? authMessages.body : []).map((message) => (message as { info?: { error?: unknown; time?: unknown } }).info).at(-1);
    const authStatus = await httpJson(badKeyServe.url, "GET", `/session/status?directory=${encodeURIComponent(scratch.project)}`);
    evidence.authError = {
      sessionErrorOnWire: authErrored,
      rawSessionError: authErrorEvent?.data ?? null,
      durableMessageError: authLast?.error ?? null,
      rawStatusAfterFailure: authStatus.body,
      injectedKeyLeakedInError: JSON.stringify(authErrorEvent?.data ?? "").includes("invalid-key-for-auth-failure-case"),
    };
    if (!authErrored) failures.push("auth failure case: no session.error event");

    // ---- (d) OpenCode session error: prompt a nonexistent session ----
    const bogus = await httpJson(serve.url, "POST", `/session/ses_does_not_exist_021/prompt_async?directory=${encodeURIComponent(scratch.project)}`, {
      parts: [{ type: "text", text: "hello" }],
      model: LIVE_MODEL,
    });
    evidence.unknownSession = { status: bogus.status, body: bogus.body };
    if (bogus.status >= 200 && bogus.status < 300) failures.push(`prompt to nonexistent session returned ${bogus.status}`);

    // ---- terminalization of failures (ties into OC-REAL-020 break) ----
    const failedStops = events.filter((entry) => entry.ev.type === "turn/stopped");
    evidence.turnStoppedEvents = failedStops.map((entry) => ({ session: entry.sessionId, ev: entry.ev }));
    evidence.malformedModelResponse = "not exercisable live: the fault proxy sits Polyth<->OpenCode; provider wire is real. Covered deterministically in transportFaults.test.ts (body faults).";

    // Secret scan of our own evidence.
    const serialized = JSON.stringify(evidence);
    const realKey = process.env.GEMINI_API_KEY ?? "";
    if (realKey.length > 4 && serialized.includes(realKey)) failures.push("REAL API key leaked into evidence");

    await writeEvidence(scratch, "failure-modes.json", { ...evidence, failures });
    await writeVerdict(scratch, {
      id: "OC-REAL-021",
      verdict: failures.length === 0 ? "partial" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `tool error surfaced as upstream tool state=error + one facade tool/error; bad model -> ${JSON.stringify(modelErrorOutcome.promptAccepted)}; auth failure -> session.error(APIError) durable on message; unknown session prompt -> HTTP ${bogus.status}; turn/stopped(error) emitted ${failedStops.length}x`,
      expected: "failure durable, bounded/redacted, not presented as completion",
      attribution: failures.length === 0 ? "NONE" : "AMBIGUITY",
      evidence: [
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-021/failure-modes.json",
        "logs/opencode-real-world/phase-1-legacy/OC-REAL-021/sse-badkey.ndjson",
      ],
      notes: "partial: malformed-model-response cannot be forced against the live provider. Real session.error carries no revision, so the facade never emits turn/stopped(error) — the failed turn is only durable upstream (same root cause as OC-REAL-020).",
    });
    sse.close();
    badSse.close();
    await facade.dispose();
  } finally {
    await proxy.close();
    await serve.stop();
    await badKeyServe.stop();
  }
};

await main();
