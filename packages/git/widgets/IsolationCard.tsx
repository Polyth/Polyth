import { useCallback, useEffect, useRef, useState } from "react";
import type { IsolationStatusDto, SessionIsolation, SessionProjection } from "@polyth/contracts";
import { isolationActions, isolationBlocksUserMutation } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { openChanges, setUiError, upsertSession, useStore } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Dialog, Menu, confirmAlert } from "../../../apps/web/src/components/ui/index.ts";
import { peekGitStatus } from "./gitStatusStore.ts";

const isolationOf = (session: SessionProjection | null | undefined): SessionIsolation | null =>
  session?.isolation?.kind === "git-worktree" ? session.isolation : null;

function applySession(next: SessionProjection): void {
  upsertSession(next);
}

function countChangedFiles(projectId: string, sessionId: string): number | null {
  const status = peekGitStatus(projectId, sessionId);
  if (!status) return null;
  const paths = new Set<string>();
  for (const list of [status.staged, status.unstaged, status.untracked, status.conflicted]) {
    for (const entry of list) paths.add(entry.path);
  }
  return paths.size;
}

function progressLabel(key: "isolation.returningWorkspace" | "isolation.cleaningWorkspace" | "isolation.deletingWorkspace"): string {
  return tr(key).replace(/…+$/u, "");
}

type StepState = "done" | "current" | "pending";

function recoverySteps(integrating: boolean, liveState: string): Array<{ label: string; state: StepState }> {
  const deletingOrIntegratingDone = liveState === "rebind-pending" || liveState === "cleanup-pending";
  const integratingCurrent = liveState === "merging" || liveState === "publishing";
  const returningDone = liveState === "cleanup-pending";
  const returningCurrent = liveState === "rebind-pending";
  const cleaningCurrent = liveState === "cleanup-pending";
  if (integrating) {
    return [
      {
        label: tr("isolation.integratingChanges"),
        state: integratingCurrent ? "current" : deletingOrIntegratingDone ? "done" : "pending",
      },
      {
        label: progressLabel("isolation.returningWorkspace"),
        state: returningCurrent ? "current" : returningDone ? "done" : "pending",
      },
      {
        label: progressLabel("isolation.cleaningWorkspace"),
        state: cleaningCurrent ? "current" : "pending",
      },
    ];
  }
  const deletingCurrent = !deletingOrIntegratingDone && integratingCurrent;
  return [
    {
      label: progressLabel("isolation.deletingWorkspace"),
      state: deletingCurrent ? "current" : deletingOrIntegratingDone ? "done" : "pending",
    },
    {
      label: progressLabel("isolation.returningWorkspace"),
      state: returningCurrent ? "current" : returningDone ? "done" : "pending",
    },
    {
      label: progressLabel("isolation.cleaningWorkspace"),
      state: cleaningCurrent ? "current" : "pending",
    },
  ];
}

function badgeDetails(isolation: SessionIsolation): string {
  return [
    isolation.targetBranch,
    isolation.worktreeBranch,
    isolation.worktreePath,
    isolation.createdAt,
  ].join(" · ");
}

