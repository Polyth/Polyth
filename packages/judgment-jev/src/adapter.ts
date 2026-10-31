import {
  TypeSafeClient, APIError, APIConnectionError, APITimeoutError, APIUserAbortError,
  noul, choice, score, type Questions, type SystemOneResult,
} from "@typesafe-ai/sdk";
import {
  JudgmentExecutionError, type JudgmentEngineAdapter, type JudgmentEngineMetadata,
  type JudgmentQuestionMap, type ProviderJudgmentResponse,
} from "@polyth/judgment";
import type { ModelDescriptor } from "@polyth/contracts";
import { JEV_PROVIDER, JEV_ROUTES, jevRoute, routeModel, type JevRoute } from "./routes.ts";

export { JEV_PROVIDER, JEV_ROUTES, jevRoute, type JevRoute };
export interface JevJudgmentAdapterConfig { secretHandle?: string; baseUrl?: string }
export const JEV_ENGINE_METADATA: JudgmentEngineMetadata = Object.freeze({
  id: "jev", name: "Dedicated Judgment engine", recommended: true,
  description: "Purpose-built semantic evaluation through the Jev adapter.",
});
/** Official SDK default. Additional models come from the account's models.list(), never a parallel vendor catalog. */
export const JEV_DEFAULT_MODEL: ModelDescriptor = routeModel(JEV_ROUTES[0]!);

