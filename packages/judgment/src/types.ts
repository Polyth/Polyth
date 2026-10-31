import type { JudgmentUseConfig } from "./uses.ts";
export type JudgmentState = null | boolean | number | string | JudgmentState[] | { [key: string]: JudgmentState };

export interface NoulQuestion { readonly type: "noul"; readonly instructions: string }
export interface ChoiceQuestion<T extends string = string> {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<T, string>>;
}
export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: string;
  readonly rubric: readonly string[];
}
export type JudgmentQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type JudgmentQuestionMap = Readonly<Record<string, JudgmentQuestion>>;
export interface NoulAnswer { type: "noul"; probability: number; confidence: number }
export interface ChoiceAnswer<T extends string = string> {
  type: "choice";
  value: T;
  confidence: number;
  probabilities: Record<T, number>;
}
export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  probabilities?: readonly number[];
  levelCount: number;
}
export type JudgmentAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type InferJudgmentAnswers<Q> = {
  -readonly [K in keyof Q]: Q[K] extends ChoiceQuestion<infer T> ? ChoiceAnswer<T>
    : Q[K] extends NoulQuestion ? NoulAnswer : Q[K] extends ScoreQuestion ? ScoreAnswer : never;
};
export interface JudgmentTarget { engineId?: string; providerId?: string; modelId?: string }
export interface JudgmentBudget { maxCalls: number; maxInputBytes: number; maxWallClockMs: number }
export interface JudgmentLimits {
  maxQuestionsPerCall: number;
  maxStateBytes: number;
  maxQuestionBytes: number;
  maxRequestBytes: number;
  maxCallsPerRun: number;
  maxConcurrentCalls: number;
  timeoutMs: number;
  maxRetries: number;
}
export interface JudgmentConfig extends JudgmentTarget {
  enabled: boolean;
  scopes?: Record<string, JudgmentTarget>;
  limits?: Pick<Partial<JudgmentLimits>, "timeoutMs" | "maxCallsPerRun" | "maxConcurrentCalls">;
  /** Per-use switch and parameters, keyed by use id. */
  uses?: Record<string, JudgmentUseConfig>;
}
export interface JudgmentMetadata {
  projectId?: string;
  sessionId?: string;
  turnId?: string;
  workflowId?: string;
  agentId?: string;
}
export interface JudgmentRequest<Q extends JudgmentQuestionMap> {
  scope: string;
  state: JudgmentState;
  questions: Q;
  signal?: AbortSignal;
  budget?: Partial<JudgmentBudget>;
  target?: JudgmentTarget;
  metadata?: JudgmentMetadata;
}
export type JudgmentFailureReason = "disabled" | "invalid-request" | "engine-unavailable"
  | "provider-unavailable" | "model-unavailable" | "provider-error" | "invalid-response"
  | "timeout" | "cancelled" | "budget-exhausted";
export interface JudgmentTiming { startedAt: number; completedAt: number; durationMs: number }
export interface JudgmentUsage { inputTokens?: number; outputTokens?: number; cost?: number }
export interface JudgmentSuccess<Q> {
  ok: true;
  answers: InferJudgmentAnswers<Q>;
  engine: { id: string };
  model?: { providerId?: string; modelId?: string };
  usage?: JudgmentUsage;
  timing: JudgmentTiming;
  attempts: number;
}
export interface JudgmentFailure {
  ok: false;
  reason: JudgmentFailureReason;
  retryable: boolean;
  message?: string;
  timing: JudgmentTiming;
  attempts: number;
}
export type JudgmentResult<Q> = JudgmentSuccess<Q> | JudgmentFailure;
export interface JudgmentEngineMetadata {
  id: string;
  name: string;
  recommended: boolean;
  experimental?: boolean;
  description?: string;
}
export interface JudgmentProviderCapabilities {
  questionTypes: readonly JudgmentQuestion["type"][];
  defaults?: Omit<JudgmentTarget, "engineId">;
  /** Default model per provider, used when a provider is chosen without a model. */
  defaultModels?: Readonly<Record<string, string>>;
  /** The engine's own call timeout, used when no `timeoutMs` limit is configured. */
  timeoutMs?: number;
}
export interface ProviderJudgmentRequest {
  scope: string;
  state: JudgmentState;
  questions: JudgmentQuestionMap;
  target: Required<JudgmentTarget>;
}
export interface ProviderJudgmentContext { signal: AbortSignal; deadlineAt: number; attempt: number }
export interface ProviderJudgmentResponse {
  answers: Record<string, JudgmentAnswer>;
  model?: { providerId?: string; modelId?: string };
  usage?: JudgmentUsage;
}
export interface JudgmentEngineAdapter {
  readonly id: string;
  readonly metadata: JudgmentEngineMetadata;
  capabilities(): JudgmentProviderCapabilities;
  /** Pure, local compatibility check. No credentials or network required. */
  availability(target: Required<JudgmentTarget>): "provider-unavailable" | "model-unavailable" | undefined;
  judge(request: ProviderJudgmentRequest, context: ProviderJudgmentContext): Promise<ProviderJudgmentResponse>;
}
export interface JudgmentObservation extends JudgmentMetadata {
  timestamp: number;
  scope: string;
  engineId: string;
  providerId?: string;
  modelId?: string;
  questionSetId: string;
  questionCount: number;
  stateBytes: number;
  requestBytes: number;
  durationMs: number;
  attempts: number;
  inputTokens?: number;
  outputTokens?: number;
  actualCost?: number;
  status: "success" | JudgmentFailureReason;
}
export interface JudgmentRuntime {
  judge<const Q extends JudgmentQuestionMap>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>>;
  dispose(): void;
}
