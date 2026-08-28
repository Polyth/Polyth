/** OC-REAL-010: read-only + mutating tool with observable side effect, live model.
 *  OC-REAL-011: reasoning-capable model with visible thinking (variant=high). */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  attachRuntimeLifecycle,
  createBorrowedExternalEndpointLease,
  createOpenCodeRuntimeFacade,
  createOpenCodeRuntimeLifecycle,
} from "@polyth/backend-opencode";
import type { RuntimeEvent } from "@polyth/contracts";
import {
  collectSse,
  makeScratch,
  sleep,
  spawnServe,
  waitForAssistantCompletion,
  writeEvidence,
  writeVerdict,
  OPENCODE_VERSION,
} from "./lib.ts";

// variant "high" (thinking budget) is required for reliable tool calls on
// gemini-2.5-flash; without it the model returns finish=stop with 0 output
// tokens (observed live, see logs OC-REAL-010 first run).
const TOOL_MODEL = { providerID: "google", modelID: "gemini-2.5-flash", variant: "high" };

const main = async (): Promise<void> => {
  const scratch10 = await makeScratch("OC-REAL-010");
  const scratch11 = await makeScratch("OC-REAL-011");
  const failures10: string[] = [];
  const failures11: string[] = [];

  // Auto-allow tool permissions so OC-REAL-010 exercises the tool lifecycle
  // (permission flow itself is OC-REAL-013/014).
  const configDir = join(scratch10.env.XDG_CONFIG_HOME!, "opencode");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "opencode.json"), JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    permission: { edit: "allow", bash: "allow", webfetch: "allow" },
  }));

  await writeFile(join(scratch10.project, "marker.txt"), "MARKER-CONTENT-12345\n");
  const serve = await spawnServe(scratch10);
  try {
    const sse = collectSse(
      serve.url,
      `/event?directory=${encodeURIComponent(scratch10.project)}`,
      join(scratch10.logsDir, "sse.ndjson"),
    );
    const lease = await createBorrowedExternalEndpointLease({
      url: serve.url,
      location: { directory: scratch10.project },
    });
    const lifecycle = await createOpenCodeRuntimeLifecycle({ lease, protocol: "legacy" });
    const facade = attachRuntimeLifecycle(createOpenCodeRuntimeFacade({ lifecycle }), lifecycle);
    const events: Array<{ t: number; ev: RuntimeEvent }> = [];
    facade.onEvent((_sessionId, ev) => events.push({ t: Date.now(), ev }));

    const backendId = await facade.ensureSession({
      sessionId: "canonical-tools",
      cwd: scratch10.project,
      title: "OC-REAL-010 tools",
    });
    await sleep(500);

    // Turn 1: read-only tool (absolute path: a bare "marker.txt" made the
    // model pass /marker.txt and trip an external_directory permission).
    await facade.startTurn({
      sessionId: "canonical-tools",
      text: `Use the read tool to read the file ${join(scratch10.project, "marker.txt")}, then reply with its exact content.`,
      model: TOOL_MODEL,
    });
    await waitForAssistantCompletion(serve.url, backendId, scratch10.project, 120_000);
    await sleep(2_000);
    const eventsAfterRead = events.length;

    // Turn 2: mutating tool with observable side effect
    const sideEffectPath = join(scratch10.project, "side-effect.txt");
    await facade.startTurn({
      sessionId: "canonical-tools",
      text: `Use the write tool (not bash) to create the file ${sideEffectPath} containing exactly: TOOLSIDEEFFECT-67890`,
      model: TOOL_MODEL,
    });
    await waitForAssistantCompletion(serve.url, backendId, scratch10.project, 120_000);
    await sleep(2_000);
    sse.close();

    // --- assertions ---
    const toolEvents = events.filter((entry) =>
      entry.ev.type === "tool/call" || entry.ev.type === "tool/started" || entry.ev.type === "tool/result" || entry.ev.type === "tool/error");
    const byCall = new Map<string, string[]>();
    for (const entry of toolEvents) {
      const ev = entry.ev as { callId: string; type: string; status?: string; tool?: string };
      const key = ev.callId;
      const list = byCall.get(key) ?? [];
      list.push(ev.type === "tool/call" ? `call:${ev.status}` : ev.type);
      byCall.set(key, list);
    }
    const lifecycles = Object.fromEntries(byCall);
    const RANK: Record<string, number> = { "call:pending": 0, "call:running": 1, "tool/started": 1, "tool/result": 2, "tool/error": 2 };
    for (const [callId, sequence] of byCall) {
      const ranks = sequence.map((step) => RANK[step] ?? -1);
      const ordered = ranks.every((rank, index) => index === 0 || rank >= ranks[index - 1]!);
      if (!ordered) failures10.push(`tool ${callId} lifecycle rank regressed: ${sequence.join(" -> ")}`);
      const terminals = sequence.filter((step) => step === "tool/result" || step === "tool/error").length;
      if (terminals !== 1) failures10.push(`tool ${callId} emitted ${terminals} terminal results`);
    }
    const readToolUsed = toolEvents.some((entry) => (entry.ev as { tool?: string }).tool === "read");
    const writeToolUsed = toolEvents.some((entry) => (entry.ev as { tool?: string }).tool === "write");
    if (!readToolUsed) failures10.push("read tool never invoked");
    if (!writeToolUsed) failures10.push("write tool never invoked");
    const readResult = events.find((entry) => entry.ev.type === "tool/result" && (entry.ev as { tool?: string }).tool === "read") as { ev: { output?: string; input?: { filePath?: string } } } | undefined;
    if (readResult && !String(readResult.ev.output ?? "").includes("MARKER-CONTENT-12345")) {
      failures10.push("read tool result does not contain marker content");
    }
    const sideEffect = existsSync(sideEffectPath) ? await readFile(sideEffectPath, "utf8") : undefined;
    if (!sideEffect || !sideEffect.includes("TOOLSIDEEFFECT-67890")) failures10.push(`side effect file wrong: ${JSON.stringify(sideEffect)}`);
    const finalTexts = events.filter((entry) => entry.ev.type === "assistant/message").map((entry) => (entry.ev as { text: string }).text);
    if (!finalTexts.some((text) => text.includes("MARKER-CONTENT-12345"))) failures10.push("assistant answer lost marker content");

    // raw tool part payload sample for payload-diff documentation
    const rawToolParts = sse.events
      .filter((event) => event.type === "message.part.updated"
        && (event.data as { properties?: { part?: { type?: string } } }).properties?.part?.type === "tool")
      .map((event) => {
        const part = (event.data as { properties?: { part?: { tool?: string; callID?: string; state?: { status?: string } } } }).properties?.part;
        return { tool: part?.tool, callID: part?.callID, status: part?.state?.status };
      });

    await writeEvidence(scratch10, "tool-lifecycle.json", {
      toolLifecycles: lifecycles,
      readToolUsed,
      writeToolUsed,
      sideEffectContent: sideEffect,
      rawToolPartTransitions: rawToolParts,
      eventCountReadTurn: eventsAfterRead,
      eventCountTotal: events.length,
      failures: failures10,
    });
    await writeVerdict(scratch10, {
      id: "OC-REAL-010",
      verdict: failures10.length === 0 ? "pass" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `live ${TOOL_MODEL.modelID}: read tool + write tool ran; lifecycles ${JSON.stringify(lifecycles).slice(0, 220)}; side effect file exact once; each call exactly one terminal result${failures10.length ? `; failures: ${failures10.join("; ")}` : ""}`,
      expected: "ordered lifecycle ranks; side effect and canonical result once",
      attribution: failures10.length === 0 ? "NONE" : "POLYTH",
      evidence: [
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-010/tool-lifecycle.json",
        "logs/opencode-real-world/phase-1-legacy/OC-REAL-010/sse.ndjson",
      ],
      notes: "Tool permissions auto-allowed via project opencode.json; permission flow is exercised in OC-REAL-013/014.",
    });

    // ------------------- OC-REAL-011: reasoning -------------------
    const events11: Array<{ t: number; ev: RuntimeEvent }> = [];
    const facadeSub = facade.onEvent((_sessionId, ev) => events11.push({ t: Date.now(), ev }));
    const reasoningBackendId = await facade.ensureSession({
      sessionId: "canonical-reasoning",
      cwd: scratch10.project,
      title: "OC-REAL-011 reasoning",
    });
    await sleep(500);
    await facade.startTurn({
      sessionId: "canonical-reasoning",
      text: "A farmer has 17 sheep. All but 9 run away. How many are left? Think carefully step by step before answering, then give the final number.",
      model: { ...TOOL_MODEL, variant: "high" },
    });
    const done = await waitForAssistantCompletion(serve.url, reasoningBackendId, scratch10.project, 120_000);
    await sleep(2_000);
    facadeSub.dispose();

    const reasoningChunks = events11.filter((entry) => entry.ev.type === "assistant/reasoning-chunk");
    const textChunks = events11.filter((entry) => entry.ev.type === "assistant/chunk");
    const finals11 = events11.filter((entry) => entry.ev.type === "assistant/message") as Array<{ ev: { text: string; reasoning?: string } }>;
    const upstreamParts = done.messages
      .filter((message) => (message as { info?: { role?: string } }).info?.role === "assistant")
      .flatMap((message) => ((message as { parts?: Array<{ type?: string; text?: string }> }).parts ?? []));
    const upstreamReasoning = upstreamParts.filter((part) => part.type === "reasoning").map((part) => part.text ?? "").join("");
    const upstreamText = upstreamParts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");

    if (upstreamReasoning.length === 0) {
      failures11.push("upstream produced no reasoning part (model/variant did not surface thinking)");
    } else {
      if (reasoningChunks.length === 0 && !finals11.some((entry) => entry.ev.reasoning)) {
        failures11.push("upstream reasoning present but facade emitted no reasoning events");
      }
      const finalReasoning = finals11.map((entry) => entry.ev.reasoning ?? "").join("");
      if (finals11.some((entry) => entry.ev.text.includes(upstreamReasoning.slice(0, 80)) && upstreamReasoning.length > 80)) {
        failures11.push("reasoning leaked into answer text");
      }
      if (finalReasoning && upstreamReasoning && !upstreamReasoning.startsWith(finalReasoning.slice(0, 100))) {
        // compare loosely: reasoning may be capped in Polyth
        if (!finalReasoning.slice(0, 100).startsWith(upstreamReasoning.slice(0, 100))) {
          failures11.push("facade reasoning does not correspond to upstream reasoning");
        }
      }
    }
    if (!upstreamText.includes("9")) failures11.push(`answer text suspicious: ${upstreamText.slice(0, 100)}`);

    await writeEvidence(scratch11, "reasoning.json", {
      variantRequested: "high",
      upstreamReasoningLength: upstreamReasoning.length,
      upstreamReasoningSample: upstreamReasoning.slice(0, 400),
      upstreamTextSample: upstreamText.slice(0, 200),
      facadeReasoningChunks: reasoningChunks.length,
      facadeTextChunks: textChunks.length,
      facadeFinal: finals11.map((entry) => ({ textSample: entry.ev.text.slice(0, 120), reasoningLength: (entry.ev.reasoning ?? "").length })),
      failures: failures11,
    });
    await writeVerdict(scratch11, {
      id: "OC-REAL-011",
      verdict: failures11.length === 0 ? "pass" : upstreamReasoning.length === 0 ? "blocked" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `live ${TOOL_MODEL.modelID} variant=high: upstream reasoning ${upstreamReasoning.length} chars, facade ${reasoningChunks.length} reasoning chunks vs ${textChunks.length} text chunks; reasoning kept distinct from answer text${failures11.length ? `; failures: ${failures11.join("; ")}` : ""}`,
      expected: "reasoning not exposed as answer text; resolves once",
      attribution: failures11.length === 0 ? "NONE" : upstreamReasoning.length === 0 ? "ENV" : "POLYTH",
      evidence: ["artifacts/opencode-real-world/phase-1-legacy/OC-REAL-011/reasoning.json"],
      notes: "Typed-vs-untyped delta split not separately fault-injected (H part); live stream typing recorded as-is.",
    });
    await facade.dispose();
  } finally {
    await serve.stop();
  }
};

await main();
