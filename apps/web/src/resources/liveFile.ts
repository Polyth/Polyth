export type LiveFileKind =
  | "clean"
  | "dirty"
  | "saving"
  | "saved"
  | "external-change"
  | "conflict"
  | "deleted"
  | "check-failed";

export interface LiveFileState {
  kind: LiveFileKind;
  baseRevision?: string;
  diskRevision?: string;
  dirty: boolean;
  noticeDismissed: boolean;
  message?: string;
}

export type LiveFileCheck =
  | { kind: "present"; revision?: string }
  | { kind: "deleted" }
  | { kind: "failed"; message: string };

export function loadedLiveFile(revision?: string): LiveFileState {
  return { kind: "clean", baseRevision: revision, dirty: false, noticeDismissed: false };
}

export function editLiveFile(state: LiveFileState): LiveFileState {
  if (state.kind === "conflict" || state.kind === "external-change" || state.kind === "deleted") {
    return { ...state, dirty: true, noticeDismissed: false };
  }
  // Mid-flight keystrokes keep UI kind "saving" (Save button / autosaveDelay).
  // Physical write serialization lives on Session.persistence, not this kind.
  if (state.kind === "saving") {
    return { ...state, dirty: true, noticeDismissed: false };
  }
  return { kind: "dirty", baseRevision: state.baseRevision, dirty: true, noticeDismissed: false };
}

export function restoreLiveFileBuffer(state: LiveFileState): LiveFileState {
  if (state.kind === "conflict" || state.kind === "external-change") {
    return { ...state, kind: "external-change", dirty: false, noticeDismissed: false };
  }
  if (state.kind === "deleted") return { ...state, dirty: false, noticeDismissed: false };
  return loadedLiveFile(state.baseRevision);
}

export function beginLiveFileSave(state: LiveFileState): LiveFileState {
  return { kind: "saving", baseRevision: state.baseRevision, dirty: true, noticeDismissed: false };
}

/** Exit an in-flight save after a non-conflict failure; buffer stays dirty. */
export function failLiveFileSave(state: LiveFileState): LiveFileState {
  return { kind: "dirty", baseRevision: state.baseRevision, dirty: true, noticeDismissed: false };
}

export function completeLiveFileSave(
  state: LiveFileState,
  revision: string,
  stillDirty = false,
): LiveFileState {
  return {
    kind: stillDirty ? "dirty" : "saved",
    baseRevision: revision,
    dirty: stillDirty,
    noticeDismissed: false,
  };
}

export function conflictLiveFile(state: LiveFileState, diskRevision?: string): LiveFileState {
  return {
    kind: "conflict",
    baseRevision: state.baseRevision,
    ...(diskRevision ? { diskRevision } : {}),
    dirty: true,
    noticeDismissed: false,
  };
}

export function checkLiveFile(state: LiveFileState, check: LiveFileCheck): LiveFileState {
  if (check.kind === "failed") {
    return { ...state, kind: "check-failed", message: check.message, noticeDismissed: false };
  }
  if (check.kind === "deleted") {
    return { ...state, kind: "deleted", dirty: state.dirty, noticeDismissed: false };
  }
  if (!check.revision || !state.baseRevision || check.revision === state.baseRevision) {
    if (state.kind !== "check-failed") return state;
    return {
      kind: state.dirty ? "dirty" : "clean",
      baseRevision: state.baseRevision ?? check.revision,
      dirty: state.dirty,
      noticeDismissed: false,
    };
  }
  return {
    kind: state.dirty ? "conflict" : "external-change",
    baseRevision: state.baseRevision,
    diskRevision: check.revision,
    dirty: state.dirty,
    noticeDismissed: false,
  };
}

export function dismissLiveFileNotice(state: LiveFileState): LiveFileState {
  return { ...state, noticeDismissed: true };
}

export interface AutosaveConditions {
  enabled: boolean;
  editing: boolean;
  composing: boolean;
  readOnly: boolean;
}

export function autosaveDelay(
  state: LiveFileState,
  conditions: AutosaveConditions,
  delayMs = 1_500,
): number | null {
  if (!conditions.enabled || !conditions.editing || conditions.composing || conditions.readOnly) return null;
  return state.kind === "dirty" && state.dirty ? delayMs : null;
}

export type EditorPreviewKind = "markdown" | "html" | "json" | null;

export function previewKindForPath(path: string): EditorPreviewKind {
  if (/\.(md|markdown)$/i.test(path)) return "markdown";
  if (/\.(html?|xhtml)$/i.test(path)) return "html";
  if (/\.json$/i.test(path)) return "json";
  return null;
}

export function initialPreviewVisible(
  path: string,
  openInPreview: boolean,
  byKind?: Partial<Record<"markdown" | "html" | "json", boolean>>,
): boolean {
  const kind = previewKindForPath(path);
  if (kind === null) return false;
  return byKind?.[kind] ?? openInPreview;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/** Inline scripts run only in an opaque sandbox; all network access stays blocked. */
export function htmlPreviewDocument(content: string, baseHref: string): string {
  const head = [
    `<base href="${escapeAttribute(baseHref)}">`,
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">`,
  ].join("\n");
  return `<!doctype html>\n<head>\n${head}\n</head>\n${content}`;
}
