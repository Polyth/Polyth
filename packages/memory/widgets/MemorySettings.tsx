import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
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
import MyNotes, { type Notify } from "./MyNotes.tsx";
import ReflectPanel from "./ReflectPanel.tsx";
import { reflectStrings } from "./reflectStrings.ts";
import { englishTranslate, enumLabel, type Translate } from "./i18n.ts";
import { ActionMenu, Btn, Check, Choice, Glyph, TabPane, TabStrip, TextArea, TextField, type MenuItem } from "./ui.tsx";

type Context = {
  projectId: string;
  project: Readonly<Project>;
  mobile: boolean;
  /** Host locale; older hosts and tests may omit it (English fallback). */
  locale?: string;
  /** Host translation lookup; omitted by tests and older hosts (English). */
  translate?: Translate;
  notify?: Notify;
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

/** One settings line: what it is on the left, its control on the right; the
 *  control drops under the text in a narrow container. */
function Setting({ label, hint, children, plain, narrow }: { label: string; hint?: string; children: ReactNode; plain?: boolean; narrow?: boolean }) {
  const Tag = plain ? "div" : "label";
  return (
    <Tag className={hint ? "memory-setting memory-setting--hinted" : "memory-setting"}>
      <span className="memory-setting-copy">
        <span className="memory-setting-label">{label}</span>
        {hint && <span className="memory-setting-hint">{hint}</span>}
      </span>
      <span className={narrow ? "memory-setting-control memory-setting-control--narrow" : "memory-setting-control"}>{children}</span>
    </Tag>
  );
}

/** A number that is saved once: on Enter or when the field is left, not on
 *  every digit typed. */
function NumberSetting({ label, value, min, max, disabled, onCommit }: { label: string; value: number; min: number; max: number; disabled?: boolean; onCommit(value: number): void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = Math.max(min, Math.min(max, Math.round(Number(draft)) || min));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <Setting label={label} narrow>
      <TextField type="number" inputMode="numeric" className="memory-number" value={draft} onChange={setDraft} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") commit(); }} {...(disabled ? { disabled } : {})} />
    </Setting>
  );
}

type Tab = "records" | "rules" | "settings";

export default function MemorySettings({ projectId, project, mobile, locale, translate, notify, onBack }: Context) {
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
  const [tab, setTab] = useState<Tab>("records");
  const [selecting, setSelecting] = useState(false);
  const [pendingRules, setPendingRules] = useState(0);
  const tabsId = useId();
  const generation = useRef(0);
  const filterEpoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const t = translate ?? englishTranslate;
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const count = (value: number): string => number.format(value);
  const label = (prefix: "memory.category" | "memory.lifecycle", value: string): string => enumLabel(t, prefix, value);
  const errorOf = (cause: unknown) => memoryError(cause, t);
  // A passing result belongs to the host's notification stack; without a host
  // it stays on the page.
  const announce = (text: string) => { if (notify) notify({ kind: "success", title: text }); else setNotice(text); };

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
      if (done) announce(typeof done === "function" ? done(result) : done);
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
  const stopSelecting = () => { setSelecting(false); setSelectedIds([]); setBulkRecords([]); setSelectionFilter(""); };

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
      setTab("records");
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
  const retryable = error && ["offline", "unavailable", "busy", "corrupt"].includes(error.kind);

  if (selected) {
    const field = (name: keyof Omit<Editor, "id" | "revision">, labelKey: string, placeholderKey?: string) => (
      <label className="memory-field">
        <span>{t(labelKey)}</span>
        <TextField value={selected[name]} onChange={(value) => setSelected({ ...selected, [name]: value })} {...(placeholderKey ? { placeholder: t(placeholderKey) } : {})} />
      </label>
    );
    return (
      <div className="pkg-memory memory-page memory-editor-page">
        <div className="memory-page-head">
          <Btn variant="ghost" icon="back" onClick={() => leave(() => undefined)} disabled={busy}>{t("memory.back")}</Btn>
          <span className="memory-draft-state">{selected.id ? t("memory.editor.revision", { revision: count(selected.revision) }) : t("memory.new")}</span>
          <Btn variant="primary" onClick={save} disabled={busy || writesBlocked || !selected.title.trim() || !selected.body.trim()}>{t("memory.save")}</Btn>
        </div>
        {error && <ErrorNotice {...error} />}
        {error?.kind === "conflict" && <div className="memory-actions"><Btn onClick={() => { setSelected(null); setError(null); void load(offset); }}>{t("memory.action.reload")}</Btn></div>}
        {retryable && <div className="memory-actions"><Btn onClick={() => { setError(null); void load(offset); }}>{t("memory.retry")}</Btn></div>}
        {field("title", "memory.field.title")}
        <label className="memory-field">
          <span>{t("memory.field.body")}</span>
          <TextArea value={selected.body} onChange={(body) => setSelected({ ...selected, body })} rows={mobile ? 9 : 12} />
        </label>
        <div className="memory-field-grid">
          <label className="memory-field">
            <span>{t("memory.field.category")}</span>
            <Choice
              label={t("memory.field.category")}
              value={selected.category}
              onChange={(category) => setSelected({ ...selected, category })}
              options={["decision", "convention", "gotcha", "procedure", "observation"].map((value) => ({ value, label: t(`memory.category.${value}`) }))}
            />
          </label>
          {field("tags", "memory.field.tags", "memory.field.commaSeparated")}
          {field("aliases", "memory.field.aliases", "memory.field.commaSeparated")}
          {field("applicability", "memory.field.appliesTo", "memory.field.pathsOrContexts")}
        </div>
        {field("sources", "memory.field.sources", "memory.field.sourceReferences")}
        <p className="memory-help">{t("memory.editor.help")}</p>
      </div>
    );
  }

  const act = (item: MemoryListItem, action: "review" | "pin" | "lock" | "unlock" | "archive" | "forget", done: string) =>
    void run(() => memoryApi.action(projectId, item.id, action, item.revision), t(done));
  const rowMenu = (item: MemoryListItem): Array<MenuItem | "separator"> => [
    { id: "edit", label: t("memory.mine.edit"), onSelect: () => open(item) },
    { id: "review", label: t("memory.action.markReviewed"), disabled: writesBlocked, onSelect: () => act(item, "review", "memory.notice.reviewed") },
    { id: "pin", label: t(item.pinned ? "memory.action.unpin" : "memory.action.pin"), disabled: writesBlocked, onSelect: () => act(item, "pin", item.pinned ? "memory.notice.unpinned" : "memory.notice.pinned") },
    { id: "lock", label: t(item.userLocked ? "memory.action.unlock" : "memory.action.lock"), disabled: writesBlocked, onSelect: () => act(item, item.userLocked ? "unlock" : "lock", item.userLocked ? "memory.notice.unlocked" : "memory.notice.locked") },
    { id: "archive", label: t("memory.action.archive"), disabled: writesBlocked || item.lifecycle === "archived" || item.lifecycle === "forgotten", onSelect: () => act(item, "archive", "memory.notice.archived") },
    "separator",
    {
      id: "forget", label: t("memory.action.forget"), danger: true, disabled: writesBlocked || item.lifecycle === "forgotten",
      onSelect: () => { if (window.confirm(t("memory.confirm.forgetOne", { title: item.title, project: project.name }))) act(item, "forget", "memory.notice.forgotten"); },
    },
  ];
  // What a row says under its text: only what sets the record apart. An
  // active record of unknown age needs no label for either.
  const facts = (item: MemoryListItem): Array<{ key: string; text: string; strong?: boolean }> => [
    ...(item.pinned ? [{ key: "pinned", text: t("memory.card.pinned"), strong: true }] : []),
    { key: "category", text: label("memory.category", item.category) },
    ...(item.lifecycle !== "active" ? [{ key: "lifecycle", text: label("memory.lifecycle", item.lifecycle) }] : []),
    ...(item.userLocked ? [{ key: "locked", text: t("memory.card.locked") }] : []),
    ...(item.freshness && item.freshness !== "current" && item.freshness !== "unknown" ? [{ key: "freshness", text: item.freshness }] : []),
  ];
  const lifecycles = ["candidate", "active", "archived", "superseded", "forgotten"];
  const pickImport = () => importRef.current?.click();
  const startNew = () => { const next = { ...EMPTY }; setSelected(next); setEditorBaseline(editorKey(next)); };

  return (
    <div className="pkg-memory memory-page">
      <div className="memory-page-head">
        <Btn variant="ghost" icon="back" onClick={onBack}>{t("memory.back")}</Btn>
        <Btn variant="primary" icon="plus" onClick={startNew} disabled={writesBlocked}>{t("memory.new")}</Btn>
      </div>
      <p className="memory-intro"><WithProject template={t("memory.intro")} name={project.name} /></p>
      <TabStrip
        idBase={tabsId}
        label={t("memory.name")}
        value={tab}
        onChange={(id) => setTab(id as Tab)}
        tabs={[
          { id: "records", label: t("memory.records.heading") },
          ...(writesBlocked ? [] : [{
            id: "rules",
            label: pendingRules > 0
              ? <span className="memory-tab-count">{t("memory.tab.rules")}<span className="memory-count">{count(pendingRules)}</span></span>
              : t("memory.tab.rules"),
          }]),
          { id: "settings", label: t("memory.tab.settings") },
        ]}
      />
      {error && <ErrorNotice {...error} />}
      {notice && <div className="memory-notice memory-notice-success" role="status">{notice}</div>}
      {error?.kind === "forbidden" && <p className="memory-help">{t("memory.help.readOnly")}</p>}
      {error?.kind === "unavailable" && <p className="memory-help">{t("memory.help.unavailable")}</p>}
      {error?.kind === "busy" && <p className="memory-help">{t("memory.help.busy")}</p>}
      {error?.kind === "corrupt" && <p className="memory-help">{t("memory.help.corrupt")}</p>}
      <input ref={importRef} type="file" accept="application/json" hidden aria-label={t("memory.import.fileAria")} onChange={importFile} />

      <TabPane idBase={tabsId} id="records" active={tab === "records"}>
        {policy?.mode === "off" && (
          <div className="memory-notice memory-notice-info memory-off" role="note">
            <span>{t("memory.off.notice")}</span>
            <Btn onClick={() => setTab("settings")}>{t("memory.tab.settings")}</Btn>
          </div>
        )}
        <section className="memory-records" aria-label={t("memory.records.heading")}>
          <div className="memory-toolbar">
            <div className="memory-search ui-field-well">
              <Glyph name="search" />
              <TextField type="search" className="memory-search-input" value={query} onChange={setQuery} placeholder={t("memory.search.placeholder")} aria-label={t("memory.search.label")} />
            </div>
            <div className="memory-toolbar-end">
              <Choice
                label={t("memory.filter.lifecycle")}
                value={lifecycle}
                onChange={setLifecycle}
                align="end"
                options={[{ value: "", label: t("memory.lifecycle.all") }, ...lifecycles.map((value) => ({ value, label: t(`memory.lifecycle.${value}`) }))]}
              />
              <ActionMenu
                label={t("memory.action.more")}
                entries={[
                  { id: "select", label: t("memory.action.select"), disabled: writesBlocked || !items.length, onSelect: () => setSelecting(true) },
                  "separator",
                  { id: "export", label: t("memory.export"), disabled: busy, onSelect: () => void download() },
                  { id: "import", label: t("memory.action.stageImport"), disabled: busy || writesBlocked, onSelect: pickImport },
                ]}
              />
            </div>
          </div>
          {importStage && (
            <div className="memory-import-stage" role="region" aria-label={t("memory.import.regionAria")}>
              <div className="memory-import-copy">
                <strong>{t("memory.import.staged", { name: importStage.name })}</strong>
                <span>{t("memory.import.count", { count: count(importStage.records.length), project: project.name })}</span>
              </div>
              <Choice
                label={t("memory.import.mode")}
                value={importStage.mode}
                onChange={(mode) => setImportStage({ ...importStage, mode: mode as "merge" | "replace", preview: null, recoveryReady: false })}
                options={[{ value: "merge", label: t("memory.import.mergeOption") }, { value: "replace", label: t("memory.import.replaceOption") }]}
              />
              {importStage.preview && <p className="memory-help">{t("memory.import.previewHelp", { duplicates: count(importStage.preview.duplicates), conflicts: count(importStage.preview.conflicts), invalid: count(importStage.preview.invalid) })}</p>}
              <div className="memory-actions">
                {importStage.preview
                  ? <Btn variant="primary" onClick={commitImport} disabled={busy || importStage.preview.invalid > 0 || (importStage.mode === "replace" && !importStage.recoveryReady)}>{t("memory.action.confirm", { mode: modeLabel(importStage.mode) })}</Btn>
                  : <Btn variant="primary" onClick={previewImport} disabled={busy || !policy}>{t("memory.action.preview", { mode: modeLabel(importStage.mode) })}</Btn>}
                {importStage.mode === "replace" && <Btn onClick={() => void download(true)} disabled={busy}>{t("memory.action.downloadRecovery")}</Btn>}
                <Btn variant="ghost" onClick={() => setImportStage(null)} disabled={busy}>{t("memory.cancel")}</Btn>
              </div>
            </div>
          )}
          {selecting && (
            <div className="memory-bulk-bar" role="group" aria-label={t("memory.action.select")}>
              <div className="memory-bulk-pick">
                <Check checked={allVisibleSelected} onChange={toggleVisible} disabled={busy || !items.length} label={t("memory.bulk.selectVisible")} />
                {total > items.length && <Btn variant="ghost" onClick={() => void selectAllFiltered()} disabled={busy || writesBlocked || !total}>{t("memory.action.selectAll", { count: count(Math.min(total, MAX_BULK)) })}</Btn>}
                <Btn variant="ghost" onClick={stopSelecting} disabled={busy}>{t("memory.action.done")}</Btn>
              </div>
              <div className="memory-bulk-act">
                <span className="memory-bulk-count" aria-live="polite">{t("memory.bulk.selected", { count: count(selectedIds.length) })}</span>
                <Btn onClick={() => bulkAction("archive")} disabled={busy || writesBlocked || !selectedIds.length}>{t("memory.action.archive")}</Btn>
                <Btn variant="danger" onClick={() => bulkAction("forget")} disabled={busy || writesBlocked || !selectedIds.length}>{t("memory.action.forget")}</Btn>
              </div>
            </div>
          )}
          {loading && items.length === 0 && <p className="memory-loading" role="status">{t("memory.loading")}</p>}
          {items.length === 0 && !loading
            ? <p className="memory-empty">{query || lifecycle ? t("memory.empty.noMatch") : t("memory.empty.none")}</p>
            : (
              <ul className="memory-list" aria-live="polite" aria-busy={loading || undefined}>
                {items.map((item) => {
                  const picked = selectedIds.includes(item.id);
                  return (
                    <li className="memory-row" key={item.id} data-picked={selecting && picked ? "true" : undefined}>
                      {selecting && <Check className="memory-row-check" checked={picked} onChange={() => toggleSelected(item.id)} disabled={busy} label={<span className="memory-sr">{t("memory.card.select", { title: item.title })}</span>} />}
                      <button type="button" className="memory-row-main" {...(selecting ? { "aria-pressed": picked } : {})} onClick={() => selecting ? toggleSelected(item.id) : open(item)}>
                        <span className="memory-row-title">{item.title}</span>
                        <span className="memory-row-snippet">{item.snippet}</span>
                        <span className="memory-meta">
                          {facts(item).map((fact) => <span key={fact.key} className={fact.strong ? "memory-meta-strong" : undefined}>{fact.text}</span>)}
                        </span>
                      </button>
                      {!selecting && <ActionMenu label={t("memory.card.actions", { title: item.title })} entries={rowMenu(item)} disabled={busy} />}
                    </li>
                  );
                })}
              </ul>
            )}
          {total > 0 && (
            <div className="memory-pagination">
              <span>{t("memory.pagination.range", { from: count(offset + 1), to: count(Math.min(offset + items.length, total)), total: count(total) })}</span>
              {total > MAX_PAGE && (
                <div className="memory-actions">
                  <Btn onClick={() => void load(Math.max(0, offset - MAX_PAGE))} disabled={busy || offset === 0}>{t("memory.previous")}</Btn>
                  <Btn onClick={() => void load(offset + MAX_PAGE)} disabled={busy || offset + items.length >= total}>{t("memory.next")}</Btn>
                </div>
              )}
            </div>
          )}
        </section>
        <MyNotes projectId={projectId} project={project} translate={t} notify={notify} />
      </TabPane>

      {!writesBlocked && (
        <TabPane idBase={tabsId} id="rules" active={tab === "rules"}>
          <ReflectPanel projectId={projectId} project={project} strings={reflectStrings(locale)} memoryOff={policy?.mode === "off"} onMemoryChanged={() => void load(offset)} onPendingChange={setPendingRules} />
        </TabPane>
      )}

      <TabPane idBase={tabsId} id="settings" active={tab === "settings"}>
        <section className="memory-section" aria-labelledby="memory-policy-heading">
          <div className="memory-section-head"><div><h3 id="memory-policy-heading">{t("memory.policy.heading")}</h3><p>{t("memory.policy.description")}</p></div></div>
          {policy ? (
            <div className="memory-settings" aria-disabled={writesBlocked}>
              {writesBlocked && <p className="memory-help">{t("memory.policy.readOnly")}</p>}
              <Setting label={t("memory.policy.mode")}>
                <Choice label={t("memory.policy.mode")} value={policy.mode} disabled={busy || writesBlocked} align="end" onChange={(mode) => updatePolicy({ mode: mode as MemoryPolicy["mode"] })} options={[{ value: "auto", label: t("memory.policy.modeAuto") }, { value: "read-only", label: t("memory.policy.modeReadOnly") }, { value: "off", label: t("memory.policy.modeOff") }]} />
              </Setting>
              <NumberSetting label={t("memory.policy.maxRecords")} value={budgetRecords} min={1} max={8} disabled={busy || writesBlocked} onCommit={(maxRecords) => updatePolicy({ contextBudget: { ...policy.contextBudget, maxRecords } })} />
              <NumberSetting label={t("memory.policy.maxBytes")} value={budgetBytes} min={512} max={RECALL_BYTES} disabled={busy || writesBlocked} onCommit={(maxBytes) => updatePolicy({ contextBudget: { ...policy.contextBudget, maxBytes } })} />
              <Setting label={t("memory.policy.otherProjects")} hint={t("memory.policy.crossHelp", { project: project.name })}>
                <Choice label={t("memory.policy.otherProjects")} value={policy.crossProjectRecall ?? "ask"} disabled={busy || writesBlocked} align="end" onChange={(value) => updatePolicy({ crossProjectRecall: value as NonNullable<MemoryPolicy["crossProjectRecall"]> })} options={[{ value: "ask", label: t("memory.policy.crossAsk") }, { value: "allow", label: t("memory.policy.crossAllow") }, { value: "off", label: t("memory.policy.crossOff") }]} />
              </Setting>
              <div className="memory-setting memory-setting-check">
                <Check checked={policy.blockWithoutMemory} disabled={busy || writesBlocked} onChange={(blockWithoutMemory) => updatePolicy({ blockWithoutMemory })} label={t("memory.policy.blockWithoutMemory")} />
              </div>
            </div>
          ) : <p className="memory-help">{t("memory.policy.unavailable")}</p>}
        </section>

        {policy && (
          <section className="memory-section" aria-labelledby="memory-harvest-heading">
            <div className="memory-section-head"><div><h3 id="memory-harvest-heading">{t("memory.policy.harvesting")}</h3><p>{t("memory.policy.reviewHelp")}</p></div></div>
            <div className="memory-settings" aria-disabled={writesBlocked}>
              <Setting label={t("memory.policy.harvestReview")}>
                <Choice label={t("memory.policy.harvestReview")} value={policy.reviewPolicy} disabled={busy || writesBlocked} align="end" onChange={(value) => updatePolicy({ reviewPolicy: value as MemoryPolicy["reviewPolicy"] })} options={[{ value: "low-risk-auto-active", label: t("memory.policy.reviewAuto") }, { value: "manual", label: t("memory.policy.reviewManual") }]} />
              </Setting>
              <Setting plain label={t("memory.policy.utilityModel")}>
                <fieldset className="memory-model-picker" disabled={busy || writesBlocked} aria-label={t("memory.policy.utilityModel")}><ModelPicker models={utilityModels} {...(policy.utilityModel ? { value: policy.utilityModel } : { emptyLabel: t("memory.policy.chooseUtilityModel") })} catalogLoading={utilityModelsLoading} onPick={configureUtilityModel} /></fieldset>
              </Setting>
              <NumberSetting label={t("memory.policy.utilityBudget")} value={policy.utilityBudget.maxCalls} min={0} max={10000} disabled={busy || writesBlocked} onCommit={(maxCalls) => updatePolicy({ utilityBudget: { maxCalls } })} />
              <div className="memory-setting memory-setting-check">
                <Check checked={policy.utilityModelAllowed} disabled={busy || writesBlocked} onChange={setUtilityEnabled} label={t("memory.policy.utilityConsent")} />
              </div>
              <p className="memory-help">{t("memory.policy.readiness", { status: policy.utilityStatus, used: count(policy.utilityBudget.usedCalls), max: count(policy.utilityBudget.maxCalls) })}</p>
            </div>
          </section>
        )}

        <section className="memory-section" aria-labelledby="memory-maintenance-heading">
          <div className="memory-section-head"><div>
            <h3 id="memory-maintenance-heading">{t("memory.maintenance.heading")}</h3>
            <p><WithProject template={t("memory.maintenance.description")} name={project.name} /></p>
          </div></div>
          <div className="memory-actions">
            <Btn onClick={() => void download()} disabled={busy}>{t("memory.export")}</Btn>
            <Btn onClick={pickImport} disabled={busy || writesBlocked}>{t("memory.action.stageImport")}</Btn>
            <Btn onClick={() => void download(true)} disabled={busy || !policy}>{t("memory.action.downloadRecovery")}</Btn>
            <Btn variant="danger" disabled={busy || !policy || writesBlocked} onClick={() => { if (window.confirm(t("memory.confirm.clear", { project: project.name }))) void run(() => memoryApi.clear(projectId, policy?.generation ?? ""), t("memory.notice.cleared")); }}>{t("memory.maintenance.clear")}</Btn>
          </div>
        </section>
      </TabPane>
    </div>
  );
}
