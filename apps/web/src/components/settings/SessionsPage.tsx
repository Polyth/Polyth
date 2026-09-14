import { useEffect, useMemo, useState } from "react";
import { api } from "@polyth/session/web-api";
import { setUiError, updateSettings, useStore } from "../../store.ts";
import { friendlyError } from "../../settings.ts";
import { setGlobalDefaultModel, setSessionDefaults, useSessionDefaults } from "../../sessionDefaults.ts";
import { PageHead, Row, Seg } from "./parts.tsx";
import { modelSupportsTextWorkflow } from "../../composer/discovery.ts";
import { roleKind, useRolePrefs } from "../../rolePrefs.ts";
import ModelPicker from "../../../../../packages/models/widgets/ModelPicker.tsx";
import { tr } from "../../i18n/index.ts";
import { Button, Select, TextInput } from "../ui/index.ts";
import { confirmAlert } from "../../alerts.ts";

type RetentionAction = "archive" | "delete";

export default function SessionsPage() {
  const models = useStore((s) => s.models);
  const textModels = useMemo(() => models.filter(modelSupportsTextWorkflow), [models]);
  const agents = useStore((s) => s.agents);
  const rolePrefs = useRolePrefs();
  const mainAgents = agents.filter((agent) =>
    roleKind(agent, rolePrefs) === "main" && agent.name.toLowerCase() !== "compaction");
  const defaults = useSessionDefaults();
  const retentionDays = defaults.retentionDays ?? 30;
  const retentionAction: RetentionAction = defaults.retentionAction ?? "archive";
  const archiveRetentionDays = defaults.archiveRetentionDays ?? 30;
  const defaultAgent = defaults.defaultAgent
    && mainAgents.some((agent) => agent.name === defaults.defaultAgent)
    ? defaults.defaultAgent
    : mainAgents.find((agent) => agent.name.toLowerCase() === "build")?.name
      ?? mainAgents[0]?.name
    ?? "";
  const defaultModel = (defaults.defaultModel
    ? textModels.find((model) =>
        model.providerID === defaults.defaultModel?.providerID
        && model.modelID === defaults.defaultModel.modelID
        && (!defaults.defaultModel.harnessId || model.harnessId === defaults.defaultModel.harnessId))
    : undefined) ?? textModels[0];
  const defaultModelRef = defaultModel
    ? {
        providerID: defaultModel.providerID,
        modelID: defaultModel.modelID,
        ...(defaultModel.harnessId ? { harnessId: defaultModel.harnessId } : {}),
      }
    : undefined;
  const thinkingOptions = [...new Set(models.flatMap((model) => model.variants ?? []))];
  const [eligible, setEligible] = useState<number | null>(null);
  const [archivesEligible, setArchivesEligible] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setEligible(null);
    void api.sessionRetention(retentionDays)
      .then((summary) => {
        if (live) setEligible(typeof summary.eligibleCount === "number" ? summary.eligibleCount : 0);
      })
      .catch(() => { if (live) setEligible(0); });
    return () => { live = false; };
  }, [retentionDays]);

  useEffect(() => {
    let live = true;
    setArchivesEligible(null);
    void api.sessionRetention(archiveRetentionDays, "archives")
      .then((summary) => {
        if (live) setArchivesEligible(typeof summary.eligibleCount === "number" ? summary.eligibleCount : 0);
      })
      .catch(() => { if (live) setArchivesEligible(0); });
    return () => { live = false; };
  }, [archiveRetentionDays]);

  const cleanup = async () => {
    if (retentionAction === "delete" && !await confirmAlert(
      tr("settings.sessionspage.confirmDeleteEligibleSessions"),
      { title: tr("settings.sessionspage.deleteEligibleSessions"), confirmLabel: tr("common.delete"), destructive: true },
    )) return;
    setBusy(true);
    try {
      const result = await api.runSessionRetention(retentionDays, retentionAction);
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

  const deleteOldArchives = async () => {
    if (!await confirmAlert(
      tr("settings.sessionspage.confirmDeleteArchivesOlderThan", { days: archiveRetentionDays }),
      { title: tr("settings.sessionspage.deleteOldArchives"), confirmLabel: tr("common.delete"), destructive: true },
    )) return;
    setArchiveBusy(true);
    try {
      const result = await api.deleteArchivedSessions(archiveRetentionDays);
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

  const deleteAllArchives = async () => {
    if (!await confirmAlert(
      tr("settings.sessionspage.confirmDeleteAllArchives"),
      { title: tr("settings.sessionspage.deleteAllArchives"), confirmLabel: tr("common.delete"), destructive: true },
    )) return;
    setArchiveBusy(true);
    try {
      const result = await api.deleteAllArchivedSessions();
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

  return (
    <>
      <PageHead title={tr("settings.sessionspage.sessions")} blurb={tr("settings.sessionspage.setDefaultsAndRetentionForSessions")} />
      <div className="stat-label session-settings-heading">{tr("settings.sessionspage.sessionDefaults")}</div>
      <p className="session-default-summary">
        {tr("settings.sessionspage.newSessionsWillStartWith")} {" "}
        <strong>{defaultModel?.name ?? tr("settings.sessionspage.noModelAvailable")}</strong>
        {defaultAgent && <> / <strong>{defaultAgent}</strong></>}
      </p>
      <Row label={tr("settings.sessionspage.defaultModel")} hint={tr("settings.sessionspage.theModelSelectedWhenAProjectDoes")} itemId="sessions.defaultModel">
        <ModelPicker
          direction="down"
          models={textModels}
          value={defaults.defaultModel}
          recommended={defaultModelRef}
          onPick={(model) => {
            setGlobalDefaultModel(model);
            updateSettings({ defaultModel: model ? `${model.providerID}/${model.modelID}` : "" });
          }}
        />
      </Row>
      <Row label={tr("settings.sessionspage.defaultThinking")} hint={tr("settings.sessionspage.appliedToModelsThatOfferThinkingVariants")}>
        <Select
          label={defaults.defaultThinking ?? tr("settings.sessionspage.default")}
          ariaLabel={tr("settings.sessionspage.defaultThinking")}
          value={defaults.defaultThinking ?? ""}
          options={[
            { value: "", label: tr("settings.sessionspage.default") },
            ...thinkingOptions.map((thinking) => ({ value: thinking, label: thinking })),
          ]}
          onChange={(value) => setSessionDefaults({ defaultThinking: value || undefined })}
        />
      </Row>
      <Row label={tr("settings.sessionspage.defaultAgent")} hint={tr("settings.sessionspage.opencodeRoleUsedWhenNoProjectOr")}>
        <Select
          label={defaultAgent || tr("settings.sessionspage.opencodeAgentDefault")}
          ariaLabel={tr("settings.sessionspage.defaultAgent")}
          value={defaultAgent}
          options={[
            { value: "", label: tr("settings.sessionspage.opencodeAgentDefault") },
            ...mainAgents.map((agent) => ({ value: agent.name, label: agent.name })),
          ]}
          onChange={(value) => setSessionDefaults({ defaultAgent: value || undefined })}
        />
      </Row>
      <Row label={tr("settings.sessionspage.smallModel")} hint={tr("settings.sessionspage.overrideModelForLightweightSummariesAndGenerated")}>
        <ModelPicker
          direction="down"
          models={textModels}
          value={defaults.smallModel}
          recommended={defaultModelRef}
          onPick={(smallModel) => setSessionDefaults({ smallModel })}
        />
      </Row>
      <Row label={tr("settings.sessionspage.changesWalkthroughModel")} hint={tr("settings.sessionspage.modelUsedWhenGeneratingAChangesWalkthrough")}>
        <ModelPicker
          direction="down"
          models={textModels}
          value={defaults.walkthroughModel}
          recommended={defaultModelRef}
          onPick={(walkthroughModel) => setSessionDefaults({ walkthroughModel })}
        />
      </Row>

      <div className="stat-label session-settings-heading">{tr("settings.sessionspage.sessionRetention")}</div>
      <Row label={tr("settings.sessionspage.retentionPeriod")} hint={tr("settings.sessionspage.idleCompletedSessionsOlderThanThisBecome")}>
        <label className="retention-days">
          <TextInput
            uiSize="sm"
            type="number"
            min={1}
            max={3650}
            value={retentionDays}
            aria-label={tr("settings.sessionspage.retentionPeriod")}
            onChange={(event) => setSessionDefaults({ retentionDays: Number(event.target.value) || 1 })}
          />
          <span>{tr("settings.sessionspage.days")}</span>
        </label>
      </Row>
      <p className="session-retention-note">
        {tr(retentionAction === "delete"
          ? "settings.sessionspage.expiredSessionsAreDeletedOnlyWhenYou"
          : "settings.sessionspage.expiredSessionsAreArchivedOnlyWhenYou")}</p>
      <Row label={tr("settings.sessionspage.cleanupAction")} hint={tr("settings.sessionspage.chooseWhatHappensToExpiredSessions")}>
        <Seg
          value={retentionAction}
          options={[
            ["archive", tr("common.archive")],
            ["delete", tr("common.delete")],
          ]}
          onChange={(value) => setSessionDefaults({ retentionAction: value as RetentionAction })}
        />
      </Row>
      <Row label={tr("settings.sessionspage.manualCleanup")} hint={tr("settings.sessionspage.chooseWhatHappensToExpiredSessions")}>
        <Button size="sm" variant={retentionAction === "delete" ? "danger" : "quiet"} busy={busy} disabled={!eligible} onClick={() => void cleanup()}>
          {busy
            ? retentionAction === "delete" ? tr("settings.sessionspage.deleting") : tr("settings.sessionspage.archiving")
            : retentionAction === "delete" ? tr("settings.sessionspage.deleteEligibleSessions") : tr("settings.sessionspage.archiveEligibleSessions")}
        </Button>
      </Row>
      <div className="retention-eligible" role="status">
        {retentionAction === "archive"
          ? tr("settings.sessionspage.eligibleForArchivingRightNow")
          : tr("settings.sessionspage.eligibleForDeletionRightNow")} <strong>{eligible ?? "…"}</strong>
      </div>

      <div className="stat-label session-settings-heading">{tr("settings.sessionspage.archiveCleanup")}</div>
      <Row label={tr("settings.sessionspage.deleteArchivesOlderThan")} hint={tr("settings.sessionspage.deleteArchivesOlderThanHint")}>
        <label className="retention-days">
          <TextInput
            uiSize="sm"
            type="number"
            min={1}
            max={3650}
            value={archiveRetentionDays}
            aria-label={tr("settings.sessionspage.deleteArchivesOlderThan")}
            onChange={(event) => setSessionDefaults({ archiveRetentionDays: Number(event.target.value) || 1 })}
          />
          <span>{tr("settings.sessionspage.days")}</span>
        </label>
      </Row>
      <Row label={tr("settings.sessionspage.manualCleanup")} hint={tr("settings.sessionspage.deleteArchivesOlderThanHint")}>
        <div className="retention-actions">
          <Button size="sm" variant="danger" busy={archiveBusy} disabled={busy || !archivesEligible} onClick={() => void deleteOldArchives()}>
            {tr("settings.sessionspage.deleteOldArchives")}
          </Button>
          <Button size="sm" variant="danger" busy={archiveBusy} disabled={busy} onClick={() => void deleteAllArchives()}>
            {tr("settings.sessionspage.deleteAllArchives")}
          </Button>
        </div>
      </Row>
      <div className="retention-eligible" role="status">
        {tr("settings.sessionspage.eligibleArchivesForDeletionRightNow")} <strong>{archivesEligible ?? "…"}</strong>
      </div>
    </>
  );
}