/** A server-side credential callback; the SDK and plaintext never escape this package. */
export interface JevJudgmentAdapterOptions {
  config?: JevJudgmentAdapterConfig;
  /** Resolves the credential saved for this route. Never called for a keyless route. */
  withCredential: (use: (secret: string) => Promise<void>, route: JevRoute) => Promise<void>;
  /** Canonical descriptors across routes; `providerID` is the route. Defaults to TypeSafe's SDK default. */
  models?: readonly ModelDescriptor[];
  /** The route Automatic resolves to. Defaults to TypeSafe. */
  automaticProviderId?: string;
  /** Inject an HTTP transport for offline protocol tests, not SDK types. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

function translateQuestions(questions: JudgmentQuestionMap): Questions {
  return Object.fromEntries(Object.entries(questions).map(([id, q]) => [id,
    q.type === "noul" ? noul(q.instructions) : q.type === "choice" ? choice(q.instructions, { ...q.criteria })
      : score(q.instructions, [...q.rubric] as [string, string, ...string[]]),
  ]));
}
function normalizeResponse(raw: SystemOneResult<Questions>, questions: JudgmentQuestionMap, route: JevRoute): ProviderJudgmentResponse {
  if (!raw || typeof raw !== "object" || !raw.answers || typeof raw.answers !== "object"
    || Object.keys(raw.answers).length !== Object.keys(questions).length
    || Object.keys(raw.answers).some((id) => !Object.hasOwn(questions, id))
    || typeof raw.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/~-]{0,199}$/.test(raw.model)) throw new JudgmentExecutionError("invalid-response");
  const answers: ProviderJudgmentResponse["answers"] = {};
  for (const [id, q] of Object.entries(questions)) {
    const native = raw.answers[id];
    if (!native || native.type !== q.type) throw new JudgmentExecutionError("invalid-response");
    if (native.type === "noul") {
      // Native noul has no separate confidence. Probability of the more likely polarity is explicit and lossless.
      answers[id] = { type: "noul", probability: native.noul, confidence: Math.max(native.noul, 1 - native.noul) };
    } else if (native.type === "choice") {
      answers[id] = { type: "choice", value: native.choice, confidence: native.confidence, probabilities: native.probabilities };
    } else if (q.type === "score") {
      const probs = native.probabilities;
      if (!probs || Object.keys(probs).length !== q.rubric.length
        || q.rubric.some((_, i) => !Object.hasOwn(probs, String(i)))) throw new JudgmentExecutionError("invalid-response");
      answers[id] = { type: "score", score: native.score, confidence: native.confidence,
        probabilities: q.rubric.map((_, i) => probs[i]!), levelCount: q.rubric.length };
    }
  }
  if (!raw.usage || typeof raw.usage.input_tokens !== "number" || typeof raw.usage.output_tokens !== "number") {
    throw new JudgmentExecutionError("invalid-response");
  }
  return { answers, model: { providerId: route.provider.id, modelId: raw.model },
    usage: { inputTokens: raw.usage.input_tokens, outputTokens: raw.usage.output_tokens } };
}
function normalizeError(error: unknown): JudgmentExecutionError {
  if (error instanceof JudgmentExecutionError) return error;
  // The SDK wraps a transport refusal (an off-route URL) as a connection error.
  if (error instanceof APIConnectionError && error.cause instanceof JudgmentExecutionError) return error.cause;
  if (error instanceof APIUserAbortError) return new JudgmentExecutionError("cancelled");
  if (error instanceof APITimeoutError) return new JudgmentExecutionError("timeout");
  if (error instanceof APIError) {
    // 402: an exhausted balance or an ended promotion. Retrying cannot help.
    if (error.status === 401 || error.status === 402 || error.status === 403) return new JudgmentExecutionError("provider-unavailable");
    if (error.status === 400 || error.status === 422) return new JudgmentExecutionError("invalid-request");
    if (error.status === 404) return new JudgmentExecutionError("model-unavailable");
    return new JudgmentExecutionError("provider-error", [429, 502, 503, 504].includes(error.status));
  }
  if (error instanceof APIConnectionError) return new JudgmentExecutionError("provider-error", true);
  return new JudgmentExecutionError("provider-error");
}

function createClient(options: JevJudgmentAdapterOptions, route: JevRoute, secret?: string): TypeSafeClient {
  if (route.credential === "required" && !secret?.trim()) throw new JudgmentExecutionError("provider-unavailable");
  const baseURL = (route === JEV_ROUTES[0] ? options.config?.baseUrl ?? route.baseURL : route.baseURL).replace(/\/$/, "");
  // Each route accepts only its verified endpoint. A configurable arbitrary host would leak its credential.
  if (baseURL !== route.baseURL) throw new JudgmentExecutionError("provider-unavailable");
  const transport = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, { ...init, redirect: "error" }));
  return new TypeSafeClient({ apiKey: secret ?? "keyless", baseURL, defaultModel: route.defaultModel,
    logLevel: "off", retry: { maxRetries: 0 }, timeout: 10_000, defaultHeaders: { ...route.headers },
    fetch: (input, init) => {
      const url = String(input);
      if (!url.startsWith(`${route.baseURL}/v1/`)) return Promise.reject(new JudgmentExecutionError("provider-unavailable"));
      if (route.credential === "required") return transport(url, init);
      // The SDK always signs requests. A keyless route sends no Authorization header at all.
      const headers = new Headers(init?.headers); headers.delete("authorization");
      return transport(url, { ...init, headers });
    } });
}
async function withRoute(options: JevJudgmentAdapterOptions, route: JevRoute, use: (client: TypeSafeClient) => Promise<void>) {
  if (route.credential === "none") return use(createClient(options, route));
  return options.withCredential((secret) => use(createClient(options, route, secret)), route);
}
const automaticModel = (route: JevRoute, models: readonly ModelDescriptor[]) => {
  const own = models.filter((model) => model.providerID === route.provider.id);
  return own.find((model) => model.modelID === route.defaultModel)?.modelID
    ?? [...own].sort((a, b) => a.modelID < b.modelID ? -1 : a.modelID > b.modelID ? 1 : 0)[0]?.modelID;
};

export function createJevJudgmentEngine(options: JevJudgmentAdapterOptions): JudgmentEngineAdapter {
  const models = options.models ?? [JEV_DEFAULT_MODEL];
  const automatic = jevRoute(options.automaticProviderId) ?? JEV_ROUTES[0]!;
  const availability: JudgmentEngineAdapter["availability"] = (target) => !jevRoute(target.providerId)
    ? "provider-unavailable" : !models.some((model) => model.providerID === target.providerId && model.modelID === target.modelId)
      ? "model-unavailable" : undefined;
  return {
    id: JEV_ENGINE_METADATA.id, metadata: JEV_ENGINE_METADATA,
    capabilities: () => ({ questionTypes: ["noul", "choice", "score"],
      defaults: { providerId: automatic.provider.id, modelId: automaticModel(automatic, models) },
      defaultModels: Object.fromEntries(JEV_ROUTES.flatMap((route) => {
        const modelId = automaticModel(route, models);
        return modelId ? [[route.provider.id, modelId]] : [];
      })) }),
    availability,
    async judge(request, context) {
      const unavailable = availability(request.target);
      if (unavailable) throw new JudgmentExecutionError(unavailable);
      const route = jevRoute(request.target.providerId)!;
      let result: ProviderJudgmentResponse | undefined;
      try {
        if (context.signal.aborted) throw new JudgmentExecutionError("cancelled");
        await withRoute(options, route, async (client) => {
          if (context.signal.aborted) throw new JudgmentExecutionError("cancelled");
          const raw = await client.systemOne({ model: request.target.modelId,
            state: typeof request.state === "boolean" || typeof request.state === "number" ? { value: request.state } : request.state,
            questions: translateQuestions(request.questions) },
          { signal: context.signal, timeout: Math.max(1, context.deadlineAt - Date.now()), retry: { maxRetries: 0 } });
          if (!route.floating.includes(request.target.modelId) && raw.model !== request.target.modelId) {
            throw new JudgmentExecutionError("invalid-response");
          }
          result = normalizeResponse(raw, request.questions, route);
        });
      } catch (error) { throw normalizeError(error); }
      if (!result) throw new JudgmentExecutionError("provider-unavailable");
      return result;
    },
  };
}

/** Account discovery for a route that supports it; any other route offers its one verified model. */
export async function discoverJevModels(options: JevJudgmentAdapterOptions, signal: AbortSignal, providerId = JEV_PROVIDER.id): Promise<ModelDescriptor[]> {
  const route = jevRoute(providerId);
  if (!route) throw new JudgmentExecutionError("provider-unavailable");
  if (!route.discovery) return [routeModel(route)];
  let models: ModelDescriptor[] = [];
  try {
    await withRoute(options, route, async (client) => {
      const cards = await client.models.list({ signal, timeout: 10_000, retry: { maxRetries: 0 } });
      if (!Array.isArray(cards) || cards.length > 1_000 || cards.some((card) => !card || typeof card.name !== "string" || !/^[A-Za-z0-9._:/-]{1,200}$/.test(card.name))) {
        throw new JudgmentExecutionError("invalid-response");
      }
      models = cards.map((card) => ({ providerID: route.provider.id, providerName: route.provider.name,
        modelID: card.name, name: card.name, connected: true, capabilities: ["input:text"] }));
    });
  } catch (error) { throw normalizeError(error); }
  return models;
}
