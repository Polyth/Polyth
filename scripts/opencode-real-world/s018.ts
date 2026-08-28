/** OC-REAL-018: fork before first prompt (empty history), mid-history with
 *  repeated equal text (positional boundary, not text-similarity), and at
 *  full history. Verifies exact child prefix, untouched source, no duplicate
 *  child, and the wire fork boundary (messageID). */
import { join } from "node:path";
import {
  attachRuntimeLifecycle,
  createBorrowedExternalEndpointLease,
  createOpenCodeRuntimeFacade,
  createOpenCodeRuntimeLifecycle,
} from "@polyth/backend-opencode";
import type { ModelMessage } from "@polyth/contracts";
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

interface BackendEntry { id: string; role: string; text: string }

const backendEntries = async (base: string, sessionId: string, directory: string): Promise<BackendEntry[]> => {
  const result = await httpJson(base, "GET", `/session/${sessionId}/message?directory=${encodeURIComponent(directory)}&limit=1000`);
  const rows = Array.isArray(result.body) ? result.body : [];
  return rows.flatMap((row) => {
    const info = (row as { info?: { id?: string; role?: string } }).info;
    if (!info?.id || (info.role !== "user" && info.role !== "assistant")) return [];
    const text = ((row as { parts?: Array<{ type?: string; text?: string }> }).parts ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();
    return [{ id: info.id, role: info.role!, text }];
  });
};

const toModelMessages = (entries: BackendEntry[]): ModelMessage[] =>
  entries.map((entry) => ({
    role: entry.role as "user" | "assistant",
    parts: [{ type: "text", text: entry.text }],
  }));

const sameEntries = (left: BackendEntry[], right: BackendEntry[]): boolean =>
  left.length === right.length
  && left.every((entry, index) => entry.role === right[index]!.role && entry.text === right[index]!.text);

const main = async (): Promise<void> => {
  const scratch = await makeScratch("OC-REAL-018");
  const failures: string[] = [];
  const wire = new WireLog(join(scratch.logsDir, "wire.ndjson"));
  const serve = await spawnServe(scratch);
  const proxy = await startFaultProxy(serve.url, wire);
  const evidence: Record<string, unknown> = {};
  try {
    const lease = await createBorrowedExternalEndpointLease({ url: proxy.url, location: { directory: scratch.project } });
    const lifecycle = await createOpenCodeRuntimeLifecycle({ lease, protocol: "legacy" });
    const facade = attachRuntimeLifecycle(createOpenCodeRuntimeFacade({ lifecycle }), lifecycle);

    const sessionCount = async (): Promise<number> => {
      const result = await httpJson(serve.url, "GET", `/session?directory=${encodeURIComponent(scratch.project)}`);
      return Array.isArray(result.body) ? result.body.length : -1;
    };

    // ---- Case A: fork before first prompt (empty history) ----
    const srcEmpty = await facade.ensureSession({ sessionId: "fork-src-empty", cwd: scratch.project, title: "OC-REAL-018 empty source" });
    const countBeforeA = await sessionCount();
    const childEmptyId = await facade.branchSession!({
      sourceSessionId: "fork-src-empty",
      target: { projectId: "p", sessionId: "fork-child-empty", cwd: scratch.project, title: "empty fork child" },
      history: [],
    });
    const countAfterA = await sessionCount();
    const childEmptyHistory = await backendEntries(serve.url, childEmptyId, scratch.project);
    evidence.caseA = {
      sourceBackendId: srcEmpty,
      childBackendId: childEmptyId,
      childHistoryLength: childEmptyHistory.length,
      sessionsBefore: countBeforeA,
      sessionsAfter: countAfterA,
    };
    if (childEmptyId === srcEmpty) failures.push("caseA: empty fork returned the source session id");
    if (childEmptyHistory.length !== 0) failures.push(`caseA: empty fork child has ${childEmptyHistory.length} messages`);
    if (countAfterA !== countBeforeA + 1) failures.push(`caseA: session count went ${countBeforeA} -> ${countAfterA}, expected exactly one new child`);

    // ---- Build a source with REPEATED EQUAL user text ----
    const src = await facade.ensureSession({ sessionId: "fork-src", cwd: scratch.project, title: "OC-REAL-018 source" });
    const prompt = "Reply with exactly the word SAME and nothing else.";
    await facade.startTurn({ sessionId: "fork-src", text: prompt, model: LIVE_MODEL });
    await waitForAssistantCompletion(serve.url, src, scratch.project, 90_000);
    await facade.startTurn({ sessionId: "fork-src", text: prompt, model: LIVE_MODEL });
    await waitForAssistantCompletion(serve.url, src, scratch.project, 90_000);
    await sleep(500);
    const sourceEntries = await backendEntries(serve.url, src, scratch.project);
    evidence.sourceEntries = sourceEntries;
    if (sourceEntries.length < 4) {
      failures.push(`source has only ${sourceEntries.length} entries; expected 4 (two identical user turns)`);
    }
    const firstPair = sourceEntries.slice(0, 2);
    const repeatedEqual = sourceEntries.length >= 3 && sourceEntries[0]!.text === sourceEntries[2]!.text;
    if (!repeatedEqual) failures.push("user text was not repeated equal (prompt drift)");

    // ---- Case B: mid-history fork at the FIRST identical pair ----
    const countBeforeB = await sessionCount();
    let childMidId: string | undefined;
    let midError: string | undefined;
    try {
      childMidId = await facade.branchSession!({
        sourceSessionId: "fork-src",
        target: { projectId: "p", sessionId: "fork-child-mid", cwd: scratch.project, title: "mid fork child" },
        history: toModelMessages(firstPair),
      });
    } catch (error) {
      midError = String(error);
    }
    const countAfterB = await sessionCount();
    const childMidHistory = childMidId ? await backendEntries(serve.url, childMidId, scratch.project) : [];
    const sourceAfterMid = await backendEntries(serve.url, src, scratch.project);
    // Wire proof of the positional boundary: fork body messageID must equal
    // the SECOND user message id (entries[2]), not anything text-derived.
    const wireRaw = await import("node:fs/promises").then((fs) => fs.readFile(wire.path, "utf8"));
    const forkPosts = wireRaw.trim().split("\n").map((line) => JSON.parse(line) as { kind: string; method?: string; path?: string; body?: unknown })
      .filter((line) => line.kind === "request" && (line.path ?? "").includes("/fork"));
    evidence.caseB = {
      childBackendId: childMidId ?? null,
      error: midError ?? null,
      childHistory: childMidHistory,
      wantedPrefix: firstPair,
      forkPosts,
      sessionsBefore: countBeforeB,
      sessionsAfter: countAfterB,
      sourceUnchanged: sameEntries(sourceEntries, sourceAfterMid),
    };
    if (midError) failures.push(`caseB: mid-history fork failed: ${midError}`);
    if (childMidId && !sameEntries(childMidHistory, firstPair)) {
      failures.push(`caseB: child history is not the exact positional prefix (got ${childMidHistory.length} entries: ${JSON.stringify(childMidHistory.map((entry) => entry.text))})`);
    }
    if (!sameEntries(sourceEntries, sourceAfterMid)) failures.push("caseB: source history changed after fork");
    const expectedBoundaryId = sourceEntries[2]?.id;
    const midForkPost = forkPosts.find((post) => (post.path ?? "").includes(src));
    const sentBoundary = (midForkPost?.body as { messageID?: string })?.messageID;
    if (childMidId && sentBoundary !== expectedBoundaryId) {
      failures.push(`caseB: fork boundary messageID=${sentBoundary}, expected ${expectedBoundaryId} (positional, second identical user message)`);
    }

    // ---- Case C: full-history fork ----
    const countBeforeC = await sessionCount();
    let childFullId: string | undefined;
    let fullError: string | undefined;
    try {
      childFullId = await facade.branchSession!({
        sourceSessionId: "fork-src",
        target: { projectId: "p", sessionId: "fork-child-full", cwd: scratch.project, title: "full fork child" },
        history: toModelMessages(sourceEntries),
      });
    } catch (error) {
      fullError = String(error);
    }
    const countAfterC = await sessionCount();
    const childFullHistory = childFullId ? await backendEntries(serve.url, childFullId, scratch.project) : [];
    const sourceAfterFull = await backendEntries(serve.url, src, scratch.project);
    evidence.caseC = {
      childBackendId: childFullId ?? null,
      error: fullError ?? null,
      childHistory: childFullHistory,
      sessionsBefore: countBeforeC,
      sessionsAfter: countAfterC,
      sourceUnchanged: sameEntries(sourceEntries, sourceAfterFull),
    };
    if (fullError) failures.push(`caseC: full-history fork failed: ${fullError}`);
    if (childFullId && !sameEntries(childFullHistory, sourceEntries)) failures.push("caseC: full fork child history differs from source");
    if (!sameEntries(sourceEntries, sourceAfterFull)) failures.push("caseC: source history changed after full fork");

    // ---- Negative: a prefix that is NOT present must be rejected, source mapping unchanged ----
    let mismatchOutcome = "no-error";
    try {
      await facade.branchSession!({
        sourceSessionId: "fork-src",
        target: { projectId: "p", sessionId: "fork-child-bogus", cwd: scratch.project },
        history: [{ role: "user", parts: [{ type: "text", text: "THIS PREFIX NEVER HAPPENED" }] }],
      });
    } catch (error) {
      mismatchOutcome = `${(error as { code?: string }).code ?? "error"}: ${String(error).slice(0, 120)}`;
    }
    evidence.mismatchOutcome = mismatchOutcome;
    if (mismatchOutcome === "no-error") failures.push("bogus prefix fork was not rejected");

    await writeEvidence(scratch, "fork-boundaries.json", { ...evidence, failures });
    await writeVerdict(scratch, {
      id: "OC-REAL-018",
      verdict: failures.length === 0 ? "pass" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `empty fork -> fresh session (${(evidence.caseA as { childHistoryLength: number }).childHistoryLength} msgs); mid fork with repeated equal text used positional messageID boundary; full fork exact; bogus prefix -> ${mismatchOutcome}`,
      expected: "child history and cwd exact; source mapping never changes on failed verification",
      attribution: failures.length === 0 ? "NONE" : "AMBIGUITY",
      evidence: [
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-018/fork-boundaries.json",
        "logs/opencode-real-world/phase-1-legacy/OC-REAL-018/wire.ndjson",
      ],
      notes: "Cross-location fork isolation is covered by worktree rows; this pins the real /fork boundary contract and read-back verification.",
    });
    await facade.dispose();
  } finally {
    await proxy.close();
    await serve.stop();
  }
};

await main();
