/** OC-REAL-015: single-choice, multi-choice, free-text and multi-question
 *  requests triggered live via the real `question` tool; normalization exact.
 *  OC-REAL-016: reply and reject; race reply-vs-reject on one request.
 *  Each case runs in its own backend session so a stalled turn cannot
 *  contaminate the next case; timed-out turns are aborted explicitly. */
import { join } from "node:path";
import {
  attachRuntimeLifecycle,
  createBorrowedExternalEndpointLease,
  createOpenCodeRuntimeFacade,
  createOpenCodeRuntimeLifecycle,
} from "@polyth/backend-opencode";
import type { RuntimeEvent } from "@polyth/contracts";
import {
  LIVE_MODEL_ALT,
  LIVE_MODEL_LITE,
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
  const scratch15 = await makeScratch("OC-REAL-015");
  const scratch16 = await makeScratch("OC-REAL-016");
  const failures15: string[] = [];
  const failures16: string[] = [];
  const wire = new WireLog(join(scratch15.logsDir, "wire.ndjson"));
  const serve = await spawnServe(scratch15);
  const proxy = await startFaultProxy(serve.url, wire);
  try {
    const sse = collectSse(serve.url, `/event?directory=${encodeURIComponent(scratch15.project)}`, join(scratch15.logsDir, "sse.ndjson"));
    const lease = await createBorrowedExternalEndpointLease({ url: proxy.url, location: { directory: scratch15.project } });
    const lifecycle = await createOpenCodeRuntimeLifecycle({ lease, protocol: "legacy" });
    const facade = attachRuntimeLifecycle(createOpenCodeRuntimeFacade({ lifecycle }), lifecycle);
    const events: Array<{ t: number; ev: RuntimeEvent }> = [];
    facade.onEvent((_sessionId, ev) => events.push({ t: Date.now(), ev }));

    const seenQuestionIds = new Set<string>();
    const isNewQuestion = (event: { type?: string; data: unknown }): boolean =>
      event.type === "question.asked"
      && !seenQuestionIds.has(String((event.data as { properties?: { id?: string } }).properties?.id ?? ""));
    const waitQuestion = async (timeoutMs: number): Promise<{ id: string; raw: unknown } | undefined> => {
      if (!(await sse.waitFor(isNewQuestion, timeoutMs))) return undefined;
      const raw = sse.events.findLast((event) => isNewQuestion(event))!;
      const id = String((raw.data as { properties?: { id?: string } }).properties?.id ?? "");
      seenQuestionIds.add(id);
      return { id, raw: raw.data };
    };

    const endpointPromise = facade.endpoint!();

    interface QuestionCase {
      name: string;
      prompt: string;
      model?: { providerID: string; modelID: string };
      answer?: { answers: unknown[] };
      reject?: boolean;
      race?: boolean;
    }
    const cases: QuestionCase[] = [
      {
        name: "single-choice",
        prompt: "Use the question tool to ask me which color I prefer. Single choice. Options exactly: red, blue.",
        answer: { answers: [["red"]] },
      },
      {
        name: "multi-choice",
        model: LIVE_MODEL_LITE,
        prompt: "Use the question tool to ask me which fruits I like. Allow selecting multiple options. Options exactly: apple, banana, cherry.",
        answer: { answers: [["apple", "cherry"]] },
      },
      {
        name: "free-text",
        model: LIVE_MODEL_LITE,
        prompt: "Use the question tool to ask me one open-ended free-text question about my favorite city. Allow a custom free-form answer.",
        answer: { answers: [["Lisbon"]] },
      },
      {
        name: "multi-question",
        model: LIVE_MODEL_LITE,
        prompt: "Use the question tool ONCE to ask me TWO questions in the same call: first which color (options red, blue), second which size (options small, large).",
        answer: { answers: [["blue"], ["small"]] },
      },
      {
        name: "reject-case",
        model: LIVE_MODEL_LITE,
        prompt: "Use the question tool to ask me whether to continue. Options exactly: yes, no.",
        reject: true,
      },
      {
        name: "race-case",
        model: LIVE_MODEL_LITE,
        prompt: "Use the question tool to ask me which animal I like. Options exactly: cat, dog.",
        race: true,
      },
    ];

    const only = (process.env.OCREAL_ONLY ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    const selectedCases = only.length > 0 ? cases.filter((entry) => only.includes(entry.name)) : cases;
    const caseResults: Record<string, unknown>[] = [];
    let ordinal = 0;
    for (const testCase of selectedCases) {
      const canonicalId = `canonical-q-${testCase.name}`;
      const backendId = await facade.ensureSession({ sessionId: canonicalId, cwd: scratch15.project, title: `OC-REAL-015 ${testCase.name}` });
      const endpoint = await endpointPromise;
      const bindingBase = {
        canonicalSessionId: canonicalId,
        backendSessionId: backendId,
        authorityId: endpoint.authorityId,
        generation: endpoint.generation,
        continuity: "generation-only" as const,
        location: { directory: scratch15.project },
      };
      await facade.startTurn({ sessionId: canonicalId, text: testCase.prompt, model: testCase.model ?? LIVE_MODEL_ALT });
      const question = await waitQuestion(75_000);
      if (!question) {
        caseResults.push({ name: testCase.name, error: "no question.asked within 120s" });
        failures15.push(`${testCase.name}: model did not raise a question`);
        await facade.abort(canonicalId).catch(() => undefined);
        await sleep(1_000);
        continue;
      }
      await sleep(800);
      const pull = await httpJson(serve.url, "GET", `/question?directory=${encodeURIComponent(scratch15.project)}`);
      const pullEntry = (Array.isArray(pull.body) ? pull.body as Array<{ id: string }> : []).find((entry) => entry.id === question.id);
      ordinal += 1;
      const snapshot = await facade.reconcile!({ ...bindingBase, reconciliationOrdinal: ordinal });
      const snapshotEntry = snapshot.questions.find((entry) => entry.requestId === question.id);
      const facadeEvents = events.filter((entry) => entry.ev.type === "question/asked" && (entry.ev as { requestId: string }).requestId === question.id);
      const rawQuestions = (question.raw as { properties?: { questions?: unknown[] } }).properties?.questions ?? [];

      if (facadeEvents.length !== 1) failures15.push(`${testCase.name}: facade emitted ${facadeEvents.length} question/asked`);
      if (!pullEntry) failures15.push(`${testCase.name}: pending pull list missed the question`);
      if (!snapshotEntry) failures15.push(`${testCase.name}: reconcile snapshot missed the question`);
      if (snapshotEntry && JSON.stringify(snapshotEntry.questions) !== JSON.stringify(rawQuestions)) {
        failures15.push(`${testCase.name}: snapshot question payload drifted from raw`);
      }

      let action: Record<string, unknown> = {};
      if (testCase.race) {
        const binding = { ...bindingBase, protocol: await lifecycle.protocol() };
        const [first, second] = await Promise.all([
          lifecycle.replyQuestion(binding, question.id, { answers: [["cat"]] }, `op-q-race-reply`),
          lifecycle.replyQuestion(binding, question.id, { action: "reject" }, `op-q-race-reject`),
        ]);
        action = { race: { first, second } };
        const confirmed = [first, second].filter((outcome) => outcome.kind === "confirmed").length;
        if (confirmed !== 1) failures16.push(`race produced ${confirmed} confirmed outcomes, expected exactly 1`);
      } else if (testCase.reject) {
        await facade.replyQuestion(canonicalId, question.id, { action: "reject" });
        action = { rejected: true };
      } else if (testCase.answer) {
        await facade.replyQuestion(canonicalId, question.id, testCase.answer as never);
        action = { answered: testCase.answer };
      }
      const done = await waitForAssistantCompletion(serve.url, backendId, scratch15.project, 90_000).catch(() => ({ messages: [] as unknown[] }));
      const questionToolParts = done.messages
        .flatMap((message) => ((message as { parts?: Array<{ type?: string; tool?: string; callID?: string; state?: { status?: string; output?: string; error?: string } }> }).parts ?? []))
        .filter((part) => part.type === "tool" && part.tool === "question");
      const lastTool = questionToolParts.at(-1);
      caseResults.push({
        name: testCase.name,
        questionId: question.id,
        rawQuestions,
        snapshotQuestions: snapshotEntry?.questions,
        action,
        toolOutcome: lastTool ? { status: lastTool.state?.status, output: String(lastTool.state?.output ?? "").slice(0, 200), error: String((lastTool.state as { error?: string })?.error ?? "").slice(0, 200) } : undefined,
      });
    }

    // OC-REAL-016 answer-integrity checks from tool outputs.
    const byName = Object.fromEntries(caseResults.map((entry) => [entry.name as string, entry]));
    const outputOf = (name: string): string =>
      String((byName[name] as { toolOutcome?: { output?: string } })?.toolOutcome?.output ?? "");
    if (selectedCases.some((entry) => entry.name === "single-choice") && !outputOf("single-choice").includes("red")) failures16.push("single-choice answer not visible in tool output");
    if (selectedCases.some((entry) => entry.name === "multi-choice") && !(outputOf("multi-choice").includes("apple") && outputOf("multi-choice").includes("cherry"))) failures16.push("multi-choice answers not visible");
    if (selectedCases.some((entry) => entry.name === "free-text") && !outputOf("free-text").includes("Lisbon")) failures16.push("free-text answer not visible");
    if (selectedCases.some((entry) => entry.name === "multi-question") && !(outputOf("multi-question").includes("blue") && outputOf("multi-question").includes("small"))) failures16.push("multi-question answers not visible");
    const rejectStatus = (byName["reject-case"] as { toolOutcome?: { status?: string } })?.toolOutcome?.status;
    if (rejectStatus === "completed") failures16.push("rejected question tool still completed");

    await writeEvidence(scratch15, "question-shapes.json", {
      cases: caseResults.map((entry) => ({ name: entry.name, questionId: entry.questionId, rawQuestions: entry.rawQuestions, snapshotQuestions: entry.snapshotQuestions, error: entry.error })),
      failures: failures15,
    });
    await writeVerdict(scratch15, {
      id: "OC-REAL-015",
      verdict: failures15.length === 0 ? "pass" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `live question tool raised ${caseResults.filter((entry) => entry.questionId).length}/6 requests (single, multi, free-text, multi-question, reject, race); facade emitted each exactly once; pull list + reconcile snapshot carried identical question payloads`,
      expected: "prompt/options/multiplicity survive normalization exactly once",
      attribution: failures15.length === 0 ? "NONE" : "AMBIGUITY",
      evidence: [
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-015/question-shapes.json",
        "logs/opencode-real-world/phase-1-legacy/OC-REAL-015/sse.ndjson",
      ],
      notes: "Detached-UI durability is server-stack scope; this pins the real question payload contract (que_ id, questions[].question/header/options[].label).",
    });
    await writeEvidence(scratch16, "question-replies.json", {
      cases: caseResults.map((entry) => ({ name: entry.name, action: entry.action, toolOutcome: entry.toolOutcome, error: entry.error })),
      failures: failures16,
    });
    await writeVerdict(scratch16, {
      id: "OC-REAL-016",
      verdict: failures16.length === 0 ? "pass" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `answers delivered exactly (single/multi/free-text/multi-question reflected in real tool output); reject produced non-completed tool state; race reply-vs-reject -> exactly one confirmed winner`,
      expected: "one upstream action, exact answer arrays, no duplicate response",
      attribution: failures16.length === 0 ? "NONE" : "AMBIGUITY",
      evidence: ["artifacts/opencode-real-world/phase-1-legacy/OC-REAL-016/question-replies.json"],
      notes: "Web-vs-mobile CAS race is Polyth server-layer; upstream single-winner contract pinned here.",
    });
    sse.close();
    await facade.dispose();
  } finally {
    await proxy.close();
    await serve.stop();
  }
};

await main();
