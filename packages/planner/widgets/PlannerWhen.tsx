import { useEffect, useId, useMemo, useState, type MouseEvent } from "react";
import { Select, Tabs, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import {
  combineDateAndTime,
  compactZoneChoices,
  fromTimeValue,
  intervalParts,
  monthlyDayNeedsApplicableMonthsCopy,
  oncePresetAt,
  switchCadenceMode,
  toDateValue,
  toTimeValue,
  validateCadenceView,
  viewToCadence,
  weekdayNames,
  type CadenceMode,
  type CadenceView,
  type OncePreset,
} from "../src/cadenceView.ts";
import { plannerApi } from "./plannerApi.ts";
import { formatPreviewRun } from "./plannerFormat.ts";
import { t } from "./plannerText.ts";

const MODES: readonly CadenceMode[] = ["once", "daily", "weekly", "monthly", "interval", "legacy-cron"];
const MODE_LABEL: Record<CadenceMode, Parameters<typeof t>[0]> = {
  once: "when.once",
  daily: "when.daily",
  weekly: "when.weekly",
  monthly: "when.monthly",
  interval: "when.interval",
  "legacy-cron": "when.custom",
};
const ONCE_PRESETS: ReadonlyArray<[OncePreset, Parameters<typeof t>[0]]> = [
  ["in-hour", "when.inHour"],
  ["this-evening", "when.thisEvening"],
  ["tomorrow-morning", "when.tomorrowMorning"],
  ["next-monday", "when.nextMonday"],
];

/** Locale week start (0 = Sunday … 6 = Saturday); Monday when unknown. */
function weekStart(locale: string): number {
  try {
    const info = (new Intl.Locale(locale) as Intl.Locale & {
      weekInfo?: { firstDay?: number };
      getWeekInfo?: () => { firstDay?: number };
    });
    const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay;
    if (typeof firstDay === "number") return firstDay % 7;
  } catch { /* older engines */ }
  return 1;
}

/** Clicking anywhere in a date/time field opens the platform picker. */
function openPicker(event: MouseEvent<HTMLInputElement>) {
  try { event.currentTarget.showPicker?.(); } catch { /* unsupported or not user-activated */ }
}

/** A number field that may be cleared while typing; it commits whole values
 *  inside the range and restores the saved value on blur. */
function NumberField({ value, min, max, label, onCommit, className }: {
  value: number;
  min: number;
  max?: number;
  label: string;
  className?: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  return (
    <TextInput
      type="number"
      inputMode="numeric"
      aria-label={label}
      className={className}
      min={min}
      {...(max !== undefined ? { max } : {})}
      value={draft}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        const next = Number(raw);
        if (raw.trim() !== "" && Number.isInteger(next) && next >= min && (max === undefined || next <= max)) onCommit(next);
      }}
      onBlur={() => setDraft(String(value))}
    />
  );
}

/** Next runs through the server's preview — the executor's own cron path. */
function useNextRuns(view: CadenceView): { runs: number[]; error: string; loading: boolean } {
  const valid = validateCadenceView(view).ok;
  const key = valid ? JSON.stringify(viewToCadence(view)) : "";
  const [state, setState] = useState<{ key: string; runs: number[]; error: string }>({ key: "", runs: [], error: "" });
  useEffect(() => {
    if (!key) return;
    const cadence = JSON.parse(key) as ReturnType<typeof viewToCadence>;
    if (cadence.kind === "at") {
      setState({ key, runs: [cadence.at], error: "" });
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void plannerApi.preview(cadence, 3)
        .then((preview) => { if (live) setState({ key, runs: preview.runs.slice(0, 3), error: "" }); })
        .catch((cause) => { if (live) setState({ key, runs: [], error: cause instanceof Error ? cause.message : String(cause) }); });
    }, 220);
    return () => { live = false; clearTimeout(timer); };
  }, [key]);
  if (!key) return { runs: [], error: validateCadenceView(view).error ?? "", loading: false };
  return state.key === key ? { ...state, loading: false } : { runs: [], error: "", loading: true };
}

