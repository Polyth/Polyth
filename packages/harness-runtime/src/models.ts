// One canonical model control: `ModelRef.modelID` picks the native model and
// `ModelRef.variant` picks the native reasoning mode. This module is the single
// place that decides whether a (model, variant) pair is sendable. It is pure —
// admission, adapters and the composer all import the same rules so a variant
// can never be silently dropped on one path and honoured on another.
import type { ModelDescriptor, ModelRef, TurnRejectionCode } from "@polyth/contracts";

export type ModelSelection =
  | {
    ok: true;
    /** Absent when the catalog could not answer for this harness. */
    descriptor?: ModelDescriptor;
    /** Absent means "use the backend's own default reasoning mode". */
    variant?: string;
  }
  | { ok: false; code: Extract<TurnRejectionCode, "invalid-model" | "invalid-variant">; message: string };

const belongsTo = (descriptor: ModelDescriptor, harnessId?: string): boolean =>
  harnessId === undefined || descriptor.harnessId === undefined || descriptor.harnessId === harnessId;

/** The models a harness can actually route to, in catalog order. */
export const harnessModels = (
  catalog: readonly ModelDescriptor[],
  harnessId?: string,
): ModelDescriptor[] => catalog.filter((descriptor) => belongsTo(descriptor, harnessId));

/**
 * Find the descriptor a ref names. `modelID` is the identity: providers report
 * their own id inconsistently across harnesses (Codex `model/list` carries no
 * provider at all), so a providerID mismatch narrows the search but never
 * invalidates a model the harness demonstrably has.
 */
export const findModelDescriptor = (
  catalog: readonly ModelDescriptor[],
  ref: Pick<ModelRef, "providerID" | "modelID">,
  harnessId?: string,
): ModelDescriptor | undefined => {
  const candidates = harnessModels(catalog, harnessId).filter((d) => d.modelID === ref.modelID);
  return candidates.find((d) => d.providerID === ref.providerID) ?? candidates[0];
};

/**
 * Validate a model + variant selection against a harness catalog.
 *
 * An empty catalog for the harness means "not discoverable right now", not
 * "no such model": validation defers to the adapter rather than inventing a
 * rejection the user cannot act on.
 */
export function resolveModelSelection(
  catalog: readonly ModelDescriptor[],
  ref: ModelRef | undefined,
  harnessId?: string,
): ModelSelection {
  if (!ref) return { ok: true };
  const known = harnessModels(catalog, harnessId);
  const descriptor = findModelDescriptor(catalog, ref, harnessId);
  const variant = ref.variant?.trim() ? ref.variant : undefined;
  if (!descriptor) {
    if (known.length === 0) return { ok: true, ...(variant ? { variant } : {}) };
    return {
      ok: false,
      code: "invalid-model",
      message: `${ref.modelID} is not available on this engine. Pick a model from the list.`,
    };
  }
  if (!variant) return { ok: true, descriptor };
  const variants = descriptor.variants ?? [];
  if (!variants.includes(variant)) {
    return {
      ok: false,
      code: "invalid-variant",
      message: variants.length
        ? `${descriptor.name} does not offer the "${variant}" thinking level. Choose one of: ${variants.join(", ")}.`
        : `${descriptor.name} does not offer a thinking level.`,
    };
  }
  return { ok: true, descriptor, variant };
}

/**
 * Reconcile a remembered variant against the model that is actually selected.
 * `reconciled` is true when the request could not be honoured, so the caller
 * can show the effective value instead of keeping a stale one.
 */
export function resolveVariantPreference(
  descriptor: Pick<ModelDescriptor, "variants" | "defaultVariant"> | undefined,
  requested: string | undefined,
): { variant?: string; reconciled: boolean } {
  const variants = descriptor?.variants ?? [];
  const wanted = requested?.trim() ? requested : undefined;
  if (variants.length === 0) return { reconciled: wanted !== undefined };
  if (wanted && variants.includes(wanted)) return { variant: wanted, reconciled: false };
  const fallback = descriptor?.defaultVariant && variants.includes(descriptor.defaultVariant)
    ? descriptor.defaultVariant
    : undefined;
  return { ...(fallback ? { variant: fallback } : {}), reconciled: wanted !== undefined };
}
