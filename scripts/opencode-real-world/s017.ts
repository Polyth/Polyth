/** OC-REAL-017: abort during text, reasoning, tool running, permission open
 *  and question open (tool-pending is the permission-gated pending state).
 *  Each case runs in its own backend session; two real serves are used so the
 *  permission config (bash=ask) does not contaminate the allow cases.
 *  Asserts: exactly one abort POST per case, turn/stopped reason "aborted"
 *  (never "completed"), no invented completion, unresolved artifacts explicit. */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  attachRuntimeLifecycle,
  createBorrowedExternalEndpointLease,
  createOpenCodeRuntimeFacade,
  createOpenCodeRuntimeLifecycle,
} from "@polyth/backend-opencode";
import type { RuntimeEvent } from "@polyth/contracts";
import {
  HF_MODEL,
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

const TOOL_MODEL = HF_MODEL;

interface CaseResult {
  name: string;
  phaseReached: boolean;
  abortPosts: number;
  turnStopped?: { reason: string; error?: string };
  completedLie: boolean;
  finalAssistant?: { completed?: boolean; error?: unknown };
  toolStates?: Array<{ tool?: string; status?: string; error?: string }>;
  pendingAfterAbort?: unknown;
  statusAfterAbort?: unknown;
  reconcileState?: unknown;
  notes?: string;
}

const main = async (): Promise<void> => {
  const scratch = await makeScratch("OC-REAL-017");
  const failures: string[] = [];
  const results: CaseResult[] = [];

  // Serve A: bash allowed (text / reasoning / tool-running / question cases).
  const wireA = new WireLog(join(scratch.logsDir, "wire-a.ndjson"));
  const serveA = await spawnServe(scratch, { logName: "opencode-a.log" });
  const proxyA = await startFaultProxy(serveA.url, wireA);

  // Serve B: bash=ask (permission-open + tool-pending case).
  const configDir = join(scratch.env.XDG_CONFIG_HOME!, "opencode");
  await mkdir(configDir, { recursive: true });
  const askConfigPath = join(scratch.root, "ask-config");
  await mkdir(join(askConfigPath, "opencode"), { recursive: true });
  await writeFile(join(askConfigPath, "opencode", "opencode.json"), JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    permission: { bash: "ask" },
  }));
  const wireB = new WireLog(join(scratch.logsDir, "wire-b.ndjson"));
  const serveB = await spawnServe(scratch, {
    logName: "opencode-b.log",
    extraEnv: { XDG_CONFIG_HOME: askConfigPath },
  });
  const proxyB = await startFaultProxy(serveB.url, wireB);

  try {
    const sseA = collectSse(serveA.url, `/event?directory=${encodeURIComponent(scratch.project)}`, join(scratch.logsDir, "sse-a.ndjson"));
    const sseB = collectSse(serveB.url, `/event?directory=${encodeURIComponent(scratch.project)}`, join(scratch.logsDir, "sse-b.ndjson"));

    const leaseA = await createBorrowedExternalEndpointLease({ url: proxyA.url, location: { directory: scratch.project } });
    const lifecycleA = await createOpenCodeRuntimeLifecycle({ lease: leaseA, protocol: "legacy" });
    const facadeA = attachRuntimeLifecycle(createOpenCodeRuntimeFacade({ lifecycle: lifecycleA }), lifecycleA);
    const leaseB = await createBorrowedExternalEndpointLease({ url: proxyB.url, location: { directory: scratch.project } });
    const lifecycleB = await createOpenCodeRuntimeLifecycle({ lease: leaseB, protocol: "legacy" });
    const facadeB = attachRuntimeLifecycle(createOpenCodeRuntimeFacade({ lifecycle: lifecycleB }), lifecycleB);

    const eventsA: Array<{ t: number; sessionId: string; ev: RuntimeEvent }> = [];
    facadeA.onEvent((sessionId, ev) => eventsA.push({ t: Date.now(), sessionId, ev }));
    const eventsB: Array<{ t: number; sessionId: string; ev: RuntimeEvent }> = [];
    facadeB.onEvent((sessionId, ev) => eventsB.push({ t: Date.now(), sessionId, ev }));

    let ordinal = 0;
    const runCase = async (options: {
      name: string;
      facade: typeof facadeA;
      serveUrl: string;
      proxy: typeof proxyA;
      events: typeof eventsA;
      sse: ReturnType<typeof collectSse>;
      prompt: string;
      model: { providerID: string; modelID: string; variant?: string };
      /** Wait until the target phase is reached. Returns true when reached. */
      phase: () => Promise<boolean>;
      pendingPath?: "/permission" | "/question";
    }): Promise<void> => {
      const canonical = `abort-${options.name}`;
      const backendId = await options.facade.ensureSession({ sessionId: canonical, cwd: scratch.project, title: `OC-REAL-017 ${options.name}` });
      await sleep(200);
      const abortsBefore = options.proxy.requestCount(new RegExp(`POST /session/${backendId}/abort`));
      await options.facade.startTurn({ sessionId: canonical, text: options.prompt, model: options.model });
      const phaseReached = await options.phase();
      if (!phaseReached) {
        results.push({ name: options.name, phaseReached: false, abortPosts: 0, completedLie: false, notes: "target phase never reached; case not exercised" });
        failures.push(`${options.name}: target phase never reached`);
        await options.facade.abort(canonical).catch(() => undefined);
        await sleep(1500);
        return;
      }
      await options.facade.abort(canonical);
      // Give the backend time to settle the aborted turn.
      const done = await waitForAssistantCompletion(options.serveUrl, backendId, scratch.project, 30_000);
      await sleep(800);
      const abortPosts = options.proxy.requestCount(new RegExp(`POST /session/${backendId}/abort`)) - abortsBefore;
      const stopped = options.events.filter((entry) => entry.sessionId === canonical && entry.ev.type === "turn/stopped")
        .map((entry) => entry.ev as { type: "turn/stopped"; reason: string; error?: string });
      const lastAssistant = done.messages.filter((message) => (message as { info?: { role?: string } }).info?.role === "assistant").at(-1) as
        | { info?: { time?: { completed?: number }; error?: unknown }; parts?: Array<{ type?: string; tool?: string; state?: { status?: string; error?: string } }> }
        | undefined;
      const toolStates = (lastAssistant?.parts ?? [])
        .filter((part) => part.type === "tool")
        .map((part) => ({ tool: part.tool, status: part.state?.status, error: part.state?.error?.slice(0, 140) }));
      const completedLie = stopped.some((entry) => entry.reason === "completed");
      const pendingAfterAbort = options.pendingPath
        ? (await httpJson(options.serveUrl, "GET", `${options.pendingPath}?directory=${encodeURIComponent(scratch.project)}`)).body
        : undefined;
      const statusAfterAbort = (await httpJson(options.serveUrl, "GET", `/session/status?directory=${encodeURIComponent(scratch.project)}`)).body;
      ordinal += 1;
      const endpoint = await options.facade.endpoint!();
      const snapshot = await options.facade.reconcile!({
        canonicalSessionId: canonical,
        backendSessionId: backendId,
        authorityId: endpoint.authorityId,
        generation: endpoint.generation,
        continuity: "generation-only",
        location: { directory: scratch.project },
        reconciliationOrdinal: ordinal,
      }).catch((error) => ({ state: { value: `reconcile-error: ${String(error)}` } }));

      const result: CaseResult = {
        name: options.name,
        phaseReached: true,
        abortPosts,
        turnStopped: stopped.at(-1),
        completedLie,
        finalAssistant: lastAssistant ? { completed: Boolean(lastAssistant.info?.time?.completed), error: lastAssistant.info?.error } : undefined,
        toolStates,
        pendingAfterAbort,
        statusAfterAbort,
        reconcileState: (snapshot as { state?: unknown }).state,
      };
      results.push(result);
      if (abortPosts !== 1) failures.push(`${options.name}: ${abortPosts} abort POSTs on the wire, expected exactly 1`);
      if (completedLie) failures.push(`${options.name}: turn/stopped reported completed after abort`);
      if (stopped.length > 0 && stopped.at(-1)!.reason !== "aborted" && stopped.at(-1)!.reason !== "error") {
        failures.push(`${options.name}: last turn/stopped reason=${stopped.at(-1)!.reason}`);
      }
    };

    // ---- Case 1: abort during text streaming ----
    await runCase({
      name: "text",
      facade: facadeA, serveUrl: serveA.url, proxy: proxyA, events: eventsA, sse: sseA,
      prompt: "Count from 1 to 2000, one number per line. Do not use any tools. Output only the numbers.",
      model: HF_MODEL,
      phase: async () => {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          if (eventsA.some((entry) => entry.sessionId === "abort-text" && entry.ev.type === "assistant/chunk")) return true;
          await sleep(100);
        }
        return false;
      },
    });

    // ---- Case 2: abort during visible reasoning ----
    await runCase({
      name: "reasoning",
      facade: facadeA, serveUrl: serveA.url, proxy: proxyA, events: eventsA, sse: sseA,
      prompt: "Think step by step very carefully: what is the 20th prime number times the 10th Fibonacci number? Show your reasoning.",
      model: HF_MODEL,
      phase: async () => {
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          if (eventsA.some((entry) => entry.sessionId === "abort-reasoning"
            && (entry.ev.type === "assistant/reasoning-chunk" || entry.ev.type === "assistant/chunk"))) return true;
          await sleep(100);
        }
        return false;
      },
    });

    // ---- Case 3: abort while a bash tool is RUNNING (side effect started) ----
    await runCase({
      name: "tool-running",
      facade: facadeA, serveUrl: serveA.url, proxy: proxyA, events: eventsA, sse: sseA,
      prompt: `Run exactly this bash command using the bash tool: sleep 25 && echo TOOL-RUNNING-MARKER > ${scratch.project}/tool-ran.txt`,
      model: TOOL_MODEL,
      phase: async () =>
        sseA.waitFor((event) => {
          if (event.type !== "message.part.updated") return false;
          const part = (event.data as { properties?: { part?: { type?: string; tool?: string; state?: { status?: string } } } }).properties?.part;
          return part?.type === "tool" && part.tool === "bash" && part.state?.status === "running";
        }, 90_000),
    });

    // ---- Case 4: abort while a question is OPEN ----
    await runCase({
      name: "question-open",
      facade: facadeA, serveUrl: serveA.url, proxy: proxyA, events: eventsA, sse: sseA,
      prompt: "Use the question tool to ask me which color I prefer. Options exactly: red, blue. Wait for my answer.",
      model: TOOL_MODEL,
      phase: async () => sseA.waitFor((event) => event.type === "question.asked", 90_000),
      pendingPath: "/question",
    });

    // ---- Case 5: abort while a permission is OPEN (tool pending) ----
    await runCase({
      name: "permission-open",
      facade: facadeB, serveUrl: serveB.url, proxy: proxyB, events: eventsB, sse: sseB,
      prompt: "Run exactly this bash command using the bash tool: echo PERM-ABORT-MARKER",
      model: TOOL_MODEL,
      phase: async () => sseB.waitFor((event) => event.type === "permission.asked", 90_000),
      pendingPath: "/permission",
    });

    // Side-effect check for the tool-running case: did the marker file appear?
    let toolSideEffect: string | undefined;
    try {
      toolSideEffect = await readFile(join(scratch.project, "tool-ran.txt"), "utf8");
    } catch {
      toolSideEffect = undefined;
    }

    await writeEvidence(scratch, "abort-matrix.json", {
      cases: results,
      toolRunningSideEffectFile: toolSideEffect ?? null,
      failures,
    });

    const reached = results.filter((entry) => entry.phaseReached).length;
    await writeVerdict(scratch, {
      id: "OC-REAL-017",
      verdict: failures.length === 0 ? "pass" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `${reached}/5 abort phases exercised (text, reasoning, tool-running, question-open, permission-open); per-case: ${results.map((entry) => `${entry.name}:${entry.abortPosts}xPOST/${entry.turnStopped?.reason ?? "no-stop"}`).join(", ")}`,
      expected: "one abort attempt per case; no invented completion; unresolved side effects stay explicit",
      attribution: failures.length === 0 ? "NONE" : "AMBIGUITY",
      evidence: [
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-017/abort-matrix.json",
        "logs/opencode-real-world/phase-1-legacy/OC-REAL-017/wire-a.ndjson",
        "logs/opencode-real-world/phase-1-legacy/OC-REAL-017/wire-b.ndjson",
      ],
      notes: "Queue preservation across abort is Polyth server-layer (deterministic-tested); this pins real upstream abort semantics per phase.",
    });

    sseA.close();
    sseB.close();
    await facadeA.dispose();
    await facadeB.dispose();
  } finally {
    await proxyA.close();
    await proxyB.close();
    await serveA.stop();
    await serveB.stop();
  }
};

await main();