export default function PlannerWhen({ view, locale, onChange }: {
  view: CadenceView;
  locale: string;
  onChange: (next: CadenceView) => void;
}) {
  const now = Date.now();
  const timeId = useId();
  const dateId = useId();
  const zoneId = useId();
  const names = useMemo(() => weekdayNames(locale, "narrow"), [locale]);
  const longNames = useMemo(() => weekdayNames(locale, "long"), [locale]);
  const order = useMemo(() => {
    const first = weekStart(locale);
    return Array.from({ length: 7 }, (_, index) => (first + index) % 7);
  }, [locale]);
  const { runs, error, loading } = useNextRuns(view);

  const clock = view.mode === "once"
    ? toTimeValue(new Date(view.at).getHours(), new Date(view.at).getMinutes())
    : view.mode === "daily" || view.mode === "weekly" || view.mode === "monthly"
      ? toTimeValue(view.hour, view.minute)
      : "";
  const setClock = (raw: string) => {
    if (view.mode === "once") {
      const stamp = combineDateAndTime(toDateValue(view.at), raw);
      if (Number.isFinite(stamp)) onChange({ mode: "once", at: stamp });
      return;
    }
    const parsed = fromTimeValue(raw);
    if (parsed && (view.mode === "daily" || view.mode === "weekly" || view.mode === "monthly")) onChange({ ...view, ...parsed });
  };
  const timeField = (
    <label className="planner-field planner-field--time" htmlFor={timeId}>
      <span className="planner-field-label">{t("when.time")}</span>
      <TextInput id={timeId} type="time" required value={clock} onClick={openPicker} onChange={(event) => setClock(event.target.value)} />
    </label>
  );
  const zone = "timeZone" in view ? view.timeZone : "";
  const zoneField = zone ? (
    <div className="planner-zone">
      <span className="planner-field-label" id={zoneId}>{t("when.timeZone")}</span>
      <Select
        className="planner-zone-select"
        label={t("when.timeZone")}
        value={zone}
        options={compactZoneChoices(zone).map((value) => ({ value, label: value.replaceAll("_", " ") }))}
        onChange={(timeZone) => {
          if (view.mode === "daily" || view.mode === "weekly" || view.mode === "monthly" || view.mode === "legacy-cron") onChange({ ...view, timeZone });
        }}
      />
    </div>
  ) : null;

  const toggleDay = (day: number) => {
    if (view.mode !== "weekly") return;
    const days = view.days.includes(day) ? view.days.filter((item) => item !== day) : [...view.days, day];
    if (days.length > 0) onChange({ ...view, days });
  };
  const setDays = (days: number[]) => {
    if (view.mode === "weekly") onChange({ ...view, days });
  };
  const daysAre = (expected: number[]) =>
    view.mode === "weekly" && view.days.length === expected.length && expected.every((day) => view.days.includes(day));

  return (
    <div className="planner-when">
      <Tabs
        size="sm"
        className="planner-modes"
        label={t("when.mode")}
        value={view.mode}
        tabs={MODES.map((mode) => ({ id: mode, label: t(MODE_LABEL[mode]) }))}
        onChange={(mode) => onChange(switchCadenceMode(view, mode as CadenceMode))}
      />

      {view.mode === "once" && (
        <>
          <div className="planner-chips" role="group" aria-label={t("when.date")}>
            {ONCE_PRESETS.map(([preset, label]) => {
              const at = oncePresetAt(preset, now);
              return (
                <button
                  key={preset}
                  type="button"
                  className="planner-chip"
                  aria-pressed={Math.abs(view.at - at) < 60_000}
                  onClick={() => onChange({ mode: "once", at })}
                >
                  {t(label)}
                </button>
              );
            })}
          </div>
          <div className="planner-fields">
            <label className="planner-field planner-field--date" htmlFor={dateId}>
              <span className="planner-field-label">{t("when.date")}</span>
              <TextInput
                id={dateId}
                type="date"
                required
                value={toDateValue(view.at)}
                onClick={openPicker}
                onChange={(event) => {
                  const stamp = combineDateAndTime(event.target.value, clock);
                  if (Number.isFinite(stamp)) onChange({ mode: "once", at: stamp });
                }}
              />
            </label>
            {timeField}
          </div>
        </>
      )}

      {view.mode === "daily" && <div className="planner-fields">{timeField}</div>}

      {view.mode === "weekly" && (
        <>
          <div className="planner-weekdays" role="group" aria-label={t("when.days")}>
            {order.map((day) => (
              <button
                key={day}
                type="button"
                className="planner-weekday"
                aria-pressed={view.days.includes(day)}
                aria-label={longNames[day]}
                title={longNames[day]}
                onClick={() => toggleDay(day)}
              >
                {names[day]}
              </button>
            ))}
          </div>
          <div className="planner-chips" role="group" aria-label={t("when.days")}>
            <button type="button" className="planner-chip" aria-pressed={daysAre([0, 1, 2, 3, 4, 5, 6])} onClick={() => setDays([0, 1, 2, 3, 4, 5, 6])}>{t("when.everyDay")}</button>
            <button type="button" className="planner-chip" aria-pressed={daysAre([1, 2, 3, 4, 5])} onClick={() => setDays([1, 2, 3, 4, 5])}>{t("when.weekdays")}</button>
            <button type="button" className="planner-chip" aria-pressed={daysAre([0, 6])} onClick={() => setDays([0, 6])}>{t("when.weekends")}</button>
          </div>
          <div className="planner-fields">{timeField}</div>
        </>
      )}

      {view.mode === "monthly" && (
        <div className="planner-fields">
          <label className="planner-field planner-field--narrow">
            <span className="planner-field-label">{t("when.dayOfMonth")}</span>
            <NumberField
              label={t("when.dayOfMonth")}
              value={view.dayOfMonth}
              min={1}
              max={31}
              onCommit={(dayOfMonth) => onChange({ ...view, dayOfMonth })}
            />
          </label>
          {timeField}
        </div>
      )}

      {view.mode === "interval" && (() => {
        const { value, unit } = intervalParts(view.everyMinutes);
        return (
          <div className="planner-fields">
            <label className="planner-field planner-field--narrow">
              <span className="planner-field-label">{t("when.every")}</span>
              <NumberField
                label={t("when.every")}
                value={value}
                min={1}
                max={unit === "hours" ? 24 * 30 : 60 * 24 * 30}
                onCommit={(next) => onChange({ mode: "interval", everyMinutes: unit === "hours" ? next * 60 : next })}
              />
            </label>
            <div className="planner-field">
              <span className="planner-field-label" aria-hidden="true">&nbsp;</span>
              <Tabs
                size="sm"
                label={t("when.every")}
                value={unit}
                tabs={[{ id: "minutes", label: t("when.minutes") }, { id: "hours", label: t("when.hours") }]}
                onChange={(next) => onChange({ mode: "interval", everyMinutes: next === "hours" ? value * 60 : value })}
              />
            </div>
          </div>
        );
      })()}

      {view.mode === "legacy-cron" && (
        <label className="planner-field planner-field--wide">
          <span className="planner-field-label">{t("when.cronExpression")}</span>
          <TextInput
            className="planner-cron-input"
            dir="ltr"
            value={view.expression}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="0 9 * * 1-5"
            invalid={!!error}
            onChange={(event) => onChange({ ...view, expression: event.target.value, description: "" })}
          />
          <span className="planner-hint">{t("when.cronHint")}</span>
        </label>
      )}

      {zoneField}

      {view.mode === "monthly" && monthlyDayNeedsApplicableMonthsCopy(view.dayOfMonth) && (
        <p className="planner-hint">{t("when.monthlyShortMonths", { day: view.dayOfMonth })}</p>
      )}
      {view.mode === "once" && view.at < now && <p className="planner-hint is-warning">{t("when.pastTime")}</p>}

      <div className="planner-preview" aria-live="polite">
        <span className="planner-field-label">{t("when.nextRuns")}</span>
        {runs.length > 0 ? (
          <ol className="planner-preview-list">
            {runs.map((at) => <li key={at}>{formatPreviewRun(at, now, locale)}</li>)}
          </ol>
        ) : loading ? (
          <span className="planner-preview-loading" aria-hidden="true"><span /><span /><span /></span>
        ) : (
          <span className={`planner-preview-empty${error ? " is-error" : ""}`}>{error || t("when.previewUnavailable")}</span>
        )}
      </div>
    </div>
  );
}
