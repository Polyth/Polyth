// A user-requested draft can be generated with AI; publication remains explicit.
import { useEffect, useState, type ChangeEvent } from "react";
import { api } from "@polyth/session/web-api";
import { useCodeHosting } from "./context.tsx";

export default function ChangeRequestCreatePanel({ projectId, sessionId, onClose, onCreated }: {
  projectId: string;
  sessionId: string | null;
  onClose: () => void;
  onCreated?: (number: number, url: string) => void;
}) {
  const { client, host, provider } = useCodeHosting();
  const { Button, Checkbox, Textarea, TextInput } = host.ui.components;
  const t = provider.t;
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
      client.repository(projectId).then((result) => {
        if (!stale && result.ok && result.data.defaultBranch) setBaseHint(result.data.defaultBranch);
      }),
      api.gitBranches(projectId, sessionId ?? undefined).then((result) => {
        if (!stale && result.current) setHeadHint(result.current);
      }),
    ]);
    return () => { stale = true; };
  }, [client, projectId, sessionId]);

  const generate = async () => {
    setGenerating(true);
    setError("");
    const r = await client.describe({ projectId, ...(base.trim() ? { base: base.trim() } : {}) });
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
    const r = await client.create({
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
        <div className="form-success">
          {t("prcreatepanel.pullRequestCreatedNbsp")}{" "}<a href={created.url} target="_blank" rel="noreferrer" className="mono">#{created.number}</a>
        </div>
        <div className="commit-row">
          <Button size="sm" onClick={onClose}>{t("common.close")}</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="pr-create-panel">
      <div className="pr-create-head">
        <div>
          <strong>{t("prcreatepanel.createPullRequest")}</strong>
          <span className="muted">{t("prcreatepanel.reviewTheTitleAndDescriptionBefore")}</span>
        </div>
        <span className="tag">{t("prcreatepanel.externalWrite")}</span>
      </div>
      <div className="pr-compare-summary" aria-label={t("prcreatepanel.compareValueIntoValue", { head: headHint || t("prcreatepanel.currentBranch"), base: base.trim() || baseHint || t("prcreatepanel.defaultBranch") })}>
        <span><small>{t("prcreatepanel.head")}</small><strong className="mono" title={headHint || t("prcreatepanel.currentBranch")}>{headHint || t("prcreatepanel.currentBranch")}</strong></span>
        <span className="pr-compare-arrow" aria-hidden="true">→</span>
        <span><small>{t("prcreatepanel.base")}</small><strong className="mono" title={base.trim() || baseHint || t("prcreatepanel.defaultBranch")}>{base.trim() || baseHint || t("prcreatepanel.defaultBranch")}</strong></span>
      </div>
      <label className="pr-create-field">
        <span>{t("prcreatepanel.title")}</span>
        <TextInput
          value={title}
          placeholder={t("prcreatepanel.pullRequestTitle")}
          onChange={(e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setTitle(e.target.value)}
        />
      </label>
      <label className="pr-create-field">
        <span>{t("prcreatepanel.description")}</span>
        <Textarea
          rows={6}
          placeholder={t("prcreatepanel.describeTheChangeInMarkdown")}
          value={body}
          onChange={(e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setBody(e.target.value)}
        />
      </label>
      <div className="pr-create-options">
        <label className="pr-create-field compact">
          <span>{t("prcreatepanel.baseBranch")}</span>
          <TextInput
            className="mono"
            value={base}
            placeholder={baseHint || t("prcreatepanel.defaultBranch")}
            onChange={(e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setBase(e.target.value)}
          />
        </label>
        <Checkbox
          className="source-confirm"
          checked={draft}
          onChange={setDraft}
          label={t("prcreatepanel.createAsDraft")}
        />
      </div>
      <div className="pr-create-actions">
        <span className="header-spacer" />
        <Button size="sm" busy={generating} disabled={creating} onClick={() => void generate()}>
          {generating ? t("prcreatepanel.generating") : t("prcreatepanel.generateWithAi")}
        </Button>
        <Button size="sm" disabled={creating} onClick={onClose}>{t("common.cancel")}</Button>
        <Button size="sm" variant="primary" busy={creating} disabled={!title.trim()} onClick={() => void create()}>
          {creating ? t("prcreatepanel.creating") : t("prcreatepanel.createPr")}
        </Button>
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
  );
}
