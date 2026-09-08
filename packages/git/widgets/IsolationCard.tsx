import { useCallback, useEffect, useState } from "react";
import type { IsolationStatusDto, SessionIsolation, SessionProjection } from "@polyth/contracts";
import { isolationActions } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { openChanges, setUiError, upsertSession, useStore } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Menu, confirmAlert } from "../../../apps/web/src/components/ui/index.ts";

const isolationOf = (session: SessionProjection | null | undefined): SessionIsolation | null =>
  session?.isolation?.kind === "git-worktree" ? session.isolation : null;

/** Both surfaces use the same authoritative status and action policy. A late
 * response can never become the status of a different session or projection. */
function useIsolationStatus() {
  const session = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null,
  );
  const isolation = isolationOf(session);
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; status: IsolationStatusDto } | null>(null);
  const key = `${session?.id}:${session?.updatedAt}:${JSON.stringify(isolation)}:${revision}`;
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!session || !isolation) return;
    let active = true;
    void api.isolationStatus(session.id).then((status) => {
      if (active) setLoaded({ key, status });
    }).catch(() => {
      // Failed reads never enable mutations using stale Git/ownership state.
      if (active) setLoaded(null);
    });
    return () => { active = false; };
  }, [key]);
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  const status = loaded?.key === key ? loaded.status : null;
  const live = status?.isolation ?? isolation;
  const state = status?.effectiveState ?? live?.state;
  const actions = isolationActions(status ?? { isolation: null, suggestion: null }, session?.status);
  return { session, isolation: live, status, state, actions, refresh };
}

function isolationLabel(state: SessionIsolation["state"], branch: string): string {
  if (state === "rebind-pending" || state === "cleanup-pending") return tr("isolation.recoveryNeeded");
  if (state === "merging" || state === "publishing") return tr("isolation.merging");
  if (state === "missing") return tr("isolation.missingWorkspace");
  if (state === "unowned" || state === "corrupt") return tr("isolation.ownershipUnverified");
  if (state === "conflict") return tr("isolation.mergeNeedsAttention");
  return tr("isolation.isolatedBranch", { branch });
}

export function IsolationCard() {
  const { session, isolation, status, state, actions, refresh } = useIsolationStatus();
  const [busy, setBusy] = useState<string | null>(null);
  if (!session || !isolation || !state) return null;
  const suggestion = status?.suggestion;
  const conflict = state === "conflict" && suggestion?.eligible !== true;
  const unavailable = state === "missing" || state === "unowned" || state === "corrupt";
  const dirty = suggestion?.reason === "dirty-target";
  const destinationUnavailable = suggestion?.reason === "destination-unavailable";
  const pending = state === "merging" || state === "publishing" || state === "rebind-pending" || state === "cleanup-pending";
  const ready = suggestion?.eligible === true;
  if (!conflict && !unavailable && !dirty && !destinationUnavailable && !pending && !ready) return null;

  const run = async (kind: string, action: () => Promise<void>) => {
    setBusy(kind);
    try { await action(); }
    catch (cause) { setUiError(friendlyError(tr("common.error"), cause)); }
    finally { setBusy(null); refresh(); }
  };
  const title = destinationUnavailable ? tr("isolation.recoveryNeeded") : unavailable || pending || conflict
    ? isolationLabel(state, isolation.targetBranch)
    : dirty
      ? tr("isolation.dirtyTarget", { branch: isolation.targetBranch })
      : tr("isolation.changesAreReady");
  const detail = state === "publishing" || state === "rebind-pending" || destinationUnavailable
    ? tr("isolation.restoreOrigin", { path: isolation.originPath ?? isolation.targetPath, branch: isolation.targetBranch })
    : state === "cleanup-pending"
      ? tr("isolation.cleanupPendingDetail")
      : state === "unowned" || state === "corrupt"
        ? tr("isolation.ownershipDetail")
        : conflict
          ? isolation.conflict?.message || tr("isolation.conflictDetail", { branch: isolation.targetBranch })
          : !unavailable && !pending && !dirty
            ? tr("isolation.mergeInto", { branch: isolation.targetBranch })
            : null;
  return (
    <div className={`isolation-card${conflict || unavailable || dirty || destinationUnavailable || actions.needsRecovery ? " isolation-card--warn" : ""}`} role="status">
      <div className="isolation-card-copy">
        <strong>{title}</strong>
        {detail && <span className="muted">{detail}</span>}
        {(unavailable || pending) && <span className="muted">{isolation.worktreePath}</span>}
      </div>
      <div className="isolation-card-actions">
        {destinationUnavailable && <Button size="sm" disabled={busy !== null} onClick={refresh}>
          {tr("gitview.checkAgain")}
        </Button>}
        {actions.canReview && <Button size="sm" disabled={busy !== null} onClick={() => openChanges()}>
          {conflict ? tr("isolation.reviewConflicts") : tr("isolation.reviewChanges")}
        </Button>}
        {actions.canKeep && <Button size="sm" disabled={busy !== null} busy={busy === "keep"}
          onClick={() => void run("keep", async () => { upsertSession(await api.isolationKeep(session.id)); })}>
          {tr("isolation.keepIsolated")}
        </Button>}
        {actions.canResolve && conflict && <Button size="sm" variant="primary" disabled={busy !== null} busy={busy === "resolve"}
          onClick={() => void run("resolve", async () => { await api.isolationResolve(session.id); })}>
          {tr("isolation.resolveWithAgent")}
        </Button>}
        {actions.canMerge && !conflict && <Button size="sm" variant="primary" disabled={busy !== null} busy={busy === "merge"}
          onClick={() => void run("merge", async () => { upsertSession((await api.isolationMerge(session.id)).session); })}>
          {tr("isolation.merge")}
        </Button>}
        {actions.needsRecovery && <Button size="sm" variant="primary" disabled={busy !== null} busy={busy === "recover"}
          onClick={() => void run("recover", async () => { upsertSession(await api.isolationRecover(session.id)); })}>
          {tr("isolation.retryRecovery")}
        </Button>}
      </div>
    </div>
  );
}

