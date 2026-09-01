// Project knowledge: notes, plans, and memory entries scoped to the active
// project. Items are revisioned; attaching one to the current session logs the
// exact revision to the session event log before it becomes model-visible.
import { useCallback, useEffect, useState } from "react";
import { api, type KnowledgeItemDto, type KnowledgeKindDto, type KnowledgeListItemDto } from "@polyth/session/web-api";
import { useStore } from "../../../apps/web/src/store.ts";
import { ago } from "../../../apps/web/src/format.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, EmptyState, Select, Tabs, Textarea, TextInput } from "../../../apps/web/src/components/ui/index.ts";

const KINDS: Array<{ id: KnowledgeKindDto | ""; label: string }> = [
  { id: "", label: tr("knowledgepanel.all") },
  { id: "note", label: tr("knowledgepanel.notes") },
  { id: "spec", label: tr("knowledgepanel.specs") },
  { id: "plan", label: tr("knowledgepanel.plans") },
  { id: "memory", label: tr("knowledgepanel.memory") },
];

interface EditorState {
  id: string | null; // null = creating
  kind: KnowledgeKindDto;
  title: string;
  body: string;
  tags: string;
  revision: number;
  /** Set when the draft came from chat→note distillation (F9). */
  sourceSessionId?: string;
}

const EMPTY_EDITOR: EditorState = { id: null, kind: "note", title: "", body: "", tags: "", revision: 0 };

