import { createJudgmentBudget, type JudgmentBudgetPool } from "./budget.ts";
import { createJudgmentConcurrency, type JudgmentConcurrency } from "./concurrency.ts";
import { resolveLimits, resolveTarget } from "./config.ts";
import { createDeadline, interruptible, retryDelay } from "./deadline.ts";
import { JudgmentEngineRegistry } from "./engineRegistry.ts";
import { JudgmentExecutionError } from "./errors.ts";
import { questionSetId } from "./fingerprint.ts";
import { boundedJson, validateRequest, validateResponse } from "./validation.ts";
import type {
  InferJudgmentAnswers, JudgmentConfig, JudgmentEngineAdapter, JudgmentLimits, JudgmentObservation,
  JudgmentQuestionMap, JudgmentRequest, JudgmentResult, JudgmentRuntime, JudgmentTarget, JudgmentUsage,
} from "./types.ts";

export interface JudgmentRuntimeOptions {
  engines?: readonly JudgmentEngineAdapter[];
  registry?: JudgmentEngineRegistry;
  global?: Partial<JudgmentConfig>;
  project?: Partial<JudgmentConfig>;
  limits?: Partial<JudgmentLimits>;
  budget?: JudgmentBudgetPool;
  concurrency?: JudgmentConcurrency;
  observe?: (observation: JudgmentObservation) => void;
  /** Evidence minimization hook. The returned state is validated and bounded again. */
  redactState?: (state: JudgmentRequest<JudgmentQuestionMap>["state"]) => JudgmentRequest<JudgmentQuestionMap>["state"];
}

