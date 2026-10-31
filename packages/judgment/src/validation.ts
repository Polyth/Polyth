import type { JudgmentLimits, JudgmentQuestionMap, JudgmentRequest, ProviderJudgmentResponse } from "./types.ts";
import { JudgmentExecutionError } from "./errors.ts";

const encoder = new TextEncoder();
export const byteLength = (value: string): number => encoder.encode(value).byteLength;
const bad = (response = false): never => { throw new JudgmentExecutionError(response ? "invalid-response" : "invalid-request"); };
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
export const safeId = (value: unknown): value is string => typeof value === "string"
  && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value) && !["__proto__", "prototype", "constructor"].includes(value);
/** Correlation ids are opaque host ids (UUIDs may start with a digit). */
const correlationId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);

/** Reject lossy JSON (including getters/toJSON), cycles and excessive traversal before serialization. */
export function boundedJson(value: unknown, maxBytes: number): string {
  let remaining = maxBytes;
  const path = new Set<object>();
  const visit = (node: unknown, depth: number): void => {
    if (--remaining < 0 || depth > 64) bad();
    if (node === null || typeof node === "boolean") return;
    if (typeof node === "number") { if (!Number.isFinite(node)) bad(); return; }
    if (typeof node === "string") { remaining -= byteLength(node); if (remaining < 0) bad(); return; }
    if (!Array.isArray(node) && !record(node)) bad();
    const object = node as object;
    if (path.has(object)) bad();
    path.add(object);
    const keys = Reflect.ownKeys(object);
    if (Array.isArray(node) && keys.length !== node.length + 1) bad();
    for (const key of keys) {
      if (Array.isArray(node) && key === "length") continue;
      if (typeof key !== "string") bad();
      if (Array.isArray(node) && (!/^(0|[1-9]\d*)$/.test(key as string) || Number(key) >= node.length)) bad();
      const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) bad();
      if (!Array.isArray(node)) remaining -= byteLength(key as string);
      visit(descriptor.value, depth + 1);
    }
    path.delete(object);
  };
  visit(value, 0);
  const json = JSON.stringify(value);
  if (byteLength(json) > maxBytes) bad();
  return json;
}

export function validateRequest<Q extends JudgmentQuestionMap>(request: JudgmentRequest<Q>, limits: JudgmentLimits) {
  if (!record(request) || !safeId(request.scope) || !record(request.questions)) bad();
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) bad();
  if (request.target !== undefined && (!record(request.target) || Object.entries(request.target)
    .some(([key, value]) => !["engineId", "providerId", "modelId"].includes(key) || typeof value !== "string" || !value.trim() || value.length > 200))) bad();
  if (request.budget !== undefined && (!record(request.budget) || Object.entries(request.budget)
    .some(([key, value]) => !["maxCalls", "maxInputBytes", "maxWallClockMs"].includes(key)
      || !Number.isSafeInteger(value) || (value as number) < 0))) bad();
  if (request.metadata !== undefined && (!record(request.metadata) || Object.entries(request.metadata)
    .some(([key, value]) => !["projectId", "sessionId", "turnId", "workflowId", "agentId"].includes(key) || !correlationId(value)))) bad();
  const entries = Object.entries(request.questions);
  if (!entries.length || entries.length > limits.maxQuestionsPerCall) bad();
  for (const [id, q] of entries) {
    if (!safeId(id) || !record(q) || typeof q.instructions !== "string" || !q.instructions.trim()) bad();
    if (q.type === "choice") {
      if (!record(q.criteria) || Object.keys(q.criteria).length < 2
        || Object.entries(q.criteria).some(([label, text]) => !safeId(label) || typeof text !== "string" || !text.trim())) bad();
    } else if (q.type === "score") {
      if (!Array.isArray(q.rubric) || q.rubric.length < 2 || q.rubric.some((text) => typeof text !== "string" || !text.trim())) bad();
    } else if (q.type !== "noul") bad();
    const allowed = q.type === "noul" ? ["type", "instructions"] : q.type === "choice" ? ["type", "instructions", "criteria"] : ["type", "instructions", "rubric"];
    if (Object.keys(q).some((key) => !allowed.includes(key))) bad();
    boundedJson(q, limits.maxQuestionBytes);
  }
  const state = boundedJson(request.state, limits.maxStateBytes);
  const questions = boundedJson(request.questions, limits.maxRequestBytes);
  const payload = boundedJson({ scope: request.scope, state: JSON.parse(state), questions: JSON.parse(questions), target: request.target ?? {} }, limits.maxRequestBytes);
  return { state: JSON.parse(state), questions: JSON.parse(questions) as Q, stateBytes: byteLength(state), requestBytes: byteLength(payload) };
}

const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const sameKeys = (a: object, b: object): boolean => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => Object.hasOwn(b, key));
const distribution = (values: unknown[]): boolean => values.every(probability) && Math.abs((values as number[]).reduce((a, b) => a + b, 0) - 1) <= 0.01;
export function validateResponse(questions: JudgmentQuestionMap, response: ProviderJudgmentResponse): ProviderJudgmentResponse {
  if (!record(response) || !record(response.answers) || !sameKeys(questions, response.answers)) bad(true);
  for (const [id, question] of Object.entries(questions)) {
    const answer = response.answers[id]!;
    if (!record(answer) || answer.type !== question.type || !probability(answer.confidence)) bad(true);
    if (question.type === "noul") {
      if (answer!.type !== "noul" || !probability(answer.probability)) bad(true);
    } else if (question.type === "choice") {
      if (answer!.type !== "choice" || typeof answer.value !== "string" || !Object.hasOwn(question.criteria, answer.value)
        || !record(answer.probabilities) || !sameKeys(question.criteria, answer.probabilities)
        || !distribution(Object.values(answer.probabilities))) bad(true);
    } else {
      if (answer!.type !== "score" || !Number.isFinite(answer.score) || answer.score < 0
        || answer.score > question.rubric.length - 1 || answer.levelCount !== question.rubric.length) bad(true);
      if (answer!.type === "score" && answer.probabilities !== undefined
        && (!Array.isArray(answer.probabilities) || answer.probabilities.length !== question.rubric.length || !distribution([...answer.probabilities]))) bad(true);
    }
  }
  if (response.model !== undefined && (!record(response.model) || Object.entries(response.model)
    .some(([key, value]) => !["providerId", "modelId"].includes(key) || typeof value !== "string" || !value.trim() || value.length > 200))) bad(true);
  if (response.usage !== undefined && (!record(response.usage) || Object.entries(response.usage)
    .some(([key, value]) => !["inputTokens", "outputTokens", "cost"].includes(key)
      || typeof value !== "number" || !Number.isFinite(value) || value < 0 || (key !== "cost" && !Number.isSafeInteger(value))))) bad(true);
  // Copy only canonical fields: providers cannot smuggle raw responses or credentials into a result.
  const answers = Object.fromEntries(Object.entries(response.answers).map(([id, a]) => [id,
    a.type === "noul" ? { type: a.type, probability: a.probability, confidence: a.confidence }
      : a.type === "choice" ? { type: a.type, value: a.value, confidence: a.confidence, probabilities: { ...a.probabilities } }
        : { type: a.type, score: a.score, confidence: a.confidence, levelCount: a.levelCount,
          ...(a.probabilities === undefined ? {} : { probabilities: [...a.probabilities] }) },
  ]));
  return { answers, model: response.model ? { ...response.model } : undefined, usage: response.usage ? { ...response.usage } : undefined };
}
