import { tr } from "../../../apps/web/src/i18n/index.ts";
import type { QuotaWindowRef } from "../src/contracts.ts";
import { formatSpan, meterTone, percent, type Translate } from "./helpers.ts";

const translate: Translate = (key, values) => tr(key as never, values);

/** Thin quota bar with its value beside it. Hidden when the quota is unknown. */
export function QuotaMeter({ used, window, ceiling, blocked = false, now }: {
  used: number | undefined;
  window?: QuotaWindowRef | undefined;
  ceiling: number;
  blocked?: boolean;
  now: number;
}) {
  const value = percent(used);
  if (value === undefined) return null;
  const name = window?.label ?? tr("orchestration.now.quotas");
  const text = window?.resetsAt && window.resetsAt > now
    ? tr("orchestration.meter.resets", { window: name, used: value, time: formatSpan(window.resetsAt - now, translate) })
    : tr("orchestration.meter.label", { window: name, used: value });
  return (
    <span
      className={`orch-meter orch-meter--${meterTone(used, ceiling, blocked)}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-valuetext={text}
      title={text}
    >
      <span className="orch-meter-bar" aria-hidden="true"><i style={{ width: `${value}%` }} /></span>
      <span className="orch-meter-value">{value}%</span>
    </span>
  );
}

export const harnessLabel = (id: string): string => id.length > 0 ? id.charAt(0).toUpperCase() + id.slice(1) : id;
