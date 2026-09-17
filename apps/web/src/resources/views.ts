import { createElement, Suspense, type ComponentType, type ReactNode } from "react";
import type { ResourceRef, Unregister } from "@polyth/web-sdk";
import { resourceKey } from "@polyth/web-sdk";
import { getActiveProfileId } from "../workbench/store.ts";
import { describeResource } from "./providers.ts";

export type ResourceViewKind = "editor" | "viewer" | "diff";

export interface ResourceViewMatch {
  ref: ResourceRef;
  descriptor: { label: string; kind: string };
  profileId: string;
}

export interface ResourceViewProps {
  ref: ResourceRef;
  descriptor: { label: string; kind: string };
  visible: boolean;
  selection: { startLine: number; endLine: number; column?: number } | null;
  onSelectionConsumed: () => void;
}

export interface ResourceViewDefinition {
  id: string;
  label: string;
  kind: ResourceViewKind;
  score(match: ResourceViewMatch): number;
  component: ComponentType<ResourceViewProps>;
}

const views = new Map<string, ResourceViewDefinition>();
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const listener of [...listeners]) listener();
}

export function registerResourceView(definition: ResourceViewDefinition): Unregister {
  views.set(definition.id, definition);
  bump();
  return () => {
    if (views.get(definition.id) === definition) {
      views.delete(definition.id);
      bump();
    }
  };
}

export function listResourceViews(): readonly ResourceViewDefinition[] {
  return [...views.values()];
}

export function resourceViewCandidates(ref: ResourceRef): readonly ResourceViewDefinition[] {
  const descriptor = describeResource(ref);
  if (!descriptor) return [];
  const match: ResourceViewMatch = {
    ref,
    descriptor,
    profileId: getActiveProfileId(),
  };
  return [...views.values()]
    .map((view) => ({ view, score: view.score(match) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.view);
}

export function subscribeResourceViews(listener: () => void): Unregister {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function resourceViewsVersion(): number {
  return version;
}

/** Editor group surface registered by @polyth/editor. Files never imports CodeMirror. */
let editorSurface: ComponentType<EditorSurfaceProps> | null = null;

export interface EditorSurfaceProps {
  groupId: string;
  resource: ResourceRef;
  path: string;
  readOnly?: boolean;
  wrap?: boolean;
  ariaLabel?: string;
  visible: boolean;
  authoritativeGeneration?: number;
  onSave?: () => void;
  onReady?: () => void;
  reveal?: { startLine: number; endLine: number } | null;
  onRevealConsumed?: () => void;
}

export function registerEditorSurface(component: ComponentType<EditorSurfaceProps>): Unregister {
  editorSurface = component;
  bump();
  return () => {
    if (editorSurface === component) editorSurface = null;
    bump();
  };
}

export function EditorSurfaceSlot(props: EditorSurfaceProps): ReactNode {
  if (!editorSurface) return null;
  return createElement(Suspense, { fallback: null }, createElement(editorSurface, props));
}

type EditorSelection = { text: string; startLine: number; endLine: number } | null;
let selectionReader: ((docKey: string) => EditorSelection) | null = null;

export function registerEditorSelection(reader: (docKey: string) => EditorSelection): Unregister {
  selectionReader = reader;
  return () => {
    if (selectionReader === reader) selectionReader = null;
  };
}

export function readEditorSelection(ref: ResourceRef): EditorSelection {
  return selectionReader?.(resourceKey(ref)) ?? null;
}

let selectionReplacer: ((docKey: string, replacement: string, expectedText: string) => boolean) | null = null;

export function registerEditorReplace(
  replacer: (docKey: string, replacement: string, expectedText: string) => boolean,
): Unregister {
  selectionReplacer = replacer;
  return () => {
    if (selectionReplacer === replacer) selectionReplacer = null;
  };
}

export function replaceEditorSelection(
  ref: ResourceRef,
  replacement: string,
  expectedText: string,
): boolean {
  return selectionReplacer?.(resourceKey(ref), replacement, expectedText) ?? false;
}
