import { Worker } from "node:worker_threads";
import {
  JudgmentExecutionError, type JudgmentEngineAdapter, type JudgmentEngineMetadata,
  type JudgmentQuestionMap, type JudgmentState, type ProviderJudgmentResponse,
} from "@polyth/judgment";

export const LOCAL_ENGINE_METADATA: JudgmentEngineMetadata = Object.freeze({
  id: "local", name: "Local models", recommended: false,
  description: "TinyDecide-format decision models running inside the Polyth server. Evidence never leaves it.",
});
export const LOCAL_PROVIDER = Object.freeze({ id: "local", name: "This server" });

/** Native shapes of the pinned TinyDecide engine (`tinydecide.d.ts`), minus correction vectors. */
export type NativeQuestion = { type: "noul"; text: string } | { type: "choice" | "score"; text: string; options: string[] };
export type NativeAnswer = { type: "noul"; p: number }
  | { type: "choice" | "score"; probs: number[]; pick: number; confidence: number; score?: number };
export interface NativeResult { answers: NativeAnswer[]; truncated: boolean; tokens: { total: number } }

export interface LocalModelFiles { engineSource: string; meta: unknown; weights: ArrayBuffer }
export interface LocalModelRunner {
  answer(request: { state: string; questions: NativeQuestion[] }, signal: AbortSignal): Promise<NativeResult>;
  close(): void;
}

// Appended to the hash-verified engine module. The engine has no imports; it is pure CPU work.
const WORKER_HANDLER = `
import { parentPort, workerData } from "node:worker_threads";
let model;
try { model = new TinyDecide(workerData.meta, workerData.weights); } catch {}
parentPort.on("message", ({ id, request }) => {
  if (!model) return parentPort.postMessage({ id, ok: false, load: true });
  try {
    const r = model.answer(request);
    parentPort.postMessage({ id, ok: true, value: { truncated: r.truncated, tokens: r.tokens,
      answers: r.answers.map((a) => a.type === "noul" ? { type: a.type, p: a.p }
        : { type: a.type, probs: a.probs, pick: a.pick, confidence: a.confidence, score: a.score }) } });
  } catch { parentPort.postMessage({ id, ok: false }); }
});`;

/**
 * One worker thread per loaded model: a ~1 s synchronous forward pass must not block the server's
 * event loop. Abort terminates the worker, which is the only way to stop a running pass.
 */
