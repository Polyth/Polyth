/** OC-REAL-008: one forced-legacy prompt; request body vs upstream user message.
 *  OC-REAL-009: live streamed deltas incl. multi-byte UTF-8; monotonic exact text. */
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
  CHEAP_MODEL,
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

const TARGET = "héllo wörld 🌍🔥 ünïcode ẽ→∞ 你好, ça va? Ω≈ç√∫";
const PROMPT = `Repeat exactly this line, nothing else, no quotes: ${TARGET}`;

const main = async (): Promise<void> => {
  const scratch8 = await makeScratch("OC-REAL-008");
  const scratch9 = await makeScratch("OC-REAL-009");
  const wire = new WireLog(join(scratch8.logsDir, "wire.ndjson"));
  const serve = await spawnServe(scratch8);
  const proxy = await startFaultProxy(serve.url, wire);
  const failures8: string[] = [];
  const failures9: string[] = [];
  try {
    // Raw SSE observer directly against the real server (evidence O).
    const sse = collectSse(
      serve.url,
      `/event?directory=${encodeURIComponent(scratch8.project)}`,
      join(scratch9.logsDir, "sse.ndjson"),
    );
    await sleep(500);

    const lease = await createBorrowedExternalEndpointLease({
      url: proxy.url,
      location: { directory: scratch8.project },
    });
    const lifecycle = await createOpenCodeRuntimeLifecycle({ lease, protocol: "legacy" });
    const facade = attachRuntimeLifecycle(
      createOpenCodeRuntimeFacade({ lifecycle }),
      lifecycle,
    );
    const events: Array<{ t: number; sessionId: string; ev: RuntimeEvent }> = [];
    let finalizeResolve: (() => void) | undefined;
    const finalized = new Promise<void>((r) => { finalizeResolve = r; });
    facade.onEvent((sessionId, ev) => {
      events.push({ t: Date.now(), sessionId, ev });
      if (ev.type === "assistant/message") finalizeResolve?.();
    });

    const backendId = await facade.ensureSession({
      sessionId: "canonical-stream",
      cwd: scratch8.project,
      title: "OC-REAL-008 stream",
    });
    await sleep(500);

    const promptPostsBefore = proxy.requestCount(/^POST \/session\/[^/]+\/(prompt_async|message)/);
    await facade.startTurn({
      sessionId: "canonical-stream",
      text: PROMPT,
      model: CHEAP_MODEL,
    });
    const promptPostsAfter = proxy.requestCount(/^POST \/session\/[^/]+\/(prompt_async|message)/);
    if (promptPostsAfter - promptPostsBefore !== 1) {
      failures8.push(`expected exactly one prompt POST, saw ${promptPostsAfter - promptPostsBefore}`);
    }

    const timedOut = await Promise.race([finalized.then(() => false), sleep(90_000).then(() => true)]);
    if (timedOut) failures9.push("assistant message did not finalize within 90s");
    const { messages } = await waitForAssistantCompletion(serve.url, backendId, scratch8.project, 10_000);
    // Give the idle SSE evidence time to arrive, then record whether the
    // facade terminalized the turn (it should not, on real 1.18.18: idle
    // events carry no comparable revision).
    await sleep(3_000);
    const turnStoppedEmitted = events.some((entry) => entry.ev.type === "turn/stopped");

    // --- OC-REAL-008 assertions ---
    const wireLines = (await readFile(wire.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      kind: string; method?: string; path?: string; status?: number; body?: unknown;
    });
    const promptRequest = wireLines.find((line) => line.kind === "request" && line.method === "POST" && /\/(prompt_async|message)\?/.test(line.path ?? ""));
    const promptResponse = wireLines.find((line) => line.kind === "response" && line.connection === (promptRequest as { connection?: number })?.connection);
    const promptBody = promptRequest?.body as { parts?: Array<{ type: string; text: string }>; model?: { providerID: string; modelID: string }; agent?: string } | undefined;
    const selectedPath = (promptRequest?.path ?? "").includes("prompt_async") ? "prompt_async" : "message";
    if (!promptBody) failures8.push("prompt request body not captured");
    if (promptBody?.parts?.[0]?.text !== PROMPT) failures8.push("prompt text drifted in request body");
    if (promptBody?.model?.providerID !== CHEAP_MODEL.providerID || promptBody?.model?.modelID !== CHEAP_MODEL.modelID) {
      failures8.push(`model drift in body: ${JSON.stringify(promptBody?.model)}`);
    }
    const userMessages = messages.filter((message) => (message as { info?: { role?: string } }).info?.role === "user");
    const userTexts = userMessages.flatMap((message) =>
      ((message as { parts?: Array<{ type?: string; text?: string }> }).parts ?? [])
        .filter((part) => part.type === "text").map((part) => part.text ?? ""));
    if (userTexts.filter((text) => text === PROMPT).length !== 1) {
      failures8.push(`upstream user message text mismatch or duplicated: ${JSON.stringify(userTexts).slice(0, 200)}`);
    }
    const assistantInfo = (messages.findLast((message) => (message as { info?: { role?: string } }).info?.role === "assistant") as { info?: { providerID?: string; modelID?: string; agent?: string; error?: unknown } })?.info;
    if (assistantInfo?.modelID !== CHEAP_MODEL.modelID) failures8.push(`assistant ran wrong model: ${assistantInfo?.modelID}`);

    await writeEvidence(scratch8, "prompt-wire.json", {
      selectedPath,
      promptStatus: promptResponse?.status,
      promptBody,
      upstreamUserTexts: userTexts,
      assistantModel: { providerID: assistantInfo?.providerID, modelID: assistantInfo?.modelID, agent: assistantInfo?.agent },
      failures: failures8,
    });
    await writeVerdict(scratch8, {
      id: "OC-REAL-008",
      verdict: failures8.length === 0 ? "pass" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `one POST to ${selectedPath} (status ${promptResponse?.status}); body carried exact text+model; upstream user message exact once; assistant ran ${assistantInfo?.providerID}/${assistantInfo?.modelID} agent=${assistantInfo?.agent}`,
      expected: "one prompt, selected model/agent intact, no body drift",
      attribution: failures8.length === 0 ? "NONE" : "POLYTH",
      evidence: [
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-008/prompt-wire.json",
        "logs/opencode-real-world/phase-1-legacy/OC-REAL-008/wire.ndjson",
      ],
      notes: "Durable-intent-before-POST is server-stack behavior (deterministic-tested); this run pins the real wire contract. LIVE model used.",
    });

    // --- OC-REAL-009 assertions ---
    const finalAssistantText = messages
      .filter((message) => (message as { info?: { role?: string } }).info?.role === "assistant")
      .flatMap((message) => ((message as { parts?: Array<{ type?: string; text?: string }> }).parts ?? [])
        .filter((part) => part.type === "text").map((part) => part.text ?? ""))
      .join("");
    const chunks = events.filter((entry) => entry.ev.type === "assistant/chunk") as Array<{ ev: { partId: string; text: string } }>;
    const finals = events.filter((entry) => entry.ev.type === "assistant/message") as Array<{ ev: { text: string } }>;
    const chunkConcat = chunks.map((entry) => entry.ev.text).join("");
    const rawDeltas = sse.events.filter((event) =>
      event.type === "message.part.delta"
      && (event.data as { properties?: { sessionID?: string; field?: string } }).properties?.sessionID === backendId
      && (event.data as { properties?: { field?: string } }).properties?.field === "text");
    const rawDeltaConcat = rawDeltas.map((event) => String((event.data as { properties?: { delta?: string } }).properties?.delta ?? "")).join("");
    const rawUpdates = sse.events.filter((event) =>
      event.type === "message.part.updated"
      && (event.data as { properties?: { sessionID?: string; part?: { type?: string } } }).properties?.sessionID === backendId
      && (event.data as { properties?: { part?: { type?: string } } }).properties?.part?.type === "text");
    // Group full-value updates per part id: the stream also carries the USER
    // prompt part as message.part.updated, so monotonicity holds per part.
    const fullValuesByPart = new Map<string, string[]>();
    for (const event of rawUpdates) {
      const part = (event.data as { properties?: { part?: { id?: string; text?: string } } }).properties?.part;
      const partId = part?.id ?? "unknown";
      const list = fullValuesByPart.get(partId) ?? [];
      list.push(String(part?.text ?? ""));
      fullValuesByPart.set(partId, list);
    }
    const monotonic = [...fullValuesByPart.values()].every((values) =>
      values.every((value, index) => index === 0 || value.startsWith(values[index - 1]!) || value === values[index - 1]));
    const fullValues = [...fullValuesByPart.values()].flat();

    if (!finalAssistantText.includes(TARGET)) failures9.push(`assistant did not reproduce UTF-8 target exactly: ${finalAssistantText.slice(0, 120)}`);
    if (finals.length !== 1) failures9.push(`expected exactly 1 assistant/message event, got ${finals.length}`);
    if (finals[0] && finals[0].ev.text !== finalAssistantText) failures9.push("facade final text differs from upstream text");
    if (chunks.length > 0 && chunkConcat !== finalAssistantText) failures9.push(`chunk concat (${chunkConcat.length} chars) != final (${finalAssistantText.length} chars)`);
    if (rawDeltas.length > 0 && rawDeltaConcat !== finalAssistantText) failures9.push("raw SSE delta concat != final upstream text");
    if (!monotonic) failures9.push("full-value part.updated snapshots were not monotonic prefixes");

    sse.close();
    await writeEvidence(scratch9, "stream-comparison.json", {
      target: TARGET,
      finalAssistantText,
      facadeChunkCount: chunks.length,
      facadeChunkConcatEqualsFinal: chunkConcat === finalAssistantText,
      facadeFinalCount: finals.length,
      rawDeltaCount: rawDeltas.length,
      rawDeltaConcatEqualsFinal: rawDeltaConcat === finalAssistantText,
      rawFullValueUpdates: fullValues.length,
      fullValueMonotonic: monotonic,
      turnStoppedEmitted,
      idleEvidenceOnWire: sse.events.some((event) =>
        event.type === "session.idle"
        || (event.type === "session.status"
          && (event.data as { properties?: { status?: { type?: string } } }).properties?.status?.type === "idle")),
      eventTypeCounts: events.reduce<Record<string, number>>((acc, entry) => {
        acc[entry.ev.type] = (acc[entry.ev.type] ?? 0) + 1;
        return acc;
      }, {}),
      failures: failures9,
    });
    await writeVerdict(scratch9, {
      id: "OC-REAL-009",
      verdict: failures9.length === 0 ? "pass" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `live stream: ${rawDeltas.length} raw text deltas, ${chunks.length} facade chunks; delta-concat == final == upstream; UTF-8 target (emoji/CJK/combining) exact; ${fullValues.length} full-value updates monotonic=${monotonic}; exactly ${finals.length} finalized assistant message; turn/stopped emitted=${turnStoppedEmitted} although idle evidence was on the wire (real idle carries no comparable revision -> see OC-REAL-020/023)`,
      expected: "text is monotonic and exact once; finalization after ingestion",
      attribution: failures9.length === 0 ? "NONE" : "POLYTH",
      evidence: [
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-009/stream-comparison.json",
        "logs/opencode-real-world/phase-1-legacy/OC-REAL-009/sse.ndjson",
      ],
      notes: "LIVE google/gemini-2.5-flash-lite. Packet-level UTF-8 split handled by decoder; UI-before-log is server-stack scope. Missing turn terminalization on real idle payloads is attributed under OC-REAL-020/023.",
    });
    await facade.dispose();
  } finally {
    await proxy.close();
    await serve.stop();
  }
};

await main();
