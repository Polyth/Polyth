import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import {
  Button,
  ResponsiveOverlay,
  Tabs,
} from "../../../apps/web/src/components/ui/index.ts";
import {
  formatClock,
  fromTimeValue,
  monthlyDayNeedsApplicableMonthsCopy,
  toTimeValue,
  weekdayNames,
  type CadenceView,
} from "../src/cadenceView.ts";
import PlannerNativeField from "./PlannerNativeField.tsx";

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

type RecurrenceView = Extract<CadenceView, { mode: "weekly" | "monthly" }>;

export default function PlannerRecurrenceSheet({
  open,
  onClose,
  value,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  value: RecurrenceView;
  onChange: (next: RecurrenceView) => void;
}) {
  const locale = getLocale();
  const names = weekdayNames(locale, "narrow");
  const longNames = weekdayNames(locale, "long");
  const kind = value.mode === "monthly" ? "monthly" : "weekly";
  const clock = formatClock(value.hour, value.minute, locale);

  const setKind = (next: string) => {
    if (next === "monthly") {
      onChange({
        mode: "monthly",
        dayOfMonth: value.mode === "monthly" ? value.dayOfMonth : 1,
        hour: value.hour,
        minute: value.minute,
        timeZone: value.timeZone,
      });
      return;
    }
    onChange({
      mode: "weekly",
      days: value.mode === "weekly" ? value.days : [new Date().getDay()],
      hour: value.hour,
      minute: value.minute,
      timeZone: value.timeZone,
    });
  };

  const setTime = (raw: string) => {
    const parsed = fromTimeValue(raw);
    if (!parsed) return;
    onChange({ ...value, hour: parsed.hour, minute: parsed.minute });
  };

  const toggleDay = (day: number) => {
    if (value.mode !== "weekly") return;
    const has = value.days.includes(day);
    const days = has ? value.days.filter((item) => item !== day) : [...value.days, day];
    if (days.length === 0) return;
    onChange({ ...value, days });
  };

  return (
    <ResponsiveOverlay
      open={open}
      onClose={onClose}
      title={tr("scheduleview.recurrence")}
      desktop="dialog"
      dialogSize="sm"
      className="planner-sheet-overlay"
      sheetAction={{ label: tr("common.done"), onClick: onClose }}
      dialogFooter={<Button variant="primary" onClick={onClose}>{tr("common.done")}</Button>}
    >
      <div className="planner-sheet">
        <Tabs
          size="sm"
          label={tr("scheduleview.recurrence")}
          value={kind}
          tabs={[
            { id: "weekly", label: tr("scheduleview.repeatWeekly") },
            { id: "monthly", label: tr("scheduleview.repeatMonthly") },
          ]}
          onChange={setKind}
        />
        {value.mode === "weekly" && (
          <div className="planner-weekdays" role="group" aria-label={tr("scheduleview.repeatWeekly")}>
            {WEEK_ORDER.map((day) => {
              const pressed = value.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  className="planner-weekday"
                  aria-pressed={pressed}
                  aria-label={longNames[day]}
                  onClick={() => toggleDay(day)}
                >
                  {names[day]}
                </button>
              );
            })}
          </div>
        )}
        {value.mode === "monthly" && (
          <>
            <PlannerNativeField
              label={tr("scheduleview.dayOfMonth")}
              display={String(value.dayOfMonth)}
              type="number"
              min={1}
              max={31}
              value={String(value.dayOfMonth)}
              onChange={(raw) => onChange({
                ...value,
                dayOfMonth: Math.max(1, Math.min(31, Number(raw) || 1)),
              })}
            />
            {monthlyDayNeedsApplicableMonthsCopy(value.dayOfMonth) && (
              <p className="planner-hint">{tr("scheduleview.monthlyDayHint")}</p>
            )}
          </>
        )}
        <PlannerNativeField
          label={tr("scheduleview.time")}
          display={clock}
          type="time"
          value={toTimeValue(value.hour, value.minute)}
          onChange={setTime}
        />
      </div>
    </ResponsiveOverlay>
  );
}
