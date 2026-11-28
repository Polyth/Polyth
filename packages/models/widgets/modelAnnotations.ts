// Model annotations: facts another package knows about a model (data
// handling, licence, region…) that the model lists here should show beside
// the model's name without this package knowing what they mean.
//
// A source registers in its web package's enable hook and disposes on
// teardown; the shell imports the picker (and with it this module), so every
// separately built package shares one registry. Sources return plain data and
// this package draws it with its own primitives, so a contribution can never
// restyle or break a model row. Presentation only: never persisted and never
// model-visible.
import { useSyncExternalStore } from "react";
import type { ModelDescriptor } from "@polyth/contracts";

export type ModelAnnotationTone = "positive" | "notice" | "warning" | "neutral";
export type ModelAnnotationIcon = "shield" | "eye" | "question";

/** The model facts a source may decide on. */
export type ModelAnnotationTarget =
  Pick<ModelDescriptor, "providerID" | "modelID">
  & Partial<Pick<ModelDescriptor, "harnessId" | "cost" | "name">>;

export interface ModelAnnotation {
  /** Stable within its source; the rendered key is `sourceId:key`. */
  key: string;
  tone: ModelAnnotationTone;
  icon: ModelAnnotationIcon;
  /** Short statement: the mark's accessible name and the first tooltip line. */
  label: string;
  /** The details row title ("Data handling"). */
  heading: string;
  /** Optional longer sentence under the label. */
  detail?: string;
  /** Optional quiet line ("Checked 2026-11-27"). */
  meta?: string;
  /** Optional https source link shown in details. */
  href?: string;
  hrefLabel?: string;
  /** Draw the mark beside the name in lists. False keeps it to the details
   *  cards (a reassuring fact that would only add noise to every row). */
  inline: boolean;
}

export interface ModelAnnotationSource {
  id: string;
  annotate: (model: ModelAnnotationTarget) => readonly ModelAnnotation[];
}

export interface ResolvedModelAnnotation extends ModelAnnotation {
  sourceId: string;
}

const sources = new Map<string, ModelAnnotationSource>();
const listeners = new Set<() => void>();
let version = 0;

const emit = (): void => {
  version += 1;
  for (const listener of [...listeners]) listener();
};

/** Register a source; re-registering an id replaces it. Returns the
 *  disposer, which only removes this exact registration. */
export function registerModelAnnotationSource(source: ModelAnnotationSource): () => void {
  sources.set(source.id, source);
  emit();
  return () => {
    if (sources.get(source.id) !== source) return;
    sources.delete(source.id);
    emit();
  };
}

/** A source whose answers changed (its preferences, for example) asks the
 *  model lists to read it again. */
export function notifyModelAnnotationsChanged(): void {
  emit();
}

const safeHref = (href: string | undefined): string | undefined => {
  if (!href) return undefined;
  try {
    return new URL(href).protocol === "https:" ? href : undefined;
  } catch {
    return undefined;
  }
};

/** Every source's annotations for one model, in registration order. A source
 *  that throws contributes nothing instead of breaking the list. */
export function modelAnnotations(model: ModelAnnotationTarget): ResolvedModelAnnotation[] {
  const out: ResolvedModelAnnotation[] = [];
  for (const source of sources.values()) {
    let found: readonly ModelAnnotation[];
    try {
      found = source.annotate(model);
    } catch {
      continue;
    }
    if (!Array.isArray(found)) continue;
    for (const annotation of found) {
      if (!annotation || typeof annotation.label !== "string" || !annotation.label) continue;
      const href = safeHref(annotation.href);
      const { href: _ignored, ...rest } = annotation;
      out.push({ ...rest, ...(href ? { href } : {}), sourceId: source.id });
    }
  }
  return out;
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getVersion = (): number => version;

/** Re-render when any source registers, leaves or changes its answers. */
export function useModelAnnotationsVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/** Test seam: drop every source. */
export function resetModelAnnotationSources(): void {
  if (sources.size === 0) return;
  sources.clear();
  emit();
}
