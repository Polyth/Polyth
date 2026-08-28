// Fusion workflow plugin: gathers N raw model answers to the same prompt, then
// asks a small model (POLYTH_SMALL_MODEL, wired by the server) to synthesize a
// single weighted answer plus attribution weights and a disagreements list.
// Same pure-logic + injected-effects shape as packages/goals' auditor.
import { randomUUID } from "node:crypto";
import type { FusionDto, FusionStatus, FusionWeightDto, JsonObject } from "@polyth/contracts";

export interface StartFusionInput { text: string; models: string[] }

export interface FusionState {
  id: string;
  sessionId: string;
  prompt: string;
  models: string[];
  status: FusionStatus;
  answer: string;
  weights: FusionWeightDto[];
  disagreements: string[];
  sources: ModelAnswer[];
  error?: string;
  createdAt: number;
}

export interface ModelAnswer { model: string; text: string }

export interface FusionDeps {
  append: (sessionId: string, type: string, data: JsonObject) => Promise<unknown>;
  /** Run the prompt against one model backend and return its raw text answer. */
  runModel: (ctx: { sessionId: string; fusionId: string; model: string; prompt: string }) => Promise<string>;
  /** One-shot cheap-model synthesis pass; sees the prompt and every model's answer. */
  synthesize: (ctx: { sessionId: string; fusionId: string; prompt: string; answers: ModelAnswer[] }) => Promise<string>;
  now?: () => number;
}

export interface FusionService {
  start(sessionId: string, input: StartFusionInput): Promise<{ id: string }>;
  get(fusionId: string): FusionState | null;
  snapshot(state: FusionState): FusionDto;
}

export const synthesisPrompt = (prompt: string, answers: ModelAnswer[]): string =>
  [
    "You fuse multiple model answers into ONE best answer. You see the original prompt and each model's reply.",
    "Write the strongest possible synthesized answer, drawing on whichever replies are most correct and complete.",
    "Then assign each model a 0..1 attribution weight for how much its reply shaped the synthesis (weights need not sum to 1; they will be normalized).",
    "List concrete disagreements between the replies (as short strings); an empty list means the replies agreed.",
    "",
    `<prompt>\n${prompt.slice(0, 4000)}\n</prompt>`,
    "",
    ...answers.map((a) => `<reply model="${a.model}">\n${a.text.slice(0, 6000)}\n</reply>`),
    "",
    'Answer with ONLY one JSON object: {"answer":"<synthesized answer>","weights":[{"model":"<name>","weight":0..1}],"disagreements":["<short string>", ...]}',
  ].join("\n");

const equalWeights = (models: string[]): FusionWeightDto[] =>
  models.map((model) => ({ model, weight: models.length ? 1 / models.length : 0 }));

const normalizeWeights = (raw: unknown, models: string[]): FusionWeightDto[] => {
  if (!Array.isArray(raw) || !raw.length) return equalWeights(models);
  const byModel = new Map<string, number>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const model = String((entry as { model?: unknown }).model ?? "");
    const weight = Number((entry as { weight?: unknown }).weight ?? 0);
    if (model && Number.isFinite(weight) && weight >= 0) byModel.set(model, weight);
  }
  if (!byModel.size) return equalWeights(models);
  const total = [...byModel.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return equalWeights(models);
  return [...byModel.entries()].map(([model, weight]) => ({ model, weight: weight / total }));
};

export function parseSynthesis(
  raw: string,
  models: string[],
): { answer: string; weights: FusionWeightDto[]; disagreements: string[] } {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as { answer?: unknown; weights?: unknown; disagreements?: unknown };
      if (typeof obj.answer === "string" && obj.answer.trim()) {
        return {
          answer: obj.answer.trim(),
          weights: normalizeWeights(obj.weights, models),
          disagreements: Array.isArray(obj.disagreements)
            ? obj.disagreements.filter((d): d is string => typeof d === "string")
            : [],
        };
      }
    } catch {
      /* fall through to prose fallback */
    }
  }
  return { answer: raw.trim(), weights: equalWeights(models), disagreements: [] };
}

export function snapshot(state: FusionState): FusionDto {
  return {
    id: state.id,
    answer: state.answer,
    weights: state.weights.map((w) => ({ ...w })),
    disagreements: [...state.disagreements],
    sources: state.sources.map((source) => ({ model: source.model, answer: source.text })),
    status: state.status,
    ...(state.error ? { error: state.error } : {}),
  };
}

export function createFusionService(deps: FusionDeps): FusionService {
  const now = deps.now ?? (() => Date.now());
  const fusions = new Map<string, FusionState>();

  const finish = async (state: FusionState) => {
    await deps.append(state.sessionId, "fusion/completed", {
      fusionId: state.id,
      status: state.status,
      answer: state.answer,
      weights: state.weights as unknown as JsonObject[],
      disagreements: state.disagreements,
      sources: state.sources.map((source) => ({
        model: source.model,
        answer: source.text,
      })) as unknown as JsonObject[],
      ...(state.error ? { error: state.error } : {}),
    } as unknown as JsonObject);
  };

  const run = async (state: FusionState): Promise<void> => {
    try {
      const answers = await Promise.all(
        state.models.map(async (model): Promise<ModelAnswer> => ({
          model,
          text: await deps.runModel({ sessionId: state.sessionId, fusionId: state.id, model, prompt: state.prompt }),
        })),
      );
      state.sources = answers;
      const raw = await deps.synthesize({ sessionId: state.sessionId, fusionId: state.id, prompt: state.prompt, answers });
      const parsed = parseSynthesis(raw, state.models);
      state.answer = parsed.answer;
      state.weights = parsed.weights;
      state.disagreements = parsed.disagreements;
      state.status = "completed";
    } catch (err) {
      state.status = "failed";
      state.error = String(err instanceof Error ? err.message : err).slice(0, 300);
    }
    await finish(state);
  };

  return {
    async start(sessionId, input) {
      const text = input.text.trim();
      if (!text) throw new Error("fusion prompt is empty");
      if (!input.models.length) throw new Error("fusion needs at least one model");
      const id = randomUUID();
      const state: FusionState = {
        id, sessionId, prompt: text, models: [...input.models],
        status: "running", answer: "", weights: [], disagreements: [], sources: [], createdAt: now(),
      };
      fusions.set(id, state);
      await deps.append(sessionId, "fusion/started", { fusionId: id, prompt: text, models: state.models });
      void run(state);
      return { id };
    },

    get(fusionId) {
      return fusions.get(fusionId) ?? null;
    },

    snapshot,
  };
}
