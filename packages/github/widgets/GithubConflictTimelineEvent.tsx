// The conflict-handoff card. The shell's timeline model keeps a boundary row
// for the event (so prompt grouping, search and export stay correct) but no
// longer owns its presentation or strings; the card itself is a package
// contribution to `session.timeline.event`.
import type { SessionEvent } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";

interface GithubConflictData {
  prNumber?: unknown;
  title?: unknown;
  url?: unknown;
  baseRefName?: unknown;
  headRefName?: unknown;
}

export default function GithubConflictTimelineEvent({ host, event }: {
  host: WebPackageHost;
  event: SessionEvent;
}) {
  // The slot may hand this card any timeline event; render only a well-formed
  // handoff. A missing number or link must not become "PR #0" with an empty
  // href (which the browser resolves to the current Polyth page).
  if (event.type !== "github/conflict-resolution-started") return null;
  const data = (event.data ?? {}) as GithubConflictData;
  const prNumber = typeof data.prNumber === "number" && Number.isSafeInteger(data.prNumber) && data.prNumber > 0 ? data.prNumber : 0;
  if (prNumber === 0) return null;
  const title = typeof data.title === "string" ? data.title : "";
  const url = typeof data.url === "string" && /^https:\/\//i.test(data.url) ? data.url : "";
  const baseRefName = typeof data.baseRefName === "string" ? data.baseRefName : "";
  const headRefName = typeof data.headRefName === "string" ? data.headRefName : "";
  const label = host.ui.locale.translate("pullrequestview.fixingPullRequestConflictsValue", { number: prNumber });
  return (
    <article className="msg github-conflict-card" data-msg-id={event.id} aria-label={label}>
      <span className="github-conflict-icon" aria-hidden="true">{host.ui.icons.pullRequest?.() ?? null}</span>
      <div className="github-conflict-copy">
        <strong>{label}</strong>
        <span>{title}</span>
        {baseRefName && headRefName && <code>{baseRefName} ← {headRefName}</code>}
      </div>
      {url && (
        <a className="ui-btn ui-btn--quiet ui-btn--sm" href={url} target="_blank" rel="noreferrer">
          {host.ui.locale.translate("githubview.openOnGithub")} {host.ui.icons.external?.() ?? null}
        </a>
      )}
    </article>
  );
}
