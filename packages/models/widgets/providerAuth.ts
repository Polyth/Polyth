import type { NormalizedAuthMethod, ProviderAuthView } from "@polyth/contracts";

export const interactiveMethods = (
  view: ProviderAuthView | undefined,
): NormalizedAuthMethod[] => view?.methods ?? [];

export const shouldOfferChooser = (methods: readonly NormalizedAuthMethod[]): boolean => methods.length > 1;

export const discoveryIsError = (view: ProviderAuthView | undefined): boolean =>
  view?.discovery.status === "failed";
