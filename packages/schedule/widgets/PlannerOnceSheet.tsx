import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import type { RefObject } from "react";
import {
  Button,
  ResponsiveOverlay,
} from "../../../apps/web/src/components/ui/index.ts";
import {
  combineDateAndTime,
  formatOnceDate,
  formatOnceTime,
  fromTimeValue,
  toDateValue,
  toTimeValue,
} from "../src/cadenceView.ts";
import PlannerNativeField from "./PlannerNativeField.tsx";

export default function PlannerOnceSheet({
  open,
  onClose,
  anchorRef,
  value,
  onChange,
  disabled = false,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  value: number;
  onChange: (at: number) => void;
  disabled?: boolean;
}) {
  const locale = getLocale();
  const at = Number.isFinite(value) ? value : Date.now();
  const timeParts = fromTimeValue(toTimeValue(new Date(at).getHours(), new Date(at).getMinutes()));

  return (
    <ResponsiveOverlay
      open={open}
      onClose={onClose}
      title={tr("scheduleview.once")}
      desktop="dialog"
      dialogSize="sm"
      phone="popover"
      anchorRef={anchorRef}
      stableAnchor
      className="planner-sheet-overlay"
      sheetAction={{ label: tr("common.done"), onClick: onClose }}
      dialogFooter={<Button variant="primary" onClick={onClose}>{tr("common.done")}</Button>}
    >
      <div className="planner-sheet">
        <PlannerNativeField
          label={tr("scheduleview.date")}
          display={formatOnceDate(at, locale)}
          type="date"
          value={toDateValue(at)}
          disabled={disabled}
          onChange={(next) => {
            const stamp = combineDateAndTime(
              next,
              toTimeValue(timeParts?.hour ?? 0, timeParts?.minute ?? 0),
            );
            if (Number.isFinite(stamp)) onChange(stamp);
          }}
        />
        <PlannerNativeField
          label={tr("scheduleview.time")}
          display={formatOnceTime(at, locale)}
          type="time"
          value={toTimeValue(new Date(at).getHours(), new Date(at).getMinutes())}
          disabled={disabled}
          onChange={(next) => {
            const stamp = combineDateAndTime(toDateValue(at), next);
            if (Number.isFinite(stamp)) onChange(stamp);
          }}
        />
      </div>
    </ResponsiveOverlay>
  );
}
