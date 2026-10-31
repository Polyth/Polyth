import type { JudgmentEngineAdapter, ProviderJudgmentContext, ProviderJudgmentRequest, ProviderJudgmentResponse } from "./types.ts";
import { JudgmentExecutionError } from "./errors.ts";

export function createFakeJudgmentEngine(options: Partial<ProviderJudgmentResponse> & {
  id?: string;
  /** Answer whatever provider/model a caller targets, as a stand-in for a real engine id. */
  acceptAnyTarget?: boolean;
  script?: Array<ProviderJudgmentResponse | JudgmentExecutionError | ((request: ProviderJudgmentRequest, context: ProviderJudgmentContext) => Promise<ProviderJudgmentResponse>)>;
} = {}): JudgmentEngineAdapter & { calls: ProviderJudgmentRequest[] } {
  const calls: ProviderJudgmentRequest[] = [];
  const id = options.id ?? "fake";
  return {
    id, metadata: { id, name: "Fake Judgment engine", recommended: false }, calls,
    capabilities: () => ({ questionTypes: ["noul", "choice", "score"], defaults: { providerId: "fake-provider", modelId: "fake-model" } }),
    availability: (target) => options.acceptAnyTarget ? undefined : target.providerId !== "fake-provider" ? "provider-unavailable" : target.modelId !== "fake-model" ? "model-unavailable" : undefined,
    async judge(request, context) {
      const step = options.script?.[calls.length];
      calls.push(structuredClone(request));
      if (step instanceof JudgmentExecutionError) throw step;
      if (typeof step === "function") return step(request, context);
      return structuredClone(step ?? { answers: options.answers ?? {}, ...(options.model ? { model: options.model } : {}), ...(options.usage ? { usage: options.usage } : {}) });
    },
  };
}
