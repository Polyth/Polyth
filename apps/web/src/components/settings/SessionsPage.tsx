import { useEffect, useMemo, useState } from "react";
import { api } from "@polyth/session/web-api";
import { setUiError, updateSettings, useStore } from "../../store.ts";
import { friendlyError } from "../../settings.ts";
import { setGlobalDefaultModel, setSessionDefaults, useSessionDefaults } from "../../sessionDefaults.ts";
import { PageHead, Row } from "./parts.tsx";
import { modelSupportsTextWorkflow } from "../../composer/discovery.ts";
import { roleKind, useRolePrefs } from "../../rolePrefs.ts";
import ModelPicker from "../../../../../packages/models/widgets/ModelPicker.tsx";
import { tr } from "../../i18n/index.ts";
import { Button, Select, TextInput } from "../ui/index.ts";

export default function SessionsPage() {
  const models = useStore((s) => s.models);
  const textModels = useMemo(() => models.filter(modelSupportsTextWorkflow), [models]);
  const agents = useStore((s) => s.agents);
  const rolePrefs = useRolePrefs();
  const mainAgents = agents.filter((agent) =>
    roleKind(agent, rolePrefs) === "main" && agent.name.toLowerCase() !== "compaction");
  const defaults = useSessionDefaults();
  const retentionDays = defaults.retentionDays ?? 30;
  const defaultAgent = defaults.defaultAgent
    && mainAgents.some((agent) => agent.name === defaults.defaultAgent)
    ? defaults.defaultAgent
    : mainAgents.find((agent) => agent.name.toLowerCase() === "build")?.name
      ?? mainAgents[0]?.name
    ?? "";
  const defaultModel = (defaults.defaultModel
    ? textModels.find((model) =>
        model.providerID === defaults.defaultModel?.providerID
        && model.modelID === defaults.defaultModel.modelID)
    : undefined) ?? textModels[0];
  const defaultModelRef = defaultModel
    ? { providerID: defaultModel.providerID, modelID: defaultModel.modelID }
    : undefined;
  const thinkingOptions = [...new Set(models.flatMap((model) => model.variants ?? []))];
  const [eligible, setEligible] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

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

  const cleanup = async () => {
    setBusy(true);
    try {
      const result = await api.runSessionRetention(retentionDays);
      setEligible(Math.max(0, result.eligibleCount - result.succeeded.length));
      if (result.failed.length > 0) {
        setUiError(tr("settings.sessionspage.eligibleSessionsCouldNotArchive", {
          count: result.failed.length,
        }));
      }
    } catch (e) {
      setUiError(friendlyError(tr("common.error"), e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title={tr("settings.sessionspage.sessions")} blurb={tr("settings.sessionspage.setDefaultsAndRetentionForSessions")} />
      <div className="stat-label session-settings-heading">{tr("settings.sessionspage.sessionDefaults")}</div>
      <p className="session-default-summary">
        {tr("settings.sessionspage.newSessionsWillStartWith")}{" "}
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
        {tr("settings.sessionspage.expiredSessionsAreArchivedOnlyWhenYou")}</p>
      <Row label={tr("settings.sessionspage.manualCleanup")} hint={tr("settings.sessionspage.archiveEverySessionThatCurrentlyMeetsThe")}>
        <Button size="sm" busy={busy} disabled={!eligible} onClick={() => void cleanup()}>
          {busy ? tr("settings.sessionspage.archiving") : tr("settings.sessionspage.archiveEligibleSessions")}
        </Button>
      </Row>
      <div className="retention-eligible" role="status">
        {tr("settings.sessionspage.eligibleForArchivingRightNow")}{" "}<strong>{eligible ?? "…"}</strong>
      </div>
    </>
  );
}
