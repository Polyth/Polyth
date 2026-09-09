import {
  isCloudDictationProvider,
  type DictationProcessingPolicy,
  type DictationProviderId,
} from "./providers.ts";
import { createFailoverSttAdapter } from "./failover.ts";
import type { SttAdapter } from "./streaming.ts";

export interface DictationRoutingInput {
  policy: DictationProcessingPolicy;
  selectedProvider: DictationProviderId;
  selected: SttAdapter | null;
  local: SttAdapter | null;
  explicitFallback: SttAdapter | null;
}

/**
 * Pure privacy/routing decision. Callers construct only providers the user has
 * configured; this function never discovers or invents a third party.
 */
export function selectDictationAdapter(input: DictationRoutingInput): SttAdapter | null {
  const { policy, selectedProvider, selected, local, explicitFallback } = input;
  const selectedCloud = isCloudDictationProvider(selectedProvider);

  switch (policy) {
    case "local-only":
      return selectedProvider === "web-speech" ? null : local;

    case "prefer-local": {
      if (!local) return explicitFallback;
      return explicitFallback ? createFailoverSttAdapter(local, explicitFallback) : local;
    }

    case "prefer-cloud":
      // If a local provider is selected while the policy explicitly prefers
      // cloud, only the named explicit fallback may move audio off-host.
      return selectedCloud ? selected : explicitFallback;

    case "auto-fallback": {
      const secondary = selectedCloud ? local : explicitFallback;
      if (!selected) return secondary;
      if (!secondary || secondary === selected) return selected;
      return createFailoverSttAdapter(selected, secondary);
    }

    case "browser-fallback":
      // Browser Web Speech is executed in the UI. Server routing only exposes
      // the named selected provider and never silently chooses browser/cloud.
      return selectedProvider === "web-speech" ? null : selected;
  }
}
