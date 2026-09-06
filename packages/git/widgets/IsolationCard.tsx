import { useCallback, useEffect, useState } from "react";
import type { IsolationStatusDto, SessionIsolation, SessionProjection } from "@polyth/contracts";
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
  const [busy, setBusy] = useState<"merge" | "keep" | "resolve" | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId || !isolation) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await api.isolationStatus(sessionId));
    } catch {
      setStatus({ isolation, suggestion: null });
    }
  }, [sessionId, isolation?.state, isolation?.dismissedRevision, session?.updatedAt]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!sessionId || !session || !isolation || isolation.state === "cleanup-pending" || isolation.state === "merging") {
    return null;
  }

  const suggestion = status?.suggestion;
  const targetBranch = isolation.targetBranch;
  const conflict = isolation.state === "conflict";
  const missing = isolation.state === "missing" || suggestion?.reason === "missing";
  const dirty = suggestion?.reason === "dirty-target";
  const working = session.status === "working" || session.status === "waiting" || session.status === "reconciling";
  const ready = !working && (isolation.state === "merge-ready" || suggestion?.eligible === true);
  if (!conflict && !missing && !dirty && !ready) return null;

  const run = async (kind: "merge" | "keep" | "resolve", action: () => Promise<void>) => {
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

  const title = missing
    ? tr("isolation.missingWorkspace")
    : dirty
      ? tr("isolation.dirtyTarget", { branch: targetBranch })
      : conflict
        ? tr("isolation.mergeNeedsAttention")
        : tr("isolation.changesAreReady");
  const detail = conflict
    ? (isolation.conflict?.message || tr("isolation.conflictDetail", { branch: targetBranch }))
    : dirty || missing
      ? null
      : tr("isolation.mergeInto", { branch: targetBranch });

  return (
    <div className={`isolation-card${conflict || missing || dirty ? " isolation-card--warn" : ""}`} role="status">
      <div className="isolation-card-copy">
        <strong>{title}</strong>
        {detail && <span className="muted">{detail}</span>}
      </div>
      <div className="isolation-card-actions">
        {missing ? null : (
          <Button size="sm" disabled={busy !== null} onClick={() => openChanges()}>
            {conflict ? tr("isolation.reviewConflicts") : tr("isolation.reviewChanges")}
          </Button>
        )}
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
        {conflict && (
          <Button
            size="sm"
            variant="primary"
            disabled={busy !== null}
            busy={busy === "resolve"}
            onClick={() => void run("resolve", async () => {
              await api.isolationResolve(sessionId);
            })}
          >
            {tr("isolation.resolveWithAgent")}
          </Button>
        )}
        {!conflict && !missing && !dirty && (
          <Button
            size="sm"
            variant="primary"
            disabled={busy !== null}
            busy={busy === "merge"}
            onClick={() => void run("merge", async () => {
              applySession((await api.isolationMerge(sessionId)).session);
            })}
          >
            {tr("isolation.merge")}
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
  if (!sessionId || !isolation) return null;
  const branch = isolation.targetBranch;
  const merging = isolation.state === "merging" || isolation.state === "cleanup-pending";

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

  return (
    <Menu
      label={tr("isolation.isolatedBranch", { branch })}
      title={tr("isolation.isolated")}
      align="end"
      entries={[
        {
          id: "review",
          label: isolation.state === "conflict" ? tr("isolation.reviewConflicts") : tr("isolation.reviewChanges"),
          disabled: busy || isolation.state === "missing",
          onSelect: () => openChanges(),
        },
        {
          id: "merge",
          label: tr("isolation.mergeBack"),
          disabled: busy || merging || isolation.state === "missing" || isolation.state === "conflict",
          onSelect: () => {
            void run(async () => {
              applySession((await api.isolationMerge(sessionId)).session);
            });
          },
        },
        {
          id: "keep",
          label: tr("isolation.keepIsolated"),
          disabled: busy || merging || isolation.state === "missing",
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
              disabled: busy,
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
          disabled: busy || merging,
          onSelect: () => { void discard(); },
        },
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