export function IsolationBadge() {
  const { session, isolation, state, actions, refresh } = useIsolationStatus();
  const [busy, setBusy] = useState(false);
  if (!session || !isolation || !state) return null;
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); }
    catch (cause) { setUiError(friendlyError(tr("common.error"), cause)); }
    finally { setBusy(false); refresh(); }
  };
  const discard = async () => {
    if (!await confirmAlert(tr("isolation.discardConfirm"), {
      title: tr("isolation.discardTitle"), confirmLabel: tr("isolation.discard"), destructive: true,
    })) return;
    await run(async () => { upsertSession(await api.isolationDiscard(session.id)); });
  };
  const label = isolationLabel(state, isolation.targetBranch);
  return (
    <Menu label={label} title={tr("isolation.isolated")} align="end" entries={[
      {
        id: "review", label: state === "conflict" ? tr("isolation.reviewConflicts") : tr("isolation.reviewChanges"),
        disabled: busy || !actions.canReview, onSelect: () => openChanges(),
      },
      {
        id: "merge", label: tr("isolation.mergeBack"), disabled: busy || !actions.canMerge,
        onSelect: () => { void run(async () => { upsertSession((await api.isolationMerge(session.id)).session); }); },
      },
      {
        id: "keep", label: tr("isolation.keepIsolated"), disabled: busy || !actions.canKeep,
        onSelect: () => { void run(async () => { upsertSession(await api.isolationKeep(session.id)); }); },
      },
      ...(state === "conflict" ? [{
        id: "resolve", label: tr("isolation.resolveWithAgent"), disabled: busy || !actions.canResolve,
        onSelect: () => { void run(async () => { await api.isolationResolve(session.id); }); },
      }] : []),
      ...(actions.needsRecovery ? [{
        id: "recover", label: tr("isolation.retryRecovery"), disabled: busy,
        onSelect: () => { void run(async () => { upsertSession(await api.isolationRecover(session.id)); }); },
      }] : []),
      "separator",
      {
        id: "discard", label: tr("isolation.discardWorkspace"), danger: true,
        disabled: busy || !actions.canDiscard, onSelect: () => { void discard(); },
      },
    ]}>
      {(trigger) => <button {...trigger} type="button" disabled={busy}
        className={`isolation-badge${actions.needsRecovery || state === "conflict" || state === "missing" || state === "unowned" || state === "corrupt" ? " isolation-badge--warn" : ""}`}>
        {label}
      </button>}
    </Menu>
  );
}

export function IsolationListBadge({ sessionId }: { sessionId: string }) {
  const isolation = useStore((state) =>
    isolationOf(state.sessions.find((candidate) => candidate.id === sessionId) ?? null),
  );
  if (!isolation) return null;
  return <span className="isolation-list-badge" title={isolationLabel(isolation.state, isolation.targetBranch)}>
    {isolation.state === "active" || isolation.state === "merge-ready"
      ? tr("isolation.isolated") : isolationLabel(isolation.state, isolation.targetBranch)}
  </span>;
}
