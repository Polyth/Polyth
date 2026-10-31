import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { ModelDescriptor, ModelRef, Project } from "@polyth/contracts";
import ModelPicker from "@polyth/models/model-picker";
import { readHarnessSnapshots } from "@polyth/models/runtime-catalog";
import {
  memoryApi,
  memoryError,
  type MemoryDto,
  type MemoryListItem,
  type MemoryPolicy,
} from "../src/client.ts";
import ReflectPanel from "./ReflectPanel.tsx";
import { reflectStrings } from "./reflectStrings.ts";
import { englishTranslate, enumLabel, type Translate } from "./i18n.ts";

type Context = {
  projectId: string;
  project: Readonly<Project>;
  mobile: boolean;
  /** Host locale; older hosts and tests may omit it (English fallback). */
  locale?: string;
  /** Host translation lookup; omitted by tests and older hosts (English). */
  translate?: Translate;
  onBack(): void;
  onClose(): void;
};

type Editor = {
  id: string | null;
  revision: number;
  title: string;
  body: string;
  category: string;
  tags: string;
  aliases: string;
  applicability: string;
  sources: string;
};

type ImportStage = {
  name: string;
  records: unknown[];
  mode: "merge" | "replace";
  preview: { duplicates: number; conflicts: number; invalid: number } | null;
  recoveryReady: boolean;
};

const EMPTY: Editor = {
  id: null, revision: 0, title: "", body: "", category: "observation", tags: "",
  aliases: "", applicability: "", sources: "",
};
const MAX_PAGE = 8;
const MAX_BULK = 50;
const RECALL_BYTES = 6144;
const csv = (value: string): string[] => value.split(",").map((part) => part.trim()).filter(Boolean);
const editorOf = (memory: MemoryDto): Editor => ({
  id: memory.id,
  revision: memory.revision,
  title: memory.title,
  body: memory.body,
  category: memory.category,
  tags: memory.tags.join(", "),
  aliases: memory.aliases.join(", "),
  applicability: [
    ...(memory.applicability.paths ?? []),
    ...(memory.applicability.modules ?? []),
    ...(memory.applicability.workingContext ?? []),
  ].join(", "),
  sources: memory.sources.map((source) => source.document ?? source.commit ?? source.sessionId ?? source.kind).join(", "),
});
const editorKey = (editor: Editor): string => JSON.stringify(editor);
const filterKeyOf = (projectId: string, query: string, lifecycle: string): string => `${projectId}\u0000${query.trim()}\u0000${lifecycle}`;

function ErrorNotice({ message, kind }: { message: string; kind?: string }) {
  return <div className={`memory-notice memory-notice-${kind ?? "error"}`} role="alert">{message}</div>;
}

function parseImport(value: string, translate: Translate): unknown[] {
  const parsed: unknown = JSON.parse(value);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { records?: unknown }).records)) return (parsed as { records: unknown[] }).records;
  throw new Error(translate("memory.error.importShape"));
}

/** A catalog sentence with one part emphasised: the template keeps `{project}`
 *  where the project name goes, so every locale controls the word order. */
function WithProject({ template, name }: { template: string; name: string }) {
  const parts = template.split("{project}");
  return <>{parts.map((part, index) => index === 0 ? part : <Fragment key={index}><strong>{name}</strong>{part}</Fragment>)}</>;
}

