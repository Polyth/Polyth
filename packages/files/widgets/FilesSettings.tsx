import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ModelDescriptor } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import ModelPicker from "@polyth/models/model-picker";
import { readHarnessSnapshots } from "@polyth/models/runtime-catalog";
import { useStore } from "../../../apps/web/src/store.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Textarea } from "../../../apps/web/src/components/ui/index.ts";
import {
  DEFAULT_EXPLAIN_PROMPT,
  DEFAULT_FIX_PROMPT,
  parseModelOverride,
  type InlineAiModelRef,
} from "../src/inlineAiShared.ts";

type InlineAiDraft = { explainPrompt: string; fixPrompt: string; modelOverride: string };

const DEFAULT_DRAFT: InlineAiDraft = {
  explainPrompt: DEFAULT_EXPLAIN_PROMPT,
  fixPrompt: DEFAULT_FIX_PROMPT,
  modelOverride: "",
};

/** The stored override keeps its `harness/provider/model` string contract. */
const formatModelOverride = (model: InlineAiModelRef | undefined): string => model
  ? [model.harnessId, model.providerID, model.modelID].filter(Boolean).join("/")
  : "";

const PLACEHOLDERS = ["{{selection}}", "{{path}}", "{{language}}"];

function PromptPlaceholders() {
  return (
    <span className="files-settings-hint">
      {tr("filessettings.placeholdersLabel")}{" "}
      {PLACEHOLDERS.map((token, index) => (
        <span key={token}>{index > 0 ? " " : ""}<code>{token}</code></span>
      ))}
    </span>
  );
}

/** Stacked settings field: label and hint above/below a wide control. */
function Field({ id, itemId, label, hint, children }: {
  id: string;
  itemId: string;
  label: string;
  hint: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="files-settings-field" data-settings-item={itemId}>
      <label className="files-settings-label" htmlFor={id}>{label}</label>
      {children}
      {hint}
    </div>
  );
}

type ExternalReadPolicy = { folders: string[]; extensions: string[] };
type ExternalReadState = ExternalReadPolicy & { defaults: ExternalReadPolicy; editable: boolean };
type ExternalReadDraft = { folders: string; extensions: string };

const EXTERNAL_READS_PATH = "/api/files/external-reads";

const toDraft = (policy: ExternalReadPolicy): ExternalReadDraft => ({
  folders: policy.folders.join("\n"),
  extensions: policy.extensions.join(", "),
});

const fromDraft = (draft: ExternalReadDraft): ExternalReadPolicy => ({
  folders: draft.folders.split("\n").map((line) => line.trim()).filter(Boolean),
  extensions: draft.extensions.split(/[\s,;]+/).map((part) => part.trim()).filter(Boolean),
});

async function externalReadsRequest(init?: RequestInit): Promise<ExternalReadState> {
  const response = await fetch(EXTERNAL_READS_PATH, init);
  const body = await response.json().catch(() => ({})) as ExternalReadState & { message?: string };
  if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
  return body;
}

/** Which files outside the project chat images and the editor may open.
 *  Installation-wide, so only the server owner can edit it. */
