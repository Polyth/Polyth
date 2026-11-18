// One judge, opened from the list or started from a template: a detail view
// with its three facts at the top (when, asks, does), then the settings in
// that order, the rarely changed ones folded under "More settings", and a
// backtest for a saved turn judge. Nothing is saved until Save.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createApiTransport } from "@polyth/web-sdk";
import { getLocale, tr } from "@polyth/web/i18n";
import { BackIcon, Badge, Button, Checkbox, Icon, Notice, Select, ShieldIcon, TextInput, Textarea } from "@polyth/web/ui";
import { CheckGroup, DisclosureRow, FormField, ItemList, NumberField, Row, SaveBar, Section, Seg } from "../../../apps/web/src/components/settings/parts.tsx";
import {
  approvesRequest, blankJudge, DEFAULT_DAILY_CAP, DESCRIPTION_MAX, DISPLAY_EFFECTS, EVIDENCE_CHARS, EVIDENCE_PICKS, FOLLOW_UP_MAX, isAction, MAX_BACKTEST,
  MAX_DAILY_CAP, MAX_ROUTES, MESSAGE_MAX, MESSAGE_PRESETS, parseRouteKey, ROUNDS, TRIGGER_EFFECTS, TRIGGER_EVIDENCE,
  type ActionKind, type ApprovalLevel, type BacktestResult, type DisplayEffectKind, type EvidencePick, type JudgeEffect, type JudgeFire, type JudgeInput,
  type JudgeQuestion, type JudgeRouteOption, type JudgeRoutesSnapshot, type JudgeTrigger, type JudgeUsage,
} from "../src/types.ts";
import { judgeErrorMessage } from "./judgeErrors.ts";
import { JudgeGlance, judgeCategory, judgeIcon, JudgeTile } from "./judgeKinds.tsx";

