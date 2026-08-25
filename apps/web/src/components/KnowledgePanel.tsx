// Project knowledge: notes, plans, and memory entries scoped to the active
// project. Items are revisioned; attaching one to the current session logs the
// exact revision to the session event log before it becomes model-visible.
import { useCallback, useEffect, useState } from "react";
import { api, type KnowledgeItemDto, type KnowledgeKindDto, type KnowledgeListItemDto } from "../api.ts";
import { useStore } from "../store.ts";
import { ago } from "../format.ts";
import { tr } from "../i18n/index.ts";

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

  if (!projectId) return <div className="rail-empty">{tr("knowledgepanel.openAProjectToKeepNotesPlans")}</div>;

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
        <div className="view-toolbar-row">
          <select value={editor.kind} onChange={(e) => setEditor({ ...editor, kind: e.target.value as KnowledgeKindDto })}>
            <option value="note">{tr("knowledgepanel.note")}</option>
            <option value="spec">{tr("knowledgepanel.spec")}</option>
            <option value="plan">{tr("knowledgepanel.plan")}</option>
            <option value="memory">{tr("knowledgepanel.memory")}</option>
          </select>
          <span className="header-spacer" />
          <button className="small-btn" onClick={() => setEditor(null)}>{tr("common.cancel")}</button>
          <button className="small-btn primary-btn" disabled={!editor.title.trim()} onClick={save}>{tr("common.save")}</button>
        </div>
        <input placeholder={tr("knowledgepanel.title")} value={editor.title} onChange={(e) => setEditor({ ...editor, title: e.target.value })} />
        <textarea rows={10} placeholder={tr("knowledgepanel.bodyMarkdownWelcome")} value={editor.body} onChange={(e) => setEditor({ ...editor, body: e.target.value })} />
        <input placeholder={tr("knowledgepanel.tagsCommaSeparated")} value={editor.tags} onChange={(e) => setEditor({ ...editor, tags: e.target.value })} />
        {editor.id !== null && <div className="muted" style={{ fontSize: "calc(12px * var(--ui-font-scale, 1))" }}>{tr("knowledgepanel.editingRevision")}{" "}{editor.revision}{tr("knowledgepanel.savingBumpsIt")}</div>}
        {error && <div className="form-error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="knowledge-panel">
      <div className="view-toolbar-row">
        <input className="knowledge-search" placeholder={tr("knowledgepanel.searchKnowledge")} value={q} onChange={(e) => setQ(e.target.value)} />
        {sessionId && (
          <button
            className="small-btn"
            disabled={distilling}
            title={tr("knowledgepanel.distillTheCurrentSessionIntoANote")}
            onClick={() => {
              setDistilling(true);
              void run(async () => {
                const draft = await api.assistNote(sessionId);
                setEditor({ ...EMPTY_EDITOR, title: draft.title, body: draft.body, sourceSessionId: sessionId });
              }).finally(() => setDistilling(false));
            }}
          >{distilling ? tr("knowledgepanel.distilling") : tr("knowledgepanel.fromChat")}</button>
        )}
        <button className="small-btn" title={tr("knowledgepanel.newKnowledgeItem")} onClick={() => setEditor({ ...EMPTY_EDITOR })}>{tr("common.new")}</button>
      </div>
      <div className="seg knowledge-kinds">
        {KINDS.map((k) => (
          <button key={k.id || "all"} className={kind === k.id ? "on" : ""} onClick={() => setKind(k.id)}>{k.label}</button>
        ))}
      </div>
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="knowledge-notice">{notice}</div>}
      {items.length === 0 && <div className="rail-empty">{q ? tr("knowledgepanel.noMatches") : tr("knowledgepanel.noKnowledgeYetCaptureNotesPlansOr")}</div>}
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
            <button className="small-btn" onClick={() => openEdit(it.id)}>{tr("common.edit")}</button>
            {sessionId && (
              <button
                className="small-btn"
                title={tr("knowledgepanel.logThisExactRevisionIntoTheCurrent")}
                onClick={() => void run(
                  () => api.knowledgeAttach(sessionId, it.id, it.revision),
                  tr("knowledgepanel.attachedToSession"),
                )}
              >{tr("knowledgepanel.attach")}</button>
            )}
            <button className="small-btn danger-btn" onClick={() => void run(() => api.knowledgeDelete(it.id))}>{tr("common.delete")}</button>
          </div>
        </div>
      ))}
      {total > items.length && <div className="muted" style={{ fontSize: "calc(12px * var(--ui-font-scale, 1))" }}>{total - items.length} {tr("knowledgepanel.moreNotShownRefineYourSearch")}</div>}
    </div>
  );
}
