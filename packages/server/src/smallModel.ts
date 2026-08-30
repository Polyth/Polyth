// Stateless utility inference.  Feature packages use this service instead of
// creating disposable agent sessions; adapters can opt into direct provider
// transport and older/unsupported providers retain oneShot as a narrow
// compatibility fallback.
import type {
  AgentRuntime,
  JsonObject,
  ModelDescriptor,
  ModelRef,
  SmallModelCompletionResult,
} from "@polyth/contracts";
import type { RuntimeMutationStore } from "@polyth/session";
import { oneShot } from "./oneshot.ts";

export interface SmallModelCompleteOptions {
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  model?: ModelRef;
  maxOutputTokens: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  responseSchema?: JsonObject;
}

export interface SmallModelService {
  complete(runtime: AgentRuntime, options: SmallModelCompleteOptions): Promise<SmallModelCompletionResult>;
  /** Input-character budget after reserving output and protocol overhead. */
  inputBudget(runtime: AgentRuntime, model: ModelRef | undefined, maxOutputTokens: number): Promise<number>;
}

const FALLBACK_CONTEXT_TOKENS = 32_000;
const PROMPT_OVERHEAD_TOKENS = 256;
const CHARS_PER_TOKEN = 3.6;

const unsupported = (error: unknown): boolean =>
  !!error && typeof error === "object" && (error as { code?: unknown }).code === "unsupported";

const promptForFallback = (options: SmallModelCompleteOptions): string =>
  options.systemPrompt ? `${options.systemPrompt}\n\n${options.prompt}` : options.prompt;

export function createSmallModelService(store: RuntimeMutationStore): SmallModelService {
  const catalogs = new WeakMap<AgentRuntime, Promise<ModelDescriptor[]>>();
  const modelsFor = (runtime: AgentRuntime): Promise<ModelDescriptor[]> => {
    let pending = catalogs.get(runtime);
    if (!pending) {
      pending = runtime.models().catch(() => []);
      catalogs.set(runtime, pending);
    }
    return pending;
  };

  return {
    async inputBudget(runtime, model, maxOutputTokens) {
      const descriptor = model
        ? (await modelsFor(runtime)).find((candidate) =>
            candidate.providerID === model.providerID && candidate.modelID === model.modelID)
        : undefined;
      const contextTokens = descriptor?.context && descriptor.context > 0
        ? descriptor.context
        : FALLBACK_CONTEXT_TOKENS;
      const inputTokens = Math.max(1_024, contextTokens - maxOutputTokens - PROMPT_OVERHEAD_TOKENS);
      return Math.floor(inputTokens * CHARS_PER_TOKEN);
    },

    async complete(runtime, options) {
      const started = performance.now();
      if (runtime.completeSmallModel && options.model) {
        try {
          return await runtime.completeSmallModel({
            cwd: options.cwd,
            prompt: options.prompt,
            ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
            model: options.model,
            maxOutputTokens: options.maxOutputTokens,
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.responseSchema ? { responseSchema: options.responseSchema } : {}),
          });
        } catch (error) {
          if (!unsupported(error)) throw error;
        }
      }
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("aborted", "AbortError");
      const text = await oneShot(runtime, {
        cwd: options.cwd,
        prompt: promptForFallback(options),
        ...(options.model ? { model: options.model } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      }, store);
      return {
        text,
        providerID: options.model?.providerID ?? "compatibility",
        modelID: options.model?.modelID ?? "default",
        inputTruncated: false,
        transport: "compatibility",
        latencyMs: Math.round(performance.now() - started),
      };
    },
  };
}
