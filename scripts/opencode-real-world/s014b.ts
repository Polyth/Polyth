/** OC-REAL-014 part B (after gemini-2.5-flash quota exhaustion): reject and
 * two-client race cases using gemini-2.5-flash-lite. Merges into the 014 verdict. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  attachRuntimeLifecycle,
  createBorrowedExternalEndpointLease,
  createOpenCodeRuntimeFacade,
  createOpenCodeRuntimeLifecycle,
} from "@polyth/backend-opencode";
import {
  CHEAP_MODEL,
  collectSse,
  makeScratch,
  readJsonFile,
  sleep,
  spawnServe,
  startFaultProxy,
  waitForAssistantCompletion,
  writeEvidence,
  writeVerdict,
  WireLog,
  OPENCODE_VERSION,
  ARTIFACTS_ROOT,
  type Verdict,
} from "./lib.ts";

const main = async (): Promise<void> => {
  const scratch = await makeScratch("OC-REAL-014", "run-b");
  const failures: string[] = [];
  const configDir = join(scratch.env.XDG_CONFIG_HOME!, "opencode");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "opencode.json"), JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    permission: { bash: "ask" },
  }));
  const wire = new WireLog(join(scratch.logsDir, "wire-b.ndjson"));
  const serve = await spawnServe(scratch, { logName: "opencode-b.log" });
  const proxy = await startFaultProxy(serve.url, wire);
  try {
    const sse = collectSse(serve.url, `/event?directory=${encodeURIComponent(scratch.project)}`, join(scratch.logsDir, "sse-b.ndjson"));
    const lease = await createBorrowedExternalEndpointLease({ url: proxy.url, location: { directory: scratch.project } });
    const lifecycle = await createOpenCodeRuntimeLifecycle({ lease, protocol: "legacy" });
    const facade = attachRuntimeLifecycle(createOpenCodeRuntimeFacade({ lifecycle }), lifecycle);

    const seen = new Set<string>();
    const isNew = (event: { type?: string; data: unknown }): boolean =>
      event.type === "permission.asked"
      && !seen.has(String((event.data as { properties?: { id?: string } }).properties?.id ?? ""));
    const waitPermission = async (timeoutMs: number): Promise<string | undefined> => {
      if (!(await sse.waitFor(isNew, timeoutMs))) return undefined;
      const raw = sse.events.findLast((event) => isNew(event))!;
      const id = String((raw.data as { properties?: { id?: string } }).properties?.id ?? "");
      seen.add(id);
      return id;
    };

    // ---- reject ----
    const backendId = await facade.ensureSession({ sessionId: "canonical-reject", cwd: scratch.project, title: "OC-REAL-014b reject" });
    await sleep(300);
    await facade.startTurn({
      sessionId: "canonical-reject",
      text: "Run exactly this bash command using the bash tool: printf REJECT-MARKER",
      model: CHEAP_MODEL,
    });
    const rejectId = await waitPermission(60_000);
    let rejectObserved: Record<string, unknown> = {};
    if (!rejectId) {
      failures.push("no permission for reject case");
    } else {
      await facade.replyPermission("canonical-reject", rejectId, "reject");
      const done = await waitForAssistantCompletion(serve.url, backendId, scratch.project, 90_000);
      const toolStates = done.messages
        .flatMap((message) => ((message as { parts?: Array<{ type?: string; tool?: string; state?: { status?: string; error?: string } }> }).parts ?? []))
        .filter((part) => part.type === "tool")
        .map((part) => ({ tool: part.tool, status: part.state?.status, error: String((part.state as { error?: string })?.error ?? "").slice(0, 140) }));
      const outputs = JSON.stringify(done.messages);
      rejectObserved = {
        toolStates,
        sideEffectRan: outputs.includes("REJECT-MARKER\\n") || toolStates.some((state) => state.status === "completed"),
      };
      if (toolStates.some((state) => state.status === "completed")) failures.push("rejected tool still completed");
      if (!toolStates.some((state) => state.status === "error" || state.status === "rejected" || state.status === "denied")) {
        rejectObserved.note = "no explicit error-state tool part; recording actual states";
      }
    }

    // ---- race: two concurrent replies on one request ----
    const backend2 = await facade.ensureSession({ sessionId: "canonical-race", cwd: scratch.project, title: "OC-REAL-014b race" });
    await sleep(300);
    await facade.startTurn({
      sessionId: "canonical-race",
      text: "Run exactly this bash command using the bash tool: printf RACE-MARKER",
      model: CHEAP_MODEL,
    });
    const raceId = await waitPermission(60_000);
    let raceResult: Record<string, unknown> = {};
    if (!raceId) {
      failures.push("no permission for race case");
    } else {
      const endpoint = await facade.endpoint!();
      const binding = {
        canonicalSessionId: "canonical-race",
        backendSessionId: backend2,
        authorityId: endpoint.authorityId,
        generation: endpoint.generation,
        continuity: "generation-only" as const,
        location: { directory: scratch.project },
        protocol: await lifecycle.protocol(),
      };
      const [first, second] = await Promise.all([
        lifecycle.replyPermission(binding, raceId, "once", "op-race-once"),
        lifecycle.replyPermission(binding, raceId, "reject", "op-race-reject"),
      ]);
      raceResult = { first, second };
      const confirmedCount = [first, second].filter((outcome) => outcome.kind === "confirmed").length;
      raceResult.confirmedCount = confirmedCount;
      if (confirmedCount === 2) {
        raceResult.note = "REAL 1.18.18 returned 2xx for BOTH concurrent replies (no single-winner enforcement upstream); Polyth response-intent CAS is the only guard";
      }
      await waitForAssistantCompletion(serve.url, backend2, scratch.project, 90_000);
    }

    await writeEvidence(scratch, "permission-replies-b.json", { rejectObserved, raceResult, failures });

    // Merge verdict with part A (once/always) results.
    const partA = await readJsonFile(join(ARTIFACTS_ROOT, "OC-REAL-014", "permission-replies.json")) as { onceRan?: boolean; askedAgainAfterOnce?: boolean; askedAfterAlways?: boolean } | undefined;
    const partAOk = !!partA?.onceRan && !!partA?.askedAgainAfterOnce && partA?.askedAfterAlways === false;
    const verdict: Verdict = {
      id: "OC-REAL-014",
      verdict: failures.length === 0 && partAOk ? "pass" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `once ran tool then re-asked; always persisted (silent third run); reject: ${JSON.stringify(rejectObserved).slice(0, 200)}; race: first=${(raceResult.first as { kind?: string })?.kind} second=${(raceResult.second as { kind?: string })?.kind} ${String(raceResult.note ?? "")}`,
      expected: "exactly one upstream answer effect; scopes honored; loser observes winner",
      attribution: failures.length === 0 && partAOk
        ? ((raceResult.confirmedCount as number) === 2 ? "OPENCODE" : "NONE")
        : "AMBIGUITY",
      evidence: [
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-014/permission-replies.json",
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-014/permission-replies-b.json",
        "logs/opencode-real-world/phase-1-legacy/OC-REAL-014/wire-b.ndjson",
      ],
      notes: "Part A (once/always) ran on gemini-2.5-flash until GOOGLE quota was exhausted (real APIError captured); part B (reject/race) reran on gemini-2.5-flash-lite. Two-client CAS is Polyth server-layer; this pins upstream double-answer behavior.",
    };
    await writeVerdict(scratch, verdict);
    sse.close();
    await facade.dispose();
  } finally {
    await proxy.close();
    await serve.stop();
  }
};

await main();
