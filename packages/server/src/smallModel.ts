// Stateless utility inference.  Feature packages use this service instead of
// creating disposable agent sessions; adapters can opt into direct provider
// transport and older/unsupported providers retain oneShot as a narrow
// compatibility fallback.
import type {
  AgentRuntime,
  JsonObject,
  ModelDescriptor,
  ModelRef,
  SessionProjection,
  SmallModelCompletionResult,
} from "@polyth/contracts";
import { resolveModelSelection } from "@polyth/contracts";
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
  purpose?: string;
  /** Only the tool-less direct completion may answer: a runtime without one
   *  fails `unsupported` instead of running the prompt as an agent turn. */
  requireDirect?: boolean;
}

export interface SmallModelService {
  complete(runtime: AgentRuntime, options: SmallModelCompleteOptions): Promise<SmallModelCompletionResult>;
  /** Input-character budget after reserving output and protocol overhead. */
  inputBudget(runtime: AgentRuntime, model: ModelRef | undefined, maxOutputTokens: number): Promise<number>;
}

const FALLBACK_CONTEXT_TOKENS = 32_000;
const PROMPT_OVERHEAD_TOKENS = 256;
const CHARS_PER_TOKEN = 3.6;

export type SmallModelRef = ModelRef & { harnessId?: string };

/** Read the browser-owned small-model preference from an account settings blob. */
export function smallModelPreference(settings: unknown): SmallModelRef | undefined {
  const raw = (settings as {
    sessionDefaults?: { smallModel?: { harnessId?: unknown; providerID?: unknown; modelID?: unknown } };
  } | null | undefined)?.sessionDefaults?.smallModel;
  if (
    !raw
    || typeof raw.providerID !== "string"
    || !raw.providerID
    || typeof raw.modelID !== "string"
    || !raw.modelID
  ) return undefined;
  return {
    providerID: raw.providerID,
    modelID: raw.modelID,
    ...(typeof raw.harnessId === "string" && raw.harnessId
      ? { harnessId: raw.harnessId }
      : {}),
  };
}

/** Keep a fallback session model on the runtime that actually owns it. */
export function smallModelExecutionRoute(
  configured: SmallModelRef | undefined,
  session?: Pick<SessionProjection, "model" | "resolvedHarnessId">,
): { model?: SmallModelRef; harnessId?: string } {
  const model = configured ?? session?.model;
  const harnessId = configured?.harnessId
    ?? (configured ? undefined : session?.resolvedHarnessId);
  return {
    ...(model ? { model } : {}),
    ...(harnessId ? { harnessId } : {}),
  };
}

type SmallModelRoute = { model?: ModelRef; harnessId?: string };

const sameRoute = (a: SmallModelRoute, b: SmallModelRoute): boolean =>
  a.harnessId === b.harnessId
  && a.model?.providerID === b.model?.providerID
  && a.model?.modelID === b.model?.modelID;

/** Write a session-scoped summary (Polyth-owned compaction). The session's
 *  own wired runtime answers first: a harness bound to one canonical session
 *  (Antigravity) cannot lend a project-scoped runtime at all. Only its direct
 *  completion is used, so the live native leg never gets an extra turn. Then
 *  the session route on a project runtime (when not already tried) and the
 *  configured small model. The first failure is reported: the session's own
 *  model explains it best. `smallModelFirst` asks the configured small model
 *  before all of them, for a session whose own model is out of quota. */
export async function summarizeSessionFirst(input: {
  sessionRuntime?: AgentRuntime;
  sessionRoute: SmallModelRoute;
  fallbackRoute: SmallModelRoute;
  smallModelFirst?: boolean;
  projectRuntime(harnessId?: string): Promise<AgentRuntime>;
  run(runtime: AgentRuntime, model: ModelRef | undefined, requireDirect: boolean): Promise<string>;
}): Promise<string> {
  let failure: unknown;
  const triedSmall = input.smallModelFirst === true && !sameRoute(input.fallbackRoute, input.sessionRoute);
  if (triedSmall) {
    try {
      const text = await input.run(await input.projectRuntime(input.fallbackRoute.harnessId), input.fallbackRoute.model, false);
      if (text.trim()) return text;
    } catch (error) {
      failure = error;
    }
  }
  const triedSession = Boolean(input.sessionRuntime?.completeSmallModel);
  if (input.sessionRuntime && triedSession) {
    try {
      const text = await input.run(input.sessionRuntime, input.sessionRoute.model, true);
      if (text.trim()) return text;
    } catch (error) {
      failure ??= error;
    }
  }
  const routes = [input.sessionRoute, input.fallbackRoute]
    .filter((route, index, all) => all.findIndex((other) => sameRoute(other, route)) === index)
    .filter((route) => !(triedSession && sameRoute(route, input.sessionRoute)))
    .filter((route) => !(triedSmall && sameRoute(route, input.fallbackRoute)));
  for (const route of routes) {
    try {
      const text = await input.run(await input.projectRuntime(route.harnessId), route.model, false);
      if (text.trim()) return text;
    } catch (error) {
      failure ??= error;
    }
  }
  throw failure ?? Object.assign(new Error("the model returned an empty summary"), { code: "unavailable" });
}

