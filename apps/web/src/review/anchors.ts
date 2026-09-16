// Local review drafts (WP7). Comments anchor to diff hunks by a digest of the
// hunk content (not line numbers), so unrelated edits above don't orphan them;
// when the anchored content changes, the comment surfaces as Outdated instead
// of silently pointing at the wrong code. Pure logic + a localStorage face.
import { hunkDigest, splitHunks, type DiffHunk } from "../../../../packages/git/src/hunks.ts";

export { hunkDigest, splitHunks };
export type { DiffHunk };

export interface ReviewComment {
  id: string;
  path: string;
  digest: string;
  /** New-file line the comment was left near (display only). */
  line: number;
  text: string;
  createdAt: number;
}

export type CommentState = "current" | "outdated";

/** A comment is current while some hunk in its file still carries its digest. */
export function commentState(c: ReviewComment, hunks: DiffHunk[]): CommentState {
  return hunks.some((h) => hunkDigest(h) === c.digest) ? "current" : "outdated";
}

// ---- localStorage face ---------------------------------------------------------

const keyOf = (projectId: string) => `polyth.review.${projectId}`;

export function loadComments(projectId: string): ReviewComment[] {
  try {
    const raw = localStorage.getItem(keyOf(projectId));
    const data = raw ? (JSON.parse(raw) as ReviewComment[]) : [];
    return Array.isArray(data) ? data.filter((c) => c && typeof c.id === "string") : [];
  } catch {
    return [];
  }
}

export function saveComments(projectId: string, comments: ReviewComment[]): void {
  try {
    localStorage.setItem(keyOf(projectId), JSON.stringify(comments.slice(0, 500)));
  } catch { /* storage full or private mode */ }
}
