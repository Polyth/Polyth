// The navigator's multi-select bar. The host owns the actions that are core
// session state (archive/restore, pin, sharing); packages add their own
// (title regeneration, leaving isolation) through `sidebar.sessions.bulk.actions`.
// Every action runs per session against the same routes as the row menu, so
// the server keeps its access checks and one refusal never hides the others.
import { useState } from "react";
import type { SessionProjection } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { getState, beginOptimisticSessionChange, setUiError, useStore } from "../../store.ts";
import { refreshSessions } from "../../init.ts";
import { friendlyError } from "../../settings.ts";
import { toggleSessionPin } from "../../sessionActions.ts";
import { canManageSession, saveSessionSharing } from "../../sessionSharing.ts";
import { confirmAlert } from "../../alerts.ts";
import { successFeedback } from "../../haptics.ts";
import { tr } from "../../i18n/index.ts";
import { announce } from "../a11y/live.tsx";
import SlotHost, { useSlotHasContent } from "../slots/SlotHost.ts";
import {
  ArchiveIcon, Button, CloseIcon, IconButton, Menu, MoreIcon, PinIcon, RestoreIcon,
  type MenuEntry,
} from "../ui/index.ts";

export interface BulkFailure { id: string; code: string }

const failureCode = (error: unknown): string => {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && code) return code;
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" ? String(status) : "error";
};

/** Announce a finished bulk action; failures also surface as an error. */
export function reportBulkResult(operation: string, succeeded: number, failed: readonly BulkFailure[]): void {
  const failNote = failed.length
    ? tr("sidebar.failedCountValue", { count: failed.length, codes: [...new Set(failed.map((f) => f.code))].join(", ") })
    : "";
  announce(succeeded === 1
    ? tr("sidebar.valueOneSessionValue", { operation, failNote })
    : tr("sidebar.valueSessionsValue", { operation, count: succeeded, failNote }));
  if (failed.length > 0) {
    setUiError(tr("sidebar.bulkSessionOperationFailed", {
      operation: operation.toLocaleLowerCase(),
      failures: failed.map((failure) => `${failure.id.slice(0, 8)}:${failure.code}`).join(", "),
    }));
  } else if (succeeded > 0) {
    successFeedback();
  }
}

/** Run one action per session, in order; returns the ids that failed. */
async function eachSession(
  ids: readonly string[],
  action: (id: string) => Promise<void>,
): Promise<{ succeeded: number; failed: BulkFailure[] }> {
  let succeeded = 0;
  const failed: BulkFailure[] = [];
  for (const id of ids) {
    try {
      await action(id);
      succeeded += 1;
    } catch (error) {
      failed.push({ id, code: failureCode(error) });
    }
  }
  return { succeeded, failed };
}

async function refreshProjects(sessions: readonly Pick<SessionProjection, "projectId">[]): Promise<void> {
  await Promise.all([...new Set(sessions.map((session) => session.projectId))].map((projectId) => refreshSessions(projectId)));
}

