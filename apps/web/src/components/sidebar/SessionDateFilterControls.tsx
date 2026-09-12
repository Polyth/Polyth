import { useId } from "react";
import { tr } from "../../i18n/index.ts";
import {
  EMPTY_SESSION_DATE_FILTER,
  sessionDateDaysAgoInputValue,
  sessionDateFilterActive,
  sessionDateInputValue,
  type SessionDateFilter,
  type SessionDateFilterMode,
} from "../../sessionDates.ts";

export default function SessionDateFilterControls({
  value,
  onChange,
}: {
  value: SessionDateFilter;
  onChange: (value: SessionDateFilter) => void;
}) {
  const name = useId();

  const selectMode = (mode: SessionDateFilterMode) => {
    if (mode === "date") {
      onChange({ ...value, mode, date: value.date || sessionDateInputValue(Date.now()) });
      return;
    }
    if (mode === "range") {
      onChange({
        ...value,
        mode,
        from: value.from || sessionDateDaysAgoInputValue(6),
        to: value.to || sessionDateInputValue(Date.now()),
      });
      return;
    }
    onChange({ ...value, mode });
  };

  return (
    <fieldset className="session-date-filter">
      <legend>{tr("sidebar.date")}</legend>
      <div className="session-date-filter-modes">
        {([
          ["all", tr("sidebar.allDates")],
          ["date", tr("sidebar.onDate")],
          ["range", tr("sidebar.dateRange")],
        ] as const).map(([mode, label]) => (
          <label key={mode} className={value.mode === mode ? "is-selected" : ""}>
            <input
              type="radio"
              name={name}
              value={mode}
              checked={value.mode === mode}
              onChange={() => selectMode(mode)}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
      {value.mode === "date" && (
        <label className="session-date-filter-field">
          <span>{tr("sidebar.date")}</span>
          <input
            type="date"
            value={value.date}
            onChange={(event) => onChange({ ...value, mode: "date", date: event.target.value })}
          />
        </label>
      )}
      {value.mode === "range" && (
        <div className="session-date-filter-range">
          <label className="session-date-filter-field">
            <span>{tr("sidebar.fromDate")}</span>
            <input
              type="date"
              value={value.from}
              max={value.to || undefined}
              onChange={(event) => onChange({ ...value, mode: "range", from: event.target.value })}
            />
          </label>
          <label className="session-date-filter-field">
            <span>{tr("sidebar.toDate")}</span>
            <input
              type="date"
              value={value.to}
              min={value.from || undefined}
              onChange={(event) => onChange({ ...value, mode: "range", to: event.target.value })}
            />
          </label>
        </div>
      )}
      {sessionDateFilterActive(value) && (
        <button
          type="button"
          className="session-date-filter-clear"
          onClick={() => onChange(EMPTY_SESSION_DATE_FILTER)}
        >
          {tr("sidebar.clearDates")}
        </button>
      )}
    </fieldset>
  );
}
