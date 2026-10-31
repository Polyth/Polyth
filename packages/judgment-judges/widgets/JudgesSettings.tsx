import { useEffect, useId, useRef, useState } from "react";
import { createApiTransport } from "@polyth/web-sdk";
import { getLocale, tr } from "@polyth/web/i18n";
import { Badge, Button, Checkbox, confirmAlert, Icon, Notice, ShieldIcon, Select, Switch, TextInput, Textarea } from "@polyth/web/ui";
import { CheckGroup, EmptyState, ErrorState, FormField, NumberField, PageHead, Row, SaveBar, Section, Seg } from "../../../apps/web/src/components/settings/parts.tsx";
import {
  approvesRequest, blankJudge, DEFAULT_DAILY_CAP, DISPLAY_EFFECTS, EVIDENCE_CHARS, EVIDENCE_PICKS, FOLLOW_UP_MAX, hasActions, isAction, MAX_BACKTEST, MAX_DAILY_CAP,
  MAX_ROUTES, MESSAGE_MAX, MESSAGE_PRESETS, parseRouteKey, ROUNDS, TRIGGER_EFFECTS, TRIGGER_EVIDENCE, validateJudgeInput,
  type ActionKind, type ApprovalLevel, type BacktestResult, type DisplayEffectKind, type EvidencePick, type JudgeDefinition, type JudgeEffect, type JudgeInput,
  type JudgeQuestion, type JudgeRouteOption, type JudgeRoutesSnapshot, type JudgesSnapshot, type JudgeTrigger,
} from "../src/types.ts";
import { judgeErrorMessage } from "./judgeErrors.ts";

type Key = Parameters<typeof tr>[0];
const api = createApiTransport();
const questionKinds = (): Array<[Exclude<JudgeQuestion["type"], "route">, string]> => [["noul", tr("judgesui.qNoul")], ["choice", tr("judgesui.qChoice")], ["score", tr("judgesui.qScore")]];
const triggerKinds = (): Array<[JudgeTrigger, string]> => [["turn-completed", tr("judgesui.trigTurn")], ["permission-requested", tr("judgesui.trigPermission")], ["limit-reached", tr("judgesui.trigLimit")]];
/** Copy looked up when read, so it follows the active language. */
const triggerCopy = (short: Key, hint: Key, scope: Key) => ({ get short() { return tr(short); }, get hint() { return tr(hint); }, get scope() { return tr(scope); } });
const TRIGGER_COPY: Record<JudgeTrigger, { short: string; hint: string; scope: string }> = {
  "turn-completed": triggerCopy("judgesui.trigTurnShort", "judgesui.trigTurnHint", "judgesui.trigTurnScope"),
  "permission-requested": triggerCopy("judgesui.trigPermissionShort", "judgesui.trigPermissionHint", "judgesui.trigPermissionScope"),
  "limit-reached": triggerCopy("judgesui.trigLimitShort", "judgesui.trigLimitHint", "judgesui.trigLimitScope"),
};
const effectCopy = (label: Key, short: Key, description: Key) => ({ get label() { return tr(label); }, get short() { return tr(short); }, get description() { return tr(description); } });
const EVIDENCE_KEYS: Record<EvidencePick, Key> = {
  "last-request": "judgesui.evLastRequest", "last-answer": "judgesui.evLastAnswer", "commands-run": "judgesui.evCommands",
  "changed-files": "judgesui.evChangedFiles", "open-todos": "judgesui.evOpenTodos", "permission-request": "judgesui.evPermission",
};
const evidenceLabel = (pick: EvidencePick) => tr(EVIDENCE_KEYS[pick]);
const PRESET_KEYS: Record<string, Key> = { continue: "judgesui.presetContinue", "fix-remaining": "judgesui.presetFix", refine: "judgesui.presetRefine", audit: "judgesui.presetAudit" };
const presetLabel = (id: string, fallback: string) => PRESET_KEYS[id] ? tr(PRESET_KEYS[id]) : fallback;
const percent = (value: number) => `${Math.round(value * 100)}%`;
const andList = (items: string[]) => items.join(tr("judgesui.listAnd"));
const message = (error: unknown) => judgeErrorMessage(error instanceof Error ? error.message : String(error));
const withoutMeta = ({ id: _id, createdAt: _c, updatedAt: _u, ownerUserId: _o, ...input }: JudgeDefinition): JudgeInput => structuredClone(input);
/** Markers in the person's words: what they will see. */
const DISPLAY_COPY: Record<DisplayEffectKind, { label: string; short: string; description: string }> = {
  "timeline-marker": effectCopy("judgesui.dispMarkLabel", "judgesui.dispMarkShort", "judgesui.dispMarkDesc"),
  "needs-attention": effectCopy("judgesui.dispAttentionLabel", "judgesui.dispAttentionShort", "judgesui.dispAttentionDesc"),
  "suggest-follow-up": effectCopy("judgesui.dispFollowLabel", "judgesui.dispFollowShort", "judgesui.dispFollowDesc"),
};
/** Actions in the person's words: what the judge will do with their access. */
const ACTION_COPY: Record<ActionKind, { label: string; short: string; description: string }> = {
  "send-message": effectCopy("judgesui.actSendLabel", "judgesui.actSendShort", "judgesui.actSendDesc"),
  "merge-isolated": effectCopy("judgesui.actMergeLabel", "judgesui.actMergeShort", "judgesui.actMergeDesc"),
  "approve-request": effectCopy("judgesui.actApproveLabel", "judgesui.actApproveShort", "judgesui.actApproveDesc"),
  "deny-request": effectCopy("judgesui.actDenyLabel", "judgesui.actDenyShort", "judgesui.actDenyDesc"),
  "set-approval": effectCopy("judgesui.actApprovalLabel", "judgesui.actApprovalShort", "judgesui.actApprovalDesc"),
  "switch-route": effectCopy("judgesui.actRouteLabel", "judgesui.actRouteShort", "judgesui.actRouteDesc"),
};
const levelOptions = (): Array<[ApprovalLevel, string]> => [["on", tr("judgesui.levelOn")], ["all", tr("judgesui.levelAll")], ["off", tr("judgesui.levelOff")]];
const effectShort = (effect: JudgeEffect) => (isAction(effect.kind) ? ACTION_COPY[effect.kind as ActionKind] : DISPLAY_COPY[effect.kind as DisplayEffectKind]).short;
const questionSummary = (question: JudgeQuestion) => question.type === "noul" ? tr("judgesui.qNoul")
  : question.type === "choice" ? tr("judgesui.qChoiceCount", { count: question.labels.length })
  : question.type === "score" ? tr("judgesui.qScoreLevels", { count: question.rubric.length }) : tr("judgesui.qRouteSummary");