export default function MemorySettings({ projectId, project, mobile, locale, translate, onBack, onClose }: Context) {
  const [items, setItems] = useState<MemoryListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [lifecycle, setLifecycle] = useState("");
  const [selected, setSelected] = useState<Editor | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkRecords, setBulkRecords] = useState<MemoryListItem[]>([]);
  const [selectionFilter, setSelectionFilter] = useState("");
  const [editorBaseline, setEditorBaseline] = useState("");
  const [policy, setPolicy] = useState<MemoryPolicy | null>(null);
  const [utilityModels, setUtilityModels] = useState<ModelDescriptor[]>([]);
  const [utilityModelsLoading, setUtilityModelsLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<{ kind: string; message: string } | null>(null);
  const [importStage, setImportStage] = useState<ImportStage | null>(null);
  const generation = useRef(0);
  const filterEpoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const t = translate ?? englishTranslate;
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const count = (value: number): string => number.format(value);
  const label = (prefix: "memory.category" | "memory.lifecycle", value: string): string => enumLabel(t, prefix, value);
  const errorOf = (cause: unknown) => memoryError(cause, t);

  useEffect(() => {
    let live = true;
    setUtilityModelsLoading(true);
    void readHarnessSnapshots({ projectId, detail: true })
      .then((rows) => {
        if (live) setUtilityModels(rows.flatMap((row) => (row.catalog?.models ?? [])
          .map((model) => ({ ...model, harnessId: model.harnessId ?? row.identity.id }))));
      })
      .catch(() => { if (live) setUtilityModels([]); })
      .finally(() => { if (live) setUtilityModelsLoading(false); });
    return () => { live = false; };
  }, [projectId]);

  const dirty = selected !== null && editorKey(selected) !== editorBaseline;
  const writesBlocked = error?.kind === "forbidden";
  const load = useCallback(async (nextOffset = offset) => {
    controller.current?.abort();
    const current = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    setError(null);
    try {
      const [list, nextPolicy] = await Promise.all([
        memoryApi.list(projectId, { limit: MAX_PAGE, offset: nextOffset, q: query, lifecycle }, abort.signal),
        memoryApi.policy(projectId, abort.signal),
      ]);
      if (current !== generation.current) return;
      setItems(list.items);
      setTotal(list.total);
      setOffset(nextOffset);
      setPolicy(nextPolicy);
    } catch (cause) {
      if (current !== generation.current || abort.signal.aborted) return;
      setError(errorOf(cause));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [lifecycle, offset, projectId, query]);

  useEffect(() => {
    filterEpoch.current++;
    setItems([]); setTotal(0); setOffset(0); setSelected(null); setSelectedIds([]); setBulkRecords([]); setSelectionFilter(""); setImportStage(null); setPolicy(null);
    void load(0);
    return () => { generation.current++; controller.current?.abort(); };
  }, [projectId]); // project switches must invalidate every old response

  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    filterEpoch.current++;
    setSelectedIds([]); setBulkRecords([]); setSelectionFilter("");
    const timer = window.setTimeout(() => void load(0), 180);
    return () => window.clearTimeout(timer);
  }, [query, lifecycle]);

  const run = async (action: () => Promise<unknown>, done?: string | ((result: unknown) => string)) => {
    if (busy) return;
    const requestProjectId = projectId;
    const requestGeneration = generation.current;
    setBusy(true); setError(null); setNotice("");
    try {
      const result = await action();
      if (requestProjectId !== projectId || requestGeneration !== generation.current) return;
      if (done) setNotice(typeof done === "function" ? done(result) : done);
      await load(offset);
    }
    catch (cause) {
      if (requestProjectId === projectId && requestGeneration === generation.current) setError(errorOf(cause));
    }
    finally { setBusy(false); }
  };

  const open = (item: MemoryListItem) => {
    const requestGeneration = generation.current;
    setBusy(true); setError(null);
    void memoryApi.get(projectId, item.id).then((full) => {
      if (requestGeneration !== generation.current || full.projectId !== projectId) return;
      const next = editorOf(full); setSelected(next); setEditorBaseline(editorKey(next));
    }).catch((cause) => {
      if (requestGeneration === generation.current) setError(errorOf(cause));
    }).finally(() => setBusy(false));
  };

  const save = () => {
    if (!selected || !selected.title.trim() || !selected.body.trim()) return;
    const patch = {
      title: selected.title.trim(), body: selected.body,
      category: (selected.category.trim() || "observation") as MemoryDto["category"], tags: csv(selected.tags),
      aliases: csv(selected.aliases), applicability: { paths: csv(selected.applicability) },
      sources: csv(selected.sources).map((document) => ({ kind: "manual" as const, document })),
      // Every manual save becomes user-locked, as required by the memory policy.
      userLocked: true,
    } satisfies Partial<MemoryDto>;
    void run(async () => {
      if (selected.id) await memoryApi.update(projectId, selected.id, selected.revision, patch);
      else await memoryApi.create({ projectId, ...patch, lifecycle: "active", evidence: "user-stated", freshness: "current", pinned: false, userLocked: true });
      setSelected(null);
    }, t("memory.notice.saved"));
  };

  const visibleIds = useMemo(() => items.map((item) => item.id), [items]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
  const toggleSelected = (id: string) => {
    const item = items.find((candidate) => candidate.id === id);
    if (item) setBulkRecords((current) => current.some((candidate) => candidate.id === id) ? current : [...current, item].slice(0, MAX_BULK));
    setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id].slice(0, MAX_BULK));
  };
  const toggleVisible = () => {
    if (allVisibleSelected) {
      setSelectedIds((current) => current.filter((id) => !visibleIds.includes(id)));
      return;
    }
    setBulkRecords((current) => [...current, ...items.filter((item) => !current.some((candidate) => candidate.id === item.id))].slice(0, MAX_BULK));
    setSelectedIds((current) => [...new Set([...current, ...visibleIds])].slice(0, MAX_BULK));
  };
  const selectAllFiltered = async () => {
    const requestGeneration = generation.current;
    const requestFilterEpoch = filterEpoch.current;
    const filter = filterKeyOf(projectId, query, lifecycle);
    setBusy(true); setError(null); setNotice("");
    try {
      const page = await memoryApi.list(projectId, { limit: MAX_BULK, offset: 0, q: query, lifecycle });
      if (requestGeneration !== generation.current || requestFilterEpoch !== filterEpoch.current) return;
      if (page.total > MAX_BULK) {
        setError({ kind: "conflict", message: t("memory.error.selectCap", { total: count(page.total), max: count(MAX_BULK) }) });
        return;
      }
      setBulkRecords(page.items); setSelectedIds(page.items.map((item) => item.id)); setSelectionFilter(filter);
      setNotice(t("memory.notice.selectedAll", { project: project.name, count: count(page.total) }));
    } catch (cause) {
      if (requestGeneration === generation.current) setError(errorOf(cause));
    } finally {
      // A filter/project change invalidates the request but must still release
      // the local busy state so the newly scoped page remains usable.
      setBusy(false);
    }
  };
  const bulkAction = (action: "archive" | "forget") => {
    if (selectionFilter && selectionFilter !== filterKeyOf(projectId, query, lifecycle)) {
      setError({ kind: "conflict", message: t("memory.error.filtersChanged") });
      return;
    }
    const targets = bulkRecords.filter((item) => selectedIds.includes(item.id)
      && (action === "archive" ? item.lifecycle !== "archived" && item.lifecycle !== "forgotten" : item.lifecycle !== "forgotten"));
    if (!targets.length) return;
    const question = t(action === "forget" ? "memory.confirm.bulkForget" : "memory.confirm.bulkArchive", {
      project: project.name, count: count(targets.length), max: count(MAX_BULK),
    });
    if (!window.confirm(question)) return;
    void run(async () => {
      const outcomes: Array<{ item: MemoryListItem; error?: string }> = [];
      for (const item of targets) {
        try {
          await memoryApi.action(projectId, item.id, action, item.revision);
          outcomes.push({ item });
        } catch (cause) {
          const failure = errorOf(cause);
          outcomes.push({ item, error: failure.message });
        }
      }
      setSelectedIds([]); setBulkRecords([]); setSelectionFilter("");
      return outcomes;
    }, (result) => {
      const outcomes = result as Array<{ item: MemoryListItem; error?: string }>;
      const failed = outcomes.filter((outcome) => outcome.error);
      const succeeded = outcomes.length - failed.length;
      const failures = failed.length ? failed.map((outcome) => `${outcome.item.title} (${outcome.error})`).join("; ") : "";
      const key = `memory.notice.bulk${action === "forget" ? "Forgotten" : "Archived"}${failures ? "Failed" : ""}`;
      return t(key, {
        project: project.name, succeeded: count(succeeded), total: count(outcomes.length), failures,
      });
    });
  };

  const leave = (action: () => void) => {
    if (dirty && !window.confirm(t("memory.confirm.discardDraft"))) return;
    setSelected(null); action();
  };
  const close = () => leave(onClose);

  const updatePolicy = (patch: Partial<Omit<MemoryPolicy, "utilityBudget">> & { utilityBudget?: { maxCalls: number } }) => {
    if (!policy) return;
    const next = { ...policy, ...patch, contextBudget: { ...policy.contextBudget, ...(patch.contextBudget ?? {}) } };
    void run(() => memoryApi.updatePolicy(projectId, {
      ...patch,
      ...(patch.contextBudget ? { contextBudget: next.contextBudget } : {}),
      expectedSettingsRevision: policy.settingsRevision,
    }), t("memory.notice.policyUpdated"));
  };

  const setUtilityEnabled = (enabled: boolean) => {
    if (!policy) return;
    if (!enabled) {
      updatePolicy({ utilityModelAllowed: false, consentRequired: true, utilityStatus: "disabled" });
      return;
    }
    const model = policy.utilityModel;
    if (!model?.providerID.trim() || !model.modelID.trim()) {
      setError({ kind: "conflict", message: t("memory.error.chooseUtilityModel") });
      return;
    }
    updatePolicy({
      utilityModel: { providerID: model.providerID.trim(), modelID: model.modelID.trim() },
      utilityAllowlist: [{ providerID: model.providerID.trim(), modelID: model.modelID.trim() }],
      utilityModelAllowed: true,
      consentRequired: false,
    });
  };

  const configureUtilityModel = (model: ModelRef | undefined) => {
    if (!policy || !model) return;
    const next = { providerID: model.providerID, modelID: model.modelID };
    updatePolicy({ utilityModel: next, utilityAllowlist: [next], utilityModelAllowed: false, consentRequired: true });
  };

  const downloadPayload = (payload: unknown, filename: string) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
  };

  const download = async (recovery = false) => {
    const requestProjectId = projectId;
    const requestGeneration = generation.current;
    try {
      const payload = await memoryApi.export(projectId, recovery);
      if (requestProjectId !== projectId || requestGeneration !== generation.current) return;
      downloadPayload(payload, `${project.name || "project"}-${recovery ? "memory-recovery" : "memory"}.json`);
      if (recovery) setImportStage((current) => current ? { ...current, recoveryReady: true } : current);
    } catch (cause) {
      if (requestProjectId === projectId && requestGeneration === generation.current) setError(errorOf(cause));
    }
  };

  const importFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    void file.text().then((contents) => {
      const records = parseImport(contents, t);
      setImportStage({ name: file.name, records, mode: "merge", preview: null, recoveryReady: false });
      setError(null); setNotice("");
    }).catch((cause) => setError(errorOf(cause)));
  };

  const previewImport = () => {
    if (!importStage || !policy) return;
    const requestGeneration = generation.current;
    setBusy(true); setError(null); setNotice("");
    void memoryApi.importPreview(projectId, policy.settingsRevision, importStage.records)
      .then((preview) => {
        if (requestGeneration !== generation.current) return;
        setImportStage((current) => current ? { ...current, preview } : current);
      })
      .catch((cause) => { if (requestGeneration === generation.current) setError(errorOf(cause)); })
      .finally(() => { if (requestGeneration === generation.current) setBusy(false); });
  };

  const commitImport = () => {
    if (!importStage || !policy || !importStage.preview) return;
    const replace = importStage.mode === "replace";
    if (replace && !importStage.recoveryReady) {
      setError({ kind: "conflict", message: t("memory.error.recoveryRequired") });
      return;
    }
    const question = t(replace ? "memory.confirm.importReplace" : "memory.confirm.importMerge", {
      project: project.name, count: count(importStage.records.length),
    });
    if (!window.confirm(question)) return;
    const stage = importStage;
    void run(
      () => memoryApi.import(projectId, policy.settingsRevision, stage.records, stage.mode),
      (result) => {
        const response = result as { imported: number; conflicts: Array<unknown> };
        setImportStage(null);
        return t("memory.notice.imported", {
          project: project.name, imported: count(response.imported), conflicts: count(response.conflicts.length),
        });
      },
    );
  };

  const budgetRecords = Math.max(1, Math.min(8, policy?.contextBudget.maxRecords ?? 6));
  const budgetBytes = Math.max(512, Math.min(RECALL_BYTES, policy?.contextBudget.maxBytes ?? RECALL_BYTES));
  const modeLabel = (mode: "merge" | "replace"): string =>
    t(mode === "merge" ? "memory.import.modeMerge" : "memory.import.modeReplace");

  if (selected) {
    return (
      <div className="pkg-memory memory-page memory-editor-page">
        <div className="memory-page-head memory-editor-head">
          <button type="button" className="memory-link-button" onClick={() => leave(() => undefined)} disabled={busy}>{t("memory.back")}</button>
          <span className="memory-draft-state">{selected.id ? t("memory.editor.revision", { revision: count(selected.revision) }) : t("memory.new")}</span>
          <button type="button" className="memory-button memory-button-primary" onClick={save} disabled={busy || writesBlocked || !selected.title.trim() || !selected.body.trim()}>{t("memory.save")}</button>
        </div>
        {error && <ErrorNotice {...error} />}
        {error?.kind === "conflict" && <button type="button" className="memory-button" onClick={() => { setSelected(null); setError(null); void load(offset); }}>{t("memory.action.reload")}</button>}
        {error && ["offline", "unavailable", "busy", "corrupt"].includes(error.kind) && <button type="button" className="memory-button" onClick={() => { setError(null); void load(offset); }}>{t("memory.retry")}</button>}
        <label className="memory-field">{t("memory.field.title")}<input value={selected.title} onChange={(event) => setSelected({ ...selected, title: event.target.value })} autoFocus /></label>
        <label className="memory-field">{t("memory.field.body")}<textarea value={selected.body} onChange={(event) => setSelected({ ...selected, body: event.target.value })} rows={mobile ? 9 : 12} /></label>
        <div className="memory-field-grid">
          <label className="memory-field">{t("memory.field.category")}<select value={selected.category} onChange={(event) => setSelected({ ...selected, category: event.target.value })}><option value="decision">{t("memory.category.decision")}</option><option value="convention">{t("memory.category.convention")}</option><option value="gotcha">{t("memory.category.gotcha")}</option><option value="procedure">{t("memory.category.procedure")}</option><option value="observation">{t("memory.category.observation")}</option></select></label>
          <label className="memory-field">{t("memory.field.tags")}<input value={selected.tags} onChange={(event) => setSelected({ ...selected, tags: event.target.value })} placeholder={t("memory.field.commaSeparated")} /></label>
          <label className="memory-field">{t("memory.field.aliases")}<input value={selected.aliases} onChange={(event) => setSelected({ ...selected, aliases: event.target.value })} placeholder={t("memory.field.commaSeparated")} /></label>
          <label className="memory-field">{t("memory.field.appliesTo")}<input value={selected.applicability} onChange={(event) => setSelected({ ...selected, applicability: event.target.value })} placeholder={t("memory.field.pathsOrContexts")} /></label>
        </div>
        <label className="memory-field">{t("memory.field.sources")}<input value={selected.sources} onChange={(event) => setSelected({ ...selected, sources: event.target.value })} placeholder={t("memory.field.sourceReferences")} /></label>
        <p className="memory-help">{t("memory.editor.help")}</p>
      </div>
    );
  }

  return (
    <div className="pkg-memory memory-page">
      <div className="memory-page-head">
        <div>
          <button type="button" className="memory-link-button" onClick={onBack}>{t("memory.back")}</button>
          <h2>{t("memory.heading")}</h2>
          <p><WithProject template={t("memory.intro")} name={project.name} /></p>
        </div>
        <button type="button" className="memory-button memory-button-primary" onClick={() => { const next = { ...EMPTY }; setSelected(next); setEditorBaseline(editorKey(next)); }} disabled={writesBlocked}>{t("memory.new")}</button>
      </div>
      {error && <ErrorNotice {...error} />}
      {notice && <div className="memory-notice memory-notice-success" role="status">{notice}</div>}
      {loading && <div className="memory-loading" role="status">{t("memory.loading")}</div>}
      {error?.kind === "forbidden" && <p className="memory-help">{t("memory.help.readOnly")}</p>}
      {error?.kind === "unavailable" && <p className="memory-help">{t("memory.help.unavailable")}</p>}
      {error?.kind === "busy" && <p className="memory-help">{t("memory.help.busy")}</p>}
      {error?.kind === "corrupt" && <p className="memory-help">{t("memory.help.corrupt")}</p>}

      {!writesBlocked && <ReflectPanel projectId={projectId} project={project} strings={reflectStrings(locale)} memoryOff={policy?.mode === "off"} onMemoryChanged={() => void load(offset)} />}

      <section className="memory-section" aria-labelledby="memory-records-heading">
        <div className="memory-section-head">
          <div><h3 id="memory-records-heading">{t("memory.records.heading")}</h3><p>{t("memory.records.description")}</p></div>
          <div className="memory-actions">
            <button type="button" className="memory-button" onClick={() => void download()} disabled={busy}>{t("memory.export")}</button>
            <button type="button" className="memory-button" onClick={() => importRef.current?.click()} disabled={busy || writesBlocked}>{t("memory.action.stageImport")}</button>
            <input ref={importRef} type="file" accept="application/json" hidden aria-label={t("memory.import.fileAria")} onChange={importFile} />
          </div>
        </div>
        <div className="memory-filters">
          <label className="memory-search">{t("memory.search.label")}<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("memory.search.placeholder")} /></label>
          <label className="memory-select">{t("memory.filter.lifecycle")}<select value={lifecycle} onChange={(event) => setLifecycle(event.target.value)}><option value="">{t("memory.lifecycle.all")}</option><option value="candidate">{t("memory.lifecycle.candidate")}</option><option value="active">{t("memory.lifecycle.active")}</option><option value="archived">{t("memory.lifecycle.archived")}</option><option value="superseded">{t("memory.lifecycle.superseded")}</option><option value="forgotten">{t("memory.lifecycle.forgotten")}</option></select></label>
        </div>
        {importStage && (
          <div className="memory-import-stage" role="region" aria-label={t("memory.import.regionAria")}>
            <strong>{t("memory.import.staged", { name: importStage.name })}</strong>
            <span>{t("memory.import.count", { count: count(importStage.records.length), project: project.name })}</span>
            <label className="memory-select">{t("memory.import.mode")}<select value={importStage.mode} onChange={(event) => setImportStage({ ...importStage, mode: event.target.value as "merge" | "replace", preview: null, recoveryReady: false })}><option value="merge">{t("memory.import.mergeOption")}</option><option value="replace">{t("memory.import.replaceOption")}</option></select></label>
            <div className="memory-actions">
              <button type="button" className="memory-button" onClick={previewImport} disabled={busy || !policy}>{t("memory.action.preview", { mode: modeLabel(importStage.mode) })}</button>
              {importStage.mode === "replace" && <button type="button" className="memory-button" onClick={() => void download(true)} disabled={busy}>{t("memory.action.downloadRecovery")}</button>}
              {importStage.preview && <button type="button" className="memory-button memory-button-primary" onClick={commitImport} disabled={busy || importStage.preview.invalid > 0 || (importStage.mode === "replace" && !importStage.recoveryReady)}>{t("memory.action.confirm", { mode: modeLabel(importStage.mode) })}</button>}
              <button type="button" className="memory-button" onClick={() => setImportStage(null)} disabled={busy}>{t("memory.cancel")}</button>
            </div>
            {importStage.preview && <p className="memory-help">{t("memory.import.previewHelp", { duplicates: count(importStage.preview.duplicates), conflicts: count(importStage.preview.conflicts), invalid: count(importStage.preview.invalid) })}</p>}
          </div>
        )}
        <div className="memory-bulk-bar">
          <div className="memory-actions">
            <label className="memory-check"><input type="checkbox" checked={allVisibleSelected} onChange={toggleVisible} disabled={busy || !items.length} /> {t("memory.bulk.selectVisible", { max: count(MAX_PAGE) })}</label>
            <button type="button" className="memory-button" onClick={() => void selectAllFiltered()} disabled={busy || writesBlocked || !total}>{t("memory.action.selectAll", { count: count(Math.min(total, MAX_BULK)) })}</button>
            <span className="memory-help">{t("memory.bulk.summary", { total: count(total), max: count(MAX_BULK) })}</span>
          </div>
          {selectedIds.length > 0 && (
            <div className="memory-actions">
              <span className="memory-help">{t("memory.bulk.selected", { project: project.name, count: count(selectedIds.length) })}</span>
              <button type="button" className="memory-button" onClick={() => bulkAction("archive")} disabled={busy || writesBlocked}>{t("memory.action.archiveSelected")}</button>
              <button type="button" className="memory-button memory-button-danger" onClick={() => bulkAction("forget")} disabled={busy || writesBlocked}>{t("memory.action.forgetSelected")}</button>
            </div>
          )}
        </div>
        <div className="memory-list" aria-live="polite">
          {items.length === 0 && !loading ? <p className="memory-empty">{query ? t("memory.empty.noMatch") : t("memory.empty.none")}</p> : items.map((item) => (
            <article className="memory-card" key={item.id}>
              <div className="memory-card-main">
                <label className="memory-card-select"><input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => toggleSelected(item.id)} disabled={busy} aria-label={t("memory.card.select", { title: item.title })} /></label>
                <div className="memory-card-title">
                  <strong>{item.title}</strong>
                  {item.pinned && <span className="memory-badge">{t("memory.card.pinned")}</span>}
                  {item.userLocked && <span className="memory-badge">{t("memory.card.locked")}</span>}
                </div>
                <p>{item.snippet}</p>
                <div className="memory-meta">
                  <span>{label("memory.category", item.category)}</span>
                  <span>{label("memory.lifecycle", item.lifecycle)}</span>
                  <span>{item.freshness}</span>
                  <span>{t("memory.card.revision", { revision: count(item.revision) })}</span>
                </div>
              </div>
              <div className="memory-card-actions">
                <button type="button" className="memory-button" onClick={() => open(item)} disabled={busy}>{t("memory.review")}</button>
                <button type="button" className="memory-button" onClick={() => void run(() => memoryApi.action(projectId, item.id, "review", item.revision), t("memory.notice.reviewed"))} disabled={busy || writesBlocked}>{t("memory.action.markReviewed")}</button>
                <button type="button" className="memory-button" onClick={() => void run(() => memoryApi.action(projectId, item.id, "pin", item.revision), t(item.pinned ? "memory.notice.unpinned" : "memory.notice.pinned"))} disabled={busy || writesBlocked}>{item.pinned ? t("memory.action.unpin") : t("memory.action.pin")}</button>
                <button type="button" className="memory-button" onClick={() => void run(() => memoryApi.action(projectId, item.id, item.userLocked ? "unlock" : "lock", item.revision), t(item.userLocked ? "memory.notice.unlocked" : "memory.notice.locked"))} disabled={busy || writesBlocked}>{item.userLocked ? t("memory.action.unlock") : t("memory.action.lock")}</button>
                <button type="button" className="memory-button" onClick={() => void run(() => memoryApi.action(projectId, item.id, "archive", item.revision), t("memory.notice.archived"))} disabled={busy || writesBlocked || item.lifecycle === "archived" || item.lifecycle === "forgotten"}>{t("memory.action.archive")}</button>
                <button type="button" className="memory-button memory-button-danger" onClick={() => { if (window.confirm(t("memory.confirm.forgetOne", { title: item.title, project: project.name }))) void run(() => memoryApi.action(projectId, item.id, "forget", item.revision), t("memory.notice.forgotten")); }} disabled={busy || writesBlocked || item.lifecycle === "forgotten"}>{t("memory.action.forget")}</button>
              </div>
            </article>
          ))}
        </div>
        <div className="memory-pagination">
          <span>{total ? t("memory.pagination.range", { from: count(offset + 1), to: count(Math.min(offset + items.length, total)), total: count(total) }) : t("memory.pagination.none")}</span>
          <div>
            <button type="button" className="memory-button" onClick={() => void load(Math.max(0, offset - MAX_PAGE))} disabled={busy || offset === 0}>{t("memory.previous")}</button>
            <button type="button" className="memory-button" onClick={() => void load(offset + MAX_PAGE)} disabled={busy || offset + items.length >= total}>{t("memory.next")}</button>
          </div>
        </div>
      </section>

      <section className="memory-section" aria-labelledby="memory-policy-heading">
        <div className="memory-section-head"><div><h3 id="memory-policy-heading">{t("memory.policy.heading")}</h3><p>{t("memory.policy.description")}</p></div></div>
        {policy ? (
          <div className="memory-policy-grid" aria-disabled={writesBlocked}>
            {writesBlocked && <p className="memory-help">{t("memory.policy.readOnly")}</p>}
            <label className="memory-field">{t("memory.policy.mode")}<select value={policy.mode} onChange={(event) => updatePolicy({ mode: event.target.value as MemoryPolicy["mode"] })}><option value="auto">{t("memory.policy.modeAuto")}</option><option value="read-only">{t("memory.policy.modeReadOnly")}</option><option value="off">{t("memory.policy.modeOff")}</option></select></label>
            <label className="memory-field">{t("memory.policy.maxRecords")}<input type="number" min={1} max={8} value={budgetRecords} onChange={(event) => updatePolicy({ contextBudget: { ...policy.contextBudget, maxRecords: Math.max(1, Math.min(8, Number(event.target.value) || 1)) } })} /></label>
            <label className="memory-field">{t("memory.policy.maxBytes")}<input type="number" min={512} max={RECALL_BYTES} value={budgetBytes} onChange={(event) => updatePolicy({ contextBudget: { ...policy.contextBudget, maxBytes: Math.max(512, Math.min(RECALL_BYTES, Number(event.target.value) || RECALL_BYTES)) } })} /></label>
            <label className="memory-check"><input type="checkbox" checked={policy.blockWithoutMemory} onChange={(event) => updatePolicy({ blockWithoutMemory: event.target.checked })} /> {t("memory.policy.blockWithoutMemory")}</label>
            <label className="memory-field">{t("memory.policy.otherProjects")}<select value={policy.crossProjectRecall ?? "ask"} disabled={busy || writesBlocked} onChange={(event) => updatePolicy({ crossProjectRecall: event.target.value as NonNullable<MemoryPolicy["crossProjectRecall"]> })}><option value="ask">{t("memory.policy.crossAsk")}</option><option value="allow">{t("memory.policy.crossAllow")}</option><option value="off">{t("memory.policy.crossOff")}</option></select></label>
            <p className="memory-help">{t("memory.policy.crossHelp", { project: project.name })}</p>
            <label className="memory-check"><input type="checkbox" checked={policy.utilityModelAllowed} onChange={(event) => setUtilityEnabled(event.target.checked)} /> {t("memory.policy.utilityConsent")}</label>
            <div className="memory-field">{t("memory.policy.utilityModel")}<fieldset className="memory-model-picker" disabled={busy || writesBlocked} aria-label={t("memory.policy.utilityModel")}><ModelPicker models={utilityModels} {...(policy.utilityModel ? { value: policy.utilityModel } : { emptyLabel: t("memory.policy.chooseUtilityModel") })} catalogLoading={utilityModelsLoading} onPick={configureUtilityModel} /></fieldset></div>
            <label className="memory-field">{t("memory.policy.harvestReview")}<select value={policy.reviewPolicy} disabled={busy || writesBlocked} onChange={(event) => updatePolicy({ reviewPolicy: event.target.value as MemoryPolicy["reviewPolicy"] })}><option value="low-risk-auto-active">{t("memory.policy.reviewAuto")}</option><option value="manual">{t("memory.policy.reviewManual")}</option></select></label>
            <p className="memory-help">{t("memory.policy.reviewHelp")}</p>
            <label className="memory-field">{t("memory.policy.utilityBudget")}<input type="number" min={0} max={10000} value={policy.utilityBudget.maxCalls} onChange={(event) => updatePolicy({ utilityBudget: { maxCalls: Math.max(0, Math.min(10000, Number(event.target.value) || 0)) } })} /></label>
            <p className="memory-help">{t("memory.policy.readiness", { status: policy.utilityStatus, used: count(policy.utilityBudget.usedCalls), max: count(policy.utilityBudget.maxCalls) })}</p>
          </div>
        ) : <p className="memory-help">{t("memory.policy.unavailable")}</p>}
      </section>

      <section className="memory-section memory-danger-zone" aria-labelledby="memory-maintenance-heading">
        <h3 id="memory-maintenance-heading">{t("memory.maintenance.heading")}</h3>
        <p><WithProject template={t("memory.maintenance.description")} name={project.name} /></p>
        <div className="memory-actions">
          <button type="button" className="memory-button" onClick={() => void download(true)} disabled={busy || !policy}>{t("memory.action.downloadRecovery")}</button>
          <button type="button" className="memory-button memory-button-danger" disabled={busy || !policy || writesBlocked} onClick={() => { if (window.confirm(t("memory.confirm.clear", { project: project.name }))) void run(() => memoryApi.clear(projectId, policy?.generation ?? ""), t("memory.notice.cleared")); }}>{t("memory.maintenance.clear")}</button>
        </div>
      </section>

      <div className="memory-footer-actions"><button type="button" className="memory-button" onClick={close}>{t("memory.close")}</button></div>
    </div>
  );
}