export function IsolationCard() {
  const sessionId = useStore((state) => state.activeSessionId);
  const session = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null,
  );
  const isolation = isolationOf(session);
  const [status, setStatus] = useState<IsolationStatusDto | null>(null);
  const [busy, setBusy] = useState<"merge" | "keep" | "resolve" | "recover" | "discard" | "abandon" | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const statusRequest = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++statusRequest.current;
    setStatus(null);
    if (!sessionId || !isolation) {
      return;
    }
    try {
      const next = await api.isolationStatus(sessionId);
      if (request === statusRequest.current) setStatus(next);
    } catch {
      if (request === statusRequest.current) setStatus(null);
    }
  }, [sessionId, isolation?.state, isolation?.dismissedRevision, session?.updatedAt]);

  useEffect(() => {
    void refresh();
    return () => { statusRequest.current += 1; };
  }, [refresh]);

  if (!sessionId || !session || !isolation) {
    return null;
  }

  const suggestion = status?.suggestion;
  const live = status?.isolation ?? isolation;
  const liveState = status?.effectiveState ?? live.state;
  const targetBranch = live.targetBranch;
  const conflict = liveState === "conflict" && suggestion?.eligible !== true;
  const unavailable = liveState === "missing" || liveState === "unowned" || liveState === "corrupt" || suggestion?.reason === "missing";
  const ownershipUnverified = liveState === "unowned" || liveState === "corrupt";
  const dirty = suggestion?.reason === "dirty-target";
  const destinationUnavailable = suggestion?.reason === "destination-unavailable";
  const recovering = liveState === "merging" || liveState === "publishing" || liveState === "rebind-pending" || liveState === "cleanup-pending";
  const discarding = recovering && liveState !== "merging" && liveState !== "publishing" && !live.resultCommit;
  const integrating = recovering && !discarding;
  const working = isolationBlocksUserMutation(session.status);
  const fallbackActions = status ? isolationActions(status, session.status) : null;
  const actions = status?.actions ?? (fallbackActions ? {
    canReview: fallbackActions.canReview,
    canMerge: fallbackActions.canMerge,
    canKeep: fallbackActions.canKeep,
    canResolve: fallbackActions.canResolve,
    canDiscard: fallbackActions.canDiscard,
    canRecover: fallbackActions.needsRecovery,
    canAbandon: false,
  } : undefined);
  const ready = actions?.canMerge === true;
  if (!conflict && !unavailable && !dirty && !destinationUnavailable && !ready && !recovering) return null;

  const fileCount = countChangedFiles(session.projectId, sessionId);
  const warn = conflict || unavailable || dirty || destinationUnavailable;

  const run = async (kind: "merge" | "keep" | "resolve" | "recover" | "discard" | "abandon", action: () => Promise<void>) => {
    setBusy(kind);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setUiError(friendlyError(tr("common.error"), cause));
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const confirmDiscard = async () => {
    setConfirmingDiscard(false);
    await run("discard", async () => {
      applySession(await api.isolationDiscard(sessionId));
    });
  };

  const abandon = async () => {
    if (!await confirmAlert(tr("isolation.finishWithoutCleanupConfirm"), {
      title: tr("isolation.finishWithoutCleanup"),
      confirmLabel: tr("common.continue"),
    })) return;
    await run("abandon", async () => {
      applySession(await api.isolationAbandon(sessionId));
    });
  };

  const title = destinationUnavailable
    ? tr("isolation.cantReturnYet", { branch: targetBranch })
    : recovering
      ? integrating
        ? liveState === "merging" || liveState === "publishing"
          ? tr("isolation.integratingInto", { branch: targetBranch })
          : liveState === "rebind-pending"
            ? tr("isolation.returningWorkspace")
            : tr("isolation.cleaningWorkspace")
        : liveState === "rebind-pending"
          ? tr("isolation.returningWorkspace")
          : tr("isolation.cleaningWorkspace")
      : ownershipUnverified
        ? tr("isolation.ownershipUnverified")
        : unavailable
          ? tr("isolation.missingWorkspace")
          : dirty
            ? tr("isolation.cantIntegrateYet", { branch: targetBranch })
            : conflict
              ? tr("isolation.mergeNeedsAttention")
              : tr("isolation.changesAreReady");

  const detail = destinationUnavailable
    ? tr("isolation.restoreOrigin", { path: live.originPath ?? live.targetPath, branch: targetBranch })
    : liveState === "cleanup-pending"
      ? tr("isolation.cleanupPendingDetail")
      : ownershipUnverified
        ? tr("isolation.ownershipDetail")
        : recovering
          ? null
          : conflict
            ? (live.conflict?.message || tr("isolation.conflictDetail", { branch: targetBranch }))
            : dirty
              ? tr("isolation.dirtyTargetDetail", { branch: targetBranch })
              : null;

  const showPath = unavailable || recovering;
  const steps = recovering ? recoverySteps(integrating, liveState) : null;

  return (
    <>
      <div className={`isolation-card${warn ? " isolation-card--warn" : ""}`} role="status">
        <div className="isolation-card-copy">
          <strong>{title}</strong>
          {ready && fileCount !== null && fileCount > 0 && (
            <span className="isolation-card-stats muted">{tr("isolation.filesChanged", { count: fileCount })}</span>
          )}
          {ready && (
            <span className="isolation-card-meta muted">{tr("isolation.basedOn", { branch: targetBranch })}</span>
          )}
          {detail && <span className="muted">{detail}</span>}
          {steps && (
            <ol className="isolation-card-progress">
              {steps.map((step) => (
                <li
                  key={step.label}
                  className={step.state === "done" ? "isolation-card-progress-done" : undefined}
                  aria-current={step.state === "current" ? "step" : undefined}
                >
                  {step.label}
                </li>
              ))}
            </ol>
          )}
          {showPath && <span className="muted">{live.worktreePath}</span>}
        </div>
        <div className="isolation-card-actions">
          {(destinationUnavailable || dirty) && (
            <Button size="sm" disabled={busy !== null} onClick={() => void refresh()}>
              {tr("gitview.checkAgain")}
            </Button>
          )}
          {actions?.canReview === true && !recovering && !unavailable && !dirty ? (
            <Button size="sm" disabled={busy !== null} onClick={() => openChanges()}>
              {conflict ? tr("isolation.reviewConflicts") : tr("isolation.reviewChanges")}
            </Button>
          ) : null}
          {!conflict && !unavailable && !dirty && ready && (
            <Button
              size="sm"
              variant="primary"
              disabled={busy !== null || working}
              busy={busy === "merge"}
              onClick={() => void run("merge", async () => {
                applySession((await api.isolationMerge(sessionId)).session);
              })}
            >
              {tr("isolation.integrateInto", { branch: targetBranch })}
            </Button>
          )}
          {conflict && actions?.canResolve === true && (
            <Button
              size="sm"
              variant="primary"
              disabled={busy !== null || working}
              busy={busy === "resolve"}
              onClick={() => void run("resolve", async () => {
                await api.isolationResolve(sessionId);
              })}
            >
              {tr("isolation.resolveWithAgent")}
            </Button>
          )}
          {actions?.canKeep === true && !recovering && (
            <Button
              size="sm"
              disabled={busy !== null}
              busy={busy === "keep"}
              onClick={() => void run("keep", async () => {
                applySession(await api.isolationKeep(sessionId));
              })}
            >
              {tr("isolation.keepIsolated")}
            </Button>
          )}
          {unavailable && actions?.canDiscard === true && (
            <Button
              size="sm"
              variant="danger"
              disabled={busy !== null || working}
              busy={busy === "discard"}
              onClick={() => setConfirmingDiscard(true)}
            >
              {tr("isolation.discard")}
            </Button>
          )}
          {recovering && actions?.canRecover === true && (
            <Button
              size="sm"
              variant="primary"
              disabled={busy !== null || working}
              busy={busy === "recover"}
              onClick={() => void run("recover", async () => {
                applySession(await api.isolationRecover(sessionId));
              })}
            >
              {tr("isolation.retryRecovery")}
            </Button>
          )}
          {recovering && actions?.canAbandon === true && (
            <Button
              size="sm"
              variant="danger"
              disabled={busy !== null || working}
              busy={busy === "abandon"}
              onClick={() => { void abandon(); }}
            >
              {tr("isolation.finishWithoutCleanup")}
            </Button>
          )}
          {!conflict && !unavailable && !dirty && ready && actions?.canDiscard === true && (
            <Menu
              label={tr("common.more")}
              align="end"
              className="isolation-card-overflow"
              entries={[{
                id: "discard",
                label: tr("isolation.discardWorkspace"),
                danger: true,
                disabled: busy !== null || working,
                onSelect: () => setConfirmingDiscard(true),
              }]}
            >
              {(trigger) => (
                <Button
                  ref={trigger.ref}
                  onClick={trigger.onClick}
                  aria-haspopup={trigger["aria-haspopup"]}
                  aria-expanded={trigger["aria-expanded"]}
                  size="sm"
                  disabled={busy !== null || working}
                  aria-label={tr("common.more")}
                >
                  {tr("common.more")}
                </Button>
              )}
            </Menu>
          )}
        </div>
      </div>
      {confirmingDiscard && (
        <Dialog
          title={tr("isolation.discardTitle")}
          onClose={() => setConfirmingDiscard(false)}
          footer={(
            <>
              <Button size="sm" onClick={() => setConfirmingDiscard(false)}>{tr("common.cancel")}</Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy !== null}
                busy={busy === "discard"}
                onClick={() => { void confirmDiscard(); }}
              >
                {tr("isolation.discard")}
              </Button>
            </>
          )}
        >
          <p>
            {fileCount !== null && fileCount > 0
              ? tr("isolation.discardConfirmFiles", { count: fileCount })
              : tr("isolation.discardConfirmGeneric")}
          </p>
          <p>{tr("isolation.discardTargetUnchanged", { branch: targetBranch })}</p>
        </Dialog>
      )}
    </>
  );
}

export function IsolationBadge() {
  const session = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null,
  );
  const isolation = isolationOf(session);
  if (!session || !isolation) return null;
  const branch = isolation.targetBranch;
  const details = badgeDetails(isolation);
  return (
    <span className="isolation-badge" title={details} aria-label={`${tr("isolation.isolatedBranch", { branch })}. ${details}`}>
      {tr("isolation.isolatedBranch", { branch })}
    </span>
  );
}

export function IsolationListBadge({ sessionId }: { sessionId: string }) {
  const isolation = useStore((state) =>
    isolationOf(state.sessions.find((candidate) => candidate.id === sessionId) ?? null),
  );
  if (!isolation) return null;
  const label = tr("isolation.isolated");
  return (
    <span className="isolation-list-badge" title={label} aria-label={label}>{label}</span>
  );
}
