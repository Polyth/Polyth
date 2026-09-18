import { useCallback, useEffect, useRef, useState } from "react";
import type { IsolationStatusDto, SessionIsolation, SessionProjection } from "@polyth/contracts";
import { isolationActions, isolationBlocksUserMutation } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { openChanges, setUiError, upsertSession, useStore } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  BranchIcon,
  Button,
  CombineIcon,
  DeleteIcon,
  Dialog,
  Icon,
  IconButton,
  Menu,
  MoreIcon,
  Spinner,
  WarningIcon,
  WorktreeIcon,
  confirmAlert,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";

const isolationOf = (session: SessionProjection | null | undefined): SessionIsolation | null =>
  session?.isolation?.kind === "git-worktree" ? session.isolation : null;

function applySession(next: SessionProjection): void {
  upsertSession(next);
}

const PROGRESS_MARK = { done: "✓", current: "●", pending: "○" } as const;

type StepState = keyof typeof PROGRESS_MARK;

function recoverySteps(integrating: boolean, liveState: string): Array<{ id: string; label: string; state: StepState }> {
  const returningDone = liveState === "cleanup-pending";
  const returning = {
    id: "returning",
    label: returningDone ? tr("isolation.returnedWorkspace") : tr("isolation.returningWorkspace"),
    state: (liveState === "rebind-pending" ? "current" : returningDone ? "done" : "pending") as StepState,
  };
  const cleaning = {
    id: "cleaning",
    label: tr("isolation.cleaningWorkspace"),
    state: (returningDone ? "current" : "pending") as StepState,
  };
  if (!integrating) return [returning, cleaning];
  return [
    {
      id: "integrating",
      label: tr("isolation.integratingChanges"),
      state: liveState === "merging" || liveState === "publishing" ? "current" : "done",
    },
    returning,
    cleaning,
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
  const [busy, setBusy] = useState<"merge" | "resolve" | "recover" | "discard" | "abandon" | null>(null);
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

  useEffect(() => {
    setConfirmingDiscard(false);
  }, [sessionId]);

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
  // New servers carry compatible dirty-target work forward. The reason is
  // retained as a legacy block when this client talks to an older server.
  const dirtyBlocked = suggestion?.reason === "dirty-target";
  const targetDirty = suggestion?.targetDirty === true;
  const destinationUnavailable = suggestion?.reason === "destination-unavailable";
  const recovering = liveState === "merging" || liveState === "publishing" || liveState === "rebind-pending" || liveState === "cleanup-pending";
  const discarding = recovering && liveState !== "merging" && liveState !== "publishing" && !live.resultCommit;
  const integrating = recovering && !discarding;
  const working = isolationBlocksUserMutation(session.status);
  const fallbackActions = status ? isolationActions(status, session.status) : null;
  const actions = status?.actions ?? (fallbackActions ? {
    canReview: fallbackActions.canReview,
    canMerge: fallbackActions.canMerge,
    canResolve: fallbackActions.canResolve,
    canDiscard: fallbackActions.canDiscard,
    canRecover: fallbackActions.needsRecovery,
    canAbandon: false,
  } : undefined);
  const ready = actions?.canMerge === true;
  if (!conflict && !unavailable && !dirtyBlocked && !destinationUnavailable && !ready && !recovering) return null;

  const warn = conflict || unavailable || dirtyBlocked || destinationUnavailable;

  const run = async (kind: "merge" | "resolve" | "recover" | "discard" | "abandon", action: () => Promise<void>) => {
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
          : dirtyBlocked
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
            : dirtyBlocked || (targetDirty && ready)
              ? tr("isolation.dirtyTargetDetail", { branch: targetBranch })
              : null;

  const showPath = unavailable || (recovering && busy === null);
  const steps = recovering ? recoverySteps(integrating, liveState) : null;
  // One quiet identity glyph per state family. Recovery shows motion; every
  // other state is legible without it, so nothing depends on color alone.
  const glyph = recovering
    ? <Spinner size="sm" />
    : <Icon icon={unavailable ? WorktreeIcon : conflict || warn ? WarningIcon : CombineIcon} size="sm" />;

  // Destructive endings live behind the overflow whenever a better action is
  // on the card. They stay in the open only when they are the only way out.
  const overflow: MenuEntry[] = [];
  if (actions?.canDiscard === true && !unavailable && !recovering) {
    overflow.push({
      id: "discard",
      label: tr("isolation.discardWorkspace"),
      icon: DeleteIcon,
      danger: true,
      disabled: busy !== null || working,
      onSelect: () => setConfirmingDiscard(true),
    });
  }
  if (recovering && actions?.canAbandon === true) {
    overflow.push({
      id: "abandon",
      label: tr("isolation.finishWithoutCleanup"),
      icon: WorktreeIcon,
      danger: true,
      disabled: busy !== null || working,
      onSelect: () => { void abandon(); },
    });
  }

  return (
    <>
      <section
        className={`isolation-card ui-glass-dock${warn ? " isolation-card--warn" : ""}`}
        role="status"
        aria-label={title}
      >
        <div className="isolation-card-head">
          <span className="isolation-card-glyph" aria-hidden="true">{glyph}</span>
          <div className="isolation-card-copy">
            <strong className="isolation-card-title">{title}</strong>
            {ready && (
              <span className="isolation-card-meta">
                <Icon icon={BranchIcon} size="sm" />
                {tr("isolation.basedOn", { branch: targetBranch })}
              </span>
            )}
          </div>
          {overflow.length > 0 && (
            <Menu label={tr("common.more")} align="end" entries={overflow}>
              {(trigger) => (
                <IconButton
                  {...trigger}
                  icon={MoreIcon}
                  size="sm"
                  className="isolation-card-overflow"
                  disabled={busy !== null || working}
                  label={tr("common.more")}
                />
              )}
            </Menu>
          )}
        </div>
        {detail && <p className="isolation-card-note">{detail}</p>}
        {steps && (
          <ol className="isolation-card-progress">
            {steps.map((step) => (
              <li
                key={step.id}
                className={step.state === "done" ? "isolation-card-progress-done" : undefined}
                aria-current={step.state === "current" ? "step" : undefined}
              >
                <span className="isolation-card-progress-mark" aria-hidden="true">{PROGRESS_MARK[step.state]}</span>
                {step.label}
              </li>
            ))}
          </ol>
        )}
        {showPath && <p className="isolation-card-path mono">{live.worktreePath}</p>}
        <div className="isolation-card-actions">
          {(destinationUnavailable || dirtyBlocked) && (
            <Button size="sm" disabled={busy !== null} onClick={() => void refresh()}>
              {tr("gitview.checkAgain")}
            </Button>
          )}
          {actions?.canReview === true && !recovering && !unavailable && !dirtyBlocked ? (
            <Button size="sm" disabled={busy !== null} onClick={() => openChanges()}>
              {conflict ? tr("isolation.reviewConflicts") : tr("isolation.reviewChanges")}
            </Button>
          ) : null}
          {unavailable && actions?.canDiscard === true && (
            <Button
              size="sm"
              variant="danger"
              className="isolation-card-primary"
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
              className="isolation-card-primary"
              disabled={busy !== null || working}
              busy={busy === "recover"}
              onClick={() => void run("recover", async () => {
                applySession(await api.isolationRecover(sessionId));
              })}
            >
              {tr("isolation.retryRecovery")}
            </Button>
          )}
          {conflict && actions?.canResolve === true && (
            <Button
              size="sm"
              variant="primary"
              className="isolation-card-primary"
              disabled={busy !== null || working}
              busy={busy === "resolve"}
              onClick={() => void run("resolve", async () => {
                await api.isolationResolve(sessionId);
              })}
            >
              {tr("isolation.resolveWithAgent")}
            </Button>
          )}
          {!conflict && !unavailable && !dirtyBlocked && ready && (
            <Button
              size="sm"
              variant="primary"
              className="isolation-card-primary"
              iconStart={CombineIcon}
              disabled={busy !== null || working}
              busy={busy === "merge"}
              onClick={() => void run("merge", async () => {
                applySession((await api.isolationMerge(sessionId)).session);
              })}
            >
              {tr("isolation.integrateInto", { branch: targetBranch })}
            </Button>
          )}
        </div>
      </section>
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
          <p>{tr("isolation.discardConfirmGeneric")}</p>
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
