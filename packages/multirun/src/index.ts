// Multirun workflow plugin: sends one prompt to N model backends in parallel
// and tracks each run's status/output/tokens/cost. The plugin never talks to
// a backend itself — deps.runOne is injected by the server, which owns the
// AgentRuntime pool (only packages/backend-opencode may talk to opencode).
// Pure logic + injected effects, same shape as packages/goals.
import { randomUUID } from "node:crypto";
import type {
  JsonObject,
  ModelRef,
  MultirunRunDto,
  MultirunRunStatus,
  SpaceContext,
} from "@polyth/contracts";
import type { RubricScoreOutcome } from "./scoring.ts";
import type { RubricAnswerRef, ScoredMultirunDto, ScoredMultirunRun } from "./rubric.ts";

export type { RubricScoreOutcome } from "./scoring.ts";
export type { RubricAnswerRef, ScoredMultirunDto, ScoredMultirunRun } from "./rubric.ts";

export interface MultirunRunSpec { model?: ModelRef; agent?: string }
export interface StartMultirunInput { text: string; runs: MultirunRunSpec[] }

/** Server-resolved tenancy for the scoring pass; absent in pure service tests. */
export interface MultirunStartContext { space?: SpaceContext }

/** Injected judge: scores the answers that exist after a Multirun settles. */
export type RubricScorer = (input: {
  sessionId: string;
  space?: SpaceContext;
  prompt: string;
  answers: RubricAnswerRef[];
}) => Promise<RubricScoreOutcome[]>;

export interface MultirunState {
  id: string;
  sessionId: string;
  prompt: string;
  runs: ScoredMultirunRun[];
  pickedRunId?: string;
  createdAt: number;
  /** True while the bounded rubric scoring pass is still running. */
  scoring?: boolean;
  space?: SpaceContext;
}

export type RunUpdate = Partial<Pick<MultirunRunDto, "status" | "output" | "tokens" | "cost" | "error">>;

/** Executes one run of the prompt against one model backend. Must resolve once
 *  the run reaches a terminal state; progress is reported via onUpdate. */
export type RunOneFn = (
  ctx: { sessionId: string; multirunId: string; runId: string; prompt: string; model?: ModelRef; agent?: string },
  onUpdate: (patch: RunUpdate) => void,
) => Promise<void>;

export interface MultirunDeps {
  append: (sessionId: string, type: string, data: JsonObject) => Promise<unknown>;
  runOne: RunOneFn;
  /** Absent when Judgment/Multirun scoring is not wired; scoring is then skipped. */
  scoreAnswers?: RubricScorer;
  now?: () => number;
}

export interface MultirunService {
  start(sessionId: string, input: StartMultirunInput, ctx?: MultirunStartContext): Promise<{ id: string }>;
  get(multirunId: string): MultirunState | null;
  pick(multirunId: string, runId: string): Promise<void>;
  snapshot(state: MultirunState): ScoredMultirunDto;
}

export function snapshot(state: MultirunState): ScoredMultirunDto {
  return {
    id: state.id,
    prompt: state.prompt,
    runs: state.runs.map((r) => ({ ...r })),
    ...(state.pickedRunId ? { pickedRunId: state.pickedRunId } : {}),
    ...(state.scoring ? { scoring: true } : {}),
  };
}

