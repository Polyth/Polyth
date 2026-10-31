/** Pure, browser-safe: what text one edit-tool call left in each file.
 *
 * A fragment is the text the edit wrote plus which of its lines the edit
 * actually changed (context lines an Edit/patch repeats are not "written").
 * Change attribution finds a fragment in the current file and claims only its
 * written lines, so a later small edit never steals a whole block.
 */
import type { JsonObject, JsonValue } from "@polyth/contracts";
import { looksLikeDiff, parseDiffRows, splitFileDiffs, toDiffLines, unifiedDiff } from "../../../../apps/web/src/diff.ts";

export interface EditFragment {
  /** Text present in the file right after the edit. */
  text: string;
  /** 0-based line offsets within `text` the edit wrote; null means every line. */
  written: readonly number[] | null;
  /** Lines the edit removed (attributes deletions). */
  removed: readonly string[];
}

export interface FileFragments {
  /** Path as the tool wrote it (absolute or relative). */
  path: string;
  fragments: EditFragment[];
}

const PATH_KEYS = ["filePath", "file_path", "path", "file", "target", "TargetFile", "AbsolutePath", "NotebookPath"] as const;
const OLD_KEYS = ["oldString", "old_string", "old_text", "oldText", "before", "TargetContent"] as const;
const NEW_KEYS = ["newString", "new_string", "new_text", "newText", "after", "ReplacementContent"] as const;
const CONTENT_KEYS = ["content", "CodeContent", "file_text"] as const;
const PATCH_KEYS = ["patch", "patchText", "patch_text", "diff"] as const;
const EDIT_LIST_KEYS = ["edits", "replacements", "ReplacementChunks"] as const;

const recordOf = (value: JsonValue | undefined): JsonObject | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value : undefined;

function firstString(input: JsonObject, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function firstPath(input: JsonObject): string | undefined {
  const value = firstString(input, PATH_KEYS);
  return value?.trim() ? value.trim() : undefined;
}

/** Fragments of one unified (or apply_patch) diff body: one per hunk. */
export function fragmentsFromDiff(diff: string): EditFragment[] {
  const fragments: EditFragment[] = [];
  let lines: string[] = [];
  let written: number[] = [];
  let removed: string[] = [];
  let open = false;
  const flush = () => {
    if (open && (written.length > 0 || removed.length > 0)) {
      fragments.push({ text: lines.join("\n"), written, removed });
    }
    lines = [];
    written = [];
    removed = [];
  };
  for (const row of parseDiffRows(diff)) {
    if (row.kind === "hunk") {
      flush();
      open = true;
      continue;
    }
    if (row.kind === "meta") continue;
    open = true;
    const body = row.text.slice(1);
    if (row.kind === "ctx") lines.push(body);
    else if (row.kind === "add") {
      written.push(lines.length);
      lines.push(body);
    } else removed.push(body);
  }
  flush();
  return fragments;
}

/** One replacement (`old_string` → `new_string`): only differing lines are written. */
export function fragmentFromReplace(before: string, after: string): EditFragment | null {
  if (before === after) return null;
  if (!before) return { text: after, written: null, removed: [] };
  if (!after) return { text: "", written: [], removed: toDiffLines(before) };
  // New-side line numbers of the snippet diff index straight into `after`.
  const written: number[] = [];
  const removed: string[] = [];
  for (const row of parseDiffRows(unifiedDiff(before, after, "file"))) {
    if (row.kind === "add" && row.newLine !== undefined) written.push(row.newLine - 1);
    else if (row.kind === "del") removed.push(row.text.slice(1));
  }
  return { text: after, written, removed };
}

/**
 * Every file an edit-tool payload wrote and the fragments it left there.
 * Unknown shapes return nothing; callers still treat `changedFiles` as edited.
 */
export function toolEditFragments(input: JsonObject, metadata?: JsonObject): FileFragments[] {
  const byPath = new Map<string, EditFragment[]>();
  const add = (path: string | undefined, fragment: EditFragment | null) => {
    if (!path || !fragment) return;
    const list = byPath.get(path) ?? [];
    list.push(fragment);
    byPath.set(path, list);
  };
  const path = firstPath(input);

  // Codex: `changes: [{ path, kind: { type }, diff }]`; an add/delete carries raw content.
  const changes = Array.isArray(input.changes) ? input.changes : Array.isArray(metadata?.changes) ? metadata!.changes as JsonValue[] : [];
  for (const raw of changes) {
    const change = recordOf(raw);
    const changePath = typeof change?.path === "string" ? change.path : undefined;
    const diff = typeof change?.diff === "string" ? change.diff : undefined;
    if (!change || !changePath || diff === undefined) continue;
    const kind = recordOf(change.kind)?.type ?? change.kind;
    if (looksLikeDiff(diff)) for (const fragment of fragmentsFromDiff(diff)) add(changePath, fragment);
    else if (kind === "delete") add(changePath, { text: "", written: [], removed: toDiffLines(diff) });
    else add(changePath, { text: diff, written: null, removed: [] });
  }
  if (byPath.size > 0) return [...byPath].map(([file, fragments]) => ({ path: file, fragments }));

  // Unified or apply_patch text, possibly covering several files.
  const patch = firstString(input, PATCH_KEYS) ?? (metadata ? firstString(metadata, PATCH_KEYS) : undefined);
  if (patch?.trim() && looksLikeDiff(patch)) {
    for (const file of splitFileDiffs(patch, path ?? "file")) {
      for (const fragment of fragmentsFromDiff(file.diff)) add(file.path, fragment);
    }
    if (byPath.size > 0) return [...byPath].map(([file, fragments]) => ({ path: file, fragments }));
  }

  // Multi-edit lists (MultiEdit, Antigravity replacement chunks).
  for (const key of EDIT_LIST_KEYS) {
    const list = input[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const edit = recordOf(item);
      if (!edit) continue;
      const before = firstString(edit, OLD_KEYS);
      const after = firstString(edit, NEW_KEYS);
      if (before === undefined && after === undefined) continue;
      add(path, fragmentFromReplace(before ?? "", after ?? ""));
    }
  }
  if (byPath.size > 0) return [...byPath].map(([file, fragments]) => ({ path: file, fragments }));

  const before = firstString(input, OLD_KEYS);
  const after = firstString(input, NEW_KEYS);
  if (before !== undefined || after !== undefined) {
    add(path, fragmentFromReplace(before ?? "", after ?? ""));
  } else {
    const content = firstString(input, CONTENT_KEYS);
    if (content !== undefined) add(path, { text: content, written: null, removed: [] });
  }
  return [...byPath].map(([file, fragments]) => ({ path: file, fragments }));
}
