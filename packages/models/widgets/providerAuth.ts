import type { ProviderAuthMethodDto } from "@polyth/session/web-api";

/** Unknown/legacy providers keep the API-key fallback; declared OAuth-only
 * providers must not be asked for a credential they do not accept. */
export const shouldShowApiKeyAuth = (methods: readonly ProviderAuthMethodDto[] | undefined): boolean =>
  !methods?.length || methods.some((method) => method.type === "api");
