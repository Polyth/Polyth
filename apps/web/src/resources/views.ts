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

/** Who made a highlighted change: a CSS colour and a spoken/tooltip label. */
export interface EditorChangeTone {
  /** CSS colour, e.g. `var(--session-tone-2)`; resolved inside the owner's DOM. */
  color: string;
  label: string;
  /** Attributed changes tint their lines; unattributed ones mark only the gutter. */
  attributed: boolean;
}

/** One reviewable change region of the current text (a Git hunk). */
export interface EditorChangeHunk {
  /** Stable id within its set; echoed back through `onAction`. */
  id: string;
  /** Added or replaced lines (1-based in `baseText`) and their owner tone. */
  lines: ReadonlyArray<{ line: number; tone: number }>;
  /** Removed text, drawn inline before `line` (`baseText` line count + 1 = end). */
  removed: ReadonlyArray<{ line: number; text: readonly string[]; tone: number }>;
  /** Line the hunk's inline actions sit on. */
  anchorLine: number;
  label: string;
  /** Nobody the owner tracks made this change: draw it without inline actions. */
  plain?: boolean;
}

/** Change highlighting a resource owner (Files) supplies. The editor only
 *  draws it: line numbers refer to `baseText`, and a document that no longer
 *  equals `baseText` keeps its previous marks mapped through the edits. */
export interface EditorChangeSet {
  /** Identity: the editor rebuilds its marks only when this changes. */
  key: string;
  baseText: string;
  tones: readonly EditorChangeTone[];
  hunks: readonly EditorChangeHunk[];
  /** Inline action labels; without them no per-change actions are drawn. */
  actions?: { undo: string; keep: string; inspect: string };
  /** `moreRemoved` summarizes a long removed block; `{count}` is replaced. */
  labels?: { moreRemoved: string };
  onAction?: (hunkId: string, action: "undo" | "keep" | "inspect") => void;
}

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
  /** Owner-supplied change highlighting. `undefined` keeps the editor's own
   *  Git gutter; `null` or a set means the owner draws changes itself. */
  changes?: EditorChangeSet | null;
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

export interface EditorCursorSnapshot { resource: ResourceRef; line: number; column: number }
let editorCursor: EditorCursorSnapshot | null = null;
const cursorListeners = new Set<() => void>();
/** Observed caret position is presentation state, independent of one-shot reveals. */
export function reportEditorCursor(resource: ResourceRef, position: { line: number; column: number } | null): void {
  if (!position) {
    if (!editorCursor || resourceKey(editorCursor.resource) !== resourceKey(resource)) return;
    editorCursor = null;
  } else {
    if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.column) || position.line < 1 || position.column < 1) return;
    if (editorCursor && resourceKey(editorCursor.resource) === resourceKey(resource)
      && editorCursor.line === position.line && editorCursor.column === position.column) return;
    editorCursor = { resource: { ...resource }, ...position };
  }
  for (const listener of cursorListeners) listener();
}
export function getEditorCursor(): EditorCursorSnapshot | null { return editorCursor; }
export function subscribeEditorCursor(listener: () => void): Unregister {
  cursorListeners.add(listener);
  return () => { cursorListeners.delete(listener); };
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
