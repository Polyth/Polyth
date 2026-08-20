// Local review drafts (WP7). Comments anchor to diff hunks by a digest of the
// hunk content (not line numbers), so unrelated edits above don't orphan them;
// when the anchored content changes, the comment surfaces as Outdated instead
// of silently pointing at the wrong code. Pure logic + a localStorage face.

export interface DiffHunk {
  /** Raw @@ header line. */
  header: string;
  /** Hunk body lines (context, +, -) excluding the header. */
  body: string[];
  /** New-file start line parsed from the header (for jump links). */
  startNew: number;
}

export function splitHunks(diff: string): DiffHunk[] {
  const out: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  for (const line of diff.split("\n")) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { header: line, body: [], startNew: Number(m[1]) };
      continue;
    }
    if (cur && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "")) {
      // File headers (+++/---) never appear inside a hunk body.
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      cur.body.push(line);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** FNV-1a 32-bit over the hunk body. Line-number independent: the identity is
 *  the changed content itself. */
export function hunkDigest(h: DiffHunk): string {
  let hash = 0x811c9dc5;
  const text = h.body.join("\n");
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

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