type Key = Parameters<typeof tr>[0];
const api = createApiTransport();
const message = (error: unknown) => judgeErrorMessage(error instanceof Error ? error.message : String(error));
const percent = (value: number) => `${Math.round(value * 100)}%`;
const andList = (items: string[]) => items.join(tr("judgesui.listAnd"));
const questionKinds = (): Array<[Exclude<JudgeQuestion["type"], "route">, string]> => [["noul", tr("judgesui.qNoul")], ["choice", tr("judgesui.qChoice")], ["score", tr("judgesui.qScore")]];
const triggerKinds = (): Array<[JudgeTrigger, string]> => [["turn-completed", tr("judgesui.trigTurn")], ["permission-requested", tr("judgesui.trigPermission")], ["limit-reached", tr("judgesui.trigLimit")]];
const TRIGGER_HINT: Record<JudgeTrigger, Key> = { "turn-completed": "judgesui.trigTurnHint", "permission-requested": "judgesui.trigPermissionHint", "limit-reached": "judgesui.trigLimitHint" };
const TRIGGER_SCOPE: Record<JudgeTrigger, Key> = { "turn-completed": "judgesui.trigTurnScope", "permission-requested": "judgesui.trigPermissionScope", "limit-reached": "judgesui.trigLimitScope" };
const EVIDENCE_KEYS: Record<EvidencePick, Key> = {
  "last-request": "judgesui.evLastRequest", "last-answer": "judgesui.evLastAnswer", "commands-run": "judgesui.evCommands",
  "changed-files": "judgesui.evChangedFiles", "open-todos": "judgesui.evOpenTodos", "permission-request": "judgesui.evPermission",
};
const evidenceLabel = (pick: EvidencePick) => tr(EVIDENCE_KEYS[pick]);
const PRESET_KEYS: Record<string, Key> = { continue: "judgesui.presetContinue", "fix-remaining": "judgesui.presetFix", refine: "judgesui.presetRefine", audit: "judgesui.presetAudit" };
const presetLabel = (id: string, fallback: string) => PRESET_KEYS[id] ? tr(PRESET_KEYS[id]) : fallback;
const copy = (label: Key, description: Key) => ({ get label() { return tr(label); }, get description() { return tr(description); } });
/** Markers in the person's words: what they will see. */
const DISPLAY_COPY: Record<DisplayEffectKind, { label: string; description: string }> = {
  "timeline-marker": copy("judgesui.dispMarkLabel", "judgesui.dispMarkDesc"),
  "needs-attention": copy("judgesui.dispAttentionLabel", "judgesui.dispAttentionDesc"),
  "suggest-follow-up": copy("judgesui.dispFollowLabel", "judgesui.dispFollowDesc"),
};
/** Actions in the person's words: what the judge will do with their access. */
export const ACTION_COPY: Record<ActionKind, { label: string; description: string; short: string }> = {
  "send-message": { ...copy("judgesui.actSendLabel", "judgesui.actSendDesc"), get short() { return tr("judgesui.actSendShort"); } },
  "merge-isolated": { ...copy("judgesui.actMergeLabel", "judgesui.actMergeDesc"), get short() { return tr("judgesui.actMergeShort"); } },
  "approve-request": { ...copy("judgesui.actApproveLabel", "judgesui.actApproveDesc"), get short() { return tr("judgesui.actApproveShort"); } },
  "deny-request": { ...copy("judgesui.actDenyLabel", "judgesui.actDenyDesc"), get short() { return tr("judgesui.actDenyShort"); } },
  "set-approval": { ...copy("judgesui.actApprovalLabel", "judgesui.actApprovalDesc"), get short() { return tr("judgesui.actApprovalShort"); } },
  "switch-route": { ...copy("judgesui.actRouteLabel", "judgesui.actRouteDesc"), get short() { return tr("judgesui.actRouteShort"); } },
};
const levelOptions = (): Array<[ApprovalLevel, string]> => [["on", tr("judgesui.levelOn")], ["all", tr("judgesui.levelAll")], ["off", tr("judgesui.levelOff")]];
/** Yes-or-no answers are Judgment's own words; choice labels are the person's and stay as written. */
const answerText = (label: string | undefined, type: JudgeQuestion["type"]) => type === "noul"
  ? ({ yes: tr("judgesui.yes"), no: tr("judgesui.no"), cannot_tell: tr("judgesui.cantTell") } as Record<string, string>)[label ?? ""] ?? label ?? "" : label ?? "";
const SKIPPED: Record<string, Key> = { cap: "judgesui.skipCap", timeout: "judgesui.skipTimeout", cancelled: "judgesui.skipCancelled", "budget-exhausted": "judgesui.skipTimeout" };

/**
 * How sure a judge must be, as three named steps; anything else is the
 * person's own numbers. A step sets the chance and the lead over the next
 * answer together.
 */
export const SURENESS = {
  cautious: { threshold: 0.9, margin: 0.4 },
  balanced: { threshold: 0.8, margin: 0.3 },
  eager: { threshold: 0.7, margin: 0.2 },
} as const;
export type Sureness = keyof typeof SURENESS | "custom";
export const surenessOf = (fire: Pick<JudgeFire, "threshold" | "margin">): Sureness =>
  (Object.entries(SURENESS).find(([, step]) => Math.abs(step.threshold - fire.threshold) < 1e-9 && Math.abs(step.margin - fire.margin) < 1e-9)?.[0] as Sureness | undefined) ?? "custom";
const surenessOptions = (): Array<[Sureness, string]> => [["cautious", tr("judgesui.sureCautious")], ["balanced", tr("judgesui.sureBalanced")], ["eager", tr("judgesui.sureEager")], ["custom", tr("judgesui.sureCustom")]];

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

