import { useEffect, useId, useRef, useState } from "react";
import { Badge, Button, ChevronDownIcon, Notice, Select, Switch, Textarea, TextInput, type BadgeTone } from "@polyth/web/ui";
import { EmptyState, NumberField, ResetLink, Row, Section, Seg, SizeStepper } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import ModelPicker from "@polyth/models/model-picker";
import type { JudgmentConfig } from "../src/types.ts";
import type { JudgmentProviderOption } from "../src/settings.ts";
import type { JudgmentUseConfig, JudgmentUseDescriptor, JudgmentUseParam, JudgmentUseValue } from "../src/uses.ts";

export type UseCommit = { ok: true } | { ok: false; message: string };
type Level = "global" | "project";
type ConfigEdit = (config: Partial<JudgmentConfig>) => Partial<JudgmentConfig>;

/** Text and slider edits wait this long after the last change before they are saved. */
const DEBOUNCE_MS = 600;

/** Rewrites one use's stored entry; an empty entry (and an empty `uses`) is removed rather than saved. */
export function editUse(config: Partial<JudgmentConfig>, id: string, patch: (entry: JudgmentUseConfig) => JudgmentUseConfig): Partial<JudgmentConfig> {
  const { uses: current, ...rest } = config;
  const uses = { ...current };
  const next = patch({ ...uses[id] });
  const params = next.params && Object.keys(next.params).length ? next.params : undefined;
  const entry: JudgmentUseConfig = { ...(next.enabled !== undefined ? { enabled: next.enabled } : {}), ...(params ? { params } : {}) };
  if (Object.keys(entry).length) uses[id] = entry; else delete uses[id];
  return Object.keys(uses).length ? { ...rest, uses } : rest;
}
const setParam = (id: string, paramId: string, value: JudgmentUseValue | undefined): ConfigEdit => (config) => editUse(config, id, (entry) => {
  const { [paramId]: _old, ...others } = entry.params ?? {};
  return { ...entry, params: value === undefined ? others : { ...others, [paramId]: value } };
});
const setEnabled = (id: string, value: boolean | undefined): ConfigEdit => (config) => editUse(config, id, ({ enabled: _old, ...entry }) => ({ ...entry, ...(value === undefined ? {} : { enabled: value }) }));
const setScope = (scope: string, target: { providerId: string; modelId: string } | undefined): ConfigEdit => (config) => {
  const { scopes: current, ...rest } = config;
  const scopes = { ...current };
  if (target) scopes[scope] = target; else delete scopes[scope];
  return Object.keys(scopes).length ? { ...rest, scopes } : rest;
};

interface UsesProps {
  uses: JudgmentUseDescriptor[];
  level: Level;
  /** The settings being edited at this level. */
  config: Partial<JudgmentConfig>;
  /** All projects' settings; what a project inherits. */
  global: Partial<JudgmentConfig>;
  /** Whether Judgment itself is on for this level. */
  judgmentOn: boolean;
  routes: JudgmentProviderOption[];
  /** Name of the model the page route would use, for the "Automatic" caption. */
  automaticModel?: string;
  /** Whether the page's route runs on this server; long-evidence uses then need their own hosted model. */
  localRoute?: boolean;
  commit: (level: Level, edit: ConfigEdit) => Promise<UseCommit>;
}

