import type { JudgmentConfig, JudgmentLimits, JudgmentTarget } from "./types.ts";

export const DEFAULT_JUDGMENT_LIMITS: Readonly<JudgmentLimits> = Object.freeze({
  maxQuestionsPerCall: 8, maxStateBytes: 64_000, maxQuestionBytes: 8_000, maxRequestBytes: 96_000,
  maxCallsPerRun: 64, maxConcurrentCalls: 4, timeoutMs: 10_000, maxRetries: 1,
});
export function resolveTarget(input: {
  defaults?: JudgmentTarget;
  global?: Partial<JudgmentConfig>;
  project?: Partial<JudgmentConfig>;
  scope: string;
  target?: JudgmentTarget;
  /** Default model per provider. A model chosen for one provider never carries over to another. */
  defaultModels?: Readonly<Record<string, string>>;
  /** The resolved engine's own provider/model defaults. A provider chosen under another engine never carries over. */
  engineDefaults?: Omit<JudgmentTarget, "engineId">;
}): JudgmentTarget {
  const layers = [input.defaults, input.global, input.project,
    input.global?.scopes?.[input.scope], input.project?.scopes?.[input.scope], input.target];
  const engineId = layers.reduce<string | undefined>((id, layer) => layer?.engineId ?? id, undefined);
  const target: JudgmentTarget = { ...(engineId === undefined ? {} : { engineId }), ...input.engineDefaults };
  for (const key of ["providerId", "modelId"] as const) if (target[key] === undefined) delete target[key];
  let modelOwner = target.modelId === undefined ? undefined : target.providerId, engine: string | undefined;
  for (const layer of layers) {
    engine = layer?.engineId ?? engine;
    // A provider/model chosen while another engine was in effect belongs to that engine.
    if (engine !== engineId) continue;
    if (layer?.providerId !== undefined) target.providerId = layer.providerId;
    if (layer?.modelId !== undefined) { target.modelId = layer.modelId; modelOwner = target.providerId; }
  }
  if (target.modelId !== undefined && modelOwner !== target.providerId) {
    const fallback = target.providerId === undefined ? undefined : input.defaultModels?.[target.providerId];
    if (fallback === undefined) delete target.modelId; else target.modelId = fallback;
  }
  return target;
}
export function resolveLimits(...layers: Array<Partial<JudgmentLimits> | undefined>): JudgmentLimits {
  const value = { ...DEFAULT_JUDGMENT_LIMITS };
  for (const layer of layers) {
    for (const key of Object.keys(value) as Array<keyof JudgmentLimits>) {
      const next = layer?.[key];
      if (next !== undefined) value[key] = next;
    }
  }
  for (const [key, n] of Object.entries(value)) {
    if (!Number.isSafeInteger(n) || n < (key === "maxRetries" ? 0 : 1) || n > 2_147_483_647) {
      throw new TypeError("Invalid Judgment limits");
    }
  }
  return value;
}