export function startLocalRunner(files: LocalModelFiles, onExit: () => void): LocalModelRunner {
  const source = files.engineSource + WORKER_HANDLER;
  const worker = new Worker(new URL(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`), {
    workerData: { meta: files.meta, weights: files.weights }, transferList: [files.weights],
    resourceLimits: { maxOldGenerationSizeMb: 512 },
  });
  worker.unref();
  const pending = new Map<number, { resolve: (value: NativeResult) => void; reject: (error: unknown) => void }>();
  let next = 0, exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    // Queued requests lost their worker, not their validity: the core may retry them.
    for (const entry of pending.values()) entry.reject(new JudgmentExecutionError("provider-error", true));
    pending.clear();
    onExit();
  };
  worker.on("message", (message: { id: number; ok: boolean; load?: boolean; value?: NativeResult }) => {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    // A model that cannot load is dropped, so fixed files load on the next request.
    if (message.load) void worker.terminate();
    if (message.ok) entry.resolve(message.value!);
    // The engine throws on requests it cannot represent (too many options, empty text); a load failure is a bad model.
    else entry.reject(new JudgmentExecutionError(message.load ? "model-unavailable" : "invalid-request"));
  });
  worker.on("error", exit);
  worker.on("exit", exit);
  return {
    answer(request, signal) {
      if (exited) return Promise.reject(new JudgmentExecutionError("provider-error", true));
      if (signal.aborted) return Promise.reject(new JudgmentExecutionError("cancelled"));
      const id = ++next;
      return new Promise<NativeResult>((resolve, reject) => {
        const onAbort = () => {
          pending.delete(id);
          reject(new JudgmentExecutionError("cancelled"));
          void worker.terminate();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        const done = <T,>(settle: (value: T) => void) => (value: T) => { signal.removeEventListener("abort", onAbort); settle(value); };
        pending.set(id, { resolve: done(resolve), reject: done(reject) });
        worker.postMessage({ id, request });
      });
    },
    close() { void worker.terminate(); },
  };
}

export function toNativeQuestions(questions: JudgmentQuestionMap): NativeQuestion[] {
  return Object.values(questions).map((q) => q.type === "noul" ? { type: "noul", text: q.instructions }
    : q.type === "choice" ? { type: "choice", text: q.instructions, options: Object.values(q.criteria) }
      : { type: "score", text: q.instructions, options: [...q.rubric] });
}
export const toNativeState = (state: JudgmentState): string => typeof state === "string" ? state : JSON.stringify(state);

const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

export function fromNative(native: NativeResult, questions: JudgmentQuestionMap, modelId: string): ProviderJudgmentResponse {
  // The model reads only the first 127 tokens. An answer about cut evidence is not evidence.
  if (native.truncated) throw new JudgmentExecutionError("invalid-request");
  const entries = Object.entries(questions);
  if (!Array.isArray(native.answers) || native.answers.length !== entries.length) throw new JudgmentExecutionError("invalid-response");
  const answers: ProviderJudgmentResponse["answers"] = {};
  entries.forEach(([id, q], index) => {
    const a = native.answers[index]!;
    if (a.type !== q.type) throw new JudgmentExecutionError("invalid-response");
    if (a.type === "noul") {
      if (!probability(a.p)) throw new JudgmentExecutionError("invalid-response");
      // Native noul has no separate confidence: the probability of the more likely polarity, as for Jev.
      answers[id] = { type: "noul", probability: a.p, confidence: Math.max(a.p, 1 - a.p) };
      return;
    }
    const levels = q.type === "choice" ? Object.keys(q.criteria) : q.type === "score" ? q.rubric : [];
    if (a.probs.length !== levels.length || !a.probs.every(probability) || !probability(a.confidence)) throw new JudgmentExecutionError("invalid-response");
    if (q.type === "choice") {
      const labels = levels as string[];
      if (!Number.isInteger(a.pick) || !labels[a.pick]) throw new JudgmentExecutionError("invalid-response");
      answers[id] = { type: "choice", value: labels[a.pick]!, confidence: a.confidence,
        probabilities: Object.fromEntries(labels.map((label, i) => [label, a.probs[i]!])) };
    } else {
      if (!probability(a.score)) throw new JudgmentExecutionError("invalid-response");
      // Native score is 0 = first level, 1 = last; Judgment's is the continuous level index.
      answers[id] = { type: "score", score: a.score * (levels.length - 1), confidence: a.confidence,
        probabilities: [...a.probs], levelCount: levels.length };
    }
  });
  return { answers, model: { providerId: LOCAL_PROVIDER.id, modelId }, usage: { inputTokens: native.tokens.total, outputTokens: 0 } };
}

export interface LocalEngineOptions {
  /** Installed and installable model IDs; the first is the automatic default. */
  models: () => string[];
  /** Resolves a runner for the model, installing a pinned preset on first use. */
  runner: (modelId: string, signal: AbortSignal) => Promise<LocalModelRunner>;
}

export function createLocalJudgmentEngine(options: LocalEngineOptions): JudgmentEngineAdapter {
  const availability: JudgmentEngineAdapter["availability"] = (target) => target.providerId !== LOCAL_PROVIDER.id
    ? "provider-unavailable" : !options.models().includes(target.modelId) ? "model-unavailable" : undefined;
  return {
    id: LOCAL_ENGINE_METADATA.id, metadata: LOCAL_ENGINE_METADATA,
    capabilities: () => {
      const modelId = options.models()[0];
      return { questionTypes: ["noul", "choice", "score"], defaults: { providerId: LOCAL_PROVIDER.id, modelId },
        ...(modelId ? { defaultModels: { [LOCAL_PROVIDER.id]: modelId } } : {}) };
    },
    availability,
    async judge(request, context) {
      const unavailable = availability(request.target);
      if (unavailable) throw new JudgmentExecutionError(unavailable);
      const runner = await options.runner(request.target.modelId, context.signal);
      const native = await runner.answer({ state: toNativeState(request.state), questions: toNativeQuestions(request.questions) }, context.signal);
      return fromNative(native, request.questions, request.target.modelId);
    },
  };
}
