import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Project } from "@polyth/contracts";
import {
  memoryError,
  REFLECT_MEMORY_OFF,
  reflectApi,
  type MemoryCategory,
  type ReflectApproveResult,
  type ReflectInstructionFile,
  type ReflectProposalDto,
  type ReflectViewDto,
} from "../src/client.ts";
import { sanitizeRule } from "../src/reflect.ts";
import { failureReason, format, type ReflectStrings } from "./reflectStrings.ts";
import { isImeComposing } from "@polyth/web-sdk";

type Props = {
  projectId: string;
  project: Readonly<Project>;
  strings: ReflectStrings;
  /** Project memory policy is off: the server neither detects nor scans. */
  memoryOff?: boolean;
  /** Refresh the records list after an approval created a memory. */
  onMemoryChanged(): void;
};

type Draft = { id: string; rule: string; category: MemoryCategory; file: ReflectInstructionFile | "" };
/** A pending instruction-file write the user must confirm in place. */
type Confirm = { id: string; file: ReflectInstructionFile; line: string; draft: Draft | null; later: boolean };
type Notice = { tone: "success" | "warning"; text: string };

const CATEGORIES: MemoryCategory[] = ["convention", "decision", "gotcha", "procedure", "observation"];

/** The exact absolute path shown before a write; the server resolves the
 * same project root and refuses a symlinked file or an escape. */
