import { useCallback, useEffect, useRef, useState } from "react";
import type { IsolationStatusDto, SessionIsolation, SessionProjection } from "@polyth/contracts";
import { isolationActions, isolationBlocksUserMutation } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { openChanges, setUiError, upsertSession, useStore } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Menu, confirmAlert } from "../../../apps/web/src/components/ui/index.ts";

const isolationOf = (session: SessionProjection | null | undefined): SessionIsolation | null =>
  session?.isolation?.kind === "git-worktree" ? session.isolation : null;

function applySession(next: SessionProjection): void {
  upsertSession(next);
}

export function IsolationCard() {
  const sessionId = useStore((state) => state.activeSessionId);
  const session = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null,
  );
  const isolation = isolationOf(session);
  const [status, setStatus] = useState<IsolationStatusDto | null>(null);
  const [busy, setBusy] = useState<"merge" | "keep" | "resolve" | "recover" | "discard" | "abandon" | null>(null);
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

  const discard = async () => {
    if (!await confirmAlert(tr("isolation.discardConfirm"), {
      title: tr("isolation.discardTitle"),
      confirmLabel: tr("isolation.discard"),
      destructive: true,
    })) return;
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
    ? tr("isolation.recoveryNeeded")
    : recovering
    ? tr("isolation.merging")
    : ownershipUnverified
    ? tr("isolation.ownershipUnverified")
    : unavailable
      ? tr("isolation.missingWorkspace")
    : dirty
      ? tr("isolation.dirtyTarget", { branch: targetBranch })
      : conflict
        ? tr("isolation.mergeNeedsAttention")
        : tr("isolation.changesAreReady");
  const detail = liveState === "publishing" || liveState === "rebind-pending" || destinationUnavailable
    ? tr("isolation.restoreOrigin", { path: live.originPath ?? live.targetPath, branch: targetBranch })
    : liveState === "cleanup-pending"
      ? tr("isolation.cleanupPendingDetail")
      : ownershipUnverified
        ? tr("isolation.ownershipDetail")
        : recovering
          ? tr("isolation.mergeInto", { branch: targetBranch })
    : conflict
    ? (live.conflict?.message || tr("isolation.conflictDetail", { branch: targetBranch }))
    : dirty || unavailable
      ? null
      : tr("isolation.mergeInto", { branch: targetBranch });

  return (
    <div className={`isolation-card${conflict || unavailable || dirty || destinationUnavailable || recovering ? " isolation-card--warn" : ""}`} role="status">
      <div className="isolation-card-copy">
        <strong>{title}</strong>
        {detail && <span className="muted">{detail}</span>}
        {(unavailable || recovering) && <span className="muted">{live.worktreePath}</span>}
      </div>
      <div className="isolation-card-actions">
        {destinationUnavailable && <Button size="sm" disabled={busy !== null} onClick={() => void refresh()}>
          {tr("gitview.checkAgain")}
        </Button>}
        {actions?.canReview === true && !recovering && !unavailable ? (
          <Button size="sm" disabled={busy !== null} onClick={() => openChanges()}>
            {conflict ? tr("isolation.reviewConflicts") : tr("isolation.reviewChanges")}
          </Button>
        ) : null}
        {actions?.canKeep === true && !recovering && <Button
          size="sm"
          disabled={busy !== null}
          busy={busy === "keep"}
          onClick={() => void run("keep", async () => {
            applySession(await api.isolationKeep(sessionId));
          })}
        >
          {tr("isolation.keepIsolated")}
        </Button>}
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
            {tr("isolation.merge")}
          </Button>
        )}
        {unavailable && actions?.canDiscard === true && (
          <Button
            size="sm"
            variant="danger"
            disabled={busy !== null || working}
            busy={busy === "discard"}
            onClick={() => { void discard(); }}
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
      </div>
    </div>
  );
}

