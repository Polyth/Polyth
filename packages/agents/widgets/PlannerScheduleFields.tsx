import { useEffect, useState, type MouseEvent } from "react";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { Tabs, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import {
  combineDateAndTime,
  defaultOnceView,
  fromTimeValue,
  localTimeZone,
  monthlyDayNeedsApplicableMonthsCopy,
  toDateValue,
  toTimeValue,
  weekdayNames,
  weeklyViewFromOnce,
  type CadenceView,
} from "../src/cadenceView.ts";

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export type EditableCadenceView = Extract<CadenceView, { mode: "once" | "weekly" | "monthly" }>;

/** Clicking anywhere in a date/time field opens the platform picker, not just its tiny indicator. */
function openPicker(event: MouseEvent<HTMLInputElement>) {
  try { event.currentTarget.showPicker?.(); } catch { /* unsupported or not user-activated */ }
}

function clockOf(view: EditableCadenceView): { hour: number; minute: number } {
  if (view.mode !== "once") return { hour: view.hour, minute: view.minute };
  const at = new Date(view.at);
  return { hour: at.getHours(), minute: at.getMinutes() };
}

/** The next moment the chosen clock comes round (today, else tomorrow). */
export function onceAtClock(hour: number, minute: number, now = Date.now()): EditableCadenceView {
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return Number.isFinite(at.getTime()) ? { mode: "once", at: at.getTime() } : defaultOnceView(now);
}

/** Day-of-month input that can be cleared while typing: the draft only
 *  commits once it is a whole day 1–31, and blur restores the saved day. */
function DayOfMonthInput({ value, disabled, onCommit }: {
  value: number;
  disabled: boolean;
  onCommit: (day: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  return (
    <TextInput
      type="number"
      inputMode="numeric"
      className="planner-day-input"
      min={1}
      max={31}
      value={draft}
      disabled={disabled}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        const day = Number(raw);
        if (raw.trim() !== "" && Number.isInteger(day) && day >= 1 && day <= 31) onCommit(day);
      }}
      onBlur={() => setDraft(String(value))}
    />
  );
}

/** Mode switch that carries the chosen clock (and Once day) across Once / Weekly / Monthly. */
export function switchCadenceMode(view: EditableCadenceView, mode: EditableCadenceView["mode"]): EditableCadenceView {
  if (mode === view.mode) return view;
  const { hour, minute } = clockOf(view);
  if (mode === "once") return onceAtClock(hour, minute);
  if (view.mode === "once" && mode === "weekly") return weeklyViewFromOnce(view.at);
  const timeZone = view.mode === "once" ? localTimeZone() : view.timeZone;
  const anchor = view.mode === "once" ? new Date(view.at) : new Date();
  if (mode === "weekly") return { mode, days: [anchor.getDay()], hour, minute, timeZone };
  return { mode, dayOfMonth: anchor.getDate(), hour, minute, timeZone };
}

/** Inline schedule editor: every field is visible in the form, no nested sheets. */
export default function PlannerScheduleFields({
  view,
  disabled = false,
  onChange,
}: {
  view: EditableCadenceView;
  disabled?: boolean;
  onChange: (next: EditableCadenceView) => void;
}) {
  const locale = getLocale();
  const names = weekdayNames(locale, "short");
  const longNames = weekdayNames(locale, "long");
  const { hour, minute } = clockOf(view);
  const time = toTimeValue(hour, minute);

  const setTime = (raw: string) => {
    if (view.mode === "once") {
      const stamp = combineDateAndTime(toDateValue(view.at), raw);
      if (Number.isFinite(stamp)) onChange({ mode: "once", at: stamp });
      return;
    }
    const parsed = fromTimeValue(raw);
    if (parsed) onChange({ ...view, ...parsed });
  };

  const toggleDay = (day: number) => {
    if (view.mode !== "weekly") return;
    const days = view.days.includes(day) ? view.days.filter((item) => item !== day) : [...view.days, day];
    if (days.length > 0) onChange({ ...view, days });
  };

  const timeField = (
    <TextInput
      type="time"
      className="planner-time-input"
      aria-label={tr("scheduleview.time")}
      value={time}
      disabled={disabled}
      required
      onClick={openPicker}
      onChange={(event) => setTime(event.target.value)}
    />
  );

  return (
    <div className="planner-when">
      <Tabs
        size="sm"
        className="planner-schedule-tabs"
        label={tr("scheduleview.schedule")}
        value={view.mode}
        tabs={[
          { id: "once", label: tr("scheduleview.once"), disabled },
          { id: "weekly", label: tr("scheduleview.repeatWeekly"), disabled },
          { id: "monthly", label: tr("scheduleview.repeatMonthly"), disabled },
        ]}
        onChange={(id) => onChange(switchCadenceMode(view, id as EditableCadenceView["mode"]))}
      />
      {view.mode === "once" && (
        <div className="planner-when-row">
          <TextInput
            type="date"
            className="planner-date-input"
            aria-label={tr("scheduleview.date")}
            value={toDateValue(view.at)}
            disabled={disabled}
            required
            onClick={openPicker}
            onChange={(event) => {
              const stamp = combineDateAndTime(event.target.value, time);
              if (Number.isFinite(stamp)) onChange({ mode: "once", at: stamp });
            }}
          />
          {timeField}
        </div>
      )}
      {view.mode === "weekly" && (
        <div className="planner-when-row">
          <div className="planner-weekdays" role="group" aria-label={tr("scheduleview.repeatWeekly")}>
            {WEEK_ORDER.map((day) => (
              <button
                key={day}
                type="button"
                className="planner-weekday"
                aria-pressed={view.days.includes(day)}
                aria-label={longNames[day]}
                title={longNames[day]}
                disabled={disabled}
                onClick={() => toggleDay(day)}
              >
                {names[day]}
              </button>
            ))}
          </div>
          {timeField}
        </div>
      )}
      {view.mode === "monthly" && (
        <>
          <div className="planner-when-row">
            <label className="planner-day-field">
              <span>{tr("scheduleview.dayOfMonth")}</span>
              <DayOfMonthInput
                value={view.dayOfMonth}
                disabled={disabled}
                onCommit={(dayOfMonth) => onChange({ ...view, dayOfMonth })}
              />
            </label>
            {timeField}
          </div>
          {monthlyDayNeedsApplicableMonthsCopy(view.dayOfMonth) && (
            <p className="planner-hint">{tr("scheduleview.monthlyDayHint")}</p>
          )}
        </>
      )}
    </div>
  );
}
