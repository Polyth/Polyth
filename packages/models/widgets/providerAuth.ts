import type { ProviderAuthMethodDto } from "@polyth/session/web-api";

/** Providers that log in via OAuth only, keyed to the button label to show
 *  when the backend has not (yet) reported their auth methods. These are
 *  plugin-provided providers (e.g. the polyth Cursor plugin) whose
 *  `/provider/auth` entry can be missing while the runtime is still warming
 *  up or briefly unreachable. Without this, an unknown-methods provider falls
 *  back to an API-key form it cannot actually accept. Reported methods always
 *  win over this table. */
export const KNOWN_OAUTH_ONLY_PROVIDERS: Readonly<Record<string, string>> = {
  cursor: "Login with Cursor",
};

/** Synthesized OAuth method for a known OAuth-only provider, used only when the
 *  backend returned no methods for it. Returns undefined when real methods
 *  exist or the provider is not in the table. */
export const knownOAuthFallback = (
  providerId: string,
  methods: readonly ProviderAuthMethodDto[] | undefined,
): ProviderAuthMethodDto[] | undefined => {
  if (methods?.length) return undefined;
  const label = KNOWN_OAUTH_ONLY_PROVIDERS[providerId];
  return label ? [{ type: "oauth", label }] : undefined;
};

/** Unknown/legacy providers keep the API-key fallback; declared OAuth-only
 *  providers (reported or in {@link KNOWN_OAUTH_ONLY_PROVIDERS}) must not be
 *  asked for a credential they do not accept. */
export const shouldShowApiKeyAuth = (
  methods: readonly ProviderAuthMethodDto[] | undefined,
  providerId?: string,
): boolean => {
  if (methods?.length) return methods.some((method) => method.type === "api");
  if (providerId && providerId in KNOWN_OAUTH_ONLY_PROVIDERS) return false;
  return true;
};
