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
      <div className="pr-create-head">
        <div>
          <strong>Create pull request</strong>
          <span className="muted">Review the title and description before publishing to GitHub.</span>
        </div>
        <span className="tag">External write</span>
      </div>
      <label className="pr-create-field">
        <span>Title</span>
        <input
          value={title}
          placeholder="Pull request title…"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="pr-create-field">
        <span>Description</span>
        <textarea
          rows={6}
          placeholder="Describe the change in Markdown…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <div className="pr-create-options">
        <label className="pr-create-field compact">
          <span>Base branch</span>
          <input
            className="mono"
            value={base}
            placeholder={baseHint || "default branch"}
            onChange={(e) => setBase(e.target.value)}
          />
        </label>
        <label className="source-confirm">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
          Create as draft
        </label>
      </div>
      <div className="pr-create-actions">
        <span className="header-spacer" />
        <button className="small-btn" disabled={generating || creating} onClick={() => void generate()}>
          {generating ? "Generating…" : "✦ Generate with AI"}
        </button>
        <button className="small-btn" disabled={creating} onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={creating || !title.trim()} onClick={() => void create()}>
          {creating ? "Creating…" : "Create PR"}
        </button>
      </div>
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}