export function BacktestTable({ result, type }: { result: BacktestResult; type: JudgeQuestion["type"] }) {
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

/** The person's model shortlist, read once per editor for both the answering model and a limit judge's routes. */
function useRoutes(query: string) {
  const [state, setState] = useState<JudgeRoutesSnapshot | { error: string }>();
  useEffect(() => {
    const controller = new AbortController();
    void api.get<JudgeRoutesSnapshot>(`/api/judges/routes${query}`, { signal: controller.signal })
      .then(setState).catch((cause: unknown) => { if (!controller.signal.aborted) setState({ error: message(cause) }); });
    return () => controller.abort();
  }, [query]);
  return state;
}
const routeName = (route: { harnessId: string; providerID: string; modelID: string }) => `${route.harnessId} · ${route.providerID}/${route.modelID}`;

/** The models a limit judge may switch to, from the person's own shortlist with live headroom. */
function RoutesPicker({ state, value, onChange, disabled }: { state: ReturnType<typeof useRoutes>; value: string[]; onChange: (routes: string[]) => void; disabled: boolean }) {
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
    label: <span className="judges-route-name">{routeName(route)}{route.runs ? ` (${route.runs})` : ""}</span>,
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
function ModelSelect({ state, value, onChange, disabled }: { state: ReturnType<typeof useRoutes>; value: string | undefined; onChange: (model: string | undefined) => void; disabled: boolean }) {
  const listed = state && !("error" in state) ? state.routes : [];
  const current = value && !listed.some((route) => route.key === value) ? parseRouteKey(value) : undefined;
  return <Select label={tr("judgesui.answeredBy")} ariaLabel={tr("judgesui.answeredBy")} disabled={disabled || !state} value={value ?? ""}
    options={[{ value: "", label: tr("judgesui.smallModelOwn") },
      ...listed.map((route) => ({ value: route.key, label: routeName(route) })),
      ...(current && value ? [{ value, label: tr("judgesui.modelNotShortlisted", { label: routeName(current) }) }] : [])]}
    onChange={(next) => onChange(next || undefined)} />;
}

export interface BacktestControls {
  result?: BacktestResult | { error: string };
  size: number;
  setSize: (size: number) => void;
  run: () => void;
  disabled: boolean;
}

type More = "model" | "evidence" | "limit" | undefined;

export default function JudgeEditor({ value, initial, error, busy, isNew, projectId, query, foreignOwner, starter, usage, backtest, badges, onChange, onSave, onBack, onDelete }: {
  value: JudgeInput;
  /** What Save would replace; Save is offered once the draft differs. A new judge always differs. */
  initial?: JudgeInput;
  error?: string; busy: boolean; isNew: boolean; projectId: string; query: string; foreignOwner: boolean;
  /** The judge is still its starter template: say so, and that saving a change makes it the person's own. */
  starter?: boolean;
  usage?: JudgeUsage;
  /** Saved turn judges only. */
  backtest?: BacktestControls;
  /** Badges the list shows for this judge, repeated in the head. */
  badges?: ReactNode;
  onChange: (next: JudgeInput) => void; onSave: () => void; onBack: () => void; onDelete?: () => void;
}) {
  const id = useId();
  const back = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const routes = useRoutes(query);
  const [more, setMore] = useState<More>();
  // A detail view replaces the list: start at its top, focus on the way back out.
  useEffect(() => {
    root.current?.scrollIntoView?.({ block: "start" });
    back.current?.focus({ preventScroll: true });
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
    onChange({ ...fresh, name: value.name, ...(value.description ? { description: value.description } : {}), enabled: value.enabled,
      filters: value.filters, dailyCap: value.dailyCap, ...(value.model ? { model: value.model } : {}) });
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
  const sureness = surenessOf(value.fire);
  const [customOpen, setCustomOpen] = useState(sureness === "custom");
  const shownSureness: Sureness = customOpen ? "custom" : sureness;
  const dirty = isNew || !initial || JSON.stringify(initial) !== JSON.stringify(value);
  const category = judgeCategory(value);
  const title = value.name.trim() || (isNew ? tr("judgesui.editorNew") : tr("judgesui.untitledJudge"));
  const modelValue = value.model ? (() => { const route = parseRouteKey(value.model!); return route ? routeName(route) : value.model!; })() : tr("judgesui.smallModelOwn");
  const evidenceValue = value.evidence.length ? value.evidence.map((entry) => evidenceLabel(entry.pick)).join(" · ") : tr("judgesui.evidenceNone");
  const openMore = (row: Exclude<More, undefined>) => setMore((current) => current === row ? undefined : row);

  return <div className="judges-detail judges-editor" role="group" aria-label={isNew ? tr("judgesui.editorNew") : tr("judgesui.editorEdit")} ref={root}>
    <Button ref={back} size="sm" variant="ghost" iconStart={BackIcon} className="judges-back" onClick={onBack}>{tr("judgesui.allJudges")}</Button>
    <div className="judges-detail-head">
      <JudgeTile icon={judgeIcon(value, category)} category={category} />
      <div className="judges-detail-copy">
        <strong className="judges-detail-title">{title}</strong>
        <span className="judges-detail-meta">
          {badges}
          {usage && <span>{usage.count >= value.dailyCap ? tr("judgesui.dailyReached", { used: usage.count, cap: value.dailyCap })
            : tr("judgesui.dailyToday", { used: usage.count, cap: value.dailyCap })}</span>}
        </span>
      </div>
    </div>
    <JudgeGlance judge={value} />
    {starter && <Notice className="judges-starter-notice" tone="info" heading={tr("judgesui.starterEditHeading")}>{tr("judgesui.starterEditBody")}</Notice>}

    <Section title={tr("judgesui.secBasics")}>
      <FormField label={tr("judgesui.fieldName")}>{(field) => <TextInput {...field} value={value.name} maxLength={80} disabled={busy}
        onChange={(event) => set({ name: event.target.value })} />}</FormField>
      <FormField label={tr("judgesui.fieldDescription")} hint={tr("judgesui.descriptionHint")} optional>{(field) => <Textarea {...field} className="judges-grow"
        value={value.description ?? ""} maxLength={DESCRIPTION_MAX} rows={2} disabled={busy}
        onChange={(event) => { const { description: _d, ...rest } = value; onChange(event.target.value ? { ...rest, description: event.target.value } : rest); }} />}</FormField>
      <Row label={tr("judgesui.fieldAsks")} hint={tr(TRIGGER_HINT[value.trigger])}>
        <Seg<JudgeTrigger> label={tr("judgesui.fieldAsks")} disabled={busy} value={value.trigger} options={triggerKinds()} onChange={setTrigger} />
      </Row>
      <Row label={tr("judgesui.fieldAppliesTo")} hint={tr(TRIGGER_SCOPE[value.trigger])}>
        <Seg<"all" | "project"> label={tr("judgesui.fieldAppliesTo")} disabled={busy} value={value.filters.projectId ? "project" : "all"}
          options={[["all", tr("judgesui.allProjects")], ["project", tr("judgesui.thisProject")]]}
          onChange={(next) => set({ filters: next === "project" ? { projectId } : {} })} />
      </Row>
    </Section>

    <Section title={q.type === "route" ? tr("judgesui.secDecision") : tr("judgesui.secQuestion")}>
      {q.type === "route" ? <>
        <FormField label={tr("judgesui.fieldInstructions")} hint={tr("judgesui.instructionsHint")}>{(field) =>
          <Textarea {...field} className="judges-grow" value={q.text} maxLength={600} rows={2} disabled={busy} onChange={(event) => setQuestion({ type: "route", text: event.target.value })} />}</FormField>
        <fieldset className="judges-options" disabled={busy}>
          <legend>{tr("judgesui.routesAllowed")}</legend>
          <p className="judges-note">{tr("judgesui.routesUpTo", { max: MAX_ROUTES })}</p>
          <RoutesPicker state={routes} value={value.routes ?? []} disabled={busy} onChange={(next) => set({ routes: next })} />
        </fieldset>
      </> : <>
        <Row label={tr("judgesui.fieldQuestionType")} hint={tr("judgesui.questionTypeHint")}>
          <Seg<Exclude<JudgeQuestion["type"], "route">> label={tr("judgesui.fieldQuestionType")} disabled={busy} value={q.type} options={questionKinds()} onChange={(type) => setQuestion(retype(q, type))} />
        </Row>
        <FormField label={tr("judgesui.fieldQuestion")} hint={tr("judgesui.questionHint")}>{(field) => <Textarea {...field} className="judges-grow" value={q.text} maxLength={600}
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
    </Section>

    <Section title={tr("judgesui.showLegend")} hint={tr("judgesui.showHint")}>
      <fieldset className="judges-options judges-show" disabled={busy}>
        <legend className="sr-only">{tr("judgesui.showLegend")}</legend>
        <p className="judges-safe"><Icon icon={ShieldIcon} size="sm" /><span>{tr("judgesui.markersSafe")}</span></p>
        {q.type === "choice" && value.fire.label !== undefined && <Row label={tr("judgesui.shownOn")} hint={tr("judgesui.shownOnHint")}>
          <Select label={tr("judgesui.shownOn")} ariaLabel={tr("judgesui.shownOn")} disabled={busy} value={value.fire.label}
            options={q.labels.filter((entry) => entry.label).map((entry) => ({ value: entry.label, label: entry.label }))}
            onChange={(label) => set({ fire: { ...value.fire, label } })} />
        </Row>}
        {displayKinds.map((kind) => <Checkbox key={kind} label={DISPLAY_COPY[kind].label} checked={!!display(kind)} onChange={(on) => toggleDisplay(kind, on)}
          description={DISPLAY_COPY[kind].description} />)}
        {followUp && followUp.kind === "suggest-follow-up" && <FormField label={tr("judgesui.followText")} hint={tr("judgesui.followTextHint")}>{(field) => <Textarea {...field} className="judges-grow" rows={2} maxLength={FOLLOW_UP_MAX}
          value={followUp.text} onChange={(event) => set({ effects: value.effects.map((entry) => entry.kind === "suggest-follow-up" ? { kind: entry.kind, text: event.target.value } : entry) })} />}</FormField>}
      </fieldset>
    </Section>

    <Section title={tr("judgesui.actLegend")} hint={tr("judgesui.actHint")}>
      <fieldset className="judges-options judges-act" disabled={busy}>
        <legend className="sr-only">{tr("judgesui.actLegend")}</legend>
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
    </Section>

    <Section title={tr("judgesui.secSure")} hint={q.type === "score" ? tr("judgesui.firesScoreHint") : tr("judgesui.sureHint")}>
      {q.type === "score" ? <Row label={tr("judgesui.firesScore")}>
        <NumberField label={tr("judgesui.threshold")} value={Math.round(value.fire.threshold * 100)} min={0} max={100} unit="%" disabled={busy}
          onCommit={(next) => set({ fire: { ...value.fire, threshold: next / 100 } })} />
      </Row> : <>
        <Row label={tr("judgesui.sureLabel")} hint={tr("judgesui.sureNow", { chance: percent(value.fire.threshold), lead: percent(value.fire.margin) })}>
          <Seg<Sureness> label={tr("judgesui.sureLabel")} disabled={busy} value={shownSureness} options={surenessOptions()}
            onChange={(next) => {
              setCustomOpen(next === "custom");
              if (next !== "custom") set({ fire: { ...value.fire, ...SURENESS[next] } });
            }} />
        </Row>
        {shownSureness === "custom" && <>
          <Row label={tr("judgesui.firesChance")} hint={tr("judgesui.firesChanceHint")}>
            <NumberField label={tr("judgesui.threshold")} value={Math.round(value.fire.threshold * 100)} min={0} max={100} unit="%" disabled={busy}
              onCommit={(next) => set({ fire: { ...value.fire, threshold: next / 100 } })} />
          </Row>
          <Row label={tr("judgesui.minLead")} hint={tr("judgesui.minLeadHint")}>
            <NumberField label={tr("judgesui.minLead")} value={Math.round(value.fire.margin * 100)} min={0} max={100} unit="%" disabled={busy}
              onCommit={(next) => set({ fire: { ...value.fire, margin: next / 100 } })} />
          </Row>
        </>}
      </>}
    </Section>

    <Section title={tr("judgesui.secMore")} hint={tr("judgesui.secMoreHint")}>
      <ItemList label={tr("judgesui.secMore")} className="judges-more">
        <DisclosureRow label={tr("judgesui.answeredBy")} value={modelValue} open={more === "model"} onToggle={() => openMore("model")}>
          <Row label={tr("judgesui.answeredBy")} hint={tr("judgesui.answeredByHint")}>
            <ModelSelect state={routes} value={value.model} disabled={busy}
              onChange={(model) => { const { model: _model, ...rest } = value; onChange(model ? { ...rest, model } : rest); }} />
          </Row>
        </DisclosureRow>
        <DisclosureRow label={tr("judgesui.evidenceLegend")} value={evidenceValue} open={more === "evidence"} onToggle={() => openMore("evidence")}>
          <fieldset className="judges-options" disabled={busy}>
            <legend className="sr-only">{tr("judgesui.evidenceLegend")}</legend>
            <p className="judges-note">{value.trigger === "limit-reached" ? tr("judgesui.evidenceNoteLimit") : tr("judgesui.evidenceNote")}</p>
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
        </DisclosureRow>
        <DisclosureRow label={tr("judgesui.dailyLimit")} value={tr("judgesui.callsPerDay", { count: value.dailyCap ?? DEFAULT_DAILY_CAP })} open={more === "limit"} onToggle={() => openMore("limit")}>
          <Row label={tr("judgesui.dailyLimit")} hint={tr("judgesui.dailyLimitHint")}>
            <NumberField label={tr("judgesui.dailyLimit")} value={value.dailyCap ?? DEFAULT_DAILY_CAP} min={1} max={MAX_DAILY_CAP} unit={tr("judgesui.unitCalls")} width="md" disabled={busy}
              onCommit={(dailyCap) => set({ dailyCap })} />
          </Row>
        </DisclosureRow>
      </ItemList>
    </Section>

    {value.trigger === "turn-completed" && <Section title={tr("judgesui.secTry")} hint={tr("judgesui.backtestSizeHint")}>
      {backtest ? <>
        <div className="judges-try">
          <NumberField label={tr("judgesui.backtestSize")} value={backtest.size} min={1} max={MAX_BACKTEST} unit={tr("judgesui.unitTurns")} onCommit={backtest.setSize} disabled={backtest.disabled} />
          <Button size="sm" variant="quiet" disabled={backtest.disabled || dirty} onClick={backtest.run}
            aria-label={tr("judgesui.backtestAria", { name: title, size: backtest.size })}>{tr("judgesui.backtest")}</Button>
          {dirty && <span className="judges-note">{tr("judgesui.backtestSaveFirst")}</span>}
        </div>
        {backtest.result && ("error" in backtest.result
          ? <Notice tone="error" role="alert" heading={tr("judgesui.backtestFailed")}>{backtest.result.error}</Notice>
          : <BacktestTable result={backtest.result} type={q.type} />)}
      </> : <p className="judges-note">{tr("judgesui.backtestAfterSave")}</p>}
    </Section>}

    {error && <Notice tone="error" role="alert" id={`${id}-error`} heading={tr("judgesui.saveFailed")}>{error}</Notice>}
    <SaveBar dirty={dirty} saving={busy} onSave={onSave} onDiscard={onBack} saveLabel={isNew ? tr("judgesui.addJudge") : tr("judgesui.saveJudge")} />
    {onDelete && <Section title={tr("judgesui.deleteJudge")} tone="danger">
      <div className="judges-editor-danger">
        <span className="judges-note">{tr("judgesui.markersStay")}</span>
        <Button size="sm" variant="danger" disabled={busy} onClick={onDelete}>{tr("judgesui.deleteJudge")}</Button>
      </div>
    </Section>}
  </div>;
}
