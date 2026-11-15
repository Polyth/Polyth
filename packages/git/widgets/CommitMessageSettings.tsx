import { useEffect, useRef, useState } from "react";
import type { HarnessSnapshot, ModelDescriptor } from "@polyth/contracts";
import { createApiTransport } from "@polyth/web-sdk";
import { Button, Notice, Select, Skeleton, Textarea } from "@polyth/web/ui";
import ModelPicker from "@polyth/models/model-picker";
import { ErrorState, ReadonlyRow, ResetLink, Row, SaveBar, Section, Seg, Toggle, type SaveStatusState } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { COMMIT_RULE_MAX, type CommitDetails, type CommitSettings, type CommitStyle } from "../src/commitSettings.ts";

const api = createApiTransport();
type Snapshot = { revision: number; settings: CommitSettings; canEdit?: boolean };

/** The section's working copy: the style always in its full shape. */
interface Draft {
  mode: CommitSettings["mode"];
  model?: CommitSettings["model"];
  style: CommitStyle;
}

const STANDARD: CommitStyle = { titleRule: "", detailsRule: "", details: "auto", matchHistory: false };
/** From here on the field shows how much room is left. */
const RULE_COUNT_FROM = 1200;

type StyleId = "standard" | "brackets" | "conventional";

/** Ready-made styles. Their text is per locale (a Ukrainian rule still asks
 *  for English commits); the examples are commit messages, so English. */
const STYLES: readonly { id: StyleId; label: () => string; title: () => string; details: () => string; example: { title: string; details: string } }[] = [
  {
    id: "standard",
    label: () => tr("gitsettings.commitStyleStandard"),
    title: () => "",
    details: () => "",
    example: { title: "Fix sign-in on slow connections", details: "Wait for the session cookie before redirecting, so a slow\nnetwork no longer lands on the sign-in page again." },
  },
  {
    id: "brackets",
    label: () => tr("gitsettings.commitStyleBrackets"),
    title: () => tr("gitsettings.commitTemplateBracketsTitle"),
    details: () => tr("gitsettings.commitTemplateBracketsDetails"),
    example: { title: "[Fix] Sign-in on slow connections", details: "Wait for the session cookie before redirecting, so a slow\nnetwork no longer lands on the sign-in page again." },
  },
  {
    id: "conventional",
    label: () => tr("gitsettings.commitStyleConventional"),
    title: () => tr("gitsettings.commitTemplateConventionalTitle"),
    details: () => tr("gitsettings.commitTemplateConventionalDetails"),
    example: { title: "fix(auth): wait for session cookie", details: "A slow network could redirect before the cookie was stored\nand show the sign-in page again." },
  },
];

/** The ready-made style the rules are, or null for the person's own. */
export function matchCommitStyle(style: Pick<CommitStyle, "titleRule" | "detailsRule">): StyleId | null {
  const title = style.titleRule.trim();
  const details = style.detailsRule.trim();
  return STYLES.find((entry) => entry.title() === title && entry.details() === details)?.id ?? null;
}

function draftOf(settings: CommitSettings): Draft {
  return {
    mode: settings.mode,
    ...(settings.mode === "custom" && settings.model ? { model: settings.model } : {}),
    style: { ...STANDARD, ...settings.style },
  };
}

/** What a save would send; equal drafts produce equal JSON. */
function settingsOf(draft: Draft): CommitSettings {
  return {
    mode: draft.mode,
    ...(draft.mode === "custom" && draft.model ? { model: draft.model } : {}),
    style: { ...draft.style, titleRule: draft.style.titleRule.trim(), detailsRule: draft.style.detailsRule.trim() },
  };
}

const sameDraft = (a: Draft, b: Draft): boolean => JSON.stringify(settingsOf(a)) === JSON.stringify(settingsOf(b));
const isStandardStyle = (style: CommitStyle): boolean => !style.titleRule.trim() && !style.detailsRule.trim() && style.details === "auto" && !style.matchHistory;

type SaveError = "conflict" | "forbidden" | "failed";

const saveErrorOf = (error: unknown): SaveError => {
  const value = error as { status?: number; code?: string } | null;
  if (value?.status === 409 || value?.code === "conflict") return "conflict";
  if (value?.status === 403 || value?.code === "permission-denied") return "forbidden";
  return "failed";
};

/** A rule field: named by its row's <label htmlFor>, grows with its text up
 *  to 14 lines (a full template on a phone) and then scrolls. */