export function IsolationBadge() {
  const sessionId = useStore((state) => state.activeSessionId);
  const session = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null,
  );
  const isolation = isolationOf(session);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<IsolationStatusDto | null>(null);
  useEffect(() => {
    if (!sessionId || !isolation) { setStatus(null); return; }
    let current = true;
    setStatus(null);
    void api.isolationStatus(sessionId).then((next) => {
      if (current) setStatus(next);
    }).catch(() => { if (current) setStatus(null); });
    return () => { current = false; };
  }, [sessionId, isolation?.state, session?.updatedAt]);
  if (!sessionId || !session || !isolation) return null;
  const branch = isolation.targetBranch;
  const merging = isolation.state === "merging" || isolation.state === "publishing" || isolation.state === "rebind-pending" || isolation.state === "cleanup-pending";
  const blocked = isolationBlocksUserMutation(session.status);
  const actions = status?.actions;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      setUiError(friendlyError(tr("common.error"), cause));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!await confirmAlert(tr("isolation.discardConfirm"), {
      title: tr("isolation.discardTitle"),
      confirmLabel: tr("isolation.discard"),
      destructive: true,
    })) return;
    await run(async () => {
      applySession(await api.isolationDiscard(sessionId));
    });
  };

  const abandon = async () => {
    if (!await confirmAlert(tr("isolation.finishWithoutCleanupConfirm"), {
      title: tr("isolation.finishWithoutCleanup"),
      confirmLabel: tr("common.continue"),
    })) return;
    await run(async () => {
      applySession(await api.isolationAbandon(sessionId));
    });
  };

  return (
    <Menu
      label={tr("isolation.isolatedBranch", { branch })}
      title={tr("isolation.isolated")}
      align="end"
      entries={[
        {
          id: "review",
          label: isolation.state === "conflict" ? tr("isolation.reviewConflicts") : tr("isolation.reviewChanges"),
          disabled: busy || actions?.canReview !== true,
          onSelect: () => openChanges(),
        },
        {
          id: "merge",
          label: tr("isolation.mergeBack"),
          disabled: busy || blocked || actions?.canMerge !== true,
          onSelect: () => {
            void run(async () => {
              applySession((await api.isolationMerge(sessionId)).session);
            });
          },
        },
        {
          id: "keep",
          label: tr("isolation.keepIsolated"),
          disabled: busy || blocked || actions?.canKeep !== true,
          onSelect: () => {
            void run(async () => {
              applySession(await api.isolationKeep(sessionId));
            });
          },
        },
        ...(isolation.state === "conflict"
          ? [{
              id: "resolve",
              label: tr("isolation.resolveWithAgent"),
              disabled: busy || blocked || actions?.canResolve !== true,
              onSelect: () => {
                void run(async () => {
                  await api.isolationResolve(sessionId);
                });
              },
            }]
          : []),
        "separator",
        {
          id: "discard",
          label: tr("isolation.discardWorkspace"),
          danger: true,
          disabled: busy || blocked || actions?.canDiscard !== true,
          onSelect: () => { void discard(); },
        },
        ...(actions?.canAbandon === true
          ? [{
              id: "abandon-cleanup",
              label: tr("isolation.finishWithoutCleanup"),
              danger: true,
              disabled: busy || blocked,
              onSelect: () => { void abandon(); },
            }]
          : []),
      ]}
    >
      {(trigger) => (
        <button
          {...trigger}
          type="button"
          className={`isolation-badge${isolation.state === "conflict" ? " isolation-badge--warn" : ""}`}
          disabled={busy}
        >
          {merging
            ? tr("isolation.merging")
            : tr("isolation.isolatedBranch", { branch })}
        </button>
      )}
    </Menu>
  );
}

export function IsolationListBadge({ sessionId }: { sessionId: string }) {
  const isolation = useStore((state) =>
    isolationOf(state.sessions.find((candidate) => candidate.id === sessionId) ?? null),
  );
  if (!isolation) return null;
  return (
    <span className="isolation-list-badge">{tr("isolation.isolated")}</span>
  );
}
