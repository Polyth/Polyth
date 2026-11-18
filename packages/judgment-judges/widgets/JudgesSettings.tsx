// Settings → Judges. One place for everything that judges a chat: a short
// guide, the person's judges (a new Space starts with the starter judges,
// switched off, under a note that they are a starting point and not a
// recommendation), and the built-in judges Settings → Judgment tunes. A judge
// opens as a detail view; "Add judge" starts from a template or a blank judge.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createApiTransport } from "@polyth/web-sdk";
import { getLocale, tr } from "@polyth/web/i18n";
import { AddIcon, Badge, Button, confirmAlert, Notice, Switch } from "@polyth/web/ui";
import { EmptyState, ErrorState, ItemList, ItemRow, PageHead, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import type { StarterTemplate } from "../src/starters.ts";
import {
  blankJudge, hasActions, MAX_JUDGES, validateJudgeInput,
  type BacktestResult, type JudgeDefinition, type JudgeInput, type JudgesSnapshot,
} from "../src/types.ts";
import { judgeErrorMessage } from "./judgeErrors.ts";
import JudgeEditor from "./JudgeEditor.tsx";
import JudgesGuide from "./JudgesGuide.tsx";
import { BUILTIN_COPY, doesSummary, judgeCategory, judgeIcon, JudgeTile, whenText } from "./judgeKinds.tsx";
import StarterGallery from "./StarterGallery.tsx";

type Key = Parameters<typeof tr>[0];
const api = createApiTransport();
const message = (error: unknown) => judgeErrorMessage(error instanceof Error ? error.message : String(error));
const withoutMeta = ({ id: _id, createdAt: _c, updatedAt: _u, ownerUserId: _o, starter: _s, ...input }: JudgeDefinition): JudgeInput => structuredClone(input);
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

type View =
  | { kind: "list" }
  | { kind: "gallery" }
  | { kind: "edit"; id?: string; draft: JudgeInput; initial?: JudgeInput; error?: string; template?: string };

export default function JudgesSettings({ projectId, openJudgment,
  confirm = (text) => confirmAlert(text, { title: tr("judgesui.deleteTitle"), confirmLabel: tr("judgesui.delete") }),
  confirmAct = (text) => confirmAlert(text, { title: tr("judgesui.actConfirmTitle"), confirmLabel: tr("judgesui.actConfirmLabel") }) }: {
  projectId: string | null;
  openJudgment: () => void;
  confirm?: (text: string) => Promise<boolean>;
  /** Asked before the switch lends the person's access to a judge that acts and is not theirs yet. */
  confirmAct?: (text: string) => Promise<boolean>;
}) {
  const [snapshot, setSnapshot] = useState<JudgesSnapshot>();
  const [error, setError] = useState<unknown>();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>({ kind: "list" });
  const [backtests, setBacktests] = useState<Record<string, BacktestResult | { error: string }>>({});
  const [backtestSize, setBacktestSize] = useState(10);
  const epoch = useRef(0);
  const seeding = useRef(false);
  const query = `?projectId=${encodeURIComponent(projectId ?? "")}`;

  useEffect(() => {
    const generation = ++epoch.current, controller = new AbortController();
    setSnapshot(undefined); setError(undefined); setView({ kind: "list" }); setBacktests({});
    const keep = (value: JudgesSnapshot) => { if (epoch.current === generation) setSnapshot(value); };
    if (projectId) void api.get<JudgesSnapshot>(`/api/judges${query}`, { signal: controller.signal })
      // A Space that never saved a judge starts with the starters, in the person's language. The server adds them only while nothing was saved.
      .then(async (value) => {
        if (!value.fresh || seeding.current) return keep(value);
        seeding.current = true;
        try { keep(await api.post<JudgesSnapshot>(`/api/judges/starters${query}`, { locale: getLocale() }, { signal: controller.signal })); }
        catch { keep(value); }
        finally { seeding.current = false; }
      })
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

  const editing = view.kind === "edit" ? view : undefined;
  const setEditError = (text: string) => setView((current) => current.kind === "edit" ? { ...current, error: text } : current);
  const save = async () => {
    if (!editing) return;
    let judge: JudgeInput;
    try { judge = validateJudgeInput(editing.draft); }
    catch (cause) { setEditError(message(cause)); return; }
    const body = { revision: snapshot.revision, judge };
    const ok = await mutate(() => editing.id ? api.put<JudgesSnapshot>(`/api/judges/${editing.id}${query}`, body) : api.post<JudgesSnapshot>(`/api/judges${query}`, body), setEditError);
    if (ok) setView({ kind: "list" });
  };
  const remove = async (id: string) => {
    const name = snapshot.judges.find((judge) => judge.id === id)?.name ?? tr("judgesui.thisJudge");
    if (!await confirm(tr("judgesui.deleteConfirm", { name }))) return;
    const ok = await mutate(() => api.delete<JudgesSnapshot>(`/api/judges/${id}${query}&revision=${snapshot.revision}`), setEditError);
    if (ok) setView({ kind: "list" });
  };
  const toggle = async (judge: JudgeDefinition, enabled: boolean) => {
    // Turning on a judge that acts lends it the person's access at once: say so first, unless it already acts as them.
    if (enabled && hasActions(judge) && judge.ownerUserId !== snapshot.viewer && !await confirmAct(tr("judgesui.actConfirmBody", { name: judge.name }))) return;
    await mutate(() => api.put<JudgesSnapshot>(`/api/judges/${judge.id}${query}`, { revision: snapshot.revision, judge: { ...withoutMeta(judge), enabled } }));
  };
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

  /** Who an acting judge works for, said only where it matters: a judge that is on, or one someone saved. */
  const accessBadge = (judge: JudgeDefinition): ReactNode => {
    if (!hasActions(judge) || (!judge.enabled && !judge.ownerUserId)) return null;
    if (!judge.ownerUserId) return <Badge tone="warning">{tr("judgesui.actsForNoOne")}</Badge>;
    return <Badge tone={judge.ownerUserId === snapshot.viewer ? "accent" : "warning"}>
      {judge.ownerUserId === snapshot.viewer ? tr("judgesui.actsAsYou") : tr("judgesui.actsAsMember")}</Badge>;
  };
  const badges = (judge: JudgeDefinition, withWhen: boolean) => {
    const used = snapshot.usage[judge.id]?.count ?? 0, full = used >= judge.dailyCap;
    return <>
      {judge.starter && <Badge tone="neutral">{tr("judgesui.starterBadge")}</Badge>}
      {withWhen && <span className="judges-row-when">{whenText(judge.trigger)} · {doesSummary(judge)}</span>}
      {accessBadge(judge)}
      {snapshot.usage[judge.id]?.failure && <Badge tone="danger">{tr("judgesui.noAnswer")}</Badge>}
      {full && <Badge tone="warning">{tr("judgesui.dailyFull")}</Badge>}
    </>;
  };
  const open = (judge: JudgeDefinition) => setView({ kind: "edit", id: judge.id, draft: withoutMeta(judge), initial: withoutMeta(judge) });

  if (editing) {
    const saved = editing.id ? snapshot.judges.find((judge) => judge.id === editing.id) : undefined;
    return <div className="judges-settings" aria-busy={busy}>
      <JudgeEditor key={editing.id ?? editing.template ?? "new"} value={editing.draft} {...(editing.initial ? { initial: editing.initial } : {})}
        {...(editing.error ? { error: editing.error } : {})} busy={busy} isNew={!editing.id} projectId={projectId} query={query}
        foreignOwner={!!saved?.ownerUserId && saved.ownerUserId !== snapshot.viewer}
        starter={!!saved?.starter || !!editing.template}
        {...(saved && snapshot.usage[saved.id] ? { usage: snapshot.usage[saved.id] } : {})}
        {...(saved ? { badges: badges(saved, false) } : {})}
        {...(saved && saved.trigger === "turn-completed" ? { backtest: {
          ...(backtests[saved.id] ? { result: backtests[saved.id] } : {}), size: backtestSize, setSize: setBacktestSize,
          run: () => void backtest(saved), disabled: busy || !snapshot.judgmentAvailable } } : {})}
        onChange={(draft) => setView({ ...editing, draft, error: undefined })}
        onSave={() => void save()} onBack={() => setView({ kind: "list" })}
        {...(editing.id ? { onDelete: () => void remove(editing.id!) } : {})} />
    </div>;
  }

  const inList = new Set(snapshot.judges.flatMap((judge) => judge.starter ? [judge.starter] : []));
  if (view.kind === "gallery") return <div className="judges-settings">
    <StarterGallery inList={inList} onBack={() => setView({ kind: "list" })}
      onBlank={() => setView({ kind: "edit", draft: blankJudge() })}
      onPick={(starter: StarterTemplate, draft) => setView({ kind: "edit", draft: { ...draft, enabled: true }, template: starter.id })} />
  </div>;

  const anyOn = snapshot.judges.some((judge) => judge.enabled) || (snapshot.builtins ?? []).some((builtin) => builtin.enabled);
  const starters = snapshot.judges.filter((judge) => judge.starter);
  const full = snapshot.judges.length >= MAX_JUDGES;
  const add = <Button size="sm" variant="quiet" iconStart={AddIcon} disabled={busy || full} onClick={() => setView({ kind: "gallery" })}>{tr("judgesui.addJudge")}</Button>;
  return <div className="judges-settings" aria-busy={busy}>
    {blurb}
    {!snapshot.judgmentAvailable && <Notice tone="warning" heading={tr("judgesui.notRunning")}>{tr("judgesui.notRunningBody")}</Notice>}
    <JudgesGuide defaultOpen={!anyOn} />
    {error !== undefined && <ErrorState compact title={tr("judgesui.wentWrong")} error={error} onRetry={() => setReload((value) => value + 1)} />}

    <Section itemId="judges.list" title={tr("judgesui.itemJudges")} hint={tr("judgesui.sectionHint")} action={snapshot.judges.length ? add : undefined}>
      {starters.length > 0 && <Notice className="judges-starter-notice" tone="info" heading={tr("judgesui.startersHeading")}>{tr("judgesui.startersBody")}</Notice>}
      {!snapshot.judges.length && <EmptyState compact icon="circle-check" title={tr("judgesui.noJudges")} body={tr("judgesui.noJudgesBody")}
        action={{ label: tr("judgesui.addJudge"), onClick: () => setView({ kind: "gallery" }) }} />}
      {snapshot.judges.length > 0 && <ItemList label={tr("judgesui.itemJudges")} className="judges-list">
        {snapshot.judges.map((judge) => {
          const failure = snapshot.usage[judge.id]?.failure;
          const category = judgeCategory(judge);
          return <ItemRow key={judge.id} className="judges-row" data-judge={judge.id} inactive={!judge.enabled}
            icon={<JudgeTile icon={judgeIcon(judge, category)} category={category} />}
            title={judge.name} meta={badges(judge, true)}
            description={judge.description ?? judge.question.text}
            {...(failure ? { error: tr("judgesui.lastCallNoAnswer", {
              time: new Date(failure.at).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" }),
              reason: FAILURE_COPY[failure.reason] ? tr(FAILURE_COPY[failure.reason]!) : tr("judgesui.failureReason", { reason: failure.reason }) }) } : {})}
            trailing={<Switch label={tr("judgesui.switchAria", { name: judge.name })} checked={judge.enabled} disabled={busy} onChange={(value) => void toggle(judge, value)} />}
            onOpen={() => open(judge)} openLabel={tr("judgesui.editAria", { name: judge.name })} />;
        })}
      </ItemList>}
      {full && <p className="judges-note">{tr("judgesui.listFull", { max: MAX_JUDGES })}</p>}
    </Section>

    {snapshot.builtins && snapshot.builtins.length > 0 && <Section itemId="judges.builtins" title={tr("judgesui.builtinsTitle")} hint={tr("judgesui.builtinsHint")}>
      <ItemList label={tr("judgesui.builtinsTitle")} className="judges-list">
        {snapshot.builtins.map((builtin) => {
          const known = BUILTIN_COPY[builtin.id];
          if (!known) return null;
          return <ItemRow key={builtin.id} className="judges-row" inactive={!builtin.enabled}
            icon={<JudgeTile icon={known.icon} category={known.category} />}
            title={tr(known.title)} description={tr(known.description)}
            meta={<Badge tone={builtin.enabled ? "success" : "neutral"} dot={builtin.enabled}>{builtin.enabled ? tr("judgesui.builtinOn") : tr("judgesui.builtinOff")}</Badge>}
            onOpen={openJudgment} openLabel={tr("judgesui.builtinOpenAria", { name: tr(known.title) })} />;
        })}
      </ItemList>
    </Section>}
  </div>;
}