function RuleField({ id, value, placeholder, onChange }: {
  id: string; value: string; placeholder: string; onChange: (value: string) => void;
}) {
  return (
    <>
      <Textarea
        id={id}
        className="git-commit-rule"
        autoGrow
        minRows={2}
        maxRows={14}
        maxLength={COMMIT_RULE_MAX}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value.length >= RULE_COUNT_FROM && (
        <p className="git-commit-note">
          {tr("gitsettings.commitRuleCount", { count: value.length.toLocaleString(), max: COMMIT_RULE_MAX.toLocaleString() })}
        </p>
      )}
    </>
  );
}

/** A fixed example for a ready-made style. For the person's own rules it
 *  points an editor at Generate instead; a reader gets nothing. */
function Example({ style, editable }: { style: CommitStyle; editable: boolean }) {
  const known = STYLES.find((entry) => entry.id === matchCommitStyle(style));
  if (!known) return editable ? <p className="git-commit-example-own">{tr("gitsettings.commitExampleOwn")}</p> : null;
  const message = style.details === "never" ? known.example.title : `${known.example.title}\n\n${known.example.details}`;
  return (
    <div className="git-commit-example">
      <div className="git-commit-example-label">
        {style.details === "auto" ? tr("gitsettings.commitExampleAuto") : tr("gitsettings.commitExample")}
      </div>
      <pre>{message}</pre>
    </div>
  );
}

/** How Polyth writes commit messages, for the whole Space: which model, and
 *  the title and details rules it follows. One draft, saved explicitly: the
 *  rules shape every member's next commit, so half-typed text must not land. */
