import { useEffect, useMemo, useState } from "react";
import type { HarnessSelection, ModelDescriptor, ModelRef } from "@polyth/contracts";
import { updateSettings, useStore } from "../../store.ts";
import {
  MAX_VISIBLE_SESSION_COUNT,
  VISIBLE_SESSION_WARNING_THRESHOLD,
} from "../../settings.ts";
import { setGlobalDefaultModel, setSessionDefaults, useSessionDefaults } from "../../sessionDefaults.ts";
import { PageHead, Row, Section, Seg, Toggle } from "./parts.tsx";
import ChatMemorySection from "./ChatMemorySection.tsx";
import { type CatalogState, harnessModelCatalog, modelSupportsTextWorkflow } from "../../composer/discovery.ts";
import { roleKind, useRolePrefs } from "../../rolePrefs.ts";
import ModelPicker from "@polyth/models/model-picker";
import { useOtherHarnessModels, useRuntimeCatalog } from "@polyth/models/runtime-catalog";
import SlotHost from "../slots/SlotHost.ts";
import { tr } from "../../i18n/index.ts";
import { Button, Dialog, Notice, Select, TextInput } from "../ui/index.ts";
import { isImeComposing } from "../input/editorCore.ts";

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

  return (
    <>
      <PageHead title={tr("settings.sessionspage.sessions")} blurb={tr("settings.sessionspage.sessionDefaultsBlurb")} />
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
        <Row label={tr("settings.sessionspage.compactionModel")} hint={tr("settings.sessionspage.compactionModelHint")} itemId="sessions.compaction-model">
          <Seg
            label={tr("settings.sessionspage.compactionModel")}
            value={defaults.compactionModel ?? "session"}
            options={[
              ["session", tr("settings.sessionspage.compactionModelSession")],
              ["small", tr("settings.sessionspage.compactionModelSmall")],
            ]}
            onChange={(compactionModel) => setSessionDefaults({ compactionModel })}
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

      <ChatMemorySection />

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
