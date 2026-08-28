/**
 * Phase 13 — independent reliability verification (adversarial re-checks).
 *
 * P13-G1  crash after upstream prompt commit, before settle -> no duplicate prompt
 * P13-G2  two concurrent permission replies -> exactly one upstream winner
 * P13-G5  owned child SIGKILL mid-turn -> status never stuck sending/working
 * P13-G6  borrowed/shared serve survives full Polyth shutdown unsignalled
 * P13-G8  transport deadlines are finite and enforced against a black hole
 *
 * Usage: node scripts/opencode-real-world/phase13.ts P13-G1|P13-G2|P13-G5|P13-G6|P13-G8
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createBorrowedExternalEndpointLease,
  createOpenCodeTransport,
  createOwnedLocalEndpointLease,
} from "@polyth/backend-opencode";
import type { SessionEvent } from "@polyth/contracts";

import {
  FREE_MODEL,
  OPENCODE_BIN,
  REPO_ROOT,
  TOOL_MODELS,
  finishVerdict,
  fixedBorrowedLease,
  json,
  makeScratch,
  procIdentity,
  sleep,
  spawnOpenCode,
  startPolyth,
  startRecordingProxy,
  waitUntil,
  writeArtifact,
  writeManifest,
  writeOpencodeConfig,
  type RequestRecord,
  type Scratch,
} from "./phase13lib.ts";

const dumpOperations = (dbPath: string): unknown[] => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(
      "SELECT operation_id, session_id, mutation_kind, state, replay_kind, receipt, code, message FROM runtime_operations ORDER BY ordinal",
    ).all() as unknown[];
  } finally {
    db.close();
  }
};

const eventsOfType = (events: SessionEvent[], sessionId: string, type: string): SessionEvent[] =>
  events.filter((event) => event.sessionId === sessionId && event.type === type);

const waitForAssistantCompletion = async (
  baseUrl: string,
  backendId: string,
  directory: string,
  timeoutMs = 120_000,
): Promise<boolean> => {
  try {
    await waitUntil(
      async () => {
        const response = await fetch(
          `${baseUrl}/session/${encodeURIComponent(backendId)}/message?directory=${encodeURIComponent(directory)}`,
        );
        const body = await response.json().catch(() => []);
        return Array.isArray(body) ? body : [];
      },
      (messages) => messages.some((message) => {
        const info = (message as { info?: { role?: string; time?: { completed?: number }; error?: unknown } }).info;
        return info?.role === "assistant"
          && (typeof info.time?.completed === "number" || info.error !== undefined);
      }),
      timeoutMs,
      `assistant completion for ${backendId}`,
    );
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- P13-G1

const scenarioG1 = async (): Promise<void> => {
  const scratch = await makeScratch("P13-G1");
  await writeOpencodeConfig(scratch, "allow");
  const serve = await spawnOpenCode(scratch);
  const proxy = await startRecordingProxy(serve.url, join(scratch.logDir, "wire.ndjson"));
  const marker = `PHASE13_G1_${Date.now().toString(36).toUpperCase()}`;
  const promptPattern = /^POST \/session\/[^/]+\/(prompt_async|message)/;
  const markerPrompt = (record: RequestRecord): boolean =>
    promptPattern.test(`${record.method} ${record.path}`) && record.body.includes(marker);

  // Scratch goes through a file: argv must never carry environment secrets.
  const scratchFile = join(scratch.root, "scratch.json");
  const { env: _env, ...scratchWithoutEnv } = scratch;
  await writeFile(scratchFile, JSON.stringify({ ...scratchWithoutEnv, env: {} }));
  const life1 = spawn(
    process.execPath,
    [
      join(REPO_ROOT, "scripts/opencode-real-world/phase13_g1_life1.ts"),
      scratchFile,
      proxy.url,
      marker,
    ],
    { cwd: REPO_ROOT, env: scratch.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const life1Lines: string[] = [];
  let created: { sessionId: string; backendId: string } | undefined;
  life1.stdout.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      life1Lines.push(line);
      try {
        const value = JSON.parse(line) as { kind?: string; sessionId?: string; backendId?: string };
        if (value.kind === "created") created = { sessionId: value.sessionId!, backendId: value.backendId! };
      } catch { /* non-JSON noise */ }
    }
  });
  life1.stderr.on("data", (chunk: Buffer) => life1Lines.push(`stderr: ${chunk.toString().trim()}`));

  await waitUntil(() => created, (value) => Boolean(value), 60_000, "life1 session binding");

  let opsAtRequest: unknown[] = [];
  let opsAtKill: unknown[] = [];
  let committedStatus = 0;
  let committedBody = "";
  let killDetail: Record<string, unknown> = {};
  const committed = new Promise<void>((resolveCommit) => {
    proxy.armSwallow(promptPattern, {
      onRequest() {
        // The moment the prompt POST hits the wire the durable operation row
        // must already exist (write-ahead). Snapshot before forwarding.
        opsAtRequest = dumpOperations(scratch.dbPath);
      },
      onCommitted(record, responseBody) {
        committedStatus = record.status ?? 0;
        committedBody = responseBody;
        void (async () => {
          // Exact-PID kill with /proc identity verification, then never relay.
          const identity = await procIdentity(life1.pid!);
          killDetail = { pid: life1.pid, identity };
          if (identity?.cmdline.includes("phase13_g1_life1.ts")) {
            process.kill(life1.pid!, "SIGKILL");
            killDetail.signalled = "SIGKILL";
          } else {
            killDetail.signalled = "refused: identity mismatch";
          }
          resolveCommit();
        })();
      },
    });
  });
  // Release the barrier only after the swallow rule is armed.
  await writeFile(join(scratch.root, "armed"), "1");

  await committed;
  await new Promise<void>((resolveExit) => {
    if (life1.exitCode !== null || life1.signalCode !== null) resolveExit();
    else life1.once("exit", () => resolveExit());
  });
  proxy.disarm();
  opsAtKill = dumpOperations(scratch.dbPath);

  // ---- life 2: same database, fresh Polyth wiring against the live serve.
  const lease2 = fixedBorrowedLease(proxy.url, scratch.project, "phase13:g1");
  const polyth2 = await startPolyth(scratch, lease2, { logName: "polyth-life2.ndjson" });
  const opsAfterRestart = dumpOperations(scratch.dbPath);

  let secondSend: Record<string, unknown> = {};
  try {
    await polyth2.sessions.send(created!.sessionId, { text: "second send after restart", model: FREE_MODEL });
    secondSend = { outcome: "admitted (UNEXPECTED)" };
  } catch (error) {
    secondSend = { outcome: "refused", code: (error as { code?: string }).code, message: String(error) };
  }

  let abortResult: Record<string, unknown> = {};
  try {
    await polyth2.sessions.abort(created!.sessionId);
    abortResult = { outcome: "accepted" };
  } catch (error) {
    abortResult = { outcome: "error", code: (error as { code?: string }).code, message: String(error) };
  }

  await sleep(15_000);
  const markerPosts = proxy.count(markerPrompt);
  const finalOps = dumpOperations(scratch.dbPath);
  const userMessages = (await polyth2.store.events(created!.sessionId))
    .filter((event) => event.type === "user/message");
  const finalProjection = await polyth2.store.projection(created!.sessionId);

  const turnSubmit = (finalOps as Array<{ mutation_kind: string; state: string; replay_kind: string }>)
    .filter((op) => op.mutation_kind === "turn-submit");
  const restartUnknown = (opsAfterRestart as Array<{ mutation_kind: string; state: string }>)
    .some((op) => op.mutation_kind === "turn-submit" && op.state === "unknown");
  const writeAheadProven = (opsAtRequest as Array<{ mutation_kind: string; state: string }>)
    .some((op) => op.mutation_kind === "turn-submit"
      && (op.state === "executing" || op.state === "prepared"));

  const passed = committedStatus >= 200 && committedStatus < 300
    && markerPosts === 1
    && writeAheadProven
    && restartUnknown
    && userMessages.length === 1
    && secondSend.outcome === "refused"
    && !turnSubmit.some((op) => op.replay_kind !== "never");

  await writeArtifact(scratch, "details.json", {
    marker,
    created,
    committedStatus,
    committedBody: committedBody.slice(0, 2_000),
    killDetail,
    opsAtRequest,
    opsAtKill,
    opsAfterRestart,
    finalOps,
    secondSend,
    abortResult,
    markerPosts,
    userMessageCount: userMessages.length,
    finalProjection,
    life1Lines,
    allPromptPosts: proxy.requests
      .filter((record) => promptPattern.test(`${record.method} ${record.path}`))
      .map((record) => ({ t: record.t, path: record.path, status: record.status, hasMarker: record.body.includes(marker) })),
  });
  await writeManifest(scratch, { serve: { pid: serve.pid, url: serve.url }, proxy: proxy.url });
  await finishVerdict(scratch, {
    id: "P13-G1",
    verdict: passed ? "pass" : "fail",
    protocol: "legacy (forced)",
    observed: `upstream committed ${committedStatus}; response swallowed; exact life1 PID SIGKILLed; ops at POST time=${json(opsAtRequest).slice(0, 200)}; restart marked turn-submit unknown=${restartUnknown}; marker prompt POSTs total=${markerPosts}; second send=${String(secondSend.outcome)}; user/message events=${userMessages.length}`,
    expected: "operation row is durable before the wire POST; restart never re-sends; exactly one marker prompt POST; blocked second send",
    attribution: passed ? "NONE" : "POLYTH",
    evidence: [
      "artifacts/opencode-real-world/phase-13/P13-G1/details.json",
      "logs/opencode-real-world/phase-13/P13-G1/wire.ndjson",
    ],
  });
  await polyth2.close();
  await proxy.close();
  await serve.stop();
};

