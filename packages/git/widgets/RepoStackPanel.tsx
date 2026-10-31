import { useEffect, useRef, useState } from "react";
import { createApiTransport } from "@polyth/web-sdk";
import { createRepoStackClient } from "../src/stackClient.ts";
import type { RepoStack, RepoStackEntry, RepoStackPreview } from "../src/stackTypes.ts";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { Button, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";

const client = createRepoStackClient(createApiTransport({ fetch: (...args) => globalThis.fetch(...args) }));
type EntryDraft = RepoStackEntry;
const emptyEntry = (baseBranch: string): EntryDraft => ({ branch: "", baseBranch, headSha: "", baseSha: "", review: "none", checks: { passed: 0, total: 0, state: "none" } });
const plural = (count: number) => new Intl.PluralRules(getLocale()).select(count) === "one";
const REVIEW_KEYS = { approved: "stackpanel.reviewApproved", "changes-requested": "stackpanel.reviewChanges", pending: "stackpanel.reviewPending", none: "stackpanel.reviewNone" } as const;
const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

export default function RepoStackPanel({ projectId, repositoryId }: { projectId: string | null; repositoryId?: string }) {
  const [stacks, setStacks] = useState<RepoStack[]>([]);
  const [preview, setPreview] = useState<RepoStackPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editingStackId, setEditingStackId] = useState<string | null>(null);
  const [editingBaseBranch, setEditingBaseBranch] = useState("");
  const [draftEntries, setDraftEntries] = useState<EntryDraft[]>([]);
  const [newStack, setNewStack] = useState({ id: "", baseBranch: "main" });
  const [createOpen, setCreateOpen] = useState(false);
  const [operationNotice, setOperationNotice] = useState<string | null>(null);
  const scopeKey = `${projectId ?? "none"}:${repositoryId ?? "none"}`;
  const generation = useRef(0);
  const renderedScope = useRef(scopeKey);
  renderedScope.current = scopeKey;

  useEffect(() => {
    const epoch = ++generation.current;
    setStacks([]); setPreview(null); setEditingStackId(null); setError(null); setOperationNotice(null); setBusy(null);
    if (!projectId || !repositoryId) return () => { generation.current += 1; setBusy(null); };
    void client.list(projectId).then((result) => {
      if (generation.current !== epoch || renderedScope.current !== scopeKey) return;
      setStacks(result.stacks.filter((stack) => stack.repositoryId === repositoryId));
    }).catch((cause: unknown) => {
      if (generation.current === epoch && renderedScope.current === scopeKey) setError(messageOf(cause));
    });
    return () => { generation.current += 1; setBusy(null); };
  }, [scopeKey, projectId, repositoryId]);

  if (!projectId || !repositoryId) return null;
  const currentStack = editingStackId ? stacks.find((stack) => stack.id === editingStackId) : undefined;
  const run = async <T,>(key: string, operation: () => Promise<T>, onSuccess: (value: T) => void): Promise<void> => {
    const epoch = generation.current;
    setBusy(key); setError(null); setOperationNotice(null);
    try {
      const value = await operation();
      if (generation.current === epoch && renderedScope.current === scopeKey) onSuccess(value);
    } catch (cause) {
      if (generation.current === epoch && renderedScope.current === scopeKey) setError(messageOf(cause));
    } finally {
      if (generation.current === epoch && renderedScope.current === scopeKey) setBusy(null);
    }
  };
  const createStack = () => {
    const id = newStack.id.trim(), baseBranch = newStack.baseBranch.trim();
    if (!id || !baseBranch) return;
    void run(`create:${id}`, () => client.create({ id, projectId, repositoryId, baseBranch, entries: [] }), (stack) => {
      setStacks((current) => [...current, stack]); setNewStack({ id: "", baseBranch: "main" }); setCreateOpen(false);
    });
  };
  const saveEntries = () => {
    if (!currentStack || !editingBaseBranch.trim() || draftEntries.some((entry) => !entry.branch.trim() || !entry.baseBranch.trim())) return;
    const entries = draftEntries.map(({ headSha, baseSha, ...entry }) => {
      const branch = entry.branch.trim(), baseBranch = entry.baseBranch.trim();
      const previous = currentStack.entries.find((candidate) => candidate.branch === branch);
      return { ...entry, branch, baseBranch, ...(previous && headSha ? { headSha } : {}), ...(previous && baseSha ? { baseSha } : {}), ...(entry.title?.trim() ? { title: entry.title.trim() } : { title: undefined }) };
    });
    void run(`save:${currentStack.id}`, () => client.update(projectId, currentStack.id, { baseBranch: editingBaseBranch.trim(), entries }), (updated) => {
      setStacks((current) => current.map((stack) => stack.id === updated.id ? updated : stack)); setEditingStackId(null);
    });
  };
  const removeStack = async (stack: RepoStack) => {
    const epoch = generation.current;
    if (!await confirmAlert(tr("stackpanel.deleteStackConfirm", { id: stack.id }), { title: tr("stackpanel.deleteStack"), confirmLabel: tr("stackpanel.delete") })) return;
    if (generation.current !== epoch || renderedScope.current !== scopeKey) return;
    void run(`delete:${stack.id}`, () => client.remove(projectId, stack.id), () => setStacks((current) => current.filter((item) => item.id !== stack.id)));
  };
  const loadPreview = (stack: RepoStack) => void run(`preview:${stack.id}`, () => client.preview(projectId, stack.id), setPreview);
  const restack = (stack: RepoStack) => {
    if (!preview || preview.stackId !== stack.id || preview.warnings.length > 0) return;
    const epoch = generation.current;
    void run(`restack:${stack.id}`, async () => {
      const result = await client.restack(projectId, stack.id, preview);
      if (generation.current !== epoch || renderedScope.current !== scopeKey) return { preview: null, result };
      const nextPreview = await client.preview(projectId, stack.id);
      const listed = await client.list(projectId);
      return { preview: nextPreview, result, listed };
    }, (value) => {
      if (value.preview) setPreview(value.preview);
      if (value.listed) setStacks(value.listed.stacks.filter((item) => item.repositoryId === repositoryId));
      const result = value.result as { partial?: boolean; outcomes?: Array<{ branch: string; ok: boolean; reason?: string; cleanupError?: string }> };
      const failed = result?.outcomes?.filter((outcome) => !outcome.ok) ?? [];
      const completed = result?.outcomes?.filter((outcome) => outcome.ok).length ?? 0;
      const total = stack.entries.length;
      const cleanupErrors = result?.outcomes?.flatMap((outcome) => outcome.cleanupError ? [outcome.cleanupError] : []) ?? [];
      const cleanup = cleanupErrors.length ? ` ${tr("stackpanel.cleanupPending", { errors: cleanupErrors.join("; ") })}` : "";
      const reason = failed[0]?.reason;
      const partialKey = reason
        ? (plural(failed.length) ? "stackpanel.restackPartialReasonOne" : "stackpanel.restackPartialReasonOther")
        : (plural(failed.length) ? "stackpanel.restackPartialOne" : "stackpanel.restackPartialOther");
      setOperationNotice(failed.length || result?.partial ? `${tr(partialKey, { completed, total, failed: failed.length, reason: reason ?? "" })}${cleanup}` : `${tr("stackpanel.restackDone")}${cleanup}`);
    });
  };
  const pushBranch = (stack: RepoStack, branch: RepoStackPreview["entries"][number]) => {
    if (!branch.expectedRemoteSha) return;
    const epoch = generation.current;
    void run(`push:${stack.id}:${branch.branch}`, async () => {
      await client.push(projectId, stack.id, { branch: branch.branch, remote: branch.remote ?? "origin", expectedRemoteSha: branch.expectedRemoteSha!, expectedLocalSha: branch.expectedHeadSha });
      if (generation.current !== epoch || renderedScope.current !== scopeKey) return null;
      return client.preview(projectId, stack.id);
    }, (nextPreview) => { if (nextPreview) setPreview(nextPreview); });
  };
  const moveEntry = (stack: RepoStack, index: number, delta: -1 | 1) => setDraftEntries((current) => {
    const next = [...current], target = index + delta;
    if (target < 0 || target >= next.length) return current;
    [next[index], next[target]] = [next[target]!, next[index]!];
    return next.map((entry, position) => ({ ...entry, baseBranch: position === 0 ? stack.baseBranch : next[position - 1]!.branch }));
  });

  return <section className="git-stack-panel" aria-label={tr("stackpanel.title")}>
    <div className="git-stack-panel-head"><strong>{tr("stackpanel.title")}</strong><span>{stacks.length}</span><Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setCreateOpen((open) => !open)}>{createOpen ? tr("stackpanel.cancel") : tr("stackpanel.createStack")}</Button></div>
    {createOpen && <div className="git-stack-create">
      <TextInput aria-label={tr("stackpanel.stackName")} placeholder={tr("stackpanel.stackName")} value={newStack.id} disabled={busy !== null} onChange={(event) => setNewStack((current) => ({ ...current, id: event.target.value }))} />
      <TextInput aria-label={tr("stackpanel.stackBaseBranch")} placeholder={tr("stackpanel.baseBranch")} value={newStack.baseBranch} disabled={busy !== null} onChange={(event) => setNewStack((current) => ({ ...current, baseBranch: event.target.value }))} />
      <Button size="sm" variant="primary" disabled={busy !== null || !newStack.id.trim() || !newStack.baseBranch.trim()} onClick={createStack}>{tr("stackpanel.createStack")}</Button>
    </div>}
    {error && <div role="alert">{error}</div>}{operationNotice && <div role="status">{operationNotice}</div>}
    {stacks.map((stack) => <div className="git-stack-card" key={stack.id}>
      <div className="git-stack-card-head"><strong>{stack.id}</strong><span className="muted">{stack.baseBranch} · {tr(plural(stack.entries.length) ? "stackpanel.branchesCountOne" : "stackpanel.branchesCountOther", { count: stack.entries.length })}</span><Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => { setEditingStackId(stack.id); setEditingBaseBranch(stack.baseBranch); setDraftEntries(stack.entries.map((entry) => ({ ...entry }))); }}>{tr("stackpanel.editBranches")}</Button></div>
      {editingStackId === stack.id ? <div className="git-stack-entry-editor">
        <TextInput aria-label={tr("stackpanel.stackBaseBranch")} placeholder={tr("stackpanel.stackBaseBranch")} value={editingBaseBranch} disabled={busy !== null} onChange={(event) => setEditingBaseBranch(event.target.value)} />
        {draftEntries.map((entry, index) => <div className="git-stack-entry-form" key={`entry-${index}`}>
          <TextInput aria-label={tr("stackpanel.branchN", { n: index + 1 })} placeholder={tr("stackpanel.branch")} value={entry.branch} disabled={busy !== null} onChange={(event) => setDraftEntries((current) => current.map((item, i) => i === index ? { ...item, branch: event.target.value } : item))} />
          <TextInput aria-label={tr("stackpanel.baseBranchN", { n: index + 1 })} placeholder={tr("stackpanel.basedOn")} value={entry.baseBranch} disabled={busy !== null} onChange={(event) => setDraftEntries((current) => current.map((item, i) => i === index ? { ...item, baseBranch: event.target.value } : item))} />
          <TextInput aria-label={tr("stackpanel.prTitleN", { n: index + 1 })} placeholder={tr("stackpanel.prTitleOptional")} value={entry.title ?? ""} disabled={busy !== null} onChange={(event) => setDraftEntries((current) => current.map((item, i) => i === index ? { ...item, title: event.target.value } : item))} />
          <TextInput aria-label={tr("stackpanel.prNumberN", { n: index + 1 })} type="number" min="1" placeholder={tr("stackpanel.prNumber")} value={entry.prNumber ?? ""} disabled={busy !== null} onChange={(event) => setDraftEntries((current) => current.map((item, i) => i === index ? { ...item, prNumber: event.target.value ? Number(event.target.value) : undefined } : item))} />
          <Button size="sm" variant="ghost" disabled={busy !== null || index === 0} onClick={() => moveEntry(stack, index, -1)}>↑</Button>
          <Button size="sm" variant="ghost" disabled={busy !== null || index === draftEntries.length - 1} onClick={() => moveEntry(stack, index, 1)}>↓</Button>
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setDraftEntries((current) => current.filter((_, i) => i !== index))}>{tr("stackpanel.remove")}</Button>
        </div>)}
        <div className="git-stack-entry-actions"><Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setDraftEntries((current) => [...current, emptyEntry(stack.baseBranch)])}>{tr("stackpanel.addBranch")}</Button><Button size="sm" variant="primary" busy={busy === `save:${stack.id}`} disabled={busy !== null || draftEntries.some((entry) => !entry.branch.trim() || !entry.baseBranch.trim())} onClick={saveEntries}>{tr("stackpanel.saveBranches")}</Button><Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setEditingStackId(null)}>{tr("stackpanel.cancel")}</Button></div>
      </div> : <div className="git-stack-entries">{stack.entries.map((entry) => <div key={entry.branch}><span className="mono">{entry.branch}</span>{entry.prNumber ? <span> #{entry.prNumber}</span> : null}{entry.url && /^https:\/\//u.test(entry.url) && <a href={entry.url} target="_blank" rel="noreferrer">{tr("stackpanel.prLink")}</a>}<span className="muted"> → {entry.baseBranch}</span>{entry.title && <span> {entry.title}</span>}{typeof entry.changedFiles === "number" && <span className="muted"> · {tr(plural(entry.changedFiles) ? "stackpanel.filesCountOne" : "stackpanel.filesCountOther", { count: entry.changedFiles })}</span>}{entry.checks && <span className="muted"> {tr("stackpanel.checks", { passed: entry.checks.passed, total: entry.checks.total })}</span>}{entry.review && <span className="muted"> {REVIEW_KEYS[entry.review] ? tr(REVIEW_KEYS[entry.review]) : entry.review}</span>}</div>)}</div>}
      <div className="git-stack-card-actions"><Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => loadPreview(stack)}>{tr("stackpanel.previewRestack")}</Button>{preview?.stackId === stack.id && preview.warnings.length === 0 && <Button size="sm" disabled={busy !== null} onClick={() => restack(stack)}>{tr("stackpanel.restackLocal")}</Button>}{preview?.stackId === stack.id && preview.entries.filter((entry) => entry.expectedRemoteSha).map((entry) => <Button key={`push-${entry.branch}`} size="sm" variant="ghost" disabled={busy !== null} onClick={() => pushBranch(stack, entry)}>{tr("stackpanel.updateBranch", { branch: entry.branch })}</Button>)}<Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void removeStack(stack)}>{tr("stackpanel.deleteStack")}</Button></div>
    </div>)}
    {preview && <div className="git-stack-preview" role="status"><strong>{tr("stackpanel.previewHeading")}</strong>{preview.warnings.map((warning) => <div key={warning}>{warning}</div>)}{preview.entries.map((entry) => <div key={entry.branch}><span className="mono">{entry.branch}</span> → {entry.ontoBaseBranch}{entry.expectedHeadSha !== entry.plannedHeadSha ? <span className="muted"> · {tr("stackpanel.historyRewrite")}</span> : null}</div>)}<span>{tr(plural(preview.entries.length) ? "stackpanel.rewritesOne" : "stackpanel.rewritesOther", { count: preview.entries.length })}{preview.requiresRemoteForceWithLease ? ` · ${tr("stackpanel.forceWithLease")}` : ""}</span></div>}
  </section>;
}