export function createMultirunService(deps: MultirunDeps): MultirunService {
  const now = deps.now ?? (() => Date.now());
  const multiruns = new Map<string, MultirunState>();
  const completedMultiruns = new Set<string>();

  const emitProgress = async (state: MultirunState, run: MultirunRunDto) => {
    await deps.append(state.sessionId, "multirun/run-progress", {
      multirunId: state.id,
      runId: run.id,
      status: run.status,
      output: run.output,
      tokens: run.tokens as unknown as JsonObject | undefined,
      cost: run.cost,
      error: run.error,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    } as unknown as JsonObject);
  };

  const settle = (r: MultirunRunStatus): boolean => r === "completed" || r === "failed";

  const emitScored = async (state: MultirunState, run: ScoredMultirunRun, outcome: RubricScoreOutcome) => {
    if (outcome.score !== undefined && outcome.levels !== undefined && outcome.confidence !== undefined) {
      await deps.append(state.sessionId, "multirun/run-scored", {
        multirunId: state.id,
        runId: run.id,
        status: "scored",
        score: outcome.score,
        levels: outcome.levels,
        confidence: outcome.confidence,
        ...(outcome.fusionTopK !== undefined ? { fusionTopK: outcome.fusionTopK } : {}),
        model: run.model as unknown as JsonObject | undefined,
      } as unknown as JsonObject);
    } else if (outcome.note) {
      await deps.append(state.sessionId, "multirun/run-scored", {
        multirunId: state.id,
        runId: run.id,
        status: "skipped",
        note: outcome.note.slice(0, 300),
        model: run.model as unknown as JsonObject | undefined,
      } as unknown as JsonObject);
    }
  };

  /** Bounded rubric pass: no scorer, disabled Judgment, failure or an invalid
   *  rubric all leave the runs exactly as today (no score, no error). */
  const applyRubricScores = async (state: MultirunState): Promise<void> => {
    const scorer = deps.scoreAnswers;
    if (!scorer) return;
    const candidates = state.runs.filter((r) => r.status === "completed" && r.output.trim().length > 0);
    if (!candidates.length) return;
    let outcomes: RubricScoreOutcome[];
    try {
      outcomes = await scorer({
        sessionId: state.sessionId,
        ...(state.space ? { space: state.space } : {}),
        prompt: state.prompt,
        answers: candidates.map((r) => ({ runId: r.id, ...(r.model ? { model: r.model } : {}), output: r.output })),
      });
    } catch {
      return;
    }
    const byRun = new Map(outcomes.map((outcome) => [outcome.runId, outcome]));
    for (const run of state.runs) {
      const outcome = byRun.get(run.id);
      if (!outcome) continue;
      if (outcome.score !== undefined && outcome.levels !== undefined && outcome.confidence !== undefined) {
        run.score = outcome.score;
        run.scoreLevels = outcome.levels;
        run.scoreConfidence = outcome.confidence;
      } else if (outcome.note) {
        run.scoreNote = outcome.note;
      } else {
        continue;
      }
      await emitScored(state, run, outcome);
    }
  };

  const executeRun = async (state: MultirunState, run: MultirunRunDto): Promise<void> => {
    run.status = "running";
    run.startedAt = now();
    await emitProgress(state, run);
    try {
      await deps.runOne(
        { sessionId: state.sessionId, multirunId: state.id, runId: run.id, prompt: state.prompt, model: run.model, agent: run.agent },
        (patch) => {
          Object.assign(run, patch);
          void emitProgress(state, run);
        },
      );
      if (!settle(run.status)) run.status = "completed";
    } catch (err) {
      run.status = "failed";
      run.error = String(err instanceof Error ? err.message : err).slice(0, 300);
    }
    run.finishedAt = now();
    await emitProgress(state, run);
    // Every run's own finalization checks the shared state, so two runs
    // settling in the same microtask window must not double-fire; the
    // check-then-add below is synchronous (no await between them).
    if (!completedMultiruns.has(state.id) && state.runs.every((r) => settle(r.status))) {
      completedMultiruns.add(state.id);
      try {
        await applyRubricScores(state);
      } catch {
        // Scoring evidence is additive; a write failure must not block completion.
      }
      if (deps.scoreAnswers) state.scoring = false;
      await deps.append(state.sessionId, "multirun/completed", { multirunId: state.id });
    }
  };

  return {
    async start(sessionId, input, ctx) {
      const text = input.text.trim();
      if (!text) throw new Error("multirun prompt is empty");
      if (!input.runs.length) throw new Error("multirun needs at least one run");
      const id = randomUUID();
      const runs: ScoredMultirunRun[] = input.runs.map((r) => ({
        id: randomUUID(), model: r.model, agent: r.agent, status: "pending", output: "",
      }));
      const state: MultirunState = {
        id, sessionId, prompt: text, runs, createdAt: now(),
        ...(deps.scoreAnswers ? { scoring: true } : {}),
        ...(ctx?.space ? { space: ctx.space } : {}),
      };
      multiruns.set(id, state);
      await deps.append(sessionId, "multirun/started", {
        multirunId: id,
        prompt: text,
        runs: runs.map((r) => ({ runId: r.id, model: r.model as unknown as JsonObject, agent: r.agent })),
      } as unknown as JsonObject);
      void Promise.allSettled(runs.map((r) => executeRun(state, r)));
      return { id };
    },

    get(multirunId) {
      return multiruns.get(multirunId) ?? null;
    },

    async pick(multirunId, runId) {
      const state = multiruns.get(multirunId);
      if (!state) throw Object.assign(new Error("multirun not found"), { code: "not-found" });
      if (!state.runs.some((r) => r.id === runId)) {
        throw Object.assign(new Error("run not found"), { code: "not-found" });
      }
      state.pickedRunId = runId;
      await deps.append(state.sessionId, "multirun/picked", { multirunId, runId });
    },

    snapshot,
  };
}
