// F7: Create-PR flow. "Generate with AI" prefills the title/body from the
// small-model describe endpoint but never submits — creating the PR is always
// the user's explicit click. gh CLI does the write; Polyth stores no tokens.
import { useEffect, useState } from "react";
import { api } from "@polyth/session/web-api";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Checkbox, Textarea, TextInput } from "../../../apps/web/src/components/ui/index.ts";

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
  const [headHint, setHeadHint] = useState("");
  const [draft, setDraft] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ number: number; url: string } | null>(null);

  useEffect(() => {
    let stale = false;
    void Promise.allSettled([
      api.githubRepo(projectId).then((result) => {
        if (!stale && result.ok && result.data.defaultBranch) setBaseHint(result.data.defaultBranch);
      }),
      api.gitBranches(projectId, sessionId ?? undefined).then((result) => {
        if (!stale && result.current) setHeadHint(result.current);
      }),
    ]);
    return () => { stale = true; };
  }, [projectId, sessionId]);

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
          {tr("prcreatepanel.pullRequestCreatedNbsp")}{" "}<a href={created.url} target="_blank" rel="noreferrer" className="mono">#{created.number}</a>
        </div>
        <div className="commit-row">
          <Button size="sm" onClick={onClose}>{tr("common.close")}</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="pr-create-panel">
      <div className="pr-create-head">
        <div>
          <strong>{tr("prcreatepanel.createPullRequest")}</strong>
          <span className="muted">{tr("prcreatepanel.reviewTheTitleAndDescriptionBefore")}</span>
        </div>
        <span className="tag">{tr("prcreatepanel.externalWrite")}</span>
      </div>
      <div className="pr-compare-summary" aria-label={tr("prcreatepanel.compareValueIntoValue", { head: headHint || tr("prcreatepanel.currentBranch"), base: base.trim() || baseHint || tr("prcreatepanel.defaultBranch") })}>
        <span><small>{tr("prcreatepanel.head")}</small><strong className="mono" title={headHint || tr("prcreatepanel.currentBranch")}>{headHint || tr("prcreatepanel.currentBranch")}</strong></span>
        <span className="pr-compare-arrow" aria-hidden="true">→</span>
        <span><small>{tr("prcreatepanel.base")}</small><strong className="mono" title={base.trim() || baseHint || tr("prcreatepanel.defaultBranch")}>{base.trim() || baseHint || tr("prcreatepanel.defaultBranch")}</strong></span>
      </div>
      <label className="pr-create-field">
        <span>{tr("prcreatepanel.title")}</span>
        <TextInput
          value={title}
          placeholder={tr("prcreatepanel.pullRequestTitle")}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="pr-create-field">
        <span>{tr("prcreatepanel.description")}</span>
        <Textarea
          rows={6}
          placeholder={tr("prcreatepanel.describeTheChangeInMarkdown")}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <div className="pr-create-options">
        <label className="pr-create-field compact">
          <span>{tr("prcreatepanel.baseBranch")}</span>
          <TextInput
            className="mono"
            value={base}
            placeholder={baseHint || tr("prcreatepanel.defaultBranch")}
            onChange={(e) => setBase(e.target.value)}
          />
        </label>
        <Checkbox
          className="source-confirm"
          checked={draft}
          onChange={setDraft}
          label={tr("prcreatepanel.createAsDraft")}
        />
      </div>
      <div className="pr-create-actions">
        <span className="header-spacer" />
        <Button size="sm" busy={generating} disabled={creating} onClick={() => void generate()}>
          {generating ? tr("prcreatepanel.generating") : tr("prcreatepanel.generateWithAi")}
        </Button>
        <Button size="sm" disabled={creating} onClick={onClose}>{tr("common.cancel")}</Button>
        <Button size="sm" variant="primary" busy={creating} disabled={!title.trim()} onClick={() => void create()}>
          {creating ? tr("prcreatepanel.creating") : tr("prcreatepanel.createPr")}
        </Button>
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
  );
}