export default function CommitMessageSettings({ projectId }: { projectId?: string }) {
  const mounted = useRef(true);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [draft, setDraftState] = useState<Draft>();
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<unknown>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<SaveStatusState>("idle");
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [reload, setReload] = useState(0);
  const [modelsReload, setModelsReload] = useState(0);
  // "Your own rules" chosen on a Standard style: open the empty fields.
  const [ownOpen, setOwnOpen] = useState(false);

  const setDraft = (next: Draft) => {
    setDraftState(next);
    setStatus("idle");
  };

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    setLoadError(null);
    void api.get<Snapshot>("/api/git/commit-settings", { signal: controller.signal }).then((value) => {
      if (controller.signal.aborted) return;
      setSnapshot(value);
      setDraftState(draftOf(value.settings));
    }).catch((error: unknown) => { if (!controller.signal.aborted) setLoadError(error); });
    return () => { mounted.current = false; controller.abort(); };
  }, [reload]);

  useEffect(() => {
    const controller = new AbortController();
    setModelsLoading(true); setModels([]); setModelsError(null);
    const scope = projectId ? `&projectId=${encodeURIComponent(projectId)}` : "";
    void api.get<HarnessSnapshot[]>(`/api/harnesses/snapshots?detail=1${scope}`, { signal: controller.signal }).then((rows) => {
      if (!controller.signal.aborted) setModels(rows.flatMap((row) => (row.catalog?.models ?? []).map((model) => ({ ...model, harnessId: model.harnessId ?? row.identity.id }))));
    }).catch((error: unknown) => { if (!controller.signal.aborted) setModelsError(error ?? new Error("models unavailable")); }).finally(() => { if (!controller.signal.aborted) setModelsLoading(false); });
    return () => controller.abort();
  }, [projectId, modelsReload]);

  const canEdit = snapshot?.canEdit !== false;
  const saved = snapshot ? draftOf(snapshot.settings) : undefined;
  const dirty = !!draft && !!saved && !sameDraft(draft, saved);
  const needsModel = draft?.mode === "custom" && !draft.model;

  const save = async () => {
    if (!snapshot || !draft || saving) return;
    const sent = draft;
    setSaving(true); setSaveError(null);
    try {
      const next = await api.put<Snapshot>("/api/git/commit-settings", { settings: settingsOf(sent), expectedRevision: snapshot.revision });
      if (!mounted.current) return;
      const value = { ...next, canEdit: snapshot.canEdit ?? true };
      setSnapshot(value);
      // Text typed while the save was in flight stays as an unsaved change.
      setDraftState((current) => current && current !== sent ? current : draftOf(value.settings));
      setStatus("saved");
    } catch (error) {
      if (mounted.current) setSaveError(saveErrorOf(error));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const discard = () => {
    if (!saved) return;
    setDraftState(saved);
    setOwnOpen(false);
    setSaveError(null);
  };

  const reloadSettings = () => {
    setSaveError(null);
    setOwnOpen(false);
    setSnapshot(undefined);
    setDraftState(undefined);
    setReload((n) => n + 1);
  };

  const modeLabel = (mode: Draft["mode"]) => mode === "session" ? tr("gitsettings.modeSession")
    : mode === "small" ? tr("gitsettings.modeSmall") : tr("gitsettings.modeCustom");
  const modeHint = (mode: Draft["mode"]) => mode === "session" ? tr("gitsettings.commitModelHintSession")
    : mode === "small" ? tr("gitsettings.commitModelHintSmall") : tr("gitsettings.commitModelHintCustom");
  const detailsLabel = (details: CommitDetails) => details === "auto" ? tr("gitsettings.commitDetailsAuto")
    : details === "always" ? tr("gitsettings.commitDetailsAlways") : tr("gitsettings.commitDetailsNever");

  const hint = canEdit ? tr("gitsettings.commitMessagesHint") : `${tr("gitsettings.commitMessagesHint")} ${tr("gitsettings.commitMessagesReadonly")}`;
  const sectionAction = canEdit && draft ? (
    <ResetLink
      disabled={isStandardStyle(draft.style)}
      onClick={() => { setOwnOpen(false); setDraft({ ...draft, style: { ...STANDARD } }); }}
    />
  ) : undefined;

  if (loadError) {
    return (
      <Section title={tr("gitsettings.commitMessages")} hint={hint} itemId="git.commitMessages">
        <ErrorState compact title={tr("gitsettings.loadSettingsError")} error={loadError} onRetry={() => setReload((n) => n + 1)} />
      </Section>
    );
  }

  if (!snapshot || !draft) {
    return (
      <Section title={tr("gitsettings.commitMessages")} hint={tr("gitsettings.commitMessagesHint")} itemId="git.commitMessages">
        <div className="git-commit-loading" aria-busy="true" aria-label={tr("gitsettings.commitMessages")}>
          <Skeleton shape="block" height="var(--control-h, 32px)" />
          <Skeleton shape="block" height="var(--control-h, 32px)" />
          <Skeleton shape="block" height="var(--control-h, 32px)" />
        </div>
      </Section>
    );
  }

  const { style } = draft;
  const setStyle = (patch: Partial<CommitStyle>) => setDraft({ ...draft, style: { ...style, ...patch } });

  if (!canEdit) {
    const customName = draft.model ? models.find((model) => model.harnessId === draft.model?.harnessId
      && model.providerID === draft.model?.providerID && model.modelID === draft.model?.modelID)?.name ?? draft.model.modelID : undefined;
    const ruleRow = (label: string, text: string, itemId?: string) => text
      ? <Row label={label} layout="stacked" {...(itemId ? { itemId } : {})}><p className="git-commit-rule-text">{text}</p></Row>
      : <ReadonlyRow label={label} value={tr("gitsettings.commitRuleStandard")} {...(itemId ? { itemId } : {})} />;
    return (
      <Section title={tr("gitsettings.commitMessages")} hint={hint} itemId="git.commitMessages">
        <ReadonlyRow label={tr("gitsettings.commitModel")} value={draft.mode === "custom" && customName ? customName : modeLabel(draft.mode)} itemId="git.commitMessageModel" />
        {ruleRow(tr("gitsettings.commitTitleRule"), style.titleRule, "git.commitStyle")}
        <ReadonlyRow label={tr("gitsettings.commitDetails")} value={detailsLabel(style.details)} itemId="git.commitDetails" />
        {style.details !== "never" && ruleRow(tr("gitsettings.commitDetailsRule"), style.detailsRule)}
        <ReadonlyRow label={tr("gitsettings.commitHistory")} value={style.matchHistory ? tr("gitsettings.commitOn") : tr("gitsettings.commitOff")} itemId="git.commitHistory" />
        <Example style={style} editable={false} />
      </Section>
    );
  }

  const matched = matchCommitStyle(style);
  // The rule fields stay folded while the built-in rule applies: most Spaces
  // never change it, and two empty boxes would be most of the section.
  const showRules = ownOpen || matched !== "standard";
  const styleValue = ownOpen || !matched ? "own" : matched;

  return (
    <Section title={tr("gitsettings.commitMessages")} hint={hint} itemId="git.commitMessages" {...(sectionAction ? { action: sectionAction } : {})}>
      <Row label={tr("gitsettings.commitModel")} hint={modeHint(draft.mode)} itemId="git.commitMessageModel">
        <Select
          label={tr("gitsettings.commitModel")}
          ariaLabel={tr("gitsettings.commitModel")}
          value={draft.mode}
          options={[
            { value: "session", label: tr("gitsettings.modeSession") },
            { value: "small", label: tr("gitsettings.modeSmall") },
            { value: "custom", label: tr("gitsettings.modeCustom") },
          ]}
          onChange={(mode) => setDraft(mode === "custom"
            ? { ...draft, mode: "custom", ...(saved?.mode === "custom" && saved.model ? { model: saved.model } : {}) }
            : { mode: mode as Draft["mode"], style })}
        />
      </Row>
      {draft.mode === "custom" && (
        <Row layout="stacked">
          <fieldset className="git-commit-model-picker" aria-label={tr("gitsettings.customModel")}>
            <ModelPicker
              models={models}
              value={draft.model}
              catalogLoading={modelsLoading}
              onPick={(model) => {
                const { model: _previous, ...rest } = draft;
                void _previous;
                setDraft(model?.harnessId ? { ...rest, model: { ...model, harnessId: model.harnessId } } : rest);
              }}
            />
          </fieldset>
          {!modelsLoading && !!modelsError && (
            <ErrorState compact title={tr("gitsettings.loadModelsError")} error={modelsError} onRetry={() => setModelsReload((n) => n + 1)} />
          )}
          {!modelsLoading && !modelsError && models.length === 0 && <p className="git-commit-note" role="status">{tr("gitsettings.noModels")}</p>}
          {!modelsLoading && !modelsError && models.length > 0 && needsModel && <p className="git-commit-note" role="status">{tr("gitsettings.customModelNeeded")}</p>}
        </Row>
      )}
      <Row label={tr("gitsettings.commitStyle")} hint={tr("gitsettings.commitStyleHint")} itemId="git.commitStyle">
        <Select
          label={tr("gitsettings.commitStyle")}
          ariaLabel={tr("gitsettings.commitStyleMenu")}
          searchable={false}
          value={styleValue}
          options={[
            ...STYLES.map((entry) => ({ value: entry.id, label: entry.label(), detail: entry.example.title })),
            { value: "own", label: tr("gitsettings.commitStyleOwn") },
          ]}
          onChange={(value) => {
            const entry = STYLES.find((candidate) => candidate.id === value);
            setOwnOpen(!entry);
            if (entry) setStyle({ titleRule: entry.title(), detailsRule: entry.details() });
          }}
        />
      </Row>
      {showRules && (
        <Row label={<label htmlFor="git-commit-title-rule">{tr("gitsettings.commitTitleRule")}</label>} hint={tr("gitsettings.commitTitleRuleHint")} layout="stacked">
          <RuleField
            id="git-commit-title-rule"
            value={style.titleRule}
            placeholder={tr("gitsettings.commitTitleRulePlaceholder")}
            onChange={(titleRule) => setStyle({ titleRule })}
          />
        </Row>
      )}
      <Row label={tr("gitsettings.commitDetails")} hint={tr("gitsettings.commitDetailsHint")} itemId="git.commitDetails">
        <Seg
          label={tr("gitsettings.commitDetails")}
          value={style.details}
          options={[
            ["auto", tr("gitsettings.commitDetailsAuto")],
            ["always", tr("gitsettings.commitDetailsAlways")],
            ["never", tr("gitsettings.commitDetailsNever")],
          ]}
          onChange={(details) => setStyle({ details })}
        />
      </Row>
      {showRules && style.details !== "never" && (
        <Row label={<label htmlFor="git-commit-details-rule">{tr("gitsettings.commitDetailsRule")}</label>} hint={tr("gitsettings.commitDetailsRuleHint")} layout="stacked">
          <RuleField
            id="git-commit-details-rule"
            value={style.detailsRule}
            placeholder={tr("gitsettings.commitDetailsRulePlaceholder")}
            onChange={(detailsRule) => setStyle({ detailsRule })}
          />
        </Row>
      )}
      <Row label={tr("gitsettings.commitHistory")} hint={tr("gitsettings.commitHistoryHint")} itemId="git.commitHistory">
        <Toggle on={style.matchHistory} label={tr("gitsettings.commitHistory")} onChange={(matchHistory) => setStyle({ matchHistory })} />
      </Row>
      <Example style={style} editable />
      {saveError && (
        <Notice
          tone="error"
          className="git-commit-save-error"
          {...(saveError !== "failed" ? { actions: <Button variant="quiet" size="sm" onClick={reloadSettings}>{tr("gitsettings.commitReload")}</Button> } : {})}
        >
          {saveError === "conflict" ? tr("gitsettings.saveConflict")
            : saveError === "forbidden" ? tr("gitsettings.commitMessagesReadonly")
              : tr("gitsettings.saveError")}
        </Notice>
      )}
      <SaveBar dirty={dirty} canSave={!needsModel} saving={saving} status={status} onSave={() => void save()} onDiscard={discard} />
    </Section>
  );
}