export default function JudgmentUses({ uses, level, config, global, judgmentOn, routes, automaticModel, localRoute = false, commit }: UsesProps) {
  const [drafts, setDrafts] = useState<Record<string, JudgmentUseValue>>({});
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const edits = useRef(new Map<string, { edit: ConfigEdit; level: Level; value: JudgmentUseValue }>());
  const base = useId();
  useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current.clear(); edits.current.clear(); }, []);
  // Drafts belong to one level; a different level shows what that level stores.
  useEffect(() => { setDrafts({}); setError(""); }, [level]);

  const run = async (levelAtEdit: Level, edit: ConfigEdit) => {
    const result = await commit(levelAtEdit, edit);
    setError(result.ok ? "" : result.message);
    return result.ok;
  };
  const flush = async (key: string) => {
    clearTimeout(timers.current.get(key)); timers.current.delete(key);
    const pending = edits.current.get(key);
    if (!pending) return;
    edits.current.delete(key);
    if (await run(pending.level, pending.edit)) setDrafts((current) => current[key] === pending.value ? Object.fromEntries(Object.entries(current).filter(([name]) => name !== key)) : current);
  };
  const schedule = (key: string, value: JudgmentUseValue, edit: ConfigEdit, delay = DEBOUNCE_MS) => {
    setDrafts((current) => ({ ...current, [key]: value }));
    edits.current.set(key, { edit, level, value });
    clearTimeout(timers.current.get(key));
    timers.current.set(key, setTimeout(() => void flush(key), delay));
  };

  const modelChoices = routes.filter((entry) => entry.status === "available").flatMap((entry) => entry.models);
  const stored = (id: string): JudgmentUseConfig | undefined => config.uses?.[id];
  const inherited = (id: string): JudgmentUseConfig | undefined => level === "project" ? global.uses?.[id] : undefined;
  const effectiveValue = (use: JudgmentUseDescriptor, param: JudgmentUseParam): JudgmentUseValue =>
    drafts[`${use.id}\u0000${param.id}`] ?? stored(use.id)?.params?.[param.id] ?? inherited(use.id)?.params?.[param.id] ?? param.default;

  const control = (use: JudgmentUseDescriptor, param: JudgmentUseParam, disabled: boolean) => {
    const key = `${use.id}\u0000${param.id}`, value = effectiveValue(use, param), label = `${use.title}: ${param.label}`;
    const put = (next: JudgmentUseValue, delay?: number) => schedule(key, next, setParam(use.id, param.id, next), delay);
    switch (param.kind) {
      case "probability": return <SizeStepper label={label} unit="%" min={0} max={100} step={1} value={Math.round(Number(value) * 100)}
        onChange={(percent) => put(Math.round(percent) / 100)} />;
      case "integer": return <NumberField label={label} {...(param.unit ? { unit: param.unit } : {})} min={param.min} max={param.max} value={Number(value)} disabled={disabled}
        onCommit={(next) => put(next, 0)} />;
      case "boolean": return <Switch label={label} checked={value === true} disabled={disabled} onChange={(next) => put(next, 0)} />;
      case "choice": return param.options.length <= 3
        ? <Seg<string> label={label} value={String(value)} disabled={disabled} options={param.options.map((option) => [option.value, option.label])} onChange={(next) => put(next, 0)} />
        : <Select label={label} ariaLabel={label} disabled={disabled} value={String(value)} options={param.options} onChange={(next) => put(next, 0)} />;
      case "text": {
        const common = { "aria-label": label, value: String(value), maxLength: param.maxLength, disabled,
          onBlur: () => void flush(key) };
        return param.multiline
          ? <Textarea {...common} rows={Math.min(8, Math.max(3, String(value).split("\n").length))} onChange={(event) => put(event.target.value)} />
          : <TextInput {...common} onChange={(event) => put(event.target.value)} />;
      }
    }
  };

  const card = (use: JudgmentUseDescriptor) => {
    const id = `${base}-${use.id}`, panel = `${id}-panel`;
    const own = stored(use.id), inheritedOn = inherited(use.id)?.enabled;
    const on = own?.enabled ?? inheritedOn ?? use.defaultEnabled;
    const expanded = on && judgmentOn && !!open[use.id];
    const overridden = level === "project" && own?.enabled !== undefined;
    const target = config.scopes?.[use.scope] ?? (level === "project" ? global.scopes?.[use.scope] : undefined);
    const ownTarget = config.scopes?.[use.scope];
    const chosen = target ? modelChoices.find((model) => model.providerID === target.providerId && model.modelID === target.modelId) : undefined;
    // Only the two facts worth a glance get a pill: a use the local model can answer, and a use the current route cannot serve.
    const onLocal = target ? !!routes.find((entry) => entry.provider.id === target.providerId)?.local : localRoute;
    const evidence: [BadgeTone, string] | undefined = use.evidence === "short" ? ["info", tr("judgment.uses.fitsLocalModel")]
      : onLocal ? ["warning", tr("judgment.uses.needsHostedModel")] : undefined;
    const foot = judgmentOn && (on || level === "project");
    return <div key={use.id} className="judgment-use" data-on={on || undefined} data-open={expanded || undefined} data-settings-item={`judgment.use.${use.id}`}>
      <div className="judgment-use-head">
        <div className="judgment-use-text">
          <span className="judgment-use-title"><strong id={`${id}-title`}>{use.title}</strong>
            {evidence && <Badge tone={evidence[0]}>{evidence[1]}</Badge>}</span>
          <span className="judgment-use-description">{use.description}</span>
          <span className="judgment-use-effect"><em>{tr("judgment.uses.whatPolythDoes")}</em> {use.effect}</span>
        </div>
        <Switch labelledBy={`${id}-title`} checked={on} disabled={!judgmentOn} onChange={(value) => void run(level, setEnabled(use.id, value))} />
      </div>
      {foot && <div className="judgment-use-foot">
        {on && <Button size="sm" variant="ghost" className="judgment-use-toggle" iconEnd={ChevronDownIcon} aria-expanded={expanded} aria-controls={panel}
          aria-label={tr("judgment.uses.optionsFor", { title: use.title })} onClick={() => setOpen((current) => ({ ...current, [use.id]: !current[use.id] }))}>{tr("judgment.uses.options")}</Button>}
        {level === "project" && <span className="judgment-use-origin" data-overridden={overridden || undefined}>{overridden ? tr("judgment.uses.setForProject") : tr("judgment.uses.sameAsAllProjects")}</span>}
        {overridden && <ResetLink label={tr("judgment.uses.useAllProjectsSetting")} onClick={() => void run(level, setEnabled(use.id, undefined))} />}
      </div>}
      {expanded && <div className="judgment-use-options" id={panel}>
        {use.params.map((param) => {
          const hasOwn = own?.params?.[param.id] !== undefined;
          return <Row key={param.id} label={param.label} layout={param.kind === "text" ? "stacked" : "inline"} {...(param.hint ? { hint: param.hint } : {})}>
            <span className="judgment-use-control">
              {control(use, param, false)}
              {hasOwn && <ResetLink label={level === "project" ? tr("judgment.uses.useAllProjectsValue") : tr("judgment.uses.useDefault")}
                onClick={() => { const key = `${use.id}\u0000${param.id}`; clearTimeout(timers.current.get(key)); edits.current.delete(key);
                  setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([name]) => name !== key)));
                  void run(level, setParam(use.id, param.id, undefined)); }} />}
            </span>
          </Row>;
        })}
        <Row label={tr("judgment.uses.model")} hint={target ? tr("judgment.uses.modelAlways", { model: chosen?.name ?? target.modelId })
          : automaticModel ? tr("judgment.uses.modelFollowsNow", { model: automaticModel }) : tr("judgment.uses.modelFollows")} layout="inline">
          <span className="judgment-use-control">
            <fieldset aria-label={tr("judgment.uses.modelAria", { title: use.title })} disabled={!modelChoices.length}>
              <ModelPicker models={modelChoices} {...(target?.providerId && target.modelId ? { value: { providerID: target.providerId, modelID: target.modelId } } : {})}
                onPick={(model) => void run(level, setScope(use.scope, model ? { providerId: model.providerID, modelId: model.modelID } : undefined))} />
            </fieldset>
            {ownTarget && <ResetLink label={tr("judgment.uses.followModelSetting")} onClick={() => void run(level, setScope(use.scope, undefined))} />}
          </span>
        </Row>
      </div>}
    </div>;
  };

  return <Section itemId="judgment.uses" title={tr("judgment.uses.title")}
    hint={tr("judgment.uses.hint")}>
    {!judgmentOn && uses.length > 0 && <p className="judgment-uses-note" role="status">{tr("judgment.uses.offNote")}</p>}
    {error && <Notice tone="error" className="judgment-uses-error" role="alert" heading={tr("judgment.uses.saveFailed")}>{error}</Notice>}
    {uses.length
      ? <div className="judgment-uses" data-off={!judgmentOn || undefined}>{uses.map(card)}</div>
      : <EmptyState compact icon="circle-check" title={tr("judgment.uses.emptyTitle")} body={tr("judgment.uses.emptyBody")} />}
  </Section>;
}