// ---------------------------------------------------------------- P13-G2

const scenarioG2 = async (): Promise<void> => {
  const scratch = await makeScratch("P13-G2");
  await writeOpencodeConfig(scratch, "ask");
  const serve = await spawnOpenCode(scratch);
  const proxy = await startRecordingProxy(serve.url, join(scratch.logDir, "wire.ndjson"));
  const polyth = await startPolyth(scratch, fixedBorrowedLease(proxy.url, scratch.project, "phase13:g2"));

  let requestId = "";
  let sessionId = "";
  let backendId = "";
  let usedModel = "";
  const attempts: Record<string, unknown>[] = [];
  for (const model of TOOL_MODELS) {
    const created = await polyth.create(`P13-G2 ${model.modelID}`);
    const sendPromise = polyth.sessions.send(created.id, {
      text: "Run exactly this bash command using the bash tool: echo PHASE13_G2_OK",
      model,
    }).catch((error) => ({ sendError: String(error) }));
    try {
      await waitUntil(
        () => eventsOfType(polyth.events, created.id, "permission/requested"),
        (events) => events.length > 0,
        90_000,
        `permission request via ${model.modelID}`,
      );
      const event = eventsOfType(polyth.events, created.id, "permission/requested")[0]!;
      requestId = (event.data as { requestId?: string }).requestId ?? "";
      sessionId = created.id;
      backendId = created.backendId;
      usedModel = `${model.providerID}/${model.modelID}`;
      attempts.push({ model: usedModel, outcome: "permission requested", requestId });
      void sendPromise;
      break;
    } catch (error) {
      attempts.push({ model: `${model.providerID}/${model.modelID}`, outcome: String(error) });
    }
  }
  if (!requestId) throw new Error(`no model produced a permission request: ${json(attempts)}`);

  // Two clients answer the same permission a few milliseconds apart with
  // OPPOSITE replies. Exactly one may reach OpenCode.
  const [first, second] = await Promise.allSettled([
    polyth.sessions.replyPermission(sessionId, requestId, "once"),
    (async () => {
      await sleep(3);
      return polyth.sessions.replyPermission(sessionId, requestId, "reject");
    })(),
  ]);

  const replyPattern = new RegExp(`^POST /session/${backendId}/permissions/${requestId}`);
  await sleep(3_000);
  const replyPosts = proxy.count((record) => replyPattern.test(`${record.method} ${record.path}`));
  const resolvedEvents = (await polyth.store.events(sessionId))
    .filter((event) => event.type === "permission/resolved"
      && (event.data as { requestId?: string }).requestId === requestId);
  const upstreamPending = await (async () => {
    const response = await fetch(`${serve.url}/permission?directory=${encodeURIComponent(scratch.project)}`);
    const body = await response.json().catch(() => []);
    return Array.isArray(body) ? body.filter((item) => (item as { id?: string }).id === requestId) : [];
  })();
  const fulfilled = [first, second].filter((result) => result.status === "fulfilled").length;
  const loser = [first, second].find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
  await waitForAssistantCompletion(serve.url, backendId, scratch.project, 60_000);

  const passed = fulfilled === 1
    && replyPosts === 1
    && resolvedEvents.length === 1
    && upstreamPending.length === 0;

  await writeArtifact(scratch, "details.json", {
    attempts,
    usedModel,
    requestId,
    raceResults: [
      { status: first.status, ...(first.status === "rejected" ? { reason: String(first.reason) } : {}) },
      { status: second.status, ...(second.status === "rejected" ? { reason: String(second.reason) } : {}) },
    ],
    loserError: loser ? String(loser.reason) : undefined,
    replyPosts,
    resolvedEvents,
    upstreamPending,
    operations: dumpOperations(scratch.dbPath),
  });
  await writeManifest(scratch, { serve: { pid: serve.pid, url: serve.url }, proxy: proxy.url });
  await finishVerdict(scratch, {
    id: "P13-G2",
    verdict: passed ? "pass" : "fail",
    protocol: "legacy (forced)",
    observed: `race (once vs reject, 3ms apart): fulfilled=${fulfilled}; upstream reply POSTs=${replyPosts}; durable permission/resolved=${resolvedEvents.length}; pending after=${upstreamPending.length}; loser=${loser ? String(loser.reason).slice(0, 120) : "none"}`,
    expected: "exactly one winner, one upstream POST, one durable resolution, typed conflict for the loser",
    attribution: passed ? "NONE" : "POLYTH",
    evidence: [
      "artifacts/opencode-real-world/phase-13/P13-G2/details.json",
      "logs/opencode-real-world/phase-13/P13-G2/wire.ndjson",
    ],
  });
  await polyth.close();
  await proxy.close();
  await serve.stop();
};

