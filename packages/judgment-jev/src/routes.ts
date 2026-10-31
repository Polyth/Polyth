import type { AvailableProviderDescriptor, ModelDescriptor } from "@polyth/contracts";

/**
 * A verified way to reach Jev. Every route pins its own origin and path root, so a
 * credential saved for one route can never be sent to another host. Routes are the
 * Judgment "providers" of the Jev engine: the provider ID is the route ID.
 */
export interface JevRoute {
  readonly provider: Readonly<AvailableProviderDescriptor>;
  /** One sentence: who answers and who bills. */
  readonly description: string;
  /** SDK API root; `/v1/systemone` and `/v1/models` are appended by the SDK. */
  readonly baseURL: string;
  readonly defaultModel: string;
  readonly modelName: string;
  /** Models whose concrete release may float; any other requested model must answer as itself. */
  readonly floating: readonly string[];
  /** `none` sends no Authorization header at all. */
  readonly credential: "required" | "none";
  /** Account model discovery through `/v1/models`. */
  readonly discovery: boolean;
  /** Eligible for Automatic. A keyless route is only ever used when picked explicitly. */
  readonly automatic: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}

const route = (value: JevRoute): JevRoute => Object.freeze({ ...value, provider: Object.freeze(value.provider), floating: Object.freeze([...value.floating]) });
/** Zen identifies the calling client, so it can see or throttle one integration without blocking another. */
const ZEN_CLIENT = Object.freeze({ "x-opencode-client": "polyth" });

/** Automatic order: the user's own account first, then gateways that bill an existing account. */
export const JEV_ROUTES: readonly JevRoute[] = Object.freeze([
  route({ provider: { id: "typesafe", name: "TypeSafe AI", docs: "https://docs.typesafe.ai/sdk/javascript" },
    description: "Direct to TypeSafe with your own key and quota.",
    baseURL: "https://api.typesafe.ai", defaultModel: "jev-latest", modelName: "Jev (latest)", floating: ["jev-latest", "jev-preview"],
    credential: "required", discovery: true, automatic: true }),
  route({ provider: { id: "openrouter", name: "OpenRouter", docs: "https://openrouter.ai/settings/keys" },
    description: "Jev through OpenRouter, billed to your OpenRouter credits.",
    baseURL: "https://openrouter.ai/api", defaultModel: "jev-latest", modelName: "Jev (latest)", floating: ["jev-latest"],
    credential: "required", discovery: false, automatic: true }),
  route({ provider: { id: "vercel-ai-gateway", name: "Vercel AI Gateway", docs: "https://vercel.com/docs/ai-gateway" },
    description: "Jev through Vercel AI Gateway, billed to your Vercel team.",
    baseURL: "https://ai-gateway.vercel.sh/typesafe", defaultModel: "typesafe-ai/jev", modelName: "Jev", floating: ["typesafe-ai/jev"],
    credential: "required", discovery: false, automatic: true }),
  route({ provider: { id: "opencode-zen", name: "OpenCode Zen", docs: "https://opencode.ai/zen" },
    description: "Jev through OpenCode Zen, paid from your Zen balance.",
    baseURL: "https://opencode.ai/zen", defaultModel: "jev-1.13", modelName: "Jev 1.13", floating: ["jev-1.13"],
    credential: "required", discovery: false, automatic: true, headers: ZEN_CLIENT }),
  route({ provider: { id: "opencode-zen-free", name: "OpenCode Zen free", docs: "https://opencode.ai/zen" },
    description: "Free while OpenCode's promotion lasts. No account or key; Polyth never picks it on its own.",
    baseURL: "https://opencode.ai/zen", defaultModel: "jev-1.13-free", modelName: "Jev 1.13 (free)", floating: ["jev-1.13-free"],
    credential: "none", discovery: false, automatic: false, headers: ZEN_CLIENT }),
]);
export const JEV_PROVIDER = JEV_ROUTES[0]!.provider;
export const jevRoute = (providerId: string | undefined) => JEV_ROUTES.find((entry) => entry.provider.id === providerId);
export const routeModel = (entry: JevRoute): ModelDescriptor => Object.freeze({ providerID: entry.provider.id,
  providerName: entry.provider.name, modelID: entry.defaultModel, name: entry.modelName, capabilities: ["input:text"] });