function ExternalReadSettings() {
  const [state, setState] = useState<ExternalReadState | null>(null);
  const [draft, setDraft] = useState<ExternalReadDraft>({ folders: "", extensions: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    void externalReadsRequest()
      .then((next) => { if (live) { setState(next); setDraft(toDraft(next)); } })
      .catch((err: unknown) => { if (live) setError(friendlyError(tr("filessettings.externalLoadFailed"), err)); });
    return () => { live = false; };
  }, []);

  const stored = state ? toDraft(state) : null;
  const dirty = stored !== null && (draft.folders !== stored.folders || draft.extensions !== stored.extensions);
  const defaults = state ? toDraft(state.defaults) : null;
  const isDefault = defaults !== null && draft.folders === defaults.folders && draft.extensions === defaults.extensions;
  const locked = !state?.editable || saving;

  const edit = (patch: Partial<ExternalReadDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setSaved(false);
  };

  // The server validates and normalizes; a rejection keeps the draft.
  const save = async () => {
    setError("");
    setSaving(true);
    try {
      const next = await externalReadsRequest({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fromDraft(draft)),
      });
      setState(next);
      setDraft(toDraft(next));
      setSaved(true);
    } catch (err: unknown) {
      setError(friendlyError(tr("filessettings.externalSaveFailed"), err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section files-settings-external" aria-busy={!state || undefined}>
      <header className="settings-section-head">
        <div className="settings-section-copy">
          <h3 className="settings-section-title">{tr("filessettings.externalTitle")}</h3>
          <p className="settings-section-hint">{tr("filessettings.externalIntro")}</p>
        </div>
      </header>
      <div className="files-settings-page">
        <Field
          id="files-settings-external-folders"
          itemId="files.external.folders"
          label={tr("filessettings.externalFolders")}
          hint={<span className="files-settings-hint">{tr("filessettings.externalFoldersHint")}</span>}
        >
          <Textarea
            id="files-settings-external-folders"
            rows={3}
            spellCheck={false}
            value={draft.folders}
            disabled={locked}
            onChange={(event) => edit({ folders: event.target.value })}
          />
        </Field>
        <Field
          id="files-settings-external-extensions"
          itemId="files.external.extensions"
          label={tr("filessettings.externalExtensions")}
          hint={<span className="files-settings-hint">{tr("filessettings.externalExtensionsHint")}</span>}
        >
          <Textarea
            id="files-settings-external-extensions"
            rows={4}
            spellCheck={false}
            value={draft.extensions}
            disabled={locked}
            onChange={(event) => edit({ extensions: event.target.value })}
          />
        </Field>
        {state && !state.editable ? <p className="files-settings-hint">{tr("filessettings.externalOwnerOnly")}</p> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        {state?.editable ? (
          <div className="files-settings-actions">
            <Button size="sm" variant="ghost" disabled={locked || isDefault} onClick={() => defaults && edit(defaults)}>
              {tr("filessettings.externalRestoreDefaults")}
            </Button>
            <span className="files-settings-status" role="status">
              {saved && !dirty ? tr("common.saved") : dirty ? tr("filessettings.unsaved") : ""}
            </span>
            <Button size="sm" variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
              {tr("common.save")}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default function FilesSettings() {
  return (
    <>
      <InlineAiSettings />
      <ExternalReadSettings />
    </>
  );
}

function InlineAiSettings() {
  const [draft, setDraft] = useState<InlineAiDraft>(DEFAULT_DRAFT);
  const [stored, setStored] = useState<InlineAiDraft | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const projectId = useStore((state) => state.activeProjectId);
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setModelsLoading(true);
    void readHarnessSnapshots({ projectId, detail: true })
      .then((rows) => {
        if (live) setModels(rows.flatMap((row) => (row.catalog?.models ?? [])
          .map((model) => ({ ...model, harnessId: model.harnessId ?? row.identity.id }))));
      })
      .catch(() => { if (live) setModels([]); })
      .finally(() => { if (live) setModelsLoading(false); });
    return () => { live = false; };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    void api.filesInlineAiSettingsGet()
      .then((settings) => {
        if (cancelled) return;
        const next = {
          explainPrompt: settings.explainPrompt,
          fixPrompt: settings.fixPrompt,
          modelOverride: settings.modelOverride ?? "",
        };
        setDraft(next);
        setStored(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(friendlyError(tr("filessettings.loadFailed"), err));
      });
    return () => { cancelled = true; };
  }, []);

  const loaded = stored !== null;
  const dirty = loaded && (
    draft.explainPrompt !== stored.explainPrompt
    || draft.fixPrompt !== stored.fixPrompt
    || draft.modelOverride !== stored.modelOverride
  );
  const isDefault = draft.explainPrompt === DEFAULT_DRAFT.explainPrompt
    && draft.fixPrompt === DEFAULT_DRAFT.fixPrompt
    && draft.modelOverride === DEFAULT_DRAFT.modelOverride;

  const edit = (patch: Partial<InlineAiDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setSaved(false);
  };

  // Saved shows at once and the fields stay editable. The server's normalized
  // values replace the draft only if nothing was typed meanwhile; a rejection
  // marks the draft unsaved again (it is never discarded) and reports.
  const save = async () => {
    if (!stored) return;
    const sent = draft;
    const previous = stored;
    const same = (left: InlineAiDraft | null, right: InlineAiDraft) => left !== null
      && left.explainPrompt === right.explainPrompt
      && left.fixPrompt === right.fixPrompt
      && left.modelOverride === right.modelOverride;
    setError("");
    setStored(sent);
    setSaved(true);
    try {
      const next = await api.filesInlineAiSettingsPut(sent);
      const normalized = {
        explainPrompt: next.explainPrompt,
        fixPrompt: next.fixPrompt,
        modelOverride: next.modelOverride ?? "",
      };
      setDraft((current) => same(current, sent) ? normalized : current);
      setStored((current) => same(current, sent) ? normalized : current);
    } catch (err: unknown) {
      setStored((current) => same(current, sent) ? previous : current);
      setSaved(false);
      setError(friendlyError(tr("filessettings.saveFailed"), err));
    }
  };

  const fieldsDisabled = !loaded;

  return (
    <section className="files-settings-page" aria-busy={!loaded || undefined}>
      <p className="files-settings-intro">{tr("filessettings.intro")}</p>
      <Field
        id="files-settings-explain"
        itemId="files.inline-ai.explain"
        label={tr("filessettings.explainPrompt")}
        hint={<PromptPlaceholders />}
      >
        <Textarea
          id="files-settings-explain"
          rows={4}
          value={draft.explainPrompt}
          disabled={fieldsDisabled}
          onChange={(event) => edit({ explainPrompt: event.target.value })}
        />
      </Field>
      <Field
        id="files-settings-fix"
        itemId="files.inline-ai.fix"
        label={tr("filessettings.fixPrompt")}
        hint={<PromptPlaceholders />}
      >
        <Textarea
          id="files-settings-fix"
          rows={4}
          value={draft.fixPrompt}
          disabled={fieldsDisabled}
          onChange={(event) => edit({ fixPrompt: event.target.value })}
        />
      </Field>
      <Field
        id="files-settings-model"
        itemId="files.inline-ai.model"
        label={tr("filessettings.modelOverride")}
        hint={<span className="files-settings-hint">{tr("filessettings.modelOverrideHint")}</span>}
      >
        <fieldset id="files-settings-model" className="files-settings-model" disabled={fieldsDisabled} aria-label={tr("filessettings.modelOverride")}>
          <ModelPicker
            models={models}
            {...(parseModelOverride(draft.modelOverride) ? { value: parseModelOverride(draft.modelOverride) } : {})}
            emptyLabel={tr("filessettings.quickModel")}
            catalogLoading={modelsLoading}
            onPick={(model) => edit({ modelOverride: formatModelOverride(model) })}
          />
        </fieldset>
      </Field>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="files-settings-actions">
        <Button size="sm" variant="ghost" disabled={fieldsDisabled || isDefault} onClick={() => edit(DEFAULT_DRAFT)}>
          {tr("filessettings.resetDefaults")}
        </Button>
        <span className="files-settings-status" role="status">
          {saved && !dirty ? tr("common.saved") : dirty ? tr("filessettings.unsaved") : ""}
        </span>
        <Button size="sm" variant="primary" disabled={!dirty} onClick={() => void save()}>
          {tr("common.save")}
        </Button>
      </div>
    </section>
  );
}
