// Pure, DOM-free core for the IME-safe text input boundary (WP2).
// The AdaptiveTextInput component owns a live uncontrolled <textarea>; this
// module owns the decisions: when a programmatic command may apply, when it
// must defer to an active composition, and how text edits compute.

export interface TextSelection {
  anchor: number;
  head?: number;
}

export type EditorCommand =
  | { kind: "replace"; text: string; selection?: TextSelection; generation: number; silent?: boolean }
  | { kind: "insert"; text: string; generation: number };

/** Composition gate: programmatic writes never interrupt an active IME
 *  composition. Deferred commands apply on compositionend only when they are
 *  newer than the last committed user edit (stale commands are dropped). */
export interface CompositionGate {
  composing: boolean;
  /** bumps on every committed user edit */
  generation: number;
  pending: EditorCommand[];
}

export function createGate(): CompositionGate {
  return { composing: false, generation: 0, pending: [] };
}

export function beginComposition(gate: CompositionGate): void {
  gate.composing = true;
}

/** A committed user edit invalidates older queued programmatic commands. */
export function commitEdit(gate: CompositionGate): number {
  gate.generation += 1;
  return gate.generation;
}

/** Returns "apply" when the command may run now, "defer" when queued. */
export function admitCommand(gate: CompositionGate, cmd: EditorCommand): "apply" | "defer" {
  if (!gate.composing) return "apply";
  gate.pending.push(cmd);
  return "defer";
}

/** End composition; returns deferred commands that are still fresh
 *  (generation >= the latest committed edit), oldest first. */
export function endComposition(gate: CompositionGate): EditorCommand[] {
  gate.composing = false;
  const fresh = gate.pending.filter((c) => c.generation >= gate.generation);
  gate.pending = [];
  return fresh;
}

// ------------------------------------------------------------------ text math

export interface EditResult {
  value: string;
  caret: number;
}

/** Insert `text` at the selection [start, end), returning new value + caret. */
export function insertAt(value: string, text: string, start: number, end: number): EditResult {
  const s = Math.max(0, Math.min(start, value.length));
  const e = Math.max(s, Math.min(end, value.length));
  const next = value.slice(0, s) + text + value.slice(e);
  return { value: next, caret: s + text.length };
}

/** Replace the whole value; selection defaults to the end of the text. */
export function replaceAll(text: string, selection?: TextSelection): EditResult & { selEnd: number } {
  const anchor = selection ? Math.max(0, Math.min(selection.anchor, text.length)) : text.length;
  const head = selection?.head !== undefined ? Math.max(anchor, Math.min(selection.head, text.length)) : anchor;
  return { value: text, caret: anchor, selEnd: head };
}

// ------------------------------------------------------------------ key logic

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  /** KeyboardEvent.isComposing (native) */
  isComposing?: boolean;
  /** legacy IME signal: keydown during composition reports keyCode 229 */
  keyCode?: number;
}

/** True when the key event is part of an IME composition and must never send,
 *  navigate autocomplete, or trigger shortcuts. Covers synthetic events that
 *  drop isComposing but carry keyCode 229 (mobile browsers). */
export function isCompositionKey(e: KeyLike, gateComposing: boolean): boolean {
  return gateComposing || e.isComposing === true || e.keyCode === 229;
}

/** Enter (no Shift) sends, but never during composition. Shift+Enter is a newline. */
export function isSendKey(e: KeyLike, gateComposing: boolean): boolean {
  if (e.key !== "Enter" || e.shiftKey) return false;
  return !isCompositionKey(e, gateComposing);
}