// ---------------------------------------------------------------- P13-G5

const scenarioG5 = async (): Promise<void> => {
  const scratch = await makeScratch("P13-G5");
  await writeOpencodeConfig(scratch, "allow");
  for (const key of [
    "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
    "GOOGLE_GENERATIVE_AI_API_KEY",
  ]) process.env[key] = scratch.env[key];

  const pidFile = join(scratch.root, "owned.pid.json");
  const lease = await createOwnedLocalEndpointLease({
    cwd: scratch.project,
    bin: OPENCODE_BIN,
    dataDir: scratch.configDir,
    pidFile,
    stateFile: join(scratch.root, "owned.lease.json"),
  });
  const polyth = await startPolyth(scratch, lease);
  const endpoint = await lease.endpoint();
  const created = await polyth.create("P13-G5 owned crash");

  const sendPromise = polyth.sessions.send(created.id, {
    text: "Use the bash tool to run exactly: sleep 45. After it finishes reply done.",
    model: FREE_MODEL,
  }).catch((error) => ({ sendError: String(error) }));

  await waitUntil(
    async () => (await polyth.store.projection(created.id))?.status,
    (status) => status === "working" || status === "waiting",
    60_000,
    "turn active",
  );
  // Give the tool call a moment to be durably underway.
  try {
    await waitUntil(
      () => polyth.events.filter((event) =>
        event.sessionId === created.id && event.type.startsWith("tool/")),
      (events) => events.length > 0,
      45_000,
      "tool activity",
    );
  } catch { /* mid-text kill is equally valid */ }

  const record = JSON.parse(await readFile(pidFile, "utf8")) as {
    child: { pid: number; startIdentity: string; executable: string; command: string };
  };
  const identity = await procIdentity(record.child.pid);
  if (!identity || identity.startTick !== record.child.startIdentity) {
    throw new Error(`owned child identity mismatch; refusing to signal pid ${record.child.pid}`);
  }
  const statusBeforeKill = (await polyth.store.projection(created.id))?.status;
  process.kill(record.child.pid, "SIGKILL");
  const killedAt = Date.now();

  const timeline: Array<{ t: number; status: string | undefined }> = [];
  let lastStatus: string | undefined;
  const deadline = killedAt + 120_000;
  let settledStatus: string | undefined;
  while (Date.now() < deadline) {
    const status = (await polyth.store.projection(created.id))?.status;
    if (status !== lastStatus) {
      timeline.push({ t: Date.now() - killedAt, status });
      lastStatus = status;
    }
    // `reconciling` is not a settle: a wedged reconciliation would keep the
    // session busy forever. Only an honest steady state counts.
    if (status && !["working", "waiting", "sending", "reconciling"].includes(status)) {
      // Require stability for 5s before declaring the settle.
      await sleep(5_000);
      const confirm = (await polyth.store.projection(created.id))?.status;
      if (confirm && !["working", "waiting", "sending", "reconciling"].includes(confirm)) {
        settledStatus = confirm;
        break;
      }
    }
    await sleep(500);
  }
  const sendOutcome = await Promise.race([sendPromise, sleep(20_000).then(() => ({ sendError: "still pending after settle+20s" }))]);
  const childAfter = await procIdentity(record.child.pid);
  const orphanRemains = childAfter !== undefined
    && childAfter.startTick === record.child.startIdentity;
  const passed = settledStatus !== undefined && !orphanRemains;

  await writeArtifact(scratch, "details.json", {
    endpoint: { authorityId: endpoint.authorityId, generation: endpoint.generation, url: endpoint.url },
    killedChild: record.child,
    statusBeforeKill,
    timeline,
    settledStatus,
    settleMs: timeline.at(-1)?.t,
    sendOutcome,
    orphanRemains,
    operations: dumpOperations(scratch.dbPath),
    finalProjection: await polyth.store.projection(created.id),
  });
  await writeManifest(scratch, { ownedChild: record.child });
  await finishVerdict(scratch, {
    id: "P13-G5",
    verdict: passed ? "pass" : "fail",
    protocol: "legacy (forced)",
    observed: `owned child ${record.child.pid} SIGKILLed mid-turn (status=${statusBeforeKill}); status timeline=${json(timeline)}; settled=${settledStatus}; orphan remains=${orphanRemains}`,
    expected: "projection leaves sending/working/waiting in bounded time and settles honestly (reconciling/unknown); no orphaned exact child",
    attribution: passed ? "NONE" : "POLYTH",
    evidence: [
      "artifacts/opencode-real-world/phase-13/P13-G5/details.json",
      "logs/opencode-real-world/phase-13/P13-G5/polyth.ndjson",
    ],
  });
  await polyth.close();
  await lease.dispose();
};

