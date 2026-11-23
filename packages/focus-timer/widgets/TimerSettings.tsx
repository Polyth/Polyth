// The timer's settings: lengths, flow and how time-up announces itself. One
// component for both places it appears: inside the floating window
// (`variant="window"`) and as the package's page in Settings.
import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { clampSetting, LIMITS, SOUND_IDS, type FocusTimerSettings } from "../src/settings.ts";
import { requestSystemPermission, systemPermission, type SystemPermission } from "./alerts.ts";
import { SpeakerGlyph } from "./glyphs.tsx";
import { timerController, timerHost, useTimer } from "./runtime.ts";
import { playSound } from "./sound.ts";

type NumericKey = keyof typeof LIMITS;

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

function Stepper({ settingKey, value, label, unit, onChange }: {
  settingKey: NumericKey;
  value: number;
  label: string;
  unit: string;
  onChange: (value: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const { min, max } = LIMITS[settingKey];
  const commit = (next: number) => {
    const clamped = clampSetting(settingKey, next);
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };
  const MinusIcon = timerHost()?.ui.iconSet?.MinusIcon;
  const PlusIcon = timerHost()?.ui.iconSet?.PlusIcon;
  return (
    <div className="focus-timer-row">
      <label className="focus-timer-row-label" htmlFor={id}>{label}</label>
      <span className="focus-timer-stepper">
        <button type="button" className="focus-timer-step" aria-label={tr("focustimer.decrease", { label })} disabled={value <= min} onClick={() => commit(value - 1)}>
          {MinusIcon ? <MinusIcon size={14} aria-hidden /> : "−"}
        </button>
        <input
          id={id}
          className="focus-timer-step-input"
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={draft}
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
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="focus-timer-section" aria-labelledby={id}>
      <h3 className="focus-timer-section-title" id={id}>{title}</h3>
      <div className="focus-timer-section-body">{children}</div>
    </section>
  );
}

export default function TimerSettings({ variant }: { variant: "window" | "page" }) {
  const snapshot = useTimer();
  const [permission, setPermission] = useState<SystemPermission>(() => systemPermission());
  const controller = timerController();
  if (!snapshot || !controller) return null;
  const settings = snapshot.settings;
  const update = (patch: Partial<FocusTimerSettings>) => controller.updateSettings(patch);
  const min = tr("focustimer.settings.minUnit");
  const preview = () => playSound(settings.soundId, settings.volume, 1);

  const systemHint = permission === "denied"
    ? tr("focustimer.settings.systemDenied")
    : permission === "unsupported"
      ? tr("focustimer.settings.systemUnsupported")
      : tr("focustimer.settings.systemHint");

  return (
    <div className="focus-timer-settings" data-variant={variant}>
      <Section title={tr("focustimer.settings.durations")}>
        <Stepper settingKey="focusMin" value={settings.focusMin} label={tr("focustimer.settings.focus")} unit={min} onChange={(focusMin) => update({ focusMin })} />
        <Stepper settingKey="shortMin" value={settings.shortMin} label={tr("focustimer.settings.short")} unit={min} onChange={(shortMin) => update({ shortMin })} />
        <Stepper settingKey="longMin" value={settings.longMin} label={tr("focustimer.settings.long")} unit={min} onChange={(longMin) => update({ longMin })} />
        <Stepper settingKey="rounds" value={settings.rounds} label={tr("focustimer.settings.rounds")} unit="" onChange={(rounds) => update({ rounds })} />
      </Section>

      <Section title={tr("focustimer.settings.flow")}>
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
            <Stepper settingKey="repeat" value={settings.repeat} label={tr("focustimer.settings.repeat")} unit="×" onChange={(repeat) => update({ repeat })} />
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