const summary = (judge: JudgeDefinition) => [
  TRIGGER_COPY[judge.trigger].short,
  questionSummary(judge.question),
  andList([...new Set(judge.effects.map(effectShort))]),
  judge.filters.projectId ? tr("judgesui.thisProject") : tr("judgesui.allProjects"),
].join(" · ");
/** Yes-or-no answers are Judgment's own words; choice labels are the person's and stay as written. */
const answerText = (label: string | undefined, type: JudgeQuestion["type"]) => type === "noul"
  ? ({ yes: tr("judgesui.yes"), no: tr("judgesui.no"), cannot_tell: tr("judgesui.cantTell") } as Record<string, string>)[label ?? ""] ?? label ?? "" : label ?? "";
const SKIPPED: Record<string, Key> = { cap: "judgesui.skipCap", timeout: "judgesui.skipTimeout", cancelled: "judgesui.skipCancelled", "budget-exhausted": "judgesui.skipTimeout" };
/** Why a judge got no answer, and what the person can do about it. */
const FAILURE_COPY: Record<string, Key> = {
  "model-unavailable": "judgesui.failModelUnavailable",
  "provider-unavailable": "judgesui.failProviderUnavailable",
  "engine-unavailable": "judgesui.failEngineUnavailable",
  timeout: "judgesui.failTimeout",
  "invalid-response": "judgesui.failInvalidResponse",
  "provider-error": "judgesui.failProviderError",
  disabled: "judgesui.failDisabled",
};

function retype(question: JudgeQuestion, type: Exclude<JudgeQuestion["type"], "route">): JudgeQuestion {
  if (type === "noul") return { type, text: question.text };
  if (type === "choice") return { type, text: question.text, labels: question.type === "choice" ? question.labels
    : [{ label: "yes", description: "" }, { label: "no", description: "" }] };
  return { type, text: question.text, rubric: question.type === "score" ? question.rubric : ["", "", ""] };
}

/**
 * Keeps each action on its answer through edits: a renamed answer carries its
 * actions, a removed one drops them, and switching to or from a choice moves
 * them to the first answer or to the judge as a whole.
 */
function rebindActions(prev: JudgeQuestion, next: JudgeQuestion, effects: JudgeEffect[]): JudgeEffect[] {
  const when = (effect: JudgeEffect) => (effect as { when?: string }).when;
  const strip = (effect: JudgeEffect): JudgeEffect => { const { when: _w, ...rest } = effect as JudgeEffect & { when?: string }; return rest as JudgeEffect; };
  if (next.type !== "choice") {
    const seen = new Set<string>();
    return effects.map(strip).filter((effect) => !seen.has(effect.kind) && seen.add(effect.kind));
  }
  const labels = next.labels.map((entry) => entry.label);
  const renamed = new Map<string, string>(prev.type === "choice" && prev.labels.length === next.labels.length
    ? prev.labels.map((entry, index) => [entry.label, next.labels[index]!.label]) : []);
  return effects.flatMap((effect): JudgeEffect[] => {
    if (!isAction(effect.kind) || effect.kind === "switch-route") return [effect];
    const current = when(effect);
    const target = current === undefined ? labels[0] : renamed.get(current) ?? current;
    return target !== undefined && labels.includes(target) ? [{ ...effect, when: target } as JudgeEffect] : [];
  });
}