export function instructionPath(project: Readonly<Project>, file: string): string {
  const root = (project as { path?: string }).path?.trim();
  if (!root) return file;
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${file}`;
}

export default function ReflectPanel({ projectId, project, strings: t, memoryOff = false, onMemoryChanged }: Props) {
  const [view, setView] = useState<ReflectViewDto | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  // Set when a scan is refused with 409 memory-off (the policy changed after
  // this view loaded); cleared by the next successful view.
  const [refusedOff, setRefusedOff] = useState(false);
  const [error, setError] = useState<{ kind: string; message: string } | null>(null);
  const generation = useRef(0);
  const sectionRef = useRef<HTMLElement>(null);
  const confirmedId = useRef<string | null>(null);
  const uid = useId();

  // The confirmation replaces the card's buttons: move focus into it, and
  // back to the card's primary action when it closes without a decision.
  useEffect(() => {
    const root = sectionRef.current;
    if (!root) return;
    if (confirm) {
      confirmedId.current = confirm.id;
      root.querySelector<HTMLElement>(".memory-reflect-confirm .memory-button-primary")?.focus();
      return;
    }
    const previous = confirmedId.current;
    confirmedId.current = null;
    const card = previous ? [...root.querySelectorAll<HTMLElement>("[data-proposal]")].find((el) => el.dataset.proposal === previous) : undefined;
    card?.querySelector<HTMLElement>(".memory-card-actions .memory-button")?.focus();
  }, [confirm?.id, confirm?.file]);

  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await reflectApi.view(projectId);
      if (current === generation.current) { setView(next); setError(null); setRefusedOff(false); }
    } catch (cause) {
      if (current === generation.current) setError(memoryError(cause));
    }
  }, [projectId]);

  useEffect(() => {
    setView(null); setDraft(null); setConfirm(null); setNotice(null); setError(null); setShowHidden(false);
    void load();
    return () => { generation.current++; };
  }, [load]);

  // The host re-reads the policy after a save, so a changed `memoryOff` is
  // newer than the cached view and any remembered 409: apply it at once and
  // re-read the view so the server flag catches up (both directions).
  const lastMemoryOff = useRef(memoryOff);
  useEffect(() => {
    if (lastMemoryOff.current === memoryOff) return;
    lastMemoryOff.current = memoryOff;
    setRefusedOff(false);
    setView((current) => current ? { ...current, memoryOff } : current);
    void load();
  }, [memoryOff, load]);

  const run = async <T,>(action: () => Promise<T>, done: (result: T) => Notice | null) => {
    if (busy) return;
    const requestProject = projectId;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await action();
      if (requestProject !== projectId) return;
      setNotice(done(result));
      await load();
    } catch (cause) {
      if (requestProject !== projectId) return;
      if ((cause as { code?: unknown } | null)?.code === REFLECT_MEMORY_OFF) setRefusedOff(true);
      else setError(memoryError(cause));
    } finally { setBusy(false); }
  };

  const instructionOutcome = (result: ReflectApproveResult): Notice | null => {
    const outcome = result.instruction;
    if (!outcome) return null;
    if (outcome.status === "appended") return { tone: "success", text: format(t.written, { file: outcome.file }) };
    if (outcome.status === "duplicate") return { tone: "success", text: format(t.duplicate, { file: outcome.file }) };
    return { tone: "warning", text: format(t.writeFailed, { file: outcome.file, reason: failureReason(t, outcome.code) }) };
  };

  const approveNow = (proposal: ReflectProposalDto, current: Draft | null, file?: ReflectInstructionFile) => {
    const rule = (current?.rule ?? proposal.rule).trim();
    void run(async () => {
      const result = await reflectApi.approve(projectId, proposal.id, { rule, category: current?.category ?? "convention" }, file);
      setDraft(null); setConfirm(null);
      onMemoryChanged();
      return result;
    }, (result) => {
      const extra = instructionOutcome(result);
      return { tone: extra?.tone ?? "success", text: extra ? `${t.approved} ${extra.text}` : t.approved };
    });
  };

  /** Writing an instruction file is a second, explicit consent: the exact
   * line and path are shown in place before the confirmation token is sent. */
  const approve = (proposal: ReflectProposalDto, current: Draft | null) => {
    const rule = (current?.rule ?? proposal.rule).trim();
    if (!rule) return;
    if (current?.file) {
      setConfirm({ id: proposal.id, file: current.file, line: `- ${sanitizeRule(rule) ?? rule}`, draft: current, later: false });
      return;
    }
    approveNow(proposal, current);
  };

  const confirmWrite = (proposal: ReflectProposalDto, pending: Confirm) => {
    if (pending.later) {
      void run(() => reflectApi.writeInstruction(projectId, proposal.id, pending.file), (result) => { setConfirm(null); return instructionOutcome(result); });
    } else approveNow(proposal, pending.draft, pending.file);
  };

  const fileLabel = (file: ReflectInstructionFile): string =>
    view?.instructionFiles.find((entry) => entry.file === file)?.exists ? file : format(t.fileMissing, { file });

  const source = (proposal: ReflectProposalDto): string => proposal.sessionTitle
    ? format(t.from, { session: proposal.sessionTitle, seq: proposal.eventSeq })
    : format(t.fromUntitled, { seq: proposal.eventSeq });

  const confirmBox = (proposal: ReflectProposalDto) => {
    if (confirm?.id !== proposal.id) return null;
    const headingId = `${uid}-confirm-${proposal.id}`;
    return (
      <div className="memory-reflect-confirm" role="group" aria-labelledby={headingId}>
        <strong id={headingId}>{format(t.confirmHeading, { file: confirm.file })}</strong>
        <dl>
          <dt>{t.confirmFile}</dt><dd><code dir="ltr">{instructionPath(project, confirm.file)}</code></dd>
          <dt>{t.confirmLine}</dt><dd><code dir="ltr">{confirm.line}</code></dd>
        </dl>
        <p className="memory-help">{t.confirmSection}</p>
        <div className="memory-actions">
          <button type="button" className="memory-button memory-button-primary" disabled={busy} onClick={() => confirmWrite(proposal, confirm)}>{confirm.later ? t.confirmWrite : t.confirmApprove}</button>
          <button type="button" className="memory-button" disabled={busy} onClick={() => setConfirm(null)}>{t.cancel}</button>
        </div>
      </div>
    );
  };

  // The host prop, the server's own view and a refused scan all mean "off".
  const off = memoryOff || view?.memoryOff === true || refusedOff;
  const scanDisabled = busy || !view || off;
  // Catalogs are EN/UK (LTR scripts); other locales fall back to English,
  // which must not inherit an RTL page direction.
  return (
    <section ref={sectionRef} className="memory-section memory-reflect" lang={t.lang} dir="ltr" aria-labelledby={`${uid}-heading`} aria-busy={busy || undefined}>
      <div className="memory-section-head">
        <div><h3 id={`${uid}-heading`}>{t.heading}</h3><p>{t.intro}</p></div>
        <div className="memory-actions">
          <button type="button" className="memory-button" disabled={scanDisabled} aria-describedby={off && view ? `${uid}-off` : undefined} onClick={() => void run(() => reflectApi.scan(projectId), (result) => ({ tone: "success", text: format(t.scanned, result) }))}>{t.scan}</button>
        </div>
      </div>
      {error && (
        <div className={`memory-notice memory-notice-${error.kind}`} role="alert">
          <span>{error.message}</span>
          {!view && <button type="button" className="memory-button" onClick={() => { setError(null); void load(); }}>{t.retry}</button>}
        </div>
      )}
      {notice && <div className={`memory-notice memory-notice-${notice.tone}`} role="status">{notice.text}</div>}
      {!view && !error && <p className="memory-loading" role="status">{t.loading}</p>}
      {view && (
        <>
          {off && <div className="memory-notice memory-notice-info" role="note" id={`${uid}-off`}>{t.memoryOff}</div>}
          <label className="memory-check"><input type="checkbox" checked={view.enabled} disabled={busy || off} onChange={(event) => void run(() => reflectApi.setEnabled(projectId, event.target.checked), () => null)} /> {t.enabled}</label>
          {!view.enabled && !off && <p className="memory-help">{t.disabledHelp}</p>}
          {!view.instructionWritable && <p className="memory-help">{t.remoteOnly}</p>}
          {view.pending.length === 0 && (!view.hidden || view.hidden.length === 0) ? <p className="memory-empty">{t.empty}</p> : (
            <div className="memory-list">
              <div className="memory-reflect-count-row">
                <span className="memory-help">{view.pendingTotal === 1 ? t.pendingCountOne : format(t.pendingCount, { count: view.pendingTotal })}</span>
                {view.hidden && view.hidden.length > 0 && (
                  <button type="button" className="memory-button" onClick={() => setShowHidden(!showHidden)}>
                    {showHidden ? t.hideHidden : format(t.showHidden, { count: view.hidden.length })}
                  </button>
                )}
              </div>
              {(showHidden && view.hidden?.length ? [...view.pending, ...view.hidden] : view.pending).map((proposal) => {
                const editing = draft?.id === proposal.id ? draft : null;
                const confirming = confirm?.id === proposal.id;
                const ruleId = `${uid}-rule-${proposal.id}`;
                return (
                  <article className="memory-card memory-reflect-card" key={proposal.id} data-proposal={proposal.id} aria-labelledby={editing ? undefined : ruleId}>
                    <div className="memory-card-main">
                      <div className="memory-card-title">
                        <span className="memory-badge">{t[`signal_${proposal.signal}`]}</span>
                        {proposal.area && (
                          <span className="memory-badge memory-badge-area" data-area={proposal.area}>
                            {t[`area_${proposal.area}`] ?? proposal.area}
                          </span>
                        )}
                        {typeof proposal.durability === "number" && (
                          <span className="memory-badge memory-badge-durability" data-durability={proposal.durability}>
                            {`${Math.round(proposal.durability * 100)}%`}
                          </span>
                        )}
                      </div>
                      {editing ? (
                        <div className="memory-reflect-editor" onKeyDown={(event) => {
                          if (isImeComposing(event)) return;
                          if (event.key === "Escape" && !confirming) { event.stopPropagation(); setDraft(null); }
                        }}>
                          <label className="memory-field">{t.rule}<textarea rows={3} maxLength={280} value={editing.rule} disabled={confirming} onChange={(event) => setDraft({ ...editing, rule: event.target.value })} autoFocus /></label>
                          <div className="memory-field-grid">
                            <label className="memory-field">{t.category}<select value={editing.category} disabled={confirming} onChange={(event) => setDraft({ ...editing, category: event.target.value as MemoryCategory })}>{CATEGORIES.map((category) => <option key={category} value={category}>{t[`category_${category}`]}</option>)}</select></label>
                            <label className="memory-field">{t.alsoWrite}<select value={editing.file} disabled={confirming || !view.instructionWritable} onChange={(event) => setDraft({ ...editing, file: event.target.value as Draft["file"] })}><option value="">{t.noFile}</option>{view.instructionFiles.map((entry) => <option key={entry.file} value={entry.file}>{fileLabel(entry.file)}</option>)}</select></label>
                          </div>
                        </div>
                      ) : <strong className="memory-reflect-rule" id={ruleId}>{proposal.rule}</strong>}
                      <div className="memory-meta"><span>{source(proposal)}</span></div>
                    </div>
                    {confirmBox(proposal)}
                    {!confirming && (
                      <div className="memory-card-actions">
                        {editing ? (
                          <>
                            <button type="button" className="memory-button memory-button-primary" disabled={busy || !editing.rule.trim()} onClick={() => approve(proposal, editing)}>{t.approve}</button>
                            <button type="button" className="memory-button" disabled={busy} onClick={() => setDraft(null)}>{t.cancel}</button>
                          </>
                        ) : (
                          <>
                            <button type="button" className="memory-button memory-button-primary" disabled={busy} onClick={() => approve(proposal, null)}>{t.approve}</button>
                            <button type="button" className="memory-button" disabled={busy} onClick={() => { setConfirm(null); setDraft({ id: proposal.id, rule: proposal.rule, category: "convention", file: "" }); }}>{t.edit}</button>
                          </>
                        )}
                        <button type="button" className="memory-button memory-button-danger" disabled={busy} onClick={() => void run(() => reflectApi.reject(projectId, proposal.id), () => ({ tone: "success", text: t.rejected }))}>{t.reject}</button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
          {view.recent.length > 0 && (
            <details className="memory-reflect-recent" open={confirm !== null && view.recent.some((row) => row.id === confirm.id) ? true : undefined}>
              <summary>{t.recent}</summary>
              <div className="memory-list">
                {view.recent.map((proposal) => (
                  <article className="memory-card memory-reflect-card" key={proposal.id} data-proposal={proposal.id}>
                    <div className="memory-card-main">
                      <p>{proposal.rule}</p>
                      <div className="memory-meta">
                        <span>{proposal.status === "approved" ? t.statusApproved : t.statusRejected}</span>
                        {proposal.area && <span>{proposal.area}</span>}
                        {typeof proposal.durability === "number" && <span>{`${Math.round(proposal.durability * 100)}%`}</span>}
                        {proposal.instruction && <span>{format(t.inFile, { file: proposal.instruction.file })}</span>}
                        <span>{source(proposal)}</span>
                      </div>
                    </div>
                    {confirmBox(proposal)}
                    {proposal.status === "approved" && !proposal.instruction && view.instructionWritable && confirm?.id !== proposal.id && (
                      <div className="memory-card-actions">
                        {view.instructionFiles.map((entry) => <button key={entry.file} type="button" className="memory-button" disabled={busy} onClick={() => setConfirm({ id: proposal.id, file: entry.file, line: `- ${sanitizeRule(proposal.rule) ?? proposal.rule}`, draft: null, later: true })}>{format(t.writeTo, { file: entry.file })}</button>)}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
