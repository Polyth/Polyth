import { useEffect, useState } from "react";
import { api } from "@polyth/session/web-api";
import { setUiError, useStore } from "../../store.ts";
import { friendlyError } from "../../settings.ts";
import { useSessionDefaults } from "../../sessionDefaults.ts";
import { projectRetention, setProjectRetention, type RetentionAction } from "../../projectRetention.ts";
import { NumberField, Row, Section, Seg, Toggle } from "./parts.tsx";
import { tr } from "../../i18n/index.ts";
import { Button } from "../ui/index.ts";
import { confirmAlert } from "../../alerts.ts";

/** Cleanup and Archive for one project, on Settings → Projects. Each person
 *  chooses these for each project; they reach only that person's own chats in
 *  the project and its private rooms. */
export default function ProjectCleanupSections({ projectId, projectIds }: {
  projectId: string;
  /** Every project in the picker, seeded on the first edit (projectRetention.ts). */
  projectIds: readonly string[];
}) {
  const defaults = useSessionDefaults();
  const legacyAuto = useStore((s) => s.settings.autoCleanupExpiredSessions);
  const {
    autoCleanup,
    days: retentionDays,
    action: retentionAction,
    skipIsolated,
    archiveDays: archiveRetentionDays,
    autoDeleteArchives,
  } = projectRetention(defaults, legacyAuto, projectId);
  const save = (patch: Parameters<typeof setProjectRetention>[1]) => setProjectRetention(projectId, patch, projectIds);

  const [eligible, setEligible] = useState<number | null>(null);
  const [archivesEligible, setArchivesEligible] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  // NumberField keeps its typed text; a remount restores the period after a
  // declined confirmation.
  const [retentionFieldKey, setRetentionFieldKey] = useState(0);
  const [archiveFieldKey, setArchiveFieldKey] = useState(0);

  useEffect(() => {
    let live = true;
    setEligible(null);
    void api.sessionRetention(retentionDays, "sessions", { skipIsolated, projectId })
      .then((summary) => {
        if (live) setEligible(typeof summary.eligibleCount === "number" ? summary.eligibleCount : 0);
      })
      .catch(() => { if (live) setEligible(0); });
    return () => { live = false; };
  }, [retentionDays, skipIsolated, projectId]);

  useEffect(() => {
    let live = true;
    setArchivesEligible(null);
    void api.sessionRetention(archiveRetentionDays, "archives", { projectId })
      .then((summary) => {
        if (live) setArchivesEligible(typeof summary.eligibleCount === "number" ? summary.eligibleCount : 0);
      })
      .catch(() => { if (live) setArchivesEligible(0); });
    return () => { live = false; };
  }, [archiveRetentionDays, projectId]);

  // The server cleans up on its own schedule, so the count moves without this page.
  useEffect(() => {
    if (!autoCleanup) return;
    const timer = setInterval(() => {
      void api.sessionRetention(retentionDays, "sessions", { skipIsolated, projectId })
        .then((summary) => setEligible(typeof summary.eligibleCount === "number" ? summary.eligibleCount : 0))
        .catch(() => {});
    }, 60_000);
    return () => clearInterval(timer);
  }, [autoCleanup, retentionDays, skipIsolated, projectId]);

  // Each of these starts permanent deletion that nobody confirms later, so the
  // person confirms it here. Archiving can be undone and needs no question,
  // unless it takes isolated work with it; that has its own question below.
  const confirmAutoDelete = () => confirmAlert(
    tr("settings.sessionspage.confirmAutoCleanupDelete", { count: eligible ?? 0 }),
    { title: tr("settings.sessionspage.autoCleanup"), confirmLabel: tr("settings.sessionspage.autoCleanupDeleteConfirm"), destructive: true },
  );

  const changeAutoCleanup = async (on: boolean) => {
    if (on && retentionAction === "delete" && !await confirmAutoDelete()) return;
    save({ autoCleanup: on });
  };

  const changeRetentionAction = async (action: RetentionAction) => {
    if (action === "delete" && autoCleanup && !await confirmAutoDelete()) return;
    save({ action });
  };

  const changeSkipIsolated = async (skip: boolean) => {
    if (!skip && !await confirmAlert(
      tr("settings.sessionspage.confirmCleanIsolated"),
      { title: tr("settings.sessionspage.skipIsolated"), confirmLabel: tr("settings.sessionspage.cleanIsolatedConfirm"), destructive: true },
    )) return;
    save({ skipIsolated: skip });
  };

  const changeRetentionDays = async (days: number) => {
    if (days < retentionDays && autoCleanup && retentionAction === "delete" && !await confirmAlert(
      tr("settings.sessionspage.confirmAutoCleanupShorterPeriod", { days }),
      { title: tr("settings.sessionspage.autoCleanup"), confirmLabel: tr("settings.sessionspage.autoCleanupDeleteConfirm"), destructive: true },
    )) {
      setRetentionFieldKey((key) => key + 1);
      return;
    }
    save({ days });
  };

  // Deleting from the archive on a schedule is permanent and nobody confirms it
  // later, so turning it on, or shortening its period while on, asks here.
  const changeAutoDeleteArchives = async (on: boolean) => {
    if (on && !await confirmAlert(
      tr("settings.sessionspage.confirmAutoDeleteArchives", { count: archivesEligible ?? 0, days: archiveRetentionDays }),
      { title: tr("settings.sessionspage.autoDeleteArchives"), confirmLabel: tr("settings.sessionspage.autoCleanupDeleteConfirm"), destructive: true },
    )) return;
    save({ autoDeleteArchives: on });
  };

  const changeArchiveDays = async (archiveDays: number) => {
    if (archiveDays < archiveRetentionDays && autoDeleteArchives && !await confirmAlert(
      tr("settings.sessionspage.confirmAutoCleanupShorterPeriod", { days: archiveDays }),
      { title: tr("settings.sessionspage.autoDeleteArchives"), confirmLabel: tr("settings.sessionspage.autoCleanupDeleteConfirm"), destructive: true },
    )) {
      setArchiveFieldKey((key) => key + 1);
      return;
    }
    save({ archiveDays });
  };

  const cleanup = async () => {
    if (retentionAction === "delete" && !await confirmAlert(
      tr("settings.sessionspage.confirmDeleteEligibleSessions", { count: eligible ?? 0 }),
      { title: tr("settings.sessionspage.cleanUpExpiredSessions"), confirmLabel: tr("common.delete"), destructive: true },
    )) return;
    setBusy(true);
    try {
      const result = await api.runSessionRetention(retentionDays, retentionAction, { skipIsolated, projectId });
      setEligible(Math.max(0, result.eligibleCount - result.succeeded.length));
      if (result.failed.length > 0) {
        setUiError(tr(retentionAction === "delete"
          ? "settings.sessionspage.eligibleSessionsCouldNotDelete"
          : "settings.sessionspage.eligibleSessionsCouldNotArchive", {
          count: result.failed.length,
        }));
      }
    } catch (e) {
      setUiError(friendlyError(tr("common.error"), e));
    } finally {
      setBusy(false);
    }
  };

  const deleteArchives = async (all: boolean) => {
    if (!await confirmAlert(
      all
        ? tr("settings.sessionspage.confirmDeleteAllArchives")
        : tr("settings.sessionspage.confirmDeleteArchivesOlderThan", { count: archivesEligible ?? 0, days: archiveRetentionDays }),
      {
        title: tr(all ? "settings.sessionspage.deleteAllArchives" : "settings.sessionspage.deleteArchivesOlderThan"),
        confirmLabel: tr("common.delete"),
        destructive: true,
      },
    )) return;
    setArchiveBusy(true);
    try {
      const result = all
        ? await api.deleteAllArchivedSessions({ projectId })
        : await api.deleteArchivedSessions(archiveRetentionDays, { projectId });
      setArchivesEligible(Math.max(0, result.eligibleCount - result.succeeded.length));
      if (result.failed.length > 0) {
        setUiError(tr("settings.sessionspage.archivesCouldNotDelete", { count: result.failed.length }));
      }
    } catch (e) {
      setUiError(friendlyError(tr("common.error"), e));
    } finally {
      setArchiveBusy(false);
    }
  };

  const cleanupVerb = retentionAction === "delete" ? "delete" : "archive";
  const autoCleanupLabel = tr(retentionAction === "delete"
    ? "settings.sessionspage.autoDeleteExpired"
    : "settings.sessionspage.autoArchive");
  const expiredHint = eligible === null
    ? tr("common.loading")
    : tr("settings.sessionspage.expiredSessionsNow", { count: eligible });
  const oldArchivesHint = archivesEligible === null
    ? tr("common.loading")
    : tr("settings.sessionspage.oldArchivesNow", { count: archivesEligible, days: archiveRetentionDays });

  return (
    <>
      <Section
        title={tr("settings.sessionspage.sessionRetention")}
        hint={tr("settings.sessionspage.cleanupProjectHint")}
        itemId="projects.cleanup"
      >
        <Row label={tr("settings.sessionspage.retentionPeriod")} hint={tr("settings.sessionspage.idleCompletedSessionsOlderThanThisBecome")}>
          <NumberField
            key={`${projectId}:${retentionFieldKey}`}
            value={retentionDays}
            min={1}
            max={3650}
            unit={tr("settings.sessionspage.days")}
            label={tr("settings.sessionspage.retentionPeriod")}
            onCommit={(days) => void changeRetentionDays(days)}
          />
        </Row>
        <Row
          label={tr("settings.sessionspage.cleanupAction")}
          hint={tr(retentionAction === "delete"
            ? "settings.sessionspage.cleanupDeleteIsPermanent"
            : "settings.sessionspage.chooseWhatHappensToExpiredSessions")}
        >
          <Seg
            value={retentionAction}
            options={[
              ["archive", tr("common.archive")],
              ["delete", tr("common.delete")],
            ]}
            onChange={(value) => void changeRetentionAction(value as RetentionAction)}
          />
        </Row>
        <Row
          label={tr("settings.sessionspage.skipIsolated")}
          hint={tr(skipIsolated
            ? "settings.sessionspage.skipIsolatedOnHint"
            : "settings.sessionspage.skipIsolatedOffHint")}
          itemId="projects.retentionSkipIsolated"
        >
          <Toggle
            on={skipIsolated}
            onChange={(skip) => void changeSkipIsolated(skip)}
            label={tr("settings.sessionspage.skipIsolated")}
          />
        </Row>
        <Row
          label={autoCleanupLabel}
          hint={tr(!autoCleanup
            ? "settings.sessionspage.autoCleanupOffHint"
            : retentionAction === "delete"
              ? "settings.sessionspage.autoCleanupDeleteHint"
              : "settings.sessionspage.autoCleanupArchiveHint")}
          itemId="projects.autoCleanupExpiredSessions"
        >
          <Toggle
            on={autoCleanup}
            onChange={(on) => void changeAutoCleanup(on)}
            label={autoCleanupLabel}
          />
        </Row>
        <Row label={tr("settings.sessionspage.cleanUpExpiredSessions")} hint={expiredHint}>
          <Button
            size="sm"
            variant={cleanupVerb === "delete" ? "danger" : "quiet"}
            busy={busy}
            disabled={!eligible}
            onClick={() => void cleanup()}
          >
            {busy
              ? cleanupVerb === "delete" ? tr("settings.sessionspage.deleting") : tr("settings.sessionspage.archiving")
              : cleanupVerb === "delete" ? tr("settings.sessionspage.deleteEligibleSessions") : tr("settings.sessionspage.archiveEligibleSessions")}
          </Button>
        </Row>
      </Section>

      <Section
        title={tr("settings.sessionspage.archiveCleanup")}
        tone="danger"
        {...(autoDeleteArchives ? {} : { hint: tr("settings.sessionspage.archiveSectionHint") })}
        itemId="projects.archives"
      >
        <Row label={tr("settings.sessionspage.deleteArchivesOlderThan")} hint={oldArchivesHint}>
          <div className="retention-actions">
            <NumberField
              key={`${projectId}:${archiveFieldKey}`}
              value={archiveRetentionDays}
              min={1}
              max={3650}
              unit={tr("settings.sessionspage.days")}
              label={tr("settings.sessionspage.deleteArchivesOlderThan")}
              onCommit={(archiveDays) => void changeArchiveDays(archiveDays)}
            />
            <Button size="sm" variant="danger" busy={archiveBusy} disabled={busy || !archivesEligible} onClick={() => void deleteArchives(false)}>
              {tr("common.delete")}
            </Button>
          </div>
        </Row>
        <Row
          label={tr("settings.sessionspage.autoDeleteArchives")}
          hint={autoDeleteArchives
            ? tr("settings.sessionspage.autoDeleteArchivesOnHint", { days: archiveRetentionDays })
            : tr("settings.sessionspage.autoDeleteArchivesOffHint")}
          itemId="projects.autoDeleteArchives"
        >
          <Toggle
            on={autoDeleteArchives}
            onChange={(on) => void changeAutoDeleteArchives(on)}
            label={tr("settings.sessionspage.autoDeleteArchives")}
          />
        </Row>
        <Row label={tr("settings.sessionspage.deleteAllArchives")} hint={tr("settings.sessionspage.deleteAllArchivesHint")}>
          <Button size="sm" variant="danger" busy={archiveBusy} disabled={busy} onClick={() => void deleteArchives(true)}>
            {tr("settings.sessionspage.deleteAllArchivesButton")}
          </Button>
        </Row>
      </Section>
    </>
  );
}