const promptForFallback = (options: SmallModelCompleteOptions): string =>
  options.systemPrompt ? `${options.systemPrompt}\n\n${options.prompt}` : options.prompt;

type SmallModelFailure = (options: SmallModelCompleteOptions, stage: string, error: unknown) => never;

const fail: SmallModelFailure = (options, stage, error) => {
  if (options.purpose) {
    console.error("[polyth] small-model generation failed", JSON.stringify({
      purpose: options.purpose,
      provider: options.model?.providerID ?? "unresolved",
      model: options.model?.modelID ?? "unresolved",
      stage,
      code: typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code
        : error instanceof DOMException && error.name === "AbortError" ? "aborted" : "upstream",
    }));
  }
  throw error;
};

export interface SmallModelServiceOptions {
  /** The configured small model is not (or no longer) offered by its provider;
   * the shared model catalog that offered it is stale. Advisory only. */
  modelCatalogStale?(signal: { harnessId?: string; reason: "small-model-invalid-model" }): void;
}

export function createSmallModelService(
  store: RuntimeMutationStore,
  serviceOptions: SmallModelServiceOptions = {},
): SmallModelService {
  const modelsFor = (runtime: AgentRuntime): Promise<ModelDescriptor[]> => runtime.models().catch(() => []);
  const failFor = (runtime: AgentRuntime): SmallModelFailure => (options, stage, error) => {
    if ((error as { code?: unknown } | null)?.code === "invalid-model") {
      try {
        serviceOptions.modelCatalogStale?.({
          ...(runtime.harnessId ? { harnessId: runtime.harnessId } : {}),
          reason: "small-model-invalid-model",
        });
      } catch (signalError) {
        console.warn("[polyth] model catalog stale signal failed", signalError);
      }
    }
    return fail(options, stage, error);
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
      const fail: SmallModelFailure = failFor(runtime);
      options.signal?.throwIfAborted();
      const started = performance.now();
      const model = options.model ? {
        providerID: options.model.providerID,
        modelID: options.model.modelID,
        ...(options.model.variant ? { variant: options.model.variant } : {}),
      } : undefined;
      if (model) {
        const selection = resolveModelSelection(await modelsFor(runtime), model, runtime.harnessId);
        options.signal?.throwIfAborted();
        if (!selection.ok) fail(options, "model-resolution", Object.assign(new Error(selection.message), { code: selection.code }));
      }
      if (runtime.completeSmallModel) {
        try {
          return await runtime.completeSmallModel({
            cwd: options.cwd,
            prompt: options.prompt,
            ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
            model,
            maxOutputTokens: options.maxOutputTokens,
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.responseSchema ? { responseSchema: options.responseSchema } : {}),
          });
        } catch (error) {
          // Only an explicitly unsupported provider falls back. Retrying a
          // timed-out/directly accepted request as a session turn delays the
          // UI by the full timeout and can double-charge the same completion.
          if ((error as { code?: unknown }).code !== "unsupported" || options.requireDirect) fail(options, "direct-provider", error);
        }
      }
      if (options.requireDirect) {
        fail(options, "direct-provider", Object.assign(new Error("runtime has no direct small-model completion"), { code: "unsupported" }));
      }
      const fallbackModel = model
        ?? fail(options, "model-resolution", Object.assign(new Error("no small model configured"), { code: "unavailable" }));
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("aborted", "AbortError");
      const text = await oneShot(runtime, {
        cwd: options.cwd,
        prompt: promptForFallback(options),
        model: fallbackModel,
        ...(options.purpose ? { purpose: options.purpose } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      }, store).catch((error) => fail(options, "compatibility", error));
      return {
        text,
        providerID: fallbackModel.providerID,
        modelID: fallbackModel.modelID,
        inputTruncated: false,
        transport: "compatibility",
        latencyMs: Math.round(performance.now() - started),
      };
    },
  };
}
