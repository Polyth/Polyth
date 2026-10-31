import { useEffect, useMemo, useState } from "react";
import type { HarnessSelection, ModelDescriptor, ModelRef } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { setUiError, updateSettings, useStore } from "../../store.ts";
import {
  friendlyError,
  MAX_VISIBLE_SESSION_COUNT,
  VISIBLE_SESSION_WARNING_THRESHOLD,
} from "../../settings.ts";
import { setGlobalDefaultModel, setSessionDefaults, useSessionDefaults } from "../../sessionDefaults.ts";
import { NumberField, PageHead, Row, Section, Seg, Toggle } from "./parts.tsx";
import { type CatalogState, harnessModelCatalog, modelSupportsTextWorkflow } from "../../composer/discovery.ts";
import { roleKind, useRolePrefs } from "../../rolePrefs.ts";
import ModelPicker from "@polyth/models/model-picker";
import { useOtherHarnessModels, useRuntimeCatalog } from "@polyth/models/runtime-catalog";
import SlotHost from "../slots/SlotHost.ts";
import { tr } from "../../i18n/index.ts";
import { Button, Dialog, Notice, Select, TextInput } from "../ui/index.ts";
import { isImeComposing } from "../input/editorCore.ts";
import { confirmAlert } from "../../alerts.ts";

type RetentionAction = "archive" | "delete";

function SessionModelPicker({
  value,
  recommended,
  onPick,
  emptyLabel,
  direction = "down",
}: {
  value?: ModelRef & { harnessId?: string };
  recommended?: ModelRef & { harnessId?: string };
  onPick: (model?: ModelRef & { harnessId?: string }) => void;
  emptyLabel?: string;
  direction?: "up" | "down";
}) {
  const [pickerHarness, setPickerHarness] = useState<HarnessSelection | null>(null);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const projectId = activeProjectId ?? undefined;
  const projects = useStore((s) => s.projectRegistry.projects);
  const activeProject = projects.find((p) => p.id === projectId);
  const spaceId = activeProject?.spaceId;
  const globalModels = useStore((s) => s.models);
  const globalAgents = useStore((s) => s.agents);

  const storedHarnessId = value?.harnessId;
  const pickerHarnessId = pickerHarness?.mode === "pinned" ? pickerHarness.harnessId : storedHarnessId;

  const routeCatalog = useRuntimeCatalog(null, globalModels, globalAgents, {
    ...(projectId ? { projectId } : {}),
    ...(spaceId ? { spaceId } : {}),
    ...(pickerHarnessId ? { harnessId: pickerHarnessId } : {}),
  });

  const catalogHarnessId = pickerHarnessId ?? routeCatalog.harnessId;

  const otherHarnessModels = useOtherHarnessModels({
    ...(projectId ? { projectId } : {}),
    ...(spaceId ? { spaceId } : {}),
    ...(catalogHarnessId ? { excludeHarnessId: catalogHarnessId } : {}),
  });

  const modelCatalog: CatalogState<ModelDescriptor> = harnessModelCatalog({
    models: routeCatalog.models,
    ...(catalogHarnessId ? { harnessId: catalogHarnessId } : {}),
    discovery: routeCatalog.discovery,
  });

  const chatModels = modelCatalog.state === "available"
    ? modelCatalog.items
    : routeCatalog.models
        .filter((model) => !catalogHarnessId || !model.harnessId || model.harnessId === catalogHarnessId)
        .filter(modelSupportsTextWorkflow);

  const harnessSelection: HarnessSelection = pickerHarness
    ?? (storedHarnessId ? { mode: "pinned", harnessId: storedHarnessId } : { mode: "auto" });

  const executionPickerContext = {
    spaceId,
    projectId,
    harnessSelection,
    resolvedHarnessId: catalogHarnessId,
    pendingHarnessSelection: harnessSelection,
    onSelectHarness: (selection: HarnessSelection) => setPickerHarness(selection),
    model: value,
    thinking: value?.variant,
  };

  const handlePick = (model?: ModelRef & { harnessId?: string }) => {
    setPickerHarness(null);
    if (!model) {
      onPick(undefined);
      return;
    }
    const resolvedHarnessId = model.harnessId ?? catalogHarnessId;
    onPick({
      providerID: model.providerID,
      modelID: model.modelID,
      ...(resolvedHarnessId ? { harnessId: resolvedHarnessId } : {}),
      ...(model.variant !== undefined ? { variant: model.variant } : {}),
    });
  };

  return (
    <ModelPicker
      direction={direction}
      models={chatModels}
      {...(catalogHarnessId ? { harnessId: catalogHarnessId } : {})}
      {...(value ? { value } : {})}
      {...(recommended ? { recommended } : {})}
      {...(emptyLabel ? { emptyLabel } : {})}
      {...(value?.variant !== undefined ? { thinking: value.variant } : {})}
      catalogLoading={modelCatalog.state === "loading" || routeCatalog.discovery.state === "pending"}
      otherHarnesses={otherHarnessModels}
      header={<SlotHost slot="modelPicker.header" context={executionPickerContext} />}
      onPick={handlePick}
    />
  );
}