/** One runtime is one bounded run. Reuse its budget pool to share reservations across runs. */
export function createJudgmentRuntime(options: JudgmentRuntimeOptions = {}): JudgmentRuntime {
  const registry = options.registry ?? new JudgmentEngineRegistry();
  for (const engine of options.engines ?? []) registry.register(engine);
  const global = structuredClone(options.global ?? {}), project = structuredClone(options.project ?? {});
  const limits = resolveLimits(options.limits, global.limits, project.limits);
  const runBudget = createJudgmentBudget({ maxCalls: limits.maxCallsPerRun,
    maxInputBytes: limits.maxRequestBytes * limits.maxCallsPerRun, maxWallClockMs: limits.timeoutMs * limits.maxCallsPerRun });
  const concurrency = createJudgmentConcurrency(limits.maxConcurrentCalls);
  const lifetime = new AbortController();

  return {
    dispose: () => lifetime.abort(),
    async judge<const Q extends JudgmentQuestionMap>(input: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      const startedAt = Date.now(), started = performance.now();
      let attempts = 0, questionCount = 0, stateBytes = 0, requestBytes = 0, fingerprint = "unvalidated";
      let scope = "invalid", target: JudgmentTarget = {}, metadata = {}, usage: JudgmentUsage | undefined;
      let deadline: ReturnType<typeof createDeadline> | undefined;
      const timing = () => ({ startedAt, completedAt: Date.now(), durationMs: Math.max(0, performance.now() - started) });
      const finish = (result: JudgmentResult<Q>): JudgmentResult<Q> => {
        const observation: JudgmentObservation = {
          timestamp: result.timing.completedAt, scope, engineId: target.engineId ?? "unresolved",
          providerId: result.ok ? result.model?.providerId : target.providerId,
          modelId: result.ok ? result.model?.modelId : target.modelId,
          ...metadata, questionSetId: fingerprint, questionCount, stateBytes, requestBytes,
          durationMs: result.timing.durationMs, attempts, status: result.ok ? "success" : result.reason,
          inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, actualCost: usage?.cost,
        };
        try { void Promise.resolve(options.observe?.(observation)).catch(() => {}); } catch { /* Observability cannot change evidence. */ }
        return result;
      };
      try {
        const validated = validateRequest(input, limits);
        const requestedBudget = { ...input.budget };
        const request = { ...input, target: input.target ? { ...input.target } : undefined,
          budget: input.budget ? requestedBudget : undefined, metadata: input.metadata ? { ...input.metadata } : undefined };
        scope = input.scope;
        metadata = { ...input.metadata };
        stateBytes = validated.stateBytes;
        requestBytes = validated.requestBytes;
        questionCount = Object.keys(validated.questions).length;
        if (lifetime.signal.aborted || request.signal?.aborted) throw new JudgmentExecutionError("cancelled");
        target = resolveTarget({ defaults: { engineId: registry.defaultId() }, global, project, scope, target: request.target });
        // A configured limit wins; otherwise a slower engine (a harness model) brings its own call timeout.
        const configuredTimeout = [options.limits, global.limits, project.limits].some((layer) => layer?.timeoutMs !== undefined);
        const engineTimeout = configuredTimeout ? undefined : registry.get(target.engineId ?? "")?.capabilities().timeoutMs;
        const callTimeout = Number.isSafeInteger(engineTimeout) && engineTimeout! > 0 ? engineTimeout! : limits.timeoutMs;
        const timeoutMs = Math.min(callTimeout, requestedBudget.maxWallClockMs ?? callTimeout);
        if (timeoutMs <= 0) throw new JudgmentExecutionError("budget-exhausted");
        deadline = createDeadline(Math.max(1, timeoutMs - (performance.now() - started)), [request.signal, lifetime.signal]);
        const deadlineAt = startedAt + timeoutMs;
        fingerprint = await interruptible(questionSetId(scope, validated.questions), deadline.signal);
        if ((project.enabled ?? global.enabled ?? true) === false) throw new JudgmentExecutionError("disabled");
        const engine = registry.get(target.engineId ?? "");
        if (!engine) throw new JudgmentExecutionError("engine-unavailable");
        const capabilities = engine.capabilities();
        target = resolveTarget({ defaults: { engineId: registry.defaultId() }, global, project, scope, target: request.target,
          engineDefaults: capabilities.defaults, defaultModels: capabilities.defaultModels });
        if (!target.providerId) throw new JudgmentExecutionError("provider-unavailable");
        // An unknown provider is reported as such, even though it also has no model.
        if (!target.modelId) throw new JudgmentExecutionError(engine.availability({ ...target, modelId: "" } as Required<JudgmentTarget>) === "provider-unavailable"
          ? "provider-unavailable" : "model-unavailable");
        const resolved = target as Required<JudgmentTarget>;
        const unavailable = engine.availability(resolved);
        if (unavailable) throw new JudgmentExecutionError(unavailable);
        if (Object.values(validated.questions).some((q) => !capabilities.questionTypes.includes(q.type))) throw new JudgmentExecutionError("invalid-request");
        const state = options.redactState ? options.redactState(validated.state) : validated.state;
        const prepared = validateRequest({ ...request, state, questions: validated.questions, target: resolved }, limits);
        stateBytes = prepared.stateBytes; requestBytes = prepared.requestBytes;
        const callBudget = createJudgmentBudget({ maxCalls: Math.min(requestedBudget.maxCalls ?? limits.maxRetries + 1, limits.maxRetries + 1),
          maxInputBytes: requestedBudget.maxInputBytes ?? limits.maxRequestBytes * (limits.maxRetries + 1), maxWallClockMs: timeoutMs });
        for (let attempt = 0; attempt <= limits.maxRetries; attempt++) {
          if (deadline.signal.aborted) throw new JudgmentExecutionError(deadline.reason());
          const remaining = Math.max(0, timeoutMs - (performance.now() - started));
          if (remaining <= 0) throw new JudgmentExecutionError("timeout");
          // Reserve before queuing or execution. A failed reservation never reaches the adapter.
          const reservations: ReturnType<JudgmentBudgetPool["reserve"]>[] = [];
          let releaseLocal: (() => void) | undefined, releaseShared: (() => void) | undefined;
          let handedOff = false;
          try {
            for (const pool of [callBudget, runBudget, options.budget]) {
              if (pool) reservations.push(pool.reserve(requestBytes, remaining));
            }
            releaseLocal = await concurrency.acquire(deadline.signal);
            if (options.concurrency) releaseShared = await options.concurrency.acquire(deadline.signal);
            if (performance.now() - started >= timeoutMs) deadline.expire();
            if (deadline.signal.aborted) throw new JudgmentExecutionError(deadline.reason());
            const attemptStarted = performance.now();
            attempts++;
            const promise = Promise.resolve().then(() => engine.judge(structuredClone({ scope, state: prepared.state,
              questions: prepared.questions, target: resolved }), { signal: deadline!.signal, deadlineAt, attempt: attempts }));
            const settle = () => {
              releaseShared?.(); releaseLocal?.();
              reservations.forEach((reservation) => reservation.release(performance.now() - attemptStarted));
            };
            handedOff = true;
            // Keep the physical concurrency slot and wall reservation for an adapter that ignores abort.
            void promise.then(settle, settle);
            try {
              const raw = await interruptible(promise, deadline.signal);
              if (performance.now() - started >= timeoutMs) deadline.expire();
              if (deadline.signal.aborted) throw new JudgmentExecutionError(deadline.reason());
              // Validate a bounded, detached response before reading its normalized fields.
              let response;
              try { response = JSON.parse(boundedJson(raw, limits.maxRequestBytes)); }
              catch { throw new JudgmentExecutionError("invalid-response"); }
              const normalized = validateResponse(prepared.questions, response);
              if (performance.now() - started >= timeoutMs) deadline.expire();
              if (deadline.signal.aborted) throw new JudgmentExecutionError(deadline.reason());
              usage = normalized.usage;
              if (normalized.model?.providerId && normalized.model.providerId !== resolved.providerId) throw new JudgmentExecutionError("invalid-response");
              return finish({ ok: true, answers: normalized.answers as InferJudgmentAnswers<Q>, engine: { id: engine.id },
                model: { providerId: resolved.providerId, modelId: normalized.model?.modelId ?? resolved.modelId },
                usage, timing: timing(), attempts });
            } catch (error) {
              const failure = error instanceof JudgmentExecutionError ? error : new JudgmentExecutionError("provider-error");
              if (deadline.signal.aborted || !failure.retryable || attempt === limits.maxRetries) throw failure;
              await retryDelay(Math.min(100 * 2 ** attempt, 1_000), deadline.signal);
            }
          } finally {
            if (!handedOff) {
              releaseShared?.(); releaseLocal?.();
              reservations.forEach((reservation) => reservation.cancel());
            }
          }
        }
        throw new JudgmentExecutionError("provider-error");
      } catch (error) {
        const failure = deadline?.signal.aborted ? new JudgmentExecutionError(deadline.reason())
          : error instanceof JudgmentExecutionError ? error : new JudgmentExecutionError("provider-error");
        return finish({ ok: false, reason: failure.reason, retryable: failure.retryable, timing: timing(), attempts });
      } finally { deadline?.dispose(); }
    },
  };
}
