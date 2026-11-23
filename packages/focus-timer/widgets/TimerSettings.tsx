// The timer's settings: the cycle and its steps, the countdown's name, the
// flow and how time-up announces itself. One component for both places it
// appears: inside the floating window (`variant="window"`) and as the
// package's page in Settings. The window's quick editor (TimerWindow.tsx)
// reuses `LabelField` and `Stepper`.
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { WebMenuEntry, WebSelectOption } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  BUILTIN_CYCLES,
  isBuiltinCycle,
  LABEL_MAX,
  MAX_CYCLES,
  MAX_STEPS,
  normalizeLabel,
  STEP_COLORS,
  STEP_MINUTES,
  type CycleSet,
  type CycleStep,
} from "../src/cycles.ts";
import { activeCycle, clampSetting, LIMITS, SOUND_IDS, type FocusTimerSettings } from "../src/settings.ts";
import { requestSystemPermission, systemPermission, type SystemPermission } from "./alerts.ts";
import type { TimerController } from "./controller.ts";
import { SpeakerGlyph } from "./glyphs.tsx";
import { cycleLabel, STEP_COLOR_CSS, stepLabel, type Tone } from "./labels.ts";
import { timerController, timerHost, useTimer } from "./runtime.ts";
import { playSound } from "./sound.ts";

const finePointer = (): boolean => typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;

/** A one-line name. The draft is the field's own until Enter or leaving the
 *  field saves it (so typing never writes the account preference per key);
 *  Escape puts the saved name back. Empty means the built-in name, which the
 *  field shows as its placeholder. */
export function LabelField({ id, tone, value, placeholder, onCommit, autoFocus, onDone, onCancel, ariaLabel }: {
  id?: string;
  /** Colour of the dot before the text; none without it. */
  tone?: Tone;
  value: string;
  /** The built-in name an empty field stands for. */
  placeholder: string;
  onCommit: (label: string) => void;
  autoFocus?: boolean;
  /** Enter was pressed (after saving). */
  onDone?: () => void;
  /** Escape was pressed (after restoring); without it the field just blurs. */
  onCancel?: () => void;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement | null>(null);
  const editing = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  useEffect(() => {
    if (!autoFocus) return;
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, [autoFocus]);
  const commit = (raw: string) => {
    const next = normalizeLabel(raw);
    setDraft(next);
    if (next !== value) onCommit(next);
  };
  const CloseIcon = timerHost()?.ui.iconSet?.CloseIcon;
  return (
    <span className="focus-timer-label-field" data-tone={tone}>
      {tone ? <span className="focus-timer-chip-dot" aria-hidden="true" /> : null}
      <input
        ref={input}
        id={id}
        className="focus-timer-label-input"
        type="text"
        enterKeyHint="done"
        autoComplete="off"
        spellCheck={false}
        maxLength={LABEL_MAX}
        value={draft}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => {
          editing.current = true;
          cancelled.current = false;
        }}
        onBlur={() => {
          editing.current = false;
          if (cancelled.current) {
            cancelled.current = false;
            return;
          }
          commit(draft);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            commit(draft);
            onDone?.();
          } else if (event.key === "Escape") {
            event.stopPropagation();
            cancelled.current = true;
            setDraft(value);
            if (onCancel) onCancel();
            else event.currentTarget.blur();
          }
        }}
      />
      {draft ? (
        <button
          type="button"
          className="focus-timer-step focus-timer-label-clear"
          aria-label={tr("focustimer.edit.clear", { name: placeholder })}
          title={tr("focustimer.edit.clear", { name: placeholder })}
          // Keep the field focused: a blur would save the old draft first.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            setDraft("");
            if (value) onCommit("");
            input.current?.focus({ preventScroll: true });
          }}
        >
          {CloseIcon ? <CloseIcon size={13} aria-hidden /> : "×"}
        </button>
      ) : null}
    </span>
  );
}