export default function SessionsPage() {
  const models = useStore((s) => s.models);
  const settings = useStore((s) => s.settings);
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
  const defaultModel = defaults.defaultModel
    ? (textModels.find((model) =>
        model.providerID === defaults.defaultModel?.providerID
        && model.modelID === defaults.defaultModel.modelID
        && (!defaults.defaultModel.harnessId || model.harnessId === defaults.defaultModel.harnessId))
      ?? {
        providerID: defaults.defaultModel.providerID,
        modelID: defaults.defaultModel.modelID,
        name: defaults.defaultModel.modelID,
        ...(defaults.defaultModel.harnessId ? { harnessId: defaults.defaultModel.harnessId } : {}),
      })
    : textModels[0];
  const defaultModelRef = defaults.defaultModel
    ? {
        providerID: defaults.defaultModel.providerID,
        modelID: defaults.defaultModel.modelID,
        ...(defaults.defaultModel.harnessId ? { harnessId: defaults.defaultModel.harnessId } : {}),
        ...(defaults.defaultModel.variant ? { variant: defaults.defaultModel.variant } : {}),
      }
    : defaultModel
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
  const [visibleSessionCountInput, setVisibleSessionCountInput] = useState(
    String(settings.defaultVisibleSessionCount),
  );
  const [pendingVisibleSessionCount, setPendingVisibleSessionCount] = useState<number | null>(null);

  useEffect(() => {
    setVisibleSessionCountInput(String(settings.defaultVisibleSessionCount));
  }, [settings.defaultVisibleSessionCount]);

  const commitVisibleSessionCount = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setVisibleSessionCountInput(String(settings.defaultVisibleSessionCount));
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setVisibleSessionCountInput(String(settings.defaultVisibleSessionCount));
      return;
    }
    const next = Math.max(1, Math.min(MAX_VISIBLE_SESSION_COUNT, Math.round(parsed)));
    setVisibleSessionCountInput(String(next));
    if (next === settings.defaultVisibleSessionCount) {
      setPendingVisibleSessionCount(null);
      return;
    }
    if (next > VISIBLE_SESSION_WARNING_THRESHOLD) {
      setPendingVisibleSessionCount(next);
      return;
    }
    updateSettings({ defaultVisibleSessionCount: next });
  };

  const previewVisibleSessionCount = (raw: string) => {
    setVisibleSessionCountInput(raw);
    const trimmed = raw.trim();
    if (!trimmed) return;
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed)) return;
    const next = Math.max(1, Math.min(MAX_VISIBLE_SESSION_COUNT, parsed));
    if (next > VISIBLE_SESSION_WARNING_THRESHOLD) {
      setVisibleSessionCountInput(String(next));
      setPendingVisibleSessionCount(next);
    }
  };

  const cancelVisibleSessionWarning = () => {
    setPendingVisibleSessionCount(null);
    setVisibleSessionCountInput(String(settings.defaultVisibleSessionCount));
  };

  const applyVisibleSessionWarning = () => {
    if (pendingVisibleSessionCount === null) return;
    updateSettings({ defaultVisibleSessionCount: pendingVisibleSessionCount });
    setPendingVisibleSessionCount(null);
  };

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
      tr("settings.sessionspage.confirmDeleteEligibleSessions", { count: eligible ?? 0 }),
      { title: tr("settings.sessionspage.cleanUpExpiredSessions"), confirmLabel: tr("common.delete"), destructive: true },
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
      tr("settings.sessionspage.confirmDeleteArchivesOlderThan", { count: archivesEligible ?? 0, days: archiveRetentionDays }),
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

  const cleanupVerb = retentionAction === "delete" ? "delete" : "archive";
  const expiredHint = eligible === null
    ? tr("common.loading")
    : tr("settings.sessionspage.expiredSessionsNow", { count: eligible });
  const oldArchivesHint = archivesEligible === null
    ? tr("common.loading")
    : tr("settings.sessionspage.oldArchivesNow", { count: archivesEligible, days: archiveRetentionDays });

  return (
    <>
      <PageHead title={tr("settings.sessionspage.sessions")} blurb={tr("settings.sessionspage.setDefaultsAndRetentionForSessions")} />
      <Section
        title={tr("settings.sessionspage.sessionDefaults")}
        hint={<>
          {tr("settings.sessionspage.newSessionsWillStartWith")}{" "}
          <strong>{defaultModel?.name ?? tr("settings.sessionspage.noModelAvailable")}</strong>
          {defaultAgent && <> · <strong>{defaultAgent}</strong></>}
        </>}
      >
        <Row label={tr("settings.sessionspage.defaultModel")} hint={tr("settings.sessionspage.theModelSelectedWhenAProjectDoes")} itemId="sessions.defaultModel">
          <SessionModelPicker
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
        <Row label={tr("settings.sessionspage.smallModel")} hint={tr("settings.sessionspage.overrideModelForLightweightSummariesAndGenerated")} itemId="sessions.small-model">
          <SessionModelPicker
            value={defaults.smallModel}
            recommended={defaultModelRef}
            onPick={(smallModel) => setSessionDefaults({ smallModel })}
          />
        </Row>
        <Row label={tr("settings.sessionspage.changesWalkthroughModel")} hint={tr("settings.sessionspage.modelUsedWhenGeneratingAChangesWalkthrough")}>
          <SessionModelPicker
            value={defaults.walkthroughModel}
            recommended={defaultModelRef}
            onPick={(walkthroughModel) => setSessionDefaults({ walkthroughModel })}
          />
        </Row>
      </Section>

      <Section title={tr("settings.sessionspage.sessionBehavior")}>
        <Row
          label={tr("settings.sessionspage.defaultVisibleSessions")}
          hint={tr("settings.sessionspage.defaultVisibleSessionsHint")}
          itemId="sessions.defaultVisibleSessionCount"
        >
          <span className="settings-number settings-number--sm">
            <TextInput
              uiSize="sm"
              className="settings-number-input"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_VISIBLE_SESSION_COUNT}
              step={1}
              value={visibleSessionCountInput}
              aria-label={tr("settings.sessionspage.defaultVisibleSessions")}
              onChange={(event) => previewVisibleSessionCount(event.target.value)}
              onBlur={(event) => commitVisibleSessionCount(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (isImeComposing(event)) return;
                if (event.key !== "Enter") return;
                event.preventDefault();
                commitVisibleSessionCount(event.currentTarget.value);
              }}
            />
            <span className="settings-number-unit" aria-hidden="true">{tr("settings.sessionspage.sessionCountUnit")}</span>
          </span>
        </Row>
        <Row
          label={tr("settings.sessionspage.autoDeleteFailedStartupSessions")}
          hint={tr("settings.sessionspage.autoDeleteFailedStartupSessionsHint")}
          itemId="sessions.autoDeleteFailedStartupSessions"
        >
          <Toggle
            on={settings.autoDeleteFailedStartupSessions}
            onChange={(autoDeleteFailedStartupSessions) => updateSettings({ autoDeleteFailedStartupSessions })}
            label={tr("settings.sessionspage.autoDeleteFailedStartupSessions")}
          />
        </Row>
      </Section>

      <Section
        title={tr("settings.sessionspage.sessionRetention")}
        hint={tr("settings.sessionspage.cleanupSectionHint")}
        itemId="sessions.cleanup"
      >
        <Row label={tr("settings.sessionspage.retentionPeriod")} hint={tr("settings.sessionspage.idleCompletedSessionsOlderThanThisBecome")}>
          <NumberField
            value={retentionDays}
            min={1}
            max={3650}
            unit={tr("settings.sessionspage.days")}
            label={tr("settings.sessionspage.retentionPeriod")}
            onCommit={(days) => setSessionDefaults({ retentionDays: days })}
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
            onChange={(value) => setSessionDefaults({ retentionAction: value as RetentionAction })}
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
        hint={tr("settings.sessionspage.archiveSectionHint")}
        itemId="sessions.archives"
      >
        <Row label={tr("settings.sessionspage.deleteArchivesOlderThan")} hint={oldArchivesHint}>
          <div className="retention-actions">
            <NumberField
              value={archiveRetentionDays}
              min={1}
              max={3650}
              unit={tr("settings.sessionspage.days")}
              label={tr("settings.sessionspage.deleteArchivesOlderThan")}
              onCommit={(days) => setSessionDefaults({ archiveRetentionDays: days })}
              />
            <Button size="sm" variant="danger" busy={archiveBusy} disabled={busy || !archivesEligible} onClick={() => void deleteOldArchives()}>
              {tr("common.delete")}
            </Button>
          </div>
        </Row>
        <Row label={tr("settings.sessionspage.deleteAllArchives")} hint={tr("settings.sessionspage.deleteAllArchivesHint")}>
          <Button size="sm" variant="danger" busy={archiveBusy} disabled={busy} onClick={() => void deleteAllArchives()}>
            {tr("settings.sessionspage.deleteAllArchivesButton")}
          </Button>
        </Row>
      </Section>
      {pendingVisibleSessionCount !== null && (
        <Dialog
          title={tr("settings.sessionspage.manySessionsWarningTitle")}
          onClose={cancelVisibleSessionWarning}
          size="sm"
          className="session-load-warning-dialog"
          footer={(
            <>
              <Button size="sm" onClick={cancelVisibleSessionWarning}>{tr("common.cancel")}</Button>
              <Button size="sm" variant="primary" onClick={applyVisibleSessionWarning}>
                {tr("common.apply")}
              </Button>
            </>
          )}
        >
          <Notice tone="warning" role="alert">
            {tr("settings.sessionspage.manySessionsWarning", { count: pendingVisibleSessionCount })}
          </Notice>
          <p className="session-load-warning-hint">
            {tr("settings.sessionspage.manySessionsWarningHint")}
          </p>
        </Dialog>
      )}
    </>
  );
}
