// A line comment on a diff, written as the markdown block the composer takes:
// `path:line` (or `path:start-end`), the first few affected diff lines as a
// fenced diff, then the comment. Pure, so the shape is tested without a DOM.
import type { DiffLine } from "./diffLines.ts";

export const COMMENT_SNIPPET_LINES = 5;

export interface LineComment {
  path: string;
  /** The rows the comment covers, in diff order (already ordered start..end). */
  lines: readonly DiffLine[];
  text: string;
}

const MARK = { add: "+", del: "-", ctx: " " } as const;

/** The number a reviewer would quote: the new file's line, else the old one. */
export const commentLineNumber = (line: DiffLine): number | undefined => line.newLine ?? line.oldLine;

export const commentable = (line: DiffLine | undefined): line is DiffLine =>
  Boolean(line) && (line!.kind === "add" || line!.kind === "del" || line!.kind === "ctx");

export function commentTarget(path: string, lines: readonly DiffLine[]): string {
  const numbers = lines.map(commentLineNumber).filter((n): n is number => n !== undefined);
  const label = path.replace(/[\r\n]/g, " ");
  if (numbers.length === 0) return label;
  const start = Math.min(...numbers);
  const end = Math.max(...numbers);
  return start === end ? `${label}:${start}` : `${label}:${start}-${end}`;
}

export function lineCommentMarkdown(comment: LineComment): string {
  const covered = comment.lines.filter(commentable);
  const snippet = covered.slice(0, COMMENT_SNIPPET_LINES).map((line) => `${MARK[line.kind as "add" | "del" | "ctx"]}${line.text}`).join("\n");
  const runs = snippet.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  const head = commentTarget(comment.path, covered);
  return `${head}\n\n${fence}diff\n${snippet}\n${fence}\n\n${comment.text.trim()}`;
}