export default function JudgesSettings({ projectId, openJudgment, confirm = (text) => confirmAlert(text, { title: tr("judgesui.deleteTitle"), confirmLabel: tr("judgesui.delete") }) }: {
  projectId: string | null;
  openJudgment: () => void;
  confirm?: (text: string) => Promise<boolean>;
}) {
  const [snapshot, setSnapshot] = useState<JudgesSnapshot>();
  const [error, setError] = useState<unknown>();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id?: string; draft: JudgeInput; error?: string }>();
  const [backtests, setBacktests] = useState<Record<string, BacktestResult | { error: string }>>({});
  const [backtestSize, setBacktestSize] = useState(10);
  const epoch = useRef(0);
  const query = `?projectId=${encodeURIComponent(projectId ?? "")}`;

  useEffect(() => {
    const generation = ++epoch.current, controller = new AbortController();
    setSnapshot(undefined); setError(undefined); setEditing(undefined); setBacktests({});
    if (projectId) void api.get<JudgesSnapshot>(`/api/judges${query}`, { signal: controller.signal })
      .then((value) => { if (epoch.current === generation) setSnapshot(value); })
      .catch((cause: unknown) => { if (epoch.current === generation && !controller.signal.aborted) setError(cause); });
    return () => { epoch.current++; controller.abort(); };
  }, [projectId, reload]);

  /** One mutation at a time; a stale project's answer is dropped. */
  const mutate = async (run: () => Promise<JudgesSnapshot>, onError?: (text: string) => void) => {
    if (busy) return false;
    const generation = epoch.current;
    setBusy(true); setError(undefined);
    try {
      const next = await run();
      if (epoch.current === generation) setSnapshot(next);
      return true;
    } catch (cause) {
      if (epoch.current === generation) (onError ? onError(message(cause)) : setError(cause));
      return false;
    } finally { if (epoch.current === generation) setBusy(false); }
  };

  const blurb = <PageHead blurb={tr("judgesui.blurb")} />;
  if (!projectId) return <div className="judges-settings">{blurb}<EmptyState icon="circle-check" title={tr("judgesui.openProject")} /></div>;
  if (!snapshot) return <div className="judges-settings">{blurb}
    {error ? <ErrorState title={tr("judgesui.loadFailed")} error={error} onRetry={() => setReload((value) => value + 1)} />
      : <EmptyState busy compact title={tr("judgesui.loading")} />}</div>;

  const save = async () => {
    if (!editing) return;
    let judge: JudgeInput;
    try { judge = validateJudgeInput(editing.draft); }
    catch (cause) { setEditing({ ...editing, error: message(cause) }); return; }
    const body = { revision: snapshot.revision, judge };
    const ok = await mutate(() => editing.id ? api.put<JudgesSnapshot>(`/api/judges/${editing.id}${query}`, body) : api.post<JudgesSnapshot>(`/api/judges${query}`, body),
      (text) => setEditing((current) => current && { ...current, error: text }));
    if (ok) setEditing(undefined);
  };
  const remove = async (id: string) => {
    const name = snapshot.judges.find((judge) => judge.id === id)?.name ?? tr("judgesui.thisJudge");
    if (!await confirm(tr("judgesui.deleteConfirm", { name }))) return;
    const ok = await mutate(() => api.delete<JudgesSnapshot>(`/api/judges/${id}${query}&revision=${snapshot.revision}`),
      (text) => setEditing((current) => current && { ...current, error: text }));
    if (ok) setEditing(undefined);
  };
  const toggle = (judge: JudgeDefinition, enabled: boolean) => void mutate(() =>
    api.put<JudgesSnapshot>(`/api/judges/${judge.id}${query}`, { revision: snapshot.revision, judge: { ...withoutMeta(judge), enabled } }));
  const backtest = async (judge: JudgeDefinition) => {
    if (busy) return;
    const generation = epoch.current;
    setBusy(true);
    try {
      const result = await api.post<BacktestResult>(`/api/judges/${judge.id}/backtest${query}`, { limit: backtestSize });
      if (epoch.current !== generation) return;
      setBacktests((current) => ({ ...current, [judge.id]: result }));
      setSnapshot((current) => current && { ...current, usage: { ...current.usage, [judge.id]: result.usage } });
    } catch (cause) {
      if (epoch.current === generation) setBacktests((current) => ({ ...current, [judge.id]: { error: message(cause) } }));
    } finally { if (epoch.current === generation) setBusy(false); }
  };
  const editingOwner = editing?.id ? snapshot.judges.find((judge) => judge.id === editing.id)?.ownerUserId : undefined;

  return <div className="judges-settings" aria-busy={busy}>
    {blurb}
    {!snapshot.judgmentAvailable && <Notice tone="warning" heading={tr("judgesui.notRunning")}>{tr("judgesui.notRunningBody")}</Notice>}
    <Notice tone="info" actions={<Button size="sm" variant="quiet" onClick={openJudgment}>{tr("judgesui.openJudgment")}</Button>}>
      {tr("judgesui.builtinNote")}
    </Notice>
    {error !== undefined && <ErrorState compact title={tr("judgesui.wentWrong")} error={error} onRetry={() => setReload((value) => value + 1)} />}

    <Section itemId="judges.list" title={tr("judgesui.itemJudges")} hint={tr("judgesui.sectionHint")}
      action={!editing && snapshot.judges.length ? <Button size="sm" variant="quiet" disabled={busy} onClick={() => setEditing({ draft: blankJudge() })}>{tr("judgesui.addJudge")}</Button> : undefined}>
      {!snapshot.judges.length && !editing && <EmptyState compact icon="circle-check" title={tr("judgesui.noJudges")}
        body={tr("judgesui.noJudgesBody")}
        action={{ label: tr("judgesui.addJudge"), onClick: () => setEditing({ draft: blankJudge() }) }} />}
      {snapshot.judges.length > 0 && <ul className="judges-list">
        {snapshot.judges.map((judge) => {
          const used = snapshot.usage[judge.id]?.count ?? 0, full = used >= judge.dailyCap;
          const failure = snapshot.usage[judge.id]?.failure;
          const result = backtests[judge.id];
          const acts = hasActions(judge);
          return <li key={judge.id} className="judges-item" data-on={judge.enabled || undefined} data-editing={editing?.id === judge.id || undefined}>
            <div className="judges-item-main">
              <strong className="judges-item-name" id={`judge-${judge.id}`}>{judge.name}</strong>
              <Switch labelledBy={`judge-${judge.id}`} checked={judge.enabled} disabled={busy} onChange={(value) => toggle(judge, value)} />
              <span className="judges-item-question" id={`judge-${judge.id}-question`}>{judge.question.text}</span>
              <span className="judges-item-meta">
                <span>{summary(judge)}</span>
                {acts && <Badge tone={judge.ownerUserId && judge.ownerUserId === snapshot.viewer ? "accent" : "warning"}>
                  {!judge.ownerUserId ? tr("judgesui.actsForNoOne") : judge.ownerUserId === snapshot.viewer ? tr("judgesui.actsAsYou") : tr("judgesui.actsAsMember")}</Badge>}
                {failure && <Badge tone="danger">{tr("judgesui.noAnswer")}</Badge>}
                <Badge tone={full ? "warning" : "neutral"}>{full ? tr("judgesui.dailyReached", { used, cap: judge.dailyCap }) : tr("judgesui.dailyToday", { used, cap: judge.dailyCap })}</Badge>
              </span>
            </div>
            {failure && <p className="judges-item-failure" role="status">
              {tr("judgesui.lastCallNoAnswer", { time: new Date(failure.at).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" }), reason: FAILURE_COPY[failure.reason] ? tr(FAILURE_COPY[failure.reason]!) : tr("judgesui.failureReason", { reason: failure.reason }) })}</p>}
            <div className="judges-item-actions">
              <Button size="sm" variant="ghost" disabled={busy || !!editing} aria-label={tr("judgesui.editAria", { name: judge.name })}
                onClick={() => setEditing({ id: judge.id, draft: withoutMeta(judge) })}>{tr("judgesui.edit")}</Button>
              {judge.trigger === "turn-completed" && <Button size="sm" variant="ghost" disabled={busy || !snapshot.judgmentAvailable} onClick={() => void backtest(judge)}
                aria-label={tr("judgesui.backtestAria", { name: judge.name, size: backtestSize })}>{tr("judgesui.backtest")}</Button>}
            </div>
            {result && ("error" in result
              ? <Notice tone="error" role="alert" heading={tr("judgesui.backtestFailed")}>{result.error}</Notice>
              : <BacktestTable result={result} type={judge.question.type} />)}
          </li>;
        })}
      </ul>}
      {snapshot.judges.some((judge) => judge.trigger === "turn-completed") && <Row label={tr("judgesui.backtestSize")} hint={tr("judgesui.backtestSizeHint")}>
        <NumberField label={tr("judgesui.backtestSize")} value={backtestSize} min={1} max={MAX_BACKTEST} unit={tr("judgesui.unitTurns")} onCommit={setBacktestSize} disabled={busy} />
      </Row>}
    </Section>

    {editing && <JudgeEditor key={editing.id ?? "new"} value={editing.draft} error={editing.error} busy={busy} isNew={!editing.id} projectId={projectId} query={query}
      foreignOwner={!!editingOwner && editingOwner !== snapshot.viewer}
      onChange={(draft) => setEditing({ ...editing, draft, error: undefined })}
      onSave={() => void save()} onCancel={() => setEditing(undefined)}
      {...(editing.id ? { onDelete: () => void remove(editing.id!) } : {})} />}
  </div>;
}

function BacktestTable({ result, type }: { result: BacktestResult; type: JudgeQuestion["type"] }) {
  if (!result.rows.length) return <p className="judges-note"> {tr("judgesui.noCompletedTurns")}</p>;
  const fired = result.rows.filter((row) => row.wouldFire).length, skipped = result.rows.filter((row) => row.skipped).length;
  // Explicit roles keep the table semantics when narrow panes restyle rows as stacked blocks.
  return <div className="judges-backtest">
    <p className="judges-note" role="status">{skipped ? tr("judgesui.btSummarySkipped", { fired, total: result.rows.length, skipped }) : tr("judgesui.btSummary", { fired, total: result.rows.length })}</p>
    <div className="judges-table-scroll">
      <table className="judges-table" role="table">
        <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader"> {tr("judgesui.colChat")}</th><th scope="col" role="columnheader">{tr("judgesui.colAnswer")}</th>
          <th scope="col" role="columnheader" className="is-number">{tr("judgesui.colChance")}</th><th scope="col" role="columnheader">{tr("judgesui.colResult")}</th></tr></thead>
        <tbody role="rowgroup">{result.rows.map((row) => <tr role="row" key={`${row.sessionId}:${row.turnSeq}`} data-fire={row.wouldFire || undefined} data-skipped={row.skipped ? true : undefined}>
          <td role="cell" className="judges-table-title" title={row.title || undefined}>{row.title || tr("judgesui.untitledChat")}</td>
          <td role="cell" className="judges-table-answer">{row.skipped ? tr(SKIPPED[row.skipped] ?? "judgesui.noAnswer") : answerText(row.label, type)}</td>
          <td role="cell" className="is-number">{row.probability !== undefined ? percent(row.probability) : "–"}</td>
          <td role="cell" className="judges-table-result">{row.wouldDo?.length
            ? <Badge tone="accent">{tr("judgesui.would", { actions: andList(row.wouldDo.map((kind) => ACTION_COPY[kind].short)) })}</Badge>
            : row.wouldFire ? <Badge tone="accent">{tr("judgesui.wouldFire")}</Badge> : <span className="judges-table-quiet">{tr("judgesui.no")}</span>}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </div>;
}

/** A message a judge sends: a ready-made one or the person's own words. */
function MessageField({ value, onChange, label }: { value: string; onChange: (text: string) => void; label: string }) {
  const preset = MESSAGE_PRESETS.find((entry) => entry.text === value)?.id ?? "own";
  return <div className="judges-message">
    <Select label={tr("judgesui.presetAria", { label })} ariaLabel={tr("judgesui.presetAria", { label })} value={preset} searchable={false}
      options={[...MESSAGE_PRESETS.map((entry) => ({ value: entry.id, label: presetLabel(entry.id, entry.label) })), { value: "own", label: tr("judgesui.presetOwn") }]}
      onChange={(id) => { const entry = MESSAGE_PRESETS.find((candidate) => candidate.id === id); onChange(entry ? entry.text : ""); }} />
    <Textarea aria-label={label} rows={2} maxLength={MESSAGE_MAX} value={value} placeholder={tr("judgesui.messagePlaceholder")}
      onChange={(event) => onChange(event.target.value)} />
  </div>;
}

/** The actions available at one answer (or for the whole judge), with their settings. */
function ActionControls({ kinds, effects, when, onChange, name }: {
  kinds: readonly ActionKind[]; effects: JudgeEffect[]; when: string | undefined; name: string;
  onChange: (effects: JudgeEffect[]) => void;
}) {
  const find = (kind: ActionKind) => effects.find((effect) => effect.kind === kind && (effect as { when?: string }).when === when);
  const at = when !== undefined ? { when } : {};
  const replace = (kind: ActionKind, next: JudgeEffect | undefined) => {
    const rest = effects.filter((effect) => !(effect.kind === kind && (effect as { when?: string }).when === when));
    onChange(next ? [...rest, next] : rest);
  };
  const fresh = (kind: ActionKind): JudgeEffect => kind === "send-message" ? { kind, text: MESSAGE_PRESETS[0].text, ...at }
    : kind === "set-approval" ? { kind, level: "on", ...at } : { kind, ...at } as JudgeEffect;
  // One answer lets the request through or denies it, never both.
  const here = effects.filter((effect) => (effect as { when?: string }).when === when);
  const allows = here.some(approvesRequest), denies = here.some((effect) => effect.kind === "deny-request");
  const blocked = (kind: ActionKind) => (kind === "deny-request" && allows) || (kind === "approve-request" && denies);
  return <div className="judges-action-controls">
    {kinds.map((kind) => {
      const effect = find(kind);
      return <div className="judges-action" key={kind} data-on={effect ? true : undefined}>
        <Checkbox label={ACTION_COPY[kind].label} checked={!!effect} disabled={!effect && blocked(kind)}
          description={!effect && blocked(kind) ? tr(kind === "deny-request" ? "judgesui.blockedDeny" : "judgesui.blockedApprove", { description: ACTION_COPY[kind].description })
            : ACTION_COPY[kind].description}
          onChange={(on) => replace(kind, on ? fresh(kind) : undefined)} />
        {effect?.kind === "send-message" && <MessageField label={tr("judgesui.messageFor", { name })} value={effect.text}
          onChange={(text) => replace(kind, { ...effect, text })} />}
        {effect?.kind === "set-approval" && <Seg<ApprovalLevel> label={tr("judgesui.approvalFor", { name })} value={effect.level}
          options={denies ? levelOptions().filter(([level]) => level !== "all") : levelOptions()}
          onChange={(level) => replace(kind, { ...effect, level })} />}
      </div>;
    })}
  </div>;
}

/** The models a limit judge may switch to, from the person's own shortlist with live headroom. */
function RoutesPicker({ query, value, onChange, disabled }: { query: string; value: string[]; onChange: (routes: string[]) => void; disabled: boolean }) {
  const [state, setState] = useState<JudgeRoutesSnapshot | { error: string }>();
  useEffect(() => {
    const controller = new AbortController();
    void api.get<JudgeRoutesSnapshot>(`/api/judges/routes${query}`, { signal: controller.signal })
      .then(setState).catch((cause: unknown) => { if (!controller.signal.aborted) setState({ error: message(cause) }); });
    return () => controller.abort();
  }, [query]);
  if (!state) return <p className="judges-note" role="status">{tr("judgesui.loadingModels")}</p>;
  const listed = "error" in state ? [] : state.routes;
  // Allowed models the shortlist no longer shows stay listed so they can be removed.
  const extra = value.filter((key) => !listed.some((route) => route.key === key)).flatMap((key): JudgeRouteOption[] => {
    const route = parseRouteKey(key);
    return route ? [{ key, ...route, favorite: false, available: true, blocked: false }] : [];
  });
  const unlisted = new Set(extra.map((route) => route.key));
  const options = [...listed, ...extra].map((route) => ({
    id: route.key,
    label: <span className="judges-route-name">{route.harnessId} · {route.providerID}/{route.modelID}{route.runs ? ` (${route.runs})` : ""}</span>,
    description: [
      route.favorite ? tr("judgesui.routeFavorite") : "",
      route.quotaUsed !== undefined ? tr("judgesui.routeQuotaUsed", { percent: percent(route.quotaUsed) }) : "",
      route.blocked ? (route.blockedUntil ? tr("judgesui.routeLimitUntil", { when: new Date(route.blockedUntil).toLocaleString(getLocale()) }) : tr("judgesui.routeLimitReached")) : "",
      !route.available ? tr("judgesui.routeUnavailable") : "",
      unlisted.has(route.key) ? tr("judgesui.routeNotShortlisted") : "",
    ].filter(Boolean).join(" · ") || undefined,
    disabled: !value.includes(route.key) && value.length >= MAX_ROUTES,
  }));
  return <div className="judges-routes">
    {"error" in state && <Notice tone="error" role="alert" heading={tr("judgesui.routesLoadFailed")}>{state.error}</Notice>}
    {!("error" in state) && state.catalogUnavailable && <p className="judges-note">{tr("judgesui.routesCatalogUnavailable")}</p>}
    {options.length ? <CheckGroup label={tr("judgesui.routesAllowed")} value={value} options={options} onChange={onChange} disabled={disabled} />
      : <p className="judges-note">{tr("judgesui.routesEmpty")}</p>}
  </div>;
}

/** The model that answers this judge: the owner's Small Model, or one from their shortlist. */
function ModelSelect({ query, value, onChange, disabled }: { query: string; value: string | undefined; onChange: (model: string | undefined) => void; disabled: boolean }) {
  const [routes, setRoutes] = useState<JudgeRouteOption[]>();
  useEffect(() => {
    const controller = new AbortController();
    void api.get<JudgeRoutesSnapshot>(`/api/judges/routes${query}`, { signal: controller.signal })
      .then((state) => setRoutes(state.routes ?? [])).catch(() => { if (!controller.signal.aborted) setRoutes([]); });
    return () => controller.abort();
  }, [query]);
  const listed = routes ?? [];
  const current = value && !listed.some((route) => route.key === value) ? parseRouteKey(value) : undefined;
  const label = (route: { harnessId: string; providerID: string; modelID: string }) => `${route.harnessId} · ${route.providerID}/${route.modelID}`;
  return <Select label={tr("judgesui.answeredBy")} ariaLabel={tr("judgesui.answeredBy")} disabled={disabled || !routes} value={value ?? ""}
    options={[{ value: "", label: tr("judgesui.smallModelOwn") },
      ...listed.map((route) => ({ value: route.key, label: label(route) })),
      ...(current && value ? [{ value, label: tr("judgesui.modelNotShortlisted", { label: label(current) }) }] : [])]}
    onChange={(next) => onChange(next || undefined)} />;
}

function JudgeEditor({ value, error, busy, isNew, projectId, query, foreignOwner, onChange, onSave, onCancel, onDelete }: {
  value: JudgeInput; error?: string; busy: boolean; isNew: boolean; projectId: string; query: string; foreignOwner: boolean;
  onChange: (next: JudgeInput) => void; onSave: () => void; onCancel: () => void; onDelete?: () => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  // The editor opens below the list: bring it into view and start at its first field.
  useEffect(() => {
    const node = root.current;
    node?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    node?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  }, []);
  const q = value.question;
  const set = (patch: Partial<JudgeInput>) => onChange({ ...value, ...patch });
  const setQuestion = (question: JudgeQuestion) => {
    const fire = { ...value.fire };
    if (question.type === "choice") fire.label = question.labels.some((entry) => entry.label === fire.label) ? fire.label : undefined;
    else delete fire.label;
    if (question.type === "choice" && fire.label === undefined && value.effects.some((effect) => !isAction(effect.kind))) fire.label = question.labels[0]?.label;
    set({ question, fire, effects: rebindActions(value.question, question, value.effects) });
  };
  const setTrigger = (trigger: JudgeTrigger) => {
    const fresh = blankJudge(trigger);
    onChange({ ...fresh, name: value.name, enabled: value.enabled, filters: value.filters, dailyCap: value.dailyCap, ...(value.model ? { model: value.model } : {}) });
  };
  const picks = TRIGGER_EVIDENCE[value.trigger];
  const pick = (name: EvidencePick) => value.evidence.find((entry) => entry.pick === name);
  const togglePick = (name: EvidencePick, on: boolean) => set({ evidence: on
    ? EVIDENCE_PICKS.flatMap((p) => p === name ? [{ pick: p, maxChars: EVIDENCE_CHARS.default }] : value.evidence.filter((entry) => entry.pick === p))
    : value.evidence.filter((entry) => entry.pick !== name) });
  const displayKinds = DISPLAY_EFFECTS.filter((kind) => TRIGGER_EFFECTS[value.trigger].includes(kind));
  const actionKinds = TRIGGER_EFFECTS[value.trigger].filter((kind): kind is ActionKind => isAction(kind) && kind !== "switch-route");
  const display = (kind: DisplayEffectKind) => value.effects.find((entry) => entry.kind === kind);
  const toggleDisplay = (kind: DisplayEffectKind, on: boolean) => {
    const effects = on ? [...value.effects, kind === "suggest-follow-up" ? { kind, text: "" } : { kind }] as JudgeEffect[]
      : value.effects.filter((entry) => entry.kind !== kind);
    const fire = { ...value.fire };
    if (q.type === "choice" && on && fire.label === undefined) fire.label = q.labels[0]?.label;
    set({ effects, fire });
  };
  const followUp = display("suggest-follow-up");
  const sends = value.effects.some((effect) => effect.kind === "send-message");
  const acts = value.effects.some((effect) => isAction(effect.kind));

  return <Section itemId="judges.editor" title={isNew ? tr("judgesui.editorNew") : tr("judgesui.editorEdit")} hint={tr("judgesui.editorHint")}>
    <div className="judges-editor" aria-label={isNew ? tr("judgesui.editorNew") : tr("judgesui.editorEdit")} role="group" ref={root}>
      <FormField label={tr("judgesui.fieldName")}>{(field) => <TextInput {...field} value={value.name} maxLength={80} disabled={busy}
        onChange={(event) => set({ name: event.target.value })} />}</FormField>
      <Row label={tr("judgesui.fieldAsks")} hint={TRIGGER_COPY[value.trigger].hint}>
        <Seg<JudgeTrigger> label={tr("judgesui.fieldAsks")} disabled={busy} value={value.trigger} options={triggerKinds()} onChange={setTrigger} />
      </Row>
      <Row label={tr("judgesui.fieldAppliesTo")} hint={TRIGGER_COPY[value.trigger].scope}>
        <Seg<"all" | "project"> label={tr("judgesui.fieldAppliesTo")} disabled={busy} value={value.filters.projectId ? "project" : "all"}
          options={[["all", tr("judgesui.allProjects")], ["project", tr("judgesui.thisProject")]]}
          onChange={(next) => set({ filters: next === "project" ? { projectId } : {} })} />
      </Row>

      <Row label={tr("judgesui.answeredBy")} hint={tr("judgesui.answeredByHint")}>
        <ModelSelect query={query} value={value.model} disabled={busy}
          onChange={(model) => { const { model: _model, ...rest } = value; onChange(model ? { ...rest, model } : rest); }} />
      </Row>

      {q.type === "route" ? <>
        <FormField label={tr("judgesui.fieldInstructions")} hint={tr("judgesui.instructionsHint")}>{(field) =>
          <Textarea {...field} value={q.text} maxLength={600} rows={2} disabled={busy} onChange={(event) => setQuestion({ type: "route", text: event.target.value })} />}</FormField>
        <fieldset className="judges-options" disabled={busy}>
          <legend>{tr("judgesui.routesAllowed")}</legend>
          <p className="judges-note">{tr("judgesui.routesUpTo", { max: MAX_ROUTES })}</p>
          <RoutesPicker query={query} value={value.routes ?? []} disabled={busy} onChange={(routes) => set({ routes })} />
        </fieldset>
      </> : <>
        <Row label={tr("judgesui.fieldQuestionType")} hint={tr("judgesui.questionTypeHint")}>
          <Seg<Exclude<JudgeQuestion["type"], "route">> label={tr("judgesui.fieldQuestionType")} disabled={busy} value={q.type} options={questionKinds()} onChange={(type) => setQuestion(retype(q, type))} />
        </Row>
        <FormField label={tr("judgesui.fieldQuestion")} hint={tr("judgesui.questionHint")}>{(field) => <Textarea {...field} value={q.text} maxLength={600}
          rows={2} disabled={busy} onChange={(event) => setQuestion({ ...q, text: event.target.value })} />}</FormField>
      </>}
      {q.type === "choice" && <fieldset className="judges-options" disabled={busy}>
        <legend>{tr("judgesui.answersLegend")}</legend>
        <p className="judges-note">{tr("judgesui.answersNote", { example: "\u0000" }).split("\u0000").flatMap((part, index) => index === 0 ? [part] : [<code key="example">unfinished</code>, part])}</p>
        <div className="judges-option-head" aria-hidden="true"><span>{tr("judgesui.headName")}</span><span>{tr("judgesui.headMeans")}</span></div>
        {q.labels.map((entry, index) => <div className="judges-option" key={index}>
          <TextInput aria-label={tr("judgesui.answerNameAria", { n: index + 1 })} value={entry.label} maxLength={32} placeholder={`answer_${index + 1}`} className="judges-option-name"
            onChange={(event) => setQuestion({ ...q, labels: q.labels.map((item, i) => i === index ? { ...item, label: event.target.value.toLowerCase() } : item) })} />
          <Textarea aria-label={tr("judgesui.answerMeaningAria", { n: index + 1 })} value={entry.description} maxLength={300} placeholder={tr("judgesui.answerMeaningPlaceholder")} className="judges-option-meaning" rows={1}
            onChange={(event) => setQuestion({ ...q, labels: q.labels.map((item, i) => i === index ? { ...item, description: event.target.value } : item) })} />
          <Button size="sm" variant="ghost" disabled={q.labels.length <= 2} aria-label={tr("judgesui.removeAnswerAria", { n: index + 1 })}
            onClick={() => setQuestion({ ...q, labels: q.labels.filter((_, i) => i !== index) })}>{tr("judgesui.remove")}</Button>
        </div>)}
        <Button size="sm" variant="quiet" disabled={q.labels.length >= 8}
          onClick={() => setQuestion({ ...q, labels: [...q.labels, { label: `answer_${q.labels.length + 1}`, description: "" }] })}>{tr("judgesui.addAnswer")}</Button>
      </fieldset>}
      {q.type === "score" && <fieldset className="judges-options" disabled={busy}>
        <legend>{tr("judgesui.scoreLegend")}</legend>
        <p className="judges-note">{tr("judgesui.scoreNote")}</p>
        {q.rubric.map((level, index) => <div className="judges-option is-level" key={index}>
          <span className="judges-level-index" aria-hidden="true">{index}</span>
          <TextInput aria-label={tr("judgesui.levelN", { n: index + 1 })} value={level} maxLength={300} placeholder={tr("judgesui.levelN", { n: index + 1 })}
            onChange={(event) => setQuestion({ ...q, rubric: q.rubric.map((item, i) => i === index ? event.target.value : item) })} />
          <Button size="sm" variant="ghost" disabled={q.rubric.length <= 2} aria-label={tr("judgesui.removeLevelAria", { n: index + 1 })}
            onClick={() => setQuestion({ ...q, rubric: q.rubric.filter((_, i) => i !== index) })}>{tr("judgesui.remove")}</Button>
        </div>)}
        <Button size="sm" variant="quiet" disabled={q.rubric.length >= 8} onClick={() => setQuestion({ ...q, rubric: [...q.rubric, ""] })}>{tr("judgesui.addLevel")}</Button>
      </fieldset>}

      <fieldset className="judges-options" disabled={busy}>
        <legend>{tr("judgesui.evidenceLegend")}</legend>
        <p className="judges-note">{value.trigger === "limit-reached"
          ? tr("judgesui.evidenceNoteLimit")
          : tr("judgesui.evidenceNote")}</p>
        {picks.map((name) => {
          const entry = pick(name), required = value.trigger === "permission-requested" && name === "permission-request";
          return <div className="judges-pick" key={name}>
            <Checkbox label={evidenceLabel(name)} checked={!!entry} disabled={required} onChange={(on) => togglePick(name, on)}
              {...(required ? { description: tr("judgesui.evAlwaysSent") } : {})} />
            {entry && <NumberField label={tr("judgesui.evLengthAria", { label: evidenceLabel(name) })} value={entry.maxChars} min={EVIDENCE_CHARS.min} max={EVIDENCE_CHARS.max} step={50} unit={tr("judgesui.unitCharacters")} width="md"
              onCommit={(maxChars) => set({ evidence: value.evidence.map((item) => item.pick === name ? { ...item, maxChars } : item) })} />}
          </div>;
        })}
      </fieldset>

      <Row label={q.type === "score" ? tr("judgesui.firesScore") : tr("judgesui.firesChance")} hint={q.type === "score" ? tr("judgesui.firesScoreHint") : tr("judgesui.firesChanceHint")}>
        <NumberField label={tr("judgesui.threshold")} value={Math.round(value.fire.threshold * 100)} min={0} max={100} unit="%" disabled={busy}
          onCommit={(next) => set({ fire: { ...value.fire, threshold: next / 100 } })} />
      </Row>
      {q.type !== "score" && <Row label={tr("judgesui.minLead")} hint={tr("judgesui.minLeadHint")}>
        <NumberField label={tr("judgesui.minLead")} value={Math.round(value.fire.margin * 100)} min={0} max={100} unit="%" disabled={busy}
          onCommit={(next) => set({ fire: { ...value.fire, margin: next / 100 } })} />
      </Row>}

      <fieldset className="judges-options" disabled={busy}>
        <legend>{tr("judgesui.showLegend")}</legend>
        <p className="judges-safe"><Icon icon={ShieldIcon} size="sm" /><span>{tr("judgesui.markersSafe")}</span></p>
        {q.type === "choice" && value.fire.label !== undefined && <Row label={tr("judgesui.shownOn")} hint={tr("judgesui.shownOnHint")}>
          <Select label={tr("judgesui.shownOn")} ariaLabel={tr("judgesui.shownOn")} disabled={busy} value={value.fire.label}
            options={q.labels.filter((entry) => entry.label).map((entry) => ({ value: entry.label, label: entry.label }))}
            onChange={(label) => set({ fire: { ...value.fire, label } })} />
        </Row>}
        {displayKinds.map((kind) => <Checkbox key={kind} label={DISPLAY_COPY[kind].label} checked={!!display(kind)} onChange={(on) => toggleDisplay(kind, on)}
          description={DISPLAY_COPY[kind].description} />)}
        {followUp && followUp.kind === "suggest-follow-up" && <FormField label={tr("judgesui.followText")} hint={tr("judgesui.followTextHint")}>{(field) => <Textarea {...field} rows={2} maxLength={FOLLOW_UP_MAX}
          value={followUp.text} onChange={(event) => set({ effects: value.effects.map((entry) => entry.kind === "suggest-follow-up" ? { kind: entry.kind, text: event.target.value } : entry) })} />}</FormField>}
      </fieldset>

      <fieldset className="judges-options judges-act" disabled={busy}>
        <legend>{tr("judgesui.actLegend")}</legend>
        <Notice tone="warning" heading={tr("judgesui.accessHeading")}>
          {tr("judgesui.accessBody", { note: foreignOwner ? tr("judgesui.accessNoteForeign") : tr("judgesui.accessNoteOwn") })}
        </Notice>
        {q.type === "route" ? <p className="judges-note">{tr("judgesui.routeActionNote", { description: ACTION_COPY["switch-route"].description })}</p>
          : q.type === "choice" ? <>
            <p className="judges-note">{tr("judgesui.choiceActionsNote")}</p>
            {q.labels.filter((entry) => entry.label).map((entry) => <div className="judges-answer-actions" key={entry.label}>
              <code className="judges-answer-name">{entry.label}</code>
              <ActionControls kinds={actionKinds} effects={value.effects} when={entry.label} name={entry.label} onChange={(effects) => set({ effects })} />
            </div>)}
          </> : <ActionControls kinds={actionKinds} effects={value.effects} when={undefined} name={tr("judgesui.thisJudge")} onChange={(effects) => set({ effects })} />}
        {sends && <Row label={tr("judgesui.messagesInRow")} hint={tr("judgesui.messagesInRowHint")}>
          <NumberField label={tr("judgesui.messagesInRow")} value={value.maxRounds ?? ROUNDS.default} min={ROUNDS.min} max={ROUNDS.max} unit={tr("judgesui.unitMessages")} width="md" disabled={busy}
            onCommit={(maxRounds) => set({ maxRounds })} />
        </Row>}
        {!acts && q.type !== "route" && <p className="judges-note">{tr("judgesui.noActions")}</p>}
      </fieldset>

      <Row label={tr("judgesui.dailyLimit")} hint={tr("judgesui.dailyLimitHint")}>
        <NumberField label={tr("judgesui.dailyLimit")} value={value.dailyCap ?? DEFAULT_DAILY_CAP} min={1} max={MAX_DAILY_CAP} unit={tr("judgesui.unitCalls")} width="md" disabled={busy}
          onCommit={(dailyCap) => set({ dailyCap })} />
      </Row>
      {error && <Notice tone="error" role="alert" id={`${id}-error`} heading={tr("judgesui.saveFailed")}>{error}</Notice>}
      <SaveBar dirty saving={busy} onSave={onSave} onDiscard={onCancel} saveLabel={isNew ? tr("judgesui.addJudge") : tr("judgesui.saveJudge")} />
      {onDelete && <div className="judges-editor-danger">
        <span className="judges-note">{tr("judgesui.markersStay")}</span>
        <Button size="sm" variant="danger" disabled={busy} onClick={onDelete}>{tr("judgesui.deleteJudge")}</Button>
      </div>}
    </div>
  </Section>;
}
