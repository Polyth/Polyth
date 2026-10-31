// DeepSeek Harness names a model route as an opaque JSON pair in its ACP
// `model` select (`["deepseek-official","deepseek-v4-flash"]`). Polyth shows
// and persists the plain DeepSeek model id instead, so model presentation,
// context lookup and Usage see `deepseek-v4-flash`. Other provider routes a
// custom dsh profile adds keep their route as a `provider/model` prefix.
import type { AcpModelIdCodec } from "@polyth/backend-acp";

/** The route of DeepSeek's own API in the shipped profiles. */
export const OFFICIAL_PROVIDER = "deepseek-official";

export const canonicalDshModelId = (provider: string, model: string): string =>
    provider === OFFICIAL_PROVIDER ? model : `${provider}/${model}`;

const routeOf = (value: string): [string, string] | undefined => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return undefined;
    }
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [provider, model] = parsed;
    return typeof provider === "string" && provider && typeof model === "string" && model
        ? [provider, model]
        : undefined;
};

/** An unrecognized value is kept verbatim rather than guessed at. */
export const dshModelIdCodec: AcpModelIdCodec = {
    canonical(value) {
        const route = routeOf(value);
        return route ? canonicalDshModelId(route[0], route[1]) : value;
    },
};
