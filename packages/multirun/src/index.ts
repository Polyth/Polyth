// Multirun workflow plugin: sends one prompt to N model backends in parallel
// and tracks each run's status/output/tokens/cost. The plugin never talks to
// a backend itself — deps.runOne is injected by the server, which owns the
// AgentRuntime pool (only packages/backend-opencode may talk to opencode).
// Pure logic + injected effects, same shape as packages/goals.
import { randomUUID } from "node:crypto";
import type {
  JsonObject,
  ModelRef,
  MultirunDto,
  MultirunRunDto,
  MultirunRunStatus,
} from "@polyth/contracts";

export interface MultirunRunSpec { model?: ModelRef; agent?: string }
export interface StartMultirunInput { text: string; runs: MultirunRunSpec[] }

export interface MultirunState {
  id: string;
  sessionId: string;
  prompt: string;
  runs: MultirunRunDto[];
  pickedRunId?: string;
  createdAt: number;
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
  now?: () => number;
}

export interface MultirunService {
  start(sessionId: string, input: StartMultirunInput): Promise<{ id: string }>;
  get(multirunId: string): MultirunState | null;
  pick(multirunId: string, runId: string): Promise<void>;
  snapshot(state: MultirunState): MultirunDto;
}

export function snapshot(state: MultirunState): MultirunDto {
  return {
    id: state.id,
    prompt: state.prompt,
    runs: state.runs.map((r) => ({ ...r })),
    ...(state.pickedRunId ? { pickedRunId: state.pickedRunId } : {}),
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
    } as unknown as JsonObject);
  };

  const settle = (r: MultirunRunStatus): boolean => r === "completed" || r === "failed";

  const executeRun = async (state: MultirunState, run: MultirunRunDto): Promise<void> => {
    run.status = "running";
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
    await emitProgress(state, run);
    // Every run's own finalization checks the shared state, so two runs
    // settling in the same microtask window must not double-fire; the
    // check-then-add below is synchronous (no await between them).
    if (!completedMultiruns.has(state.id) && state.runs.every((r) => settle(r.status))) {
      completedMultiruns.add(state.id);
      await deps.append(state.sessionId, "multirun/completed", { multirunId: state.id });
    }
  };

  return {
    async start(sessionId, input) {
      const text = input.text.trim();
      if (!text) throw new Error("multirun prompt is empty");
      if (!input.runs.length) throw new Error("multirun needs at least one run");
      const id = randomUUID();
      const runs: MultirunRunDto[] = input.runs.map((r) => ({
        id: randomUUID(), model: r.model, agent: r.agent, status: "pending", output: "",
      }));
      const state: MultirunState = { id, sessionId, prompt: text, runs, createdAt: now() };
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
