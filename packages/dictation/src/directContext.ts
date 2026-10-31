import { normalizeDictationContext, type DictationContext } from "./providers.ts";

/**
 * Browser-direct provider traffic bypasses the Polyth server's contextFilter.
 * Therefore workspace/chat context is stripped unless the browser has a
 * server-authoritative runtime config explicitly allowing context injection.
 */
export function directProviderContext(
  input: Partial<DictationContext>,
  authoritativeContextInjection = false,
): DictationContext {
  const normalized = normalizeDictationContext(input);
  if (authoritativeContextInjection) return normalized;
  return {
    language: normalized.language,
    ...(normalized.localeHints?.length ? { localeHints: normalized.localeHints } : {}),
  };
}
