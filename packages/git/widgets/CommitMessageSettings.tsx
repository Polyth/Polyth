import { useEffect, useRef, useState } from "react";
import type { HarnessSnapshot, ModelDescriptor } from "@polyth/contracts";
import { createApiTransport } from "@polyth/web-sdk";
import { Select } from "@polyth/web/ui";
import ModelPicker from "@polyth/models/model-picker";
import { ErrorState, Row, SaveStatus, Section, type SaveStatusState } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import type { CommitSettings } from "../src/commitSettings.ts";

const api = createApiTransport();
type Snapshot = { revision: number; settings: CommitSettings };

/** Commit-message model for integrations. Autosaves on change (the write is
 *  remote, so it shows SaveStatus); a custom mode saves once a model is picked.
 *  The setting is the Space's; `projectId` only scopes the model catalog. */
export default function CommitMessageSettings({ projectId }: { projectId?: string }) {
  const mounted = useRef(true);
  const pending = useRef<AbortController | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [draft, setDraft] = useState<CommitSettings>({ mode: "session" });
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [modelsError, setModelsError] = useState(false);
  const [save, setSave] = useState<SaveStatusState>("idle");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    setLoadError(null);
    void api.get<Snapshot>("/api/git/commit-settings", { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) { setSnapshot(value); setDraft(value.settings); }
    }).catch((error: unknown) => { if (!controller.signal.aborted) setLoadError(error); });
    return () => { mounted.current = false; controller.abort(); pending.current?.abort(); };
  }, [reload]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setModels([]); setModelsError(false);
    const scope = projectId ? `&projectId=${encodeURIComponent(projectId)}` : "";
    void api.get<HarnessSnapshot[]>(`/api/harnesses/snapshots?detail=1${scope}`, { signal: controller.signal }).then((rows) => {
      if (!controller.signal.aborted) setModels(rows.flatMap((row) => (row.catalog?.models ?? []).map((model) => ({ ...model, harnessId: model.harnessId ?? row.identity.id }))));
    }).catch(() => { if (!controller.signal.aborted) setModelsError(true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [projectId]);
  const commit = async (next: CommitSettings) => {
    setDraft(next);
    if (!snapshot || pending.current) return;
    if (next.mode === "custom" && !next.model) return;
    if (JSON.stringify(next) === JSON.stringify(snapshot.settings)) return;
    const controller = new AbortController();
    pending.current = controller;
    setSave("saving");
    try {
      const saved = await api.put<Snapshot>("/api/git/commit-settings", { settings: next, expectedRevision: snapshot.revision }, { signal: controller.signal });
      if (!mounted.current) return;
      setSnapshot(saved); setDraft(saved.settings); setSave("saved");
    } catch {
      if (mounted.current) { setSave("error"); setDraft(snapshot.settings); }
    } finally { pending.current = null; }
  };
  const busy = save === "saving";
  return (
    <Section
      title={tr("gitsettings.commitMessages")}
      hint={tr("gitsettings.commitMessagesHint")}
      itemId="git.commitMessageModel"
      action={<SaveStatus state={save} {...(save === "error" ? { error: tr("gitsettings.saveError") } : {})} />}
    >
      {loadError ? (
        <ErrorState compact title={tr("gitsettings.loadSettingsError")} error={loadError} onRetry={() => setReload((n) => n + 1)} />
      ) : (
        <>
          <Row label={tr("gitsettings.commitModel")} hint={tr("gitsettings.commitModelHint")}>
            <Select
              label={tr("gitsettings.commitModel")}
              ariaLabel={tr("gitsettings.commitModel")}
              value={draft.mode}
              disabled={!snapshot || busy}
              options={[
                { value: "session", label: tr("gitsettings.modeSession") },
                { value: "small", label: tr("gitsettings.modeSmall") },
                { value: "custom", label: tr("gitsettings.modeCustom") },
              ]}
              onChange={(mode) => void commit(mode === "custom"
                ? { mode: "custom", ...(snapshot?.settings.mode === "custom" && snapshot.settings.model ? { model: snapshot.settings.model } : {}) }
                : { mode: mode as CommitSettings["mode"] })}
            />
          </Row>
          {draft.mode === "custom" && (
            <Row label={tr("gitsettings.customModel")} layout="stacked">
              <fieldset className="git-commit-model-picker" disabled={busy} aria-label={tr("gitsettings.customModel")}>
                <ModelPicker
                  models={models}
                  value={draft.model}
                  catalogLoading={loading}
                  onPick={(model) => void commit({ mode: "custom", model: model?.harnessId ? { ...model, harnessId: model.harnessId } : undefined })}
                />
              </fieldset>
              {!loading && modelsError && <p className="git-commit-note" role="alert">{tr("gitsettings.loadModelsError")}</p>}
              {!loading && !modelsError && models.length === 0 && <p className="git-commit-note" role="status">{tr("gitsettings.noModels")}</p>}
            </Row>
          )}
        </>
      )}
    </Section>
  );
}
