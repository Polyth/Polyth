// Editor intelligence seam: the data-only contract through which an optional
// package feeds completions, hover details and problems into the editor
// without ever touching CodeMirror. The editor package owns CodeMirror; a
// provider owns a language service.
//
// Providers arrive as slot contributions:
//   host.slots.register({
//     slot: "editor.intelligence",
//     id: "code-intelligence.typescript",
//     render: () => null,
//     meta: { provider },
//   })
//
// The contribution payload is untrusted data: `meta.provider` is validated
// here and an invalid contribution is ignored, never thrown. The host exposes
// only `slots.list`, so a package that registers or removes a provider during
// a session announces it with the `polyth:editor-intelligence` window event;
// hosts (and tests) that can observe the slot registry directly may bind a
// `subscribe` instead.
import type { ResourceRef } from "@polyth/web-sdk";
import type {
  EditorCompletions,
  EditorDiagnostic,
  EditorHover,
  EditorPosition,
} from "../src/languageTypes.ts";

/** Everything a provider needs to answer one question about a buffer. The
 *  `content` is the live overlay (unsaved edits included) and
 *  `contentRevision` is the last saved revision it is based on. */
export interface EditorIntelligenceRequest {
  ref: ResourceRef;
  path: string;
  /** Language label from languages.ts, e.g. "TypeScript". */
  language: string;
  content: string;
  contentRevision?: string;
  position: EditorPosition;
}

export interface EditorIntelligenceProvider {
  id: string;
  /** Language labels this provider serves. */
  languages: readonly string[];
  completions?(request: EditorIntelligenceRequest, signal?: AbortSignal): Promise<EditorCompletions | null>;
  hover?(request: EditorIntelligenceRequest, signal?: AbortSignal): Promise<EditorHover | null>;
  diagnostics?(request: EditorIntelligenceRequest, signal?: AbortSignal): Promise<EditorDiagnostic[]>;
}

/** Event a provider package dispatches after registering or removing a
 *  contribution, so editors re-read the slot without a host subscription. */
export const EDITOR_INTELLIGENCE_CHANGED_EVENT = "polyth:editor-intelligence";

interface SlotItemLike {
  id: string;
  order: number;
  meta?: Readonly<Record<string, unknown>>;
}

/** The slice of the host slot registry the editor reads. `subscribe` is
 *  optional: the current host exposes only `list`. */
export interface EditorIntelligenceSlots {
  list(slot: "editor.intelligence"): SlotItemLike[];
  subscribe?(listener: () => void): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A provider-shaped contribution or null. Never trusts a package's payload. */
export function validateEditorIntelligenceProvider(value: unknown): EditorIntelligenceProvider | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  if (!Array.isArray(value.languages) || value.languages.length === 0) return null;
  if (!value.languages.every((language) => typeof language === "string" && language.length > 0)) return null;
  const capabilities = ["completions", "hover", "diagnostics"] as const;
  const present = capabilities.filter((capability) => typeof value[capability] === "function");
  if (present.length === 0) return null;
  const provider: EditorIntelligenceProvider = {
    id: value.id,
    languages: Object.freeze([...(value.languages as string[])]),
  };
  for (const capability of present) {
    (provider as unknown as Record<string, unknown>)[capability] = value[capability];
  }
  return provider;
}

let slots: EditorIntelligenceSlots | null = null;
let offSlots: (() => void) | null = null;
const listeners = new Set<() => void>();

function bump(): void {
  for (const listener of [...listeners]) listener();
}

function readProviders(): EditorIntelligenceProvider[] {
  if (!slots) return [];
  let items: SlotItemLike[];
  try {
    items = slots.list("editor.intelligence");
  } catch {
    return [];
  }
  const providers: EditorIntelligenceProvider[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== "string") continue;
    const provider = validateEditorIntelligenceProvider(item.meta?.provider);
    if (!provider || seen.has(provider.id)) continue;
    seen.add(provider.id);
    providers.push(provider);
  }
  return providers;
}

/** Bind the host slot registry once (from widgets/index.tsx) and re-read the
 *  providers whenever a registration changes. Disposal removes the binding
 *  and its subscription. */
export function bindEditorIntelligenceSlots(next: EditorIntelligenceSlots | null): () => void {
  offSlots?.();
  offSlots = null;
  slots = next;
  if (next?.subscribe) {
    try {
      offSlots = next.subscribe(bump);
    } catch {
      offSlots = null;
    }
  }
  bump();
  return () => {
    if (slots !== next) return;
    offSlots?.();
    offSlots = null;
    slots = null;
    bump();
  };
}

/** Re-read the slot after a registration change that the host cannot report
 *  through `subscribe` (a package dispatches EDITOR_INTELLIGENCE_CHANGED_EVENT). */
export function notifyEditorIntelligenceChanged(): void {
  bump();
}

export function subscribeEditorIntelligence(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Providers that serve one language label, in registry order. */
export function editorIntelligenceProvidersFor(language: string): EditorIntelligenceProvider[] {
  return readProviders().filter((provider) => provider.languages.includes(language));
}

if (typeof window !== "undefined") {
  const onChanged = (): void => bump();
  window.addEventListener(EDITOR_INTELLIGENCE_CHANGED_EVENT, onChanged);
}