export default function SessionSelectionBar({ selectedIds, onDone }: {
  selectedIds: ReadonlySet<string>;
  /** Ends the selection (clears it and leaves select mode). */
  onDone: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const allSessions = useStore((state) => state.sessions);
  const ids = [...selectedIds];
  const selected = allSessions.filter((session) => selectedIds.has(session.id));
  const count = selectedIds.size;
  const manageable = selected.filter(canManageSession);
  const allArchived = manageable.length > 0 && manageable.every((session) => session.status === "archived");
  const pinnable = selected.filter((session) => session.status !== "archived");
  const allPinned = pinnable.length > 0 && pinnable.every((session) => session.pinned !== undefined);
  // Sharing only exists on multi-person installs; a delegated subagent follows
  // the chat it came from and is shared through that one.
  const shareable = manageable.filter((session) => session.sharing && !session.sharing.inherited);

  const finish = (touched: readonly SessionProjection[]) => {
    onDone();
    void refreshProjects(touched).catch((error) => setUiError(friendlyError(tr("common.error"), error)));
  };

  const runArchive = async (op: "archive" | "restore") => {
    const targets = manageable.filter((session) => (op === "archive") !== (session.status === "archived"));
    if (targets.length === 0) return;
    // Optimistic: rows move (and select mode closes) at once; ids the server
    // reports as failed, or a rejected request, restore their previous status.
    const optimistic = new Map(targets.map((session) => [session.id, beginOptimisticSessionChange(session.id, {
      kind: "patch",
      patch: { status: op === "archive" ? "archived" : "idle" },
    })] as const));
    onDone();
    try {
      const result = await api.bulkSessions(op, targets.map((session) => session.id));
      for (const id of result.succeeded) optimistic.get(id)?.settle();
      for (const failure of result.failed) optimistic.get(failure.id)?.rollback();
      reportBulkResult(
        op === "archive" ? tr("sidebar.sessionlist.archived") : tr("common.restore"),
        result.succeeded.length,
        result.failed,
      );
      await refreshProjects(targets);
    } catch (error) {
      setUiError(friendlyError(tr("common.error"), error));
    } finally {
      // Settled handles are no-ops; anything unreported restores its status.
      for (const handle of optimistic.values()) handle.rollback();
    }
  };

  const runPin = async () => {
    const pin = !allPinned;
    const targets = pinnable.filter((session) => (session.pinned !== undefined) !== pin);
    // New pins go to the top one by one, so pin the last selected first and
    // the selection keeps its order inside the pinned group.
    const ordered = pin ? [...targets].reverse() : targets;
    const result = await eachSession(ordered.map((session) => session.id), async (id) => {
      const current = getState().sessions.find((session) => session.id === id);
      if (!current) throw Object.assign(new Error("session not found"), { code: "not-found" });
      await toggleSessionPin(
        current,
        getState().sessions.filter((candidate) => candidate.projectId === current.projectId
          && candidate.status !== "archived" && candidate.pinned !== undefined),
      );
    });
    reportBulkResult(pin ? tr("sidebar.bulk.pinned") : tr("sidebar.bulk.unpinned"), result.succeeded, result.failed);
    finish(targets);
  };

  const runShare = async (visibility: "space" | "private") => {
    const targets = shareable.filter((session) => session.sharing?.visibility !== visibility);
    if (targets.length === 0) return;
    if (visibility === "private" && !await confirmAlert(
      tr("sidebar.bulk.makePrivateConfirm", { count: targets.length }),
      { title: tr("sidebar.bulk.makePrivate"), confirmLabel: tr("sidebar.bulk.makePrivate") },
    )) return;
    // Only the audience changes: people the chat is shared with by name keep
    // their access when it opens to the Space (the server keeps the list).
    const result = await eachSession(targets.map((session) => session.id), async (id) => {
      await saveSessionSharing(id, { visibility });
    });
    reportBulkResult(
      visibility === "space" ? tr("sidebar.bulk.sharedWithSpace") : tr("sidebar.bulk.madePrivate"),
      result.succeeded,
      result.failed,
    );
    finish(targets);
  };

  const packageActions = useSlotHasContent("sidebar.sessions.bulk.actions");
  const moreEntries: MenuEntry[] = [
    ...(shareable.length > 0 ? [
      { heading: tr("sharing.share") },
      { id: "share-space", label: tr("sidebar.bulk.shareWithSpace"), onSelect: () => void runShare("space") },
      { id: "share-private", label: tr("sidebar.bulk.makePrivate"), onSelect: () => void runShare("private") },
    ] satisfies MenuEntry[] : []),
  ];

  return (
    <div className="session-bulk-actions" role="toolbar" aria-label={tr("sidebar.selectedSessionActions")}>
      <span className="session-bulk-count" aria-live="polite">
        {count === 0 ? tr("sidebar.bulk.chooseSessions") : tr("sidebar.valueSelected", { size: count })}
      </span>
      <span className="session-bulk-buttons">
        <Button
          size="sm"
          variant="ghost"
          iconStart={PinIcon}
          disabled={pinnable.length === 0}
          onClick={() => void runPin()}
        >{allPinned ? tr("sidebar.bulk.unpin") : tr("sidebar.bulk.pin")}</Button>
        <Button
          size="sm"
          variant="ghost"
          iconStart={allArchived ? RestoreIcon : ArchiveIcon}
          disabled={manageable.length === 0}
          onClick={() => void runArchive(allArchived ? "restore" : "archive")}
        >{allArchived ? tr("common.restore") : tr("common.archive")}</Button>
        <Menu
          label={tr("sidebar.bulk.more")}
          title={tr("sidebar.bulk.more")}
          align="end"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          entries={moreEntries}
          footer={count > 0 ? (
            <SlotHost slot="sidebar.sessions.bulk.actions" context={{
              sessionIds: ids,
              closeMenu: () => setMenuOpen(false),
              done: () => finish(selected),
              report: reportBulkResult,
            }} />
          ) : undefined}
        >
          {(trigger) => (
            <IconButton
              icon={MoreIcon}
              label={tr("sidebar.bulk.more")}
              className="session-bulk-more"
              disabled={count === 0 || (moreEntries.length === 0 && !packageActions)}
              {...trigger}
            />
          )}
        </Menu>
        <IconButton
          icon={CloseIcon}
          label={tr("sidebar.cancelSessionSelection")}
          className="session-bulk-close"
          onClick={onDone}
        />
      </span>
    </div>
  );
}
