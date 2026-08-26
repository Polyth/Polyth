import type { AttachmentRef } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { addAttachment, MAX_PENDING_ATTACHMENTS } from "../../../apps/web/src/attachments.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

export interface GithubUrlParts {
  owner: string;
  repo: string;
  kind: "pull" | "issues";
  number: number;
  url: string;
}

/** Parse a lone GitHub PR/issue URL. */
export function parseGithubUrl(text: string): GithubUrlParts | null {
  const value = text.trim();
  const match = value.match(
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)(?:[/#?].*)?$/,
  );
  if (!match) return null;
  const number = Number(match[4]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return {
    owner: match[1]!,
    repo: match[2]!,
    kind: match[3] as "pull" | "issues",
    number,
    url: value,
  };
}

/** True when the pasted URL points at this project's GitHub remote. */
export function githubUrlMatchesRepo(
  parts: GithubUrlParts,
  repo: { owner: string; name: string } | null | undefined,
): boolean {
  if (!repo) return false;
  return repo.owner.toLowerCase() === parts.owner.toLowerCase()
    && repo.name.toLowerCase() === parts.repo.toLowerCase();
}

/** Build the pill for a matching GitHub URL. Link-only: nothing is fetched. */
export function githubUrlRef(parts: GithubUrlParts): AttachmentRef {
  return {
    id: crypto.randomUUID(),
    name: `${parts.kind === "pull" ? "PR" : tr("common.issue")} #${parts.number}`,
    mime: "text/uri-list",
    size: 0,
    kind: "url",
    url: parts.url,
  };
}

export type GithubAttachResult =
  | { ok: true; ref: AttachmentRef }
  | {
      ok: false;
      code: "invalid-url" | "no-repo" | "repo-mismatch" | "limit" | "request-failed";
      reason: string;
    };

/** Classify a link attempt while preserving probe failures as their own state. */
export function classifyGithubAttach(
  parts: GithubUrlParts | null,
  probe: { ok: true; repo: { owner: string; name: string } | null } | { ok: false; reason: string },
): { code: "ok" } | {
  code: "invalid-url" | "no-repo" | "repo-mismatch" | "request-failed";
  reason: string;
} {
  if (!parts) {
    return { code: "invalid-url", reason: tr("attachments.enterAGithubIssueOrPullRequestUrl") };
  }
  if (!probe.ok) {
    return {
      code: "request-failed",
      reason: tr("attachments.couldnTCheckTheProjectRepositoryValue", {
        reason: probe.reason,
      }),
    };
  }
  if (!probe.repo) {
    return {
      code: "no-repo",
      reason: tr("attachments.activeProjectHasNoDetectedGithubRepository"),
    };
  }
  if (!githubUrlMatchesRepo(parts, probe.repo)) {
    return {
      code: "repo-mismatch",
      reason: tr("attachments.linkPointsAtValueNotThisProjectRepositoryValue", {
        linkedRepo: `${parts.owner}/${parts.repo}`,
        projectRepo: `${probe.repo.owner}/${probe.repo.name}`,
      }),
    };
  }
  return { code: "ok" };
}

export async function attachGithubLink(
  projectId: string,
  sessionId: string | null | undefined,
  text: string,
): Promise<GithubAttachResult> {
  const parts = parseGithubUrl(text);
  let probe: { ok: true; repo: { owner: string; name: string } | null } | {
    ok: false;
    reason: string;
  };
  if (!parts) {
    probe = { ok: true, repo: null };
  } else {
    const response = await api.githubRepo(projectId);
    probe = response.ok
      ? { ok: true, repo: response.data }
      : { ok: false, reason: response.reason };
  }
  const verdict = classifyGithubAttach(parts, probe);
  if (verdict.code !== "ok") return { ok: false, code: verdict.code, reason: verdict.reason };
  const ref = githubUrlRef(parts!);
  if (!addAttachment(sessionId, ref)) {
    return {
      ok: false,
      code: "limit",
      reason: tr("attachments.atMostValueAttachmentsPerMessage", {
        count: MAX_PENDING_ATTACHMENTS,
      }),
    };
  }
  return { ok: true, ref };
}

/** Turn a lone matching GitHub PR/issue URL into a composer pill. */
export async function tryAttachGithubUrl(
  projectId: string,
  sessionId: string | null | undefined,
  text: string,
): Promise<boolean> {
  const result = await attachGithubLink(projectId, sessionId, text);
  return result.ok;
}
