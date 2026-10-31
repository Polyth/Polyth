import type { SessionProjection } from "@polyth/contracts";
import { SESSION_SUMMARY_FIELDS, sessionDraftPreview } from "@polyth/contracts";

/** Public navigator projection. Durable runtime binding/config and workspace
 * details stay out, but every field the session row needs to resolve its own
 * status — including a pending rate-limit resume, runtime ownership and an
 * in-flight harness switch — is present so the icon is correct immediately.
 * The draft travels only as its bounded first-line preview: `row` is already
 * the reader's own view, so it is their draft. */
export function sessionSummary(row: SessionProjection): SessionProjection {
  return { ...Object.fromEntries(SESSION_SUMMARY_FIELDS.map((key) => [key, row[key]])),
    summary: true, isolationSummary: row.isolation?.kind === "git-worktree" ? "git-worktree" : undefined,
    draftPreview: sessionDraftPreview(row.draft),
  } as SessionProjection;
}
