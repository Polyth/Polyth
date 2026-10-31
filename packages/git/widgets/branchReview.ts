export type ReviewScope = "working" | "branch";
/** What the Changes tab shows. Conflicts is offered only while the session's
 *  isolation is in conflict and is never remembered as a preference. */
export type ReviewView = ReviewScope | "conflicts";
export const defaultReviewScope = (isolated: boolean, preference?: ReviewScope): ReviewScope =>
  preference ?? (isolated ? "branch" : "working");

export interface ReviewIdentity {
  project: string;
  repository: string;
  workspace: string;
  base: string;
  head: string;
}
export interface BranchReviewNote {
  id: string;
  path: string;
  text: string;
  excerpt: string;
  digest: string;
  line: number;
  mergeBase: string;
  head: string;
  createdAt: number;
  outdated?: boolean;
}
export const reviewNoteKey = (identity: ReviewIdentity): string =>
  `git-branch-notes:${[identity.project, identity.repository, identity.workspace, identity.base, identity.head].map(encodeURIComponent).join(":")}`;
export const capReviewExcerpt = (excerpt: string): string => excerpt.split("\n").slice(0, 12).join("\n");
export const markOutdatedNotes = (notes: BranchReviewNote[], path: string, digests: readonly string[]): BranchReviewNote[] =>
  notes.map((note) => note.path === path ? { ...note, outdated: !digests.includes(note.digest) } : note);
const markdownText = (value: string) => value.replace(/[\\`*_[\]<>]/g, "\\$&");
export function reviewNotesMarkdown(notes: readonly BranchReviewNote[], identity?: { head: string; base: string; mergeBase: string }): string {
  const current = notes.filter((note) => !note.outdated);
  if (!current.length) return "";
  const heading = identity ? `Review notes: ${markdownText(identity.head)} vs ${markdownText(identity.base)} (${identity.mergeBase.slice(0, 8)})\n\n` : "";
  const entries = current.map((note, index) => {
    const excerpt = capReviewExcerpt(note.excerpt);
    const runs = excerpt.match(/`+/g) ?? [];
    const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
    const label = `${note.path.replace(/[\r\n]/g, " ")}:${note.line}`;
    const ticks = "`".repeat(Math.max(1, ...(label.match(/`+/g) ?? []).map((run) => run.length + 1)));
    return `${index + 1}. ${ticks}${label}${ticks} — ${note.text}\n\n${fence}diff\n${excerpt}\n${fence}`;
  }).join("\n\n");
  const outdated = notes.length - current.length;
  return `${heading}${entries}${outdated ? `\n\n${outdated} outdated notes excluded.` : ""}`;
}