export default function KnowledgePanel() {
  const projectId = useStore((s) => s.activeProjectId);
  const sessionId = useStore((s) => s.activeSessionId);
  const [items, setItems] = useState<KnowledgeListItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [kind, setKind] = useState<KnowledgeKindDto | "">("");
  const [q, setQ] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [distilling, setDistilling] = useState(false);

  const reload = useCallback(() => {
    if (!projectId) { setItems([]); setTotal(0); return; }
    void api.knowledgeList(projectId, { ...(kind ? { kind } : {}), ...(q.trim() ? { q: q.trim() } : {}), limit: 100 })
      .then((r) => { setItems(r.items); setTotal(r.total); });
  }, [projectId, kind, q]);
  useEffect(() => { reload(); }, [reload]);

  if (!projectId) return <EmptyState title={tr("knowledgepanel.openAProjectToKeepNotesPlans")} />;

  const run = async (fn: () => Promise<unknown>, doneMsg = "") => {
    try {
      setError("");
      await fn();
      reload();
      if (doneMsg) { setNotice(doneMsg); setTimeout(() => setNotice(""), 2500); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openEdit = (id: string) => void run(async () => {
    const full: KnowledgeItemDto = await api.knowledgeGet(id);
    setEditor({ id: full.id, kind: full.kind, title: full.title, body: full.body, tags: full.tags.join(", "), revision: full.revision });
  });

  const save = () => {
    if (!editor) return;
    const tags = editor.tags.split(",").map((t) => t.trim()).filter(Boolean);
    void run(async () => {
      if (editor.id === null) {
        await api.knowledgeCreate({
          projectId, kind: editor.kind, title: editor.title, body: editor.body, tags,
          ...(editor.sourceSessionId ? { sourceSessionId: editor.sourceSessionId } : {}),
        });
      } else {
        await api.knowledgeUpdate(editor.id, { title: editor.title, body: editor.body, tags, kind: editor.kind }, editor.revision);
      }
      setEditor(null);
    }, "Saved");
  };

  if (editor) {
    return (
      <div className="knowledge-editor">
        <div className="view-toolbar-row knowledge-toolbar">
          <Select
            label={KINDS.find((candidate) => candidate.id === editor.kind)?.label ?? editor.kind}
            value={editor.kind}
            options={KINDS.filter((candidate) => candidate.id !== "").map((candidate) => ({
              value: candidate.id,
              label: candidate.label,
            }))}
            onChange={(value) => setEditor({ ...editor, kind: value as KnowledgeKindDto })}
          />
          <span className="header-spacer knowledge-toolbar-spacer" />
          <Button size="sm" variant="ghost" onClick={() => setEditor(null)}>{tr("common.cancel")}</Button>
          <Button size="sm" variant="primary" disabled={!editor.title.trim()} onClick={save}>{tr("common.save")}</Button>
        </div>
        <TextInput placeholder={tr("knowledgepanel.title")} value={editor.title} onChange={(e) => setEditor({ ...editor, title: e.target.value })} />
        <Textarea rows={10} placeholder={tr("knowledgepanel.bodyMarkdownWelcome")} value={editor.body} onChange={(e) => setEditor({ ...editor, body: e.target.value })} />
        <TextInput placeholder={tr("knowledgepanel.tagsCommaSeparated")} value={editor.tags} onChange={(e) => setEditor({ ...editor, tags: e.target.value })} />
        {editor.id !== null && <div className="muted knowledge-meta-note">{tr("knowledgepanel.editingRevision")}{" "}{editor.revision}{tr("knowledgepanel.savingBumpsIt")}</div>}
        {error && <div className="form-error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="knowledge-panel">
      <div className="view-toolbar-row knowledge-toolbar">
        <TextInput uiSize="sm" className="knowledge-search" placeholder={tr("knowledgepanel.searchKnowledge")} value={q} onChange={(e) => setQ(e.target.value)} />
        {sessionId && (
          <Button
            size="sm"
            busy={distilling}
            disabled={distilling}
            title={tr("knowledgepanel.distillTheCurrentSessionIntoANote")}
            onClick={() => {
              setDistilling(true);
              void run(async () => {
                const draft = await api.assistNote(sessionId);
                setEditor({ ...EMPTY_EDITOR, title: draft.title, body: draft.body, sourceSessionId: sessionId });
              }).finally(() => setDistilling(false));
            }}
          >{distilling ? tr("knowledgepanel.distilling") : tr("knowledgepanel.fromChat")}</Button>
        )}
        <Button size="sm" title={tr("knowledgepanel.newKnowledgeItem")} onClick={() => setEditor({ ...EMPTY_EDITOR })}>{tr("common.new")}</Button>
      </div>
      <Tabs
        className="knowledge-kinds"
        size="sm"
        label={tr("knowledgepanel.all")}
        value={kind || "__all__"}
        tabs={KINDS.map((item) => ({ id: item.id || "__all__", label: item.label }))}
        onChange={(value) => setKind(value === "__all__" ? "" : value as KnowledgeKindDto)}
      />
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="form-success">{notice}</div>}
      {items.length === 0 && <EmptyState title={q ? tr("knowledgepanel.noMatches") : tr("knowledgepanel.noKnowledgeYetCaptureNotesPlansOr")} />}
      {items.map((it) => (
        <div key={it.id} className="knowledge-card">
          <div className="knowledge-card-head">
            <span className={`knowledge-kind kind-${it.kind}`}>{it.kind}</span>
            <span className="knowledge-title">{it.title}</span>
          </div>
          {it.snippet && <div className="knowledge-snippet">{it.snippet}</div>}
          <div className="knowledge-meta">
            <span>{tr("knowledgepanel.rev")}{" "}{it.revision}</span>
            <span>·</span>
            <span>{ago(it.updatedAt)} {tr("knowledgepanel.ago")}</span>
            {it.tags.length > 0 && <><span>·</span><span>{it.tags.join(", ")}</span></>}
          </div>
          <div className="knowledge-actions">
            <Button size="sm" onClick={() => openEdit(it.id)}>{tr("common.edit")}</Button>
            {sessionId && (
              <Button
                size="sm"
                title={tr("knowledgepanel.logThisExactRevisionIntoTheCurrent")}
                onClick={() => void run(
                  () => api.knowledgeAttach(sessionId, it.id, it.revision),
                  tr("knowledgepanel.attachedToSession"),
                )}
              >{tr("knowledgepanel.attach")}</Button>
            )}
            <Button size="sm" variant="danger" onClick={() => void run(() => api.knowledgeDelete(it.id))}>{tr("common.delete")}</Button>
          </div>
        </div>
      ))}
      {total > items.length && <div className="muted knowledge-meta-note">{total - items.length} {tr("knowledgepanel.moreNotShownRefineYourSearch")}</div>}
    </div>
  );
}
