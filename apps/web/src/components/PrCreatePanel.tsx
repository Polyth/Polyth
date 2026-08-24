// F7: Create-PR flow. "Generate with AI" prefills the title/body from the
// small-model describe endpoint but never submits — creating the PR is always
// the user's explicit click. gh CLI does the write; Polyth stores no tokens.
import { useEffect, useState } from "react";
import { api } from "../api.ts";

export default function PrCreatePanel({ projectId, sessionId, onClose, onCreated }: {
  projectId: string;
  sessionId: string | null;
  onClose: () => void;
  onCreated?: (number: number, url: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [baseHint, setBaseHint] = useState("");
  const [draft, setDraft] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ number: number; url: string } | null>(null);

  useEffect(() => {
    let stale = false;
    void api.githubRepo(projectId).then((r) => {
      if (!stale && r.ok && r.data.defaultBranch) setBaseHint(r.data.defaultBranch);
    });
    return () => { stale = true; };
  }, [projectId]);

  const generate = async () => {
    setGenerating(true);
    setError("");
    const r = await api.githubPrDescribe(projectId, base.trim() || undefined);
    setGenerating(false);
    if (r.ok) {
      setTitle(r.data.title);
      setBody(r.data.body);
    } else {
      setError(r.reason);
    }
  };

  const create = async () => {
    setCreating(true);
    setError("");
    const r = await api.githubPrCreate({
      projectId, title: title.trim(), body,
      ...(base.trim() ? { base: base.trim() } : {}),
      ...(draft ? { draft: true } : {}),
      ...(sessionId ? { sessionId } : {}),
    }).catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }));
    setCreating(false);
    if (r.ok) {
      setCreated(r.data);
      onCreated?.(r.data.number, r.data.url);
    } else {
      setError(r.reason);
    }
  };

  if (created) {
    return (
      <div className="pr-create-panel" role="status">
        <div className="knowledge-notice">
          Pull request created:&nbsp;
          <a href={created.url} target="_blank" rel="noreferrer" className="mono">#{created.number}</a>
        </div>
        <div className="commit-row">
          <button className="small-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="pr-create-panel">
      <div className="stat-label">Create pull request (external write)</div>
      <div className="view-toolbar-row">
        <input
          value={title}
          placeholder="Pull request title…"
          onChange={(e) => setTitle(e.target.value)}
          style={{ flex: 1 }}
        />
      </div>
      <textarea
        rows={5}
        placeholder="Description (markdown)…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="view-toolbar-row">
        <label className="sched-every">
          base
          <input
            className="mono"
            value={base}
            placeholder={baseHint || "default branch"}
            onChange={(e) => setBase(e.target.value)}
            style={{ width: 140 }}
          />
        </label>
        <label className="sched-every">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
          Draft
        </label>
        <span className="header-spacer" />
        <button className="small-btn" disabled={generating || creating} onClick={() => void generate()}>
          {generating ? "…" : "✦ Generate with AI"}
        </button>
        <button className="small-btn" disabled={creating} onClick={onClose}>Cancel</button>
        <button className="primary-btn" style={{ padding: "5px 14px", fontSize: "calc(12px * var(--ui-font-scale, 1))" }}
          disabled={creating || !title.trim()} onClick={() => void create()}>
          {creating ? "Creating…" : "Create PR"}
        </button>
      </div>
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}