// ---------------------------------------------------------------- P13-G6

const scenarioG6 = async (): Promise<void> => {
  const scratch = await makeScratch("P13-G6");
  await writeOpencodeConfig(scratch, "allow");
  const serve = await spawnOpenCode(scratch);
  const identityBefore = await procIdentity(serve.pid);

  const lease = await createBorrowedExternalEndpointLease({
    url: serve.url,
    location: { directory: scratch.project },
  });
  const polyth = await startPolyth(scratch, lease);
  const created = await polyth.create("P13-G6 borrowed shutdown");
  await polyth.sessions.send(created.id, {
    text: "Reply exactly PHASE13_G6_OK and nothing else.",
    model: FREE_MODEL,
  }).catch(() => undefined);
  await waitForAssistantCompletion(serve.url, created.backendId, scratch.project, 90_000);

  let receivedSignal: string | null = null;
  serve.child.once("exit", (_code, signal) => { receivedSignal = signal; });

  // Full Polyth shutdown: runtime facade, lifecycle, store, endpoint lease.
  await polyth.close();
  await lease.dispose();
  await sleep(2_000);

  const identityAfter = await procIdentity(serve.pid);
  const stillListening = await fetch(`${serve.url}/session?directory=${encodeURIComponent(scratch.project)}`)
    .then((response) => response.status)
    .catch((error) => `error: ${String(error)}`);
  const alive = serve.child.exitCode === null && serve.child.signalCode === null;
  const sameIdentity = identityBefore !== undefined
    && identityAfter !== undefined
    && identityBefore.startTick === identityAfter.startTick;
  const passed = alive && sameIdentity && receivedSignal === null && stillListening === 200;

  await writeArtifact(scratch, "details.json", {
    servePid: serve.pid,
    identityBefore,
    identityAfter,
    receivedSignal,
    aliveAfterShutdown: alive,
    stillListening,
    leaseControl: lease.control,
  });
  await writeManifest(scratch, { serve: { pid: serve.pid, url: serve.url } });
  await finishVerdict(scratch, {
    id: "P13-G6",
    verdict: passed ? "pass" : "fail",
    protocol: "legacy (forced)",
    observed: `after full Polyth dispose: shared serve pid ${serve.pid} alive=${alive}, /proc identity unchanged=${sameIdentity}, signal received=${String(receivedSignal)}, health status=${String(stillListening)}`,
    expected: "borrowed dispose detaches only; the shared process is never signalled and keeps serving",
    attribution: passed ? "NONE" : "POLYTH",
    evidence: ["artifacts/opencode-real-world/phase-13/P13-G6/details.json"],
  });
  await serve.stop();
};