function Toggle({ checked, onChange, label, hint, disabled }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  const Switch = timerHost()?.ui.components.Switch;
  return (
    <div className="focus-timer-row" data-disabled={disabled || undefined}>
      <span className="focus-timer-row-text">
        <span className="focus-timer-row-label" id={`${id}-label`}>{label}</span>
        {hint ? <span className="focus-timer-row-hint">{hint}</span> : null}
      </span>
      {Switch ? (
        <Switch checked={checked} onChange={onChange} labelledBy={`${id}-label`} disabled={disabled} />
      ) : (
        <input type="checkbox" checked={checked} aria-labelledby={`${id}-label`} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      )}
    </div>
  );
}

/** A number with − and +. `label` names it; `hideLabel` keeps the name for
 *  assistive technology only (a step row shows its name field instead). */
export function Stepper({ min, max, value, label, unit, onChange, autoFocus, hideLabel }: {
  min: number;
  max: number;
  value: number;
  label: string;
  unit: string;
  onChange: (value: number) => void;
  /** Focus the number on mount (fine pointers only: a phone keeps its keyboard down). */
  autoFocus?: boolean;
  hideLabel?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const field = useRef<HTMLInputElement | null>(null);
  useEffect(() => setDraft(String(value)), [value]);
  useEffect(() => {
    if (autoFocus && finePointer()) field.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  const commit = (next: number) => {
    const clamped = Number.isFinite(next) ? Math.min(max, Math.max(min, Math.round(next))) : value;
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };
  const MinusIcon = timerHost()?.ui.iconSet?.MinusIcon;
  const PlusIcon = timerHost()?.ui.iconSet?.PlusIcon;
  const control = (
    <span className="focus-timer-stepper">
      <button type="button" className="focus-timer-step" aria-label={tr("focustimer.decrease", { label })} disabled={value <= min} onClick={() => commit(value - 1)}>
        {MinusIcon ? <MinusIcon size={14} aria-hidden /> : "−"}
      </button>
      <input
        ref={field}
        id={id}
        className="focus-timer-step-input"
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={draft}
        aria-label={hideLabel ? label : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit(Number(draft))}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(Number(draft));
        }}
      />
      {unit ? <span className="focus-timer-step-unit" aria-hidden="true">{unit}</span> : null}
      <button type="button" className="focus-timer-step" aria-label={tr("focustimer.increase", { label })} disabled={value >= max} onClick={() => commit(value + 1)}>
        {PlusIcon ? <PlusIcon size={14} aria-hidden /> : "+"}
      </button>
    </span>
  );
  if (hideLabel) return control;
  return (
    <div className="focus-timer-row">
      <label className="focus-timer-row-label" htmlFor={id}>{label}</label>
      {control}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="focus-timer-section" aria-labelledby={id} aria-describedby={hint ? `${id}-hint` : undefined}>
      <h3 className="focus-timer-section-title" id={id}>{title}</h3>
      {hint ? <p className="focus-timer-section-hint" id={`${id}-hint`}>{hint}</p> : null}
      <div className="focus-timer-section-body">{children}</div>
    </section>
  );
}

/** "25 · 5 · 25 · 5 · …": the step lengths, for the cycle picker. */
function cycleSummary(cycle: CycleSet): string {
  const lengths = cycle.steps.map((item) => item.minutes);
  return lengths.length > 6 ? `${lengths.slice(0, 6).join(" · ")} · …` : lengths.join(" · ");
}

/** Every cycle the person can run: the ready-made ones, then their own. */
export function cycleOptions(settings: FocusTimerSettings): WebSelectOption[] {
  const option = (cycle: CycleSet, group: string): WebSelectOption =>
    ({ value: cycle.id, label: cycleLabel(cycle), group, detail: cycleSummary(cycle) });
  return [
    ...BUILTIN_CYCLES.map((cycle) => option(cycle, tr("focustimer.cycle.groupBuiltin"))),
    ...settings.cycles.map((cycle) => option(cycle, tr("focustimer.cycle.groupOwn"))),
  ];
}

/** The running cycle's picker: the host's select, or a native one. */
export function CyclePicker({ settings, controller, className }: { settings: FocusTimerSettings; controller: TimerController; className?: string }) {
  const Select = timerHost()?.ui.components.Select;
  const options = cycleOptions(settings);
  const label = tr("focustimer.settings.cycleChoice");
  if (Select) {
    return (
      <Select
        label={label}
        ariaLabel={label}
        value={settings.cycleId}
        options={options}
        searchable={false}
        className={className}
        onChange={(id) => controller.selectCycle(id)}
      />
    );
  }
  return (
    <select className={`focus-timer-native-select ${className ?? ""}`} aria-label={label} value={settings.cycleId} onChange={(event) => controller.selectCycle(event.target.value)}>
      {options.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select>
  );
}

function StepRow({ cycle, index, controller }: { cycle: CycleSet; index: number; controller: TimerController }) {
  const step = cycle.steps[index]!;
  const host = timerHost();
  const Menu = host?.ui.components.Menu;
  const icons = host?.ui.iconSet;
  const MoreIcon = icons?.MoreIcon;
  const n = index + 1;
  const patch = (change: Partial<CycleStep>) => controller.updateStep(cycle.id, index, change);
  const entries: WebMenuEntry[] = [
    { heading: tr("focustimer.settings.steps") },
    { id: "kind-focus", label: tr("focustimer.settings.kindFocus"), detail: tr("focustimer.settings.kindFocusHint"), kind: "radio", checked: step.kind === "focus", onSelect: () => patch({ kind: "focus" }) },
    { id: "kind-break", label: tr("focustimer.settings.kindBreak"), kind: "radio", checked: step.kind === "break", onSelect: () => patch({ kind: "break" }) },
    {
      id: "color",
      label: tr("focustimer.settings.stepColor"),
      detail: tr(`focustimer.color.${step.color}`),
      swatch: STEP_COLOR_CSS[step.color],
      onSelect: () => {},
      entries: STEP_COLORS.map((color) => ({
        id: `color-${color}`,
        label: tr(`focustimer.color.${color}`),
        kind: "radio" as const,
        checked: step.color === color,
        swatch: STEP_COLOR_CSS[color],
        onSelect: () => patch({ color }),
      })),
    },
    "separator",
    { id: "up", label: tr("focustimer.settings.moveUp"), disabled: index === 0, onSelect: () => controller.moveStep(cycle.id, index, index - 1) },
    { id: "down", label: tr("focustimer.settings.moveDown"), disabled: index === cycle.steps.length - 1, onSelect: () => controller.moveStep(cycle.id, index, index + 1) },
    { id: "duplicate", label: tr("focustimer.settings.duplicateStep"), disabled: cycle.steps.length >= MAX_STEPS, onSelect: () => controller.duplicateStep(cycle.id, index) },
    { id: "delete", label: tr("focustimer.settings.deleteStep"), danger: true, disabled: cycle.steps.length <= 1, onSelect: () => controller.removeStep(cycle.id, index) },
  ];
  const builtIn = stepLabel({ ...step, name: "" });
  return (
    <li className="focus-timer-step-row" data-tone={step.color} data-kind={step.kind}>
      <LabelField
        tone={step.color}
        value={step.name}
        placeholder={builtIn}
        ariaLabel={tr("focustimer.settings.stepName", { n })}
        onCommit={(name) => patch({ name })}
      />
      <Stepper
        min={STEP_MINUTES.min}
        max={STEP_MINUTES.max}
        value={step.minutes}
        label={tr("focustimer.settings.stepMinutes", { n })}
        unit={tr("focustimer.settings.minUnit")}
        hideLabel
        onChange={(minutes) => patch({ minutes })}
      />
      {Menu ? (
        <Menu label={tr("focustimer.settings.stepMenu", { n })} entries={entries} align="end">
          {(trigger) => (
            <button {...trigger} type="button" className="focus-timer-step focus-timer-step-more" aria-label={tr("focustimer.settings.stepMenu", { n })} title={tr("focustimer.settings.stepMenu", { n })}>
              {MoreIcon ? <MoreIcon size={15} aria-hidden /> : "⋯"}
            </button>
          )}
        </Menu>
      ) : null}
    </li>
  );
}

function CycleSection({ settings, controller }: { settings: FocusTimerSettings; controller: TimerController }) {
  const id = useId();
  const host = timerHost();
  const Menu = host?.ui.components.Menu;
  const icons = host?.ui.iconSet;
  const MoreIcon = icons?.MoreIcon;
  const PlusIcon = icons?.PlusIcon;
  const cycle = activeCycle(settings);
  const builtin = isBuiltinCycle(cycle.id);
  const full = settings.cycles.length >= MAX_CYCLES;
  const remove = async () => {
    const name = cycleLabel(cycle);
    const confirmed = host?.ui.confirm
      ? await host.ui.confirm(tr("focustimer.settings.deleteConfirm", { name }), { confirmLabel: tr("focustimer.settings.deleteCycle"), destructive: true })
      : true;
    if (confirmed) controller.deleteCycle(cycle.id);
  };
  const entries: WebMenuEntry[] = [
    { id: "new", label: tr("focustimer.settings.newCycle"), disabled: full, onSelect: () => controller.createCycle() },
    { id: "duplicate", label: tr("focustimer.settings.duplicateCycle"), disabled: full, onSelect: () => controller.createCycle(cycle.id) },
    ...(builtin ? [] : ["separator" as const, { id: "delete", label: tr("focustimer.settings.deleteCycle"), danger: true, onSelect: () => { void remove(); } }]),
  ];
  return (
    <Section title={tr("focustimer.settings.cycle")} hint={tr("focustimer.settings.cycleHint")}>
      <div className="focus-timer-cycle-pick">
        <CyclePicker settings={settings} controller={controller} className="focus-timer-cycle-select" />
        {Menu ? (
          <Menu label={tr("focustimer.settings.cycle")} entries={entries} align="end">
            {(trigger) => (
              <button {...trigger} type="button" className="focus-timer-step focus-timer-step-more" aria-label={tr("focustimer.settings.cycle")} title={tr("focustimer.settings.cycle")}>
                {MoreIcon ? <MoreIcon size={15} aria-hidden /> : "⋯"}
              </button>
            )}
          </Menu>
        ) : null}
      </div>
      {builtin ? (
        <p className="focus-timer-cycle-note">{tr("focustimer.settings.builtinHint")}</p>
      ) : (
        <div className="focus-timer-row focus-timer-label-row">
          <label className="focus-timer-row-label" htmlFor={`${id}-name`}>{tr("focustimer.settings.cycleName")}</label>
          <LabelField
            id={`${id}-name`}
            value={cycle.name}
            placeholder={cycleLabel({ ...cycle, name: "" })}
            onCommit={(name) => controller.renameCycle(cycle.id, name)}
          />
        </div>
      )}
      <ol className="focus-timer-steps" aria-label={tr("focustimer.settings.steps")}>
        {cycle.steps.map((_, index) => <StepRow key={`${cycle.id}:${index}`} cycle={cycle} index={index} controller={controller} />)}
      </ol>
      <button
        type="button"
        className="focus-timer-add-step"
        disabled={cycle.steps.length >= MAX_STEPS || (builtin && full)}
        onClick={() => controller.addStep(cycle.id)}
      >
        {PlusIcon ? <PlusIcon size={14} aria-hidden /> : "+"}
        <span>{tr("focustimer.settings.addStep")}</span>
      </button>
    </Section>
  );
}

export default function TimerSettings({ variant }: { variant: "window" | "page" }) {
  const snapshot = useTimer();
  const [permission, setPermission] = useState<SystemPermission>(() => systemPermission());
  const controller = timerController();
  const countdownId = useId();
  if (!snapshot || !controller) return null;
  const settings = snapshot.settings;
  const update = (patch: Partial<FocusTimerSettings>) => controller.updateSettings(patch);
  const preview = () => playSound(settings.soundId, settings.volume, 1);

  const systemHint = permission === "denied"
    ? tr("focustimer.settings.systemDenied")
    : permission === "unsupported"
      ? tr("focustimer.settings.systemUnsupported")
      : tr("focustimer.settings.systemHint");

  return (
    <div className="focus-timer-settings" data-variant={variant}>
      <CycleSection settings={settings} controller={controller} />

      <Section title={tr("focustimer.settings.flow")}>
        <div className="focus-timer-row focus-timer-label-row">
          <label className="focus-timer-row-label" htmlFor={countdownId}>{tr("focustimer.settings.countdownName")}</label>
          <LabelField id={countdownId} tone="countdown" value={settings.countdownLabel} placeholder={tr("focustimer.countdown")} onCommit={(label) => controller.setCountdownLabel(label)} />
        </div>
        <Toggle checked={settings.autoStartBreaks} label={tr("focustimer.settings.autoBreaks")} onChange={(autoStartBreaks) => update({ autoStartBreaks })} />
        <Toggle checked={settings.autoStartFocus} label={tr("focustimer.settings.autoFocus")} onChange={(autoStartFocus) => update({ autoStartFocus })} />
      </Section>

      <Section title={tr("focustimer.settings.alerts")}>
        <Toggle checked={settings.sound} label={tr("focustimer.settings.sound")} onChange={(sound) => update({ sound })} />
        {settings.sound && (
          <div className="focus-timer-sound">
            <div className="focus-timer-sound-choice" role="radiogroup" aria-label={tr("focustimer.settings.soundChoice")}>
              {SOUND_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={settings.soundId === id}
                  className="focus-timer-sound-option"
                  onClick={() => {
                    update({ soundId: id });
                    playSound(id, settings.volume, 1);
                  }}
                >
                  {tr(`focustimer.sound.${id}`)}
                </button>
              ))}
            </div>
            <div className="focus-timer-row focus-timer-volume">
              <button type="button" className="focus-timer-step focus-timer-preview" aria-label={tr("focustimer.settings.preview")} title={tr("focustimer.settings.preview")} onClick={preview}>
                <SpeakerGlyph size={15} />
              </button>
              <input
                className="focus-timer-range"
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(settings.volume * 100)}
                style={{ "--ft-fill": `${Math.round(settings.volume * 100)}%` } as CSSProperties}
                aria-label={tr("focustimer.settings.volume")}
                onChange={(event) => update({ volume: Number(event.target.value) / 100 })}
                onPointerUp={preview}
                onKeyUp={(event) => {
                  if (event.key.startsWith("Arrow")) preview();
                }}
              />
            </div>
            <Stepper min={LIMITS.repeat.min} max={LIMITS.repeat.max} value={settings.repeat} label={tr("focustimer.settings.repeat")} unit="×" onChange={(repeat) => update({ repeat: clampSetting("repeat", repeat) })} />
          </div>
        )}
        <Toggle checked={settings.flash} label={tr("focustimer.settings.flash")} hint={tr("focustimer.settings.flashHint")} onChange={(flash) => update({ flash })} />
        <Toggle checked={settings.color} label={tr("focustimer.settings.color")} hint={tr("focustimer.settings.colorHint")} onChange={(color) => update({ color })} />
        <Toggle
          checked={settings.system && permission === "granted"}
          disabled={permission === "denied" || permission === "unsupported"}
          label={tr("focustimer.settings.system")}
          hint={systemHint}
          onChange={async (system) => {
            if (!system) {
              update({ system: false });
              return;
            }
            const next = await requestSystemPermission();
            setPermission(next);
            update({ system: next === "granted" });
          }}
        />
      </Section>

      {variant === "page" && (
        <div className="focus-timer-settings-foot">
          <button type="button" className="focus-timer-preset" onClick={() => controller.show()}>
            {tr("focustimer.settings.open")}
          </button>
        </div>
      )}
    </div>
  );
}
