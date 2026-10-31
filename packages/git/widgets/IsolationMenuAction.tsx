import { useEffect, useState } from "react";
import type { IsolationStatusDto, Project, SessionStatus } from "@polyth/contracts";
import { isManagedIsolationBranch, isolationBlocksUserMutation, projectIsolationLevel, SESSION_PURPOSE_CONVERSATION } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { reportGitError } from "./gitRefusal.ts";
import { activateSession, upsertSession, useStore } from "../../../apps/web/src/store.ts";
import { announce } from "../../../apps/web/src/components/a11y/announce.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { CombineIcon, Icon, LockIcon, UndoIcon, confirmAlert } from "../../../apps/web/src/components/ui/index.ts";

/** Same wording as the isolation card: a nested child merges into its
 *  parent's managed workspace, whose branch name means nothing to a person. */
const targetLabel = (branch: string): string =>
  isManagedIsolationBranch(branch) ? tr("isolation.parentWorkspace") : branch;

type Choice =
  | { kind: "return"; branch: string }
  | { kind: "integrate"; branch: string }
  /** Changes exist but the card has to explain something first (conflict,
   *  delegated work, an unavailable destination). */
  | { kind: "open"; branch: string };

/** Decide from a live status read; null when the menu has nothing to offer. */
export function isolationMenuChoice(status: IsolationStatusDto, sessionStatus: SessionStatus | undefined): Choice | null {
  const isolation = status.isolation;
  if (!isolation || !status.suggestion) return null;
  const state = status.effectiveState ?? isolation.state;
  if (state !== "active" && state !== "merge-ready" && state !== "conflict") return null;
  if (sessionStatus && isolationBlocksUserMutation(sessionStatus)) return null;
  // Servers predating `actions` (and `/return`) get no menu entry.
  if (!status.actions) return null;
  const branch = targetLabel(isolation.targetBranch);
  if (!status.suggestion.hasChanges) return status.actions.canDiscard ? { kind: "return", branch } : null;
  return status.actions.canMerge && state !== "conflict" ? { kind: "integrate", branch } : { kind: "open", branch };
}

/** Whether an ordinary chat may be moved into its own isolated workspace:
 *  the project offers isolation, works on this machine, and the chat is at
 *  rest. The server re-checks everything (Git checkout, membership, runtime). */
export function canIsolateSession(
  project: Pick<Project, "defaults" | "remote"> | undefined,
  sessionStatus: SessionStatus | undefined,
): boolean {
  if (!project || project.remote) return false;
  if (projectIsolationLevel(project.defaults) === "off") return false;
  if (!sessionStatus || sessionStatus === "archived") return false;
  return !isolationBlocksUserMutation(sessionStatus);
}

/** Move an ordinary chat into its own isolated workspace, branched from the
 *  checkout it works in now; merge-back later returns there. */
function IsolateSessionItem({ sessionId, closeMenu }: { sessionId: string; closeMenu?: () => void }) {
  const run = async () => {
    closeMenu?.();
    if (!await confirmAlert(tr("isolation.moveConfirm"), {
      title: tr("isolation.moveTitle"),
      confirmLabel: tr("isolation.moveAction"),
      destructive: false,
    })) return;
    try {
      const result = await api.isolationIsolate(sessionId);
      upsertSession(result.session);
      announce(tr("isolation.moved", { branch: targetLabel(result.targetBranch) }));
    } catch (cause) {
      reportGitError(tr("common.error"), cause);
    }
  };
  return (
    <button type="button" role="menuitem" className="ui-menu-item" onClick={() => void run()}>
      <Icon icon={LockIcon} size="sm" />
      <span className="ui-menu-item-copy"><span className="ui-menu-item-label">{tr("isolation.moveToIsolation")}</span></span>
    </button>
  );
}

/**
 * Session-menu entry for a session working in an isolated workspace. With
 * nothing to integrate it returns the session to its original workspace;
 * with changes it runs the same integration as the card's primary button
 * (commit, merge, return, clean up). The status is read when the menu opens,
 * and the server re-checks it, so a stale menu cannot discard work. An
 * ordinary chat is offered the move into isolation instead.
 */
export function IsolationMenuAction({ sessionId, status: sessionStatus, closeMenu }: {
  sessionId: string;
  status?: SessionStatus;
  closeMenu?: () => void;
}) {
  // Rows the store knows to be ordinary skip the status read entirely.
  const known = useStore((state) => {
    const session = state.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return "unknown" as const;
    return session.isolation?.kind === "git-worktree" || session.isolationSummary === "git-worktree"
      ? "isolated" as const
      : "plain" as const;
  });
  const isolatable = useStore((state) => {
    const session = state.sessions.find((candidate) => candidate.id === sessionId);
    if (!session || session.purpose === SESSION_PURPOSE_CONVERSATION) return false;
    return canIsolateSession(state.projectRegistry.projects.find((project) => project.id === session.projectId), sessionStatus ?? session.status);
  });
  const [status, setStatus] = useState<IsolationStatusDto | null>(null);
  const [loading, setLoading] = useState(known !== "plain");

  useEffect(() => {
    if (known === "plain") return;
    let live = true;
    setLoading(true);
    api.isolationStatus(sessionId)
      .then((next) => { if (live) setStatus(next); })
      .catch(() => { if (live) setStatus(null); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sessionId, known]);

  if (known === "plain") return isolatable ? <IsolateSessionItem sessionId={sessionId} {...(closeMenu ? { closeMenu } : {})} /> : null;
  if (loading) {
    // Only a session the store already knows is isolated earns a placeholder.
    if (known !== "isolated") return null;
    return (
      <button type="button" role="menuitem" className="ui-menu-item" disabled aria-busy="true">
        <span className="ui-spinner ui-spinner--sm" aria-hidden="true" />
        <span className="ui-menu-item-copy"><span className="ui-menu-item-label">{tr("isolation.checking")}</span></span>
      </button>
    );
  }
  const choice = status ? isolationMenuChoice(status, sessionStatus) : null;
  if (!choice) return null;

  const run = async () => {
    closeMenu?.();
    if (choice.kind === "open") {
      // The isolation card in the session explains what blocks integration.
      activateSession(sessionId);
      return;
    }
    if (choice.kind === "return") {
      try {
        upsertSession(await api.isolationReturn(sessionId));
        announce(tr("timeline.returnedFromIsolation"));
      } catch (cause) {
        reportGitError(tr("common.error"), cause);
      }
      return;
    }
    if (!await confirmAlert(tr("isolation.integrateConfirm", { branch: choice.branch }), {
      title: tr("isolation.integrateInto", { branch: choice.branch }),
      confirmLabel: tr("isolation.merge"),
      destructive: false,
    })) return;
    try {
      const result = await api.isolationMerge(sessionId);
      upsertSession(result.session);
      announce(tr("isolation.mergedIntoBranch", { branch: choice.branch }));
    } catch (cause) {
      reportGitError(tr("common.error"), cause);
    }
  };

  const label = choice.kind === "return"
    ? tr("isolation.returnTo", { branch: choice.branch })
    : tr("isolation.integrateInto", { branch: choice.branch }) + (choice.kind === "open" ? "…" : "");
  return (
    <button type="button" role="menuitem" className="ui-menu-item" onClick={() => void run()}>
      <Icon icon={choice.kind === "return" ? UndoIcon : CombineIcon} size="sm" />
      <span className="ui-menu-item-copy"><span className="ui-menu-item-label">{label}</span></span>
    </button>
  );
}