// ---------------------------------------------------------------- P13-G8

const scenarioG8 = async (): Promise<void> => {
  const scratch = await makeScratch("P13-G8");
  const blackHole = createServer(() => { /* accept, never respond */ });
  await new Promise<void>((resolveListen) => blackHole.listen(0, "127.0.0.1", resolveListen));
  const address = blackHole.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const results: Record<string, unknown> = {};

  const singleAttempt = createOpenCodeTransport({ baseUrl, queryAttempts: 1 });
  {
    const start = Date.now();
    let outcome: string;
    try {
      await singleAttempt.query({ method: "GET", path: "/session", deadlineMs: 1_500 });
      outcome = "resolved (UNEXPECTED)";
    } catch (error) {
      outcome = `${(error as Error).name}: ${(error as Error).message}`;
    }
    results.querysingle = { outcome, elapsedMs: Date.now() - start };
  }

  const defaultAttempts = createOpenCodeTransport({ baseUrl });
  {
    const start = Date.now();
    let outcome: string;
    try {
      await defaultAttempts.query({ method: "GET", path: "/session", deadlineMs: 2_000 });
      outcome = "resolved (UNEXPECTED)";
    } catch (error) {
      outcome = `${(error as Error).name}: ${(error as Error).message}`;
    }
    results.queryRetries = { outcome, elapsedMs: Date.now() - start };
  }

  {
    const start = Date.now();
    const outcome = await singleAttempt.mutate({
      method: "POST",
      path: "/session/x/message",
      body: {},
      operationId: "p13-g8",
      deadlineMs: 1_500,
      replay: { kind: "never" },
    });
    results.mutate = { outcome, elapsedMs: Date.now() - start };
  }

  for (const [name, deadlineMs] of [
    ["infinity", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["negative", -5],
  ] as const) {
    try {
      await singleAttempt.query({ method: "GET", path: "/session", deadlineMs });
      results[`invalid-${name}`] = "accepted (UNEXPECTED)";
    } catch (error) {
      results[`invalid-${name}`] = `${(error as Error).name}: ${(error as Error).message}`;
    }
  }

  blackHole.closeAllConnections?.();
  await new Promise<void>((resolveClose) => blackHole.close(() => resolveClose()));

  const querySingleResult = results.querysingle as { outcome: string; elapsedMs: number };
  const queryRetriesResult = results.queryRetries as { outcome: string; elapsedMs: number };
  const mutateResult = results.mutate as { outcome: { kind: string }; elapsedMs: number };
  const passed = querySingleResult.outcome.includes("OpenCodeDeadlineError")
    && querySingleResult.elapsedMs < 4_000
    && queryRetriesResult.outcome.includes("OpenCodeDeadlineError")
    && queryRetriesResult.elapsedMs < 4_500
    && mutateResult.outcome.kind === "unknown"
    && mutateResult.elapsedMs < 4_000
    && String(results["invalid-infinity"]).includes("RangeError")
    && String(results["invalid-zero"]).includes("RangeError")
    && String(results["invalid-negative"]).includes("RangeError");

  await writeArtifact(scratch, "details.json", results);
  await writeManifest(scratch, { blackHole: baseUrl });
  await finishVerdict(scratch, {
    id: "P13-G8",
    verdict: passed ? "pass" : "fail",
    protocol: "transport",
    observed: json(results).slice(0, 600),
    expected: "every REST query/mutate enforces a positive finite deadline; black-hole calls settle within budget; non-finite deadlines are rejected",
    attribution: passed ? "NONE" : "POLYTH",
    evidence: ["artifacts/opencode-real-world/phase-13/P13-G8/details.json"],
  });
};

const scenarios: Record<string, () => Promise<void>> = {
  "P13-G1": scenarioG1,
  "P13-G2": scenarioG2,
  "P13-G5": scenarioG5,
  "P13-G6": scenarioG6,
  "P13-G8": scenarioG8,
};

const selected = process.argv[2];
if (!selected || !(selected in scenarios)) {
  throw new Error(`usage: node ${process.argv[1]} ${Object.keys(scenarios).join("|")}`);
}
await scenarios[selected]!();
process.exit(0);
