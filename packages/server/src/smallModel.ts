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

/** Which model writes a Polyth-owned compaction summary, from the account's
 *  Settings → Sessions → Compaction model. The other one stays the fallback. */
export function compactionModelPreference(settings: unknown): "session" | "small" {
  return (settings as { sessionDefaults?: { compactionModel?: unknown } } | null | undefined)
    ?.sessionDefaults?.compactionModel === "small" ? "small" : "session";
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
 *  configured small model. `smallModelFirst` asks the configured small model
 *  before all of them, for a session whose own model is out of quota.
 *  A blank answer counts as a failure of its model. A blank or unusable
 *  answer and a transient upstream fault get one retry on the same route
 *  after 2 s; a limit, quota, auth, model, timeout or abort does not. When every route fails,
 *  the error names each model tried, in order, with its own reason, e.g.
 *  "opus on Claude Code: You've hit your 5-hour limit · resets 2:50pm"; its
 *  code is the first failure's. */
export async function summarizeSessionFirst(input: {
  sessionRuntime?: AgentRuntime;
  sessionRoute: SmallModelRoute;
  fallbackRoute: SmallModelRoute;
  smallModelFirst?: boolean;
  projectRuntime(harnessId?: string): Promise<AgentRuntime>;
  run(runtime: AgentRuntime, model: ModelRef | undefined, requireDirect: boolean): Promise<string>;
  /** How a failure names its route; defaults to "<modelID> on <harnessId>". */
  describe?(route: SmallModelRoute): string;
  /** Pause before a retry; a test seam. */
  retryDelayMs?: number;
}): Promise<string> {
  const failures: Array<{ route: SmallModelRoute; error: unknown }> = [];
  const retryDelayMs = input.retryDelayMs ?? SUMMARY_RETRY_DELAY_MS;
  const attempt = async (
    route: SmallModelRoute,
    runtime: () => Promise<AgentRuntime>,
    requireDirect: boolean,
  ): Promise<string | undefined> => {
    let rt: AgentRuntime;
    try {
      rt = await runtime();
    } catch (error) {
      failures.push({ route, error });
      return undefined;
    }
    let error: unknown;
    for (let tries = 1; tries <= SUMMARY_TRIES; tries += 1) {
      if (tries > 1 && retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      try {
        const text = await input.run(rt, route.model, requireDirect);
        if (text.trim()) return text;
        error = Object.assign(new Error("returned an empty summary"), { code: "invalid-response" });
      } catch (caught) {
        error = caught;
      }
      if (!retryableSummaryFailure(error)) break;
      if (tries === SUMMARY_TRIES) {
        error = Object.assign(new Error(`${errorText(error)} (tried ${SUMMARY_TRIES} times)`), {
          code: (error as { code?: unknown } | null)?.code ?? "unavailable",
          cause: error,
        });
      }
    }
    failures.push({ route, error });
    return undefined;
  };
  const triedSmall = input.smallModelFirst === true && !sameRoute(input.fallbackRoute, input.sessionRoute);
  if (triedSmall) {
    const text = await attempt(input.fallbackRoute, () => input.projectRuntime(input.fallbackRoute.harnessId), false);
    if (text) return text;
  }
  const sessionRuntime = input.sessionRuntime;
  const triedSession = Boolean(sessionRuntime?.completeSmallModel);
  if (sessionRuntime && triedSession) {
    const text = await attempt(input.sessionRoute, async () => sessionRuntime, true);
    if (text) return text;
  }
  const routes = [input.sessionRoute, input.fallbackRoute]
    .filter((route, index, all) => all.findIndex((other) => sameRoute(other, route)) === index)
    .filter((route) => !(triedSession && sameRoute(route, input.sessionRoute)))
    .filter((route) => !(triedSmall && sameRoute(route, input.fallbackRoute)));
  for (const route of routes) {
    const text = await attempt(route, () => input.projectRuntime(route.harnessId), false);
    if (text) return text;
  }
  throw summaryFailure(failures, input.describe ?? describeRoute);
}

/** Each route gets one retry for a failure that a second identical request
 *  can plausibly fix. */
const SUMMARY_TRIES = 2;
const SUMMARY_RETRY_DELAY_MS = 2_000;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
/** A usage limit or quota does not lift within seconds; retrying only spends a
 *  refused request (or, after a reset, a second paid one). */
const LIMIT_FAILURE = /hit your .*limit|usage limit|rate.?limit|quota|too many requests|\b429\b/i;
const TRANSIENT_FAILURE = /overloaded|\b(?:500|502|503|504|529)\b|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed|network error/i;
/** Retry a blank or unusable answer and a transient upstream fault. Never a
 *  limit, quota, auth, model, timeout (it already waited 3 minutes), abort or
 *  unknown outcome. */
const retryableSummaryFailure = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  const message = errorText(error);
  if (LIMIT_FAILURE.test(message)) return false;
  if (code === "invalid-response" || code === "overloaded") return true;
  if (typeof code === "string" && code !== "unavailable" && code !== "upstream") return false;
  return TRANSIENT_FAILURE.test(message);
};

const describeRoute = (route: SmallModelRoute): string =>
  `${route.model?.modelID ?? "the default model"}${route.harnessId ? ` on ${route.harnessId}` : ""}`;

const summaryFailure = (
  failures: ReadonlyArray<{ route: SmallModelRoute; error: unknown }>,
  describe: (route: SmallModelRoute) => string,
): Error => {
  if (!failures.length) return Object.assign(new Error("no model could write the summary"), { code: "unavailable" });
  const message = failures.map(({ route, error }) => {
    const reason = error instanceof Error ? error.message : String(error);
    return `${describe(route)}: ${reason.trim() || "failed"}`;
  }).join("; ");
  const code = (failures[0]!.error as { code?: unknown } | null)?.code;
  return Object.assign(new Error(message), {
    code: typeof code === "string" ? code : "unavailable",
    cause: failures[0]!.error,
  });
};

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
