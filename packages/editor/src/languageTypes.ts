/** Browser-safe DTOs shared by the editor language client and server routes.
 * This file intentionally has no Node or filesystem imports. */

export type EditorLanguageCapability = "definition" | "references" | "rename" | "completion" | "hover" | "diagnostics";

export interface EditorPosition {
  line: number;
  character: number;
}

export interface EditorRange {
  start: EditorPosition;
  end: EditorPosition;
}

export interface EditorLocation {
  projectId: string;
  sessionId: string | null;
  repositoryId: string;
  path: string;
  range: EditorRange;
}

export interface EditorDefinition extends EditorLocation {
  name?: string;
  kind?: string;
}

export interface EditorReference extends EditorLocation {
  isDefinition?: boolean;
}

export interface EditorRenameTarget extends EditorLocation {
  expectedRevision: string;
}

export interface EditorRenamePreview {
  oldName: string;
  newName: string;
  targets: EditorRenameTarget[];
}

export interface EditorLanguageRequest {
  projectId: string;
  sessionId?: string | null;
  repositoryId: string;
  path: string;
  position: EditorPosition;
  /** Versioned live buffer overlay; bytes never leave the request scope. */
  content?: string;
  contentRevision?: string;
}

export type EditorCompletionKind =
  | "keyword" | "variable" | "constant" | "function" | "method" | "property"
  | "class" | "interface" | "type" | "enum" | "module" | "text";

export interface EditorCompletionItem {
  label: string;
  kind: EditorCompletionKind;
  /** Short type or signature shown beside the label (plain text). */
  detail?: string;
  /** Language-service ordering key; lower sorts first. */
  sortText?: string;
  /** Text to insert when it differs from the label. */
  insertText?: string;
}

export interface EditorCompletions {
  /** Start of the word being completed; the range ends at the request position. */
  from: EditorPosition;
  items: EditorCompletionItem[];
  /** True when the service had more items than the response limit. */
  incomplete?: boolean;
}

export interface EditorHover {
  range: EditorRange;
  /** Type or signature line, plain text. */
  display: string;
  /** Documentation, plain text. */
  documentation?: string;
}

export type EditorDiagnosticSeverity = "error" | "warning" | "info";

export interface EditorDiagnostic {
  range: EditorRange;
  severity: EditorDiagnosticSeverity;
  message: string;
  /** Language-service code (TypeScript error number). */
  code?: number;
}

export interface EditorLanguageResponse {
  capability: EditorLanguageCapability;
  definitions?: EditorDefinition[];
  references?: EditorReference[];
  rename?: EditorRenamePreview;
  /** `completion`: candidates at the request position (null: none). */
  completions?: EditorCompletions | null;
  /** `hover`: what the symbol at the request position is (null: nothing). */
  hover?: EditorHover | null;
  /** `diagnostics`: problems in the whole document; the position is ignored. */
  diagnostics?: EditorDiagnostic[];
  unavailable?: "language" | "symbol" | "readonly";
  message?: string;
}

export interface EditorRenameApplyRequest {
  projectId: string;
  sessionId?: string | null;
  repositoryId: string;
  newName: string;
  targets: EditorRenameTarget[];
}

export interface EditorRenameApplyResponse {
  ok: boolean;
  applied: string[];
  failed?: { path: string; reason: string }[];
}
