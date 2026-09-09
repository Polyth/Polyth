import type { DictationContext } from "./providers.ts";
import { directProviderContext } from "./directContext.ts";

export interface DirectBrowserAuthority {
  /** True only after a server-authoritative runtime configuration read. */
  contextInjection: boolean;
}

/** Direct provider traffic bypasses the server contextFilter. Always fail
 * closed unless a server-authoritative configuration explicitly allowed it. */
export const contextForDirectProvider = (
  context: Partial<DictationContext>,
  authority?: DirectBrowserAuthority,
): DictationContext => directProviderContext(context, authority?.contextInjection === true);
