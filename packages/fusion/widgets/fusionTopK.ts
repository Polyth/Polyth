// Fusion "pick sources" preselection by Multirun rubric score. Pure helpers so
// the setup view can offer the top-K scoring models while the person still
// confirms the sources. Reads the same use id the Multirun package registers.
import type { ModelRef, SessionEvent } from "@polyth/contracts";

export interface ScoredSource {
  /** `providerID/modelID`, the key Fusion's source picker uses. */
  model: string;
  score: number;
  confidence: number;
  levels: number;
}

const modelKey = (raw: unknown): string | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const model = raw as Partial<ModelRef> & { providerID?: unknown; modelID?: unknown };
  return typeof model.providerID === "string" && typeof model.modelID === "string"
    ? `${model.providerID}/${model.modelID}`
    : undefined;
};

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Rubric scores from the newest Multirun in the session, keyed by model. */
export function latestScoredSources(events: readonly SessionEvent[]): ScoredSource[] {
  let latestId = "";
  const byModel = new Map<string, ScoredSource>();
  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const multirunId = typeof data.multirunId === "string" ? data.multirunId : "";
    if (event.type === "multirun/started" && multirunId) {
      if (multirunId !== latestId) {
        latestId = multirunId;
        byModel.clear();
      }
      continue;
    }
    if (event.type !== "multirun/run-scored" || !multirunId) continue;
    if (multirunId !== latestId) {
      latestId = multirunId;
      byModel.clear();
    }
    const model = modelKey(data.model);
    const score = finite(data.score);
    const confidence = finite(data.confidence);
    const levels = finite(data.levels);
    if (!model || score === undefined || confidence === undefined || levels === undefined) continue;
    byModel.set(model, { model, score, confidence, levels });
  }
  return [...byModel.values()];
}

/** Top-K scoring models that are actually offered, strongest first. */
export function rankTopSources(
  sources: readonly ScoredSource[],
  topK: number,
  available: readonly string[],
): string[] {
  if (!Number.isSafeInteger(topK) || topK <= 0) return [];
  const allowed = new Set(available);
  return sources
    .filter((source) => allowed.has(source.model))
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.model.localeCompare(b.model))
    .slice(0, topK)
    .map((source) => source.model);
}

/** The `fusionTopK` the server resolved when it scored the newest Multirun; 0 = off. */
export function latestFusionTopK(events: readonly SessionEvent[]): number {
  let latestId = "", topK = 0;
  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const multirunId = typeof data.multirunId === "string" ? data.multirunId : "";
    if (!multirunId || (event.type !== "multirun/started" && event.type !== "multirun/run-scored")) continue;
    if (multirunId !== latestId) { latestId = multirunId; topK = 0; }
    const raw = data.fusionTopK;
    if (event.type === "multirun/run-scored" && typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 && raw <= 8) topK = raw;
  }
  return topK;
}
