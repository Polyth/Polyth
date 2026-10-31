import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { CheckIcon, Icon, ShieldAlertIcon, ShieldEmptyIcon, ShieldIcon } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import type { PermissionsMessageKey } from "../src/i18n/en.ts";
import type { ApprovalLevel } from "./approvalDefaults.ts";

export interface ApprovalLevelOption {
  level: ApprovalLevel;
  /** The session setting that picks this level. */
  setting: "off" | "on" | "all";
  icon: typeof ShieldIcon;
  title: PermissionsMessageKey;
  detail: PermissionsMessageKey;
}

/** One glyph per level everywhere: empty shield = Ask, shield-check =
 *  Auto-Approve, shield-alert = Full access. */
export const APPROVAL_LEVEL_OPTIONS: readonly ApprovalLevelOption[] = [
  { level: "off", setting: "off", icon: ShieldEmptyIcon, title: "permissionbanner.levelAsk", detail: "permissionbanner.levelAskDetail" },
  { level: "routine", setting: "on", icon: ShieldIcon, title: "permissionbanner.levelRoutine", detail: "permissionbanner.autoApproveHint" },
  { level: "all", setting: "all", icon: ShieldAlertIcon, title: "permissionbanner.fullAccess", detail: "permissionbanner.fullAccessHint" },
];

export const approvalLevelOption = (level: ApprovalLevel): ApprovalLevelOption =>
  APPROVAL_LEVEL_OPTIONS.find((option) => option.level === level) ?? APPROVAL_LEVEL_OPTIONS[0]!;

export const approvalLevelTitle = (level: ApprovalLevel): string => tr(approvalLevelOption(level).title);

/** Radio-group keyboard model shared with the approval switch: arrows move
 *  focus (mirrored in right-to-left text), Enter or Space chooses, Home/End
 *  jump to the ends. Moving focus never picks a level, so arrowing past Full
 *  access cannot turn it on. */
export function moveRadioFocus(event: KeyboardEvent<HTMLElement>, options: ReadonlyArray<HTMLElement | null>): void {
  const index = options.findIndex((option) => option === document.activeElement);
  if (index < 0) return;
  const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
  const back = event.key === "ArrowLeft" || event.key === "ArrowUp";
  const rtl = getComputedStyle(event.currentTarget).direction === "rtl" && (event.key === "ArrowRight" || event.key === "ArrowLeft");
  let next = index;
  if (forward || back) next = (index + ((forward !== rtl) ? 1 : -1) + options.length) % options.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = options.length - 1;
  else return;
  event.preventDefault();
  options[next]?.focus();
}

/** The level in force, for someone who may not change it: the same row as
 *  the choice list, without the radio. */
export function ApprovalLevelSummary({ level, title, detail }: { level: ApprovalLevel; title?: string; detail?: ReactNode }) {
  const option = approvalLevelOption(level);
  return (
    <div className="approval-choices is-static">
      <div className="approval-choice" data-level={level}>
        <span className="approval-choice-mark" aria-hidden="true"><Icon icon={option.icon} size="md" /></span>
        <span className="approval-choice-copy">
          <span className="approval-choice-title">{title ?? tr(option.title)}</span>
          <span className="approval-choice-detail">{detail ?? tr(option.detail)}</span>
        </span>
      </div>
    </div>
  );
}

export interface ApprovalChoice<T extends string> {
  value: T;
  /** The level this choice gives, which colors its glyph. */
  level: ApprovalLevel;
  icon: typeof ShieldIcon;
  title: string;
  detail: ReactNode;
}

/** Mutually exclusive approval levels, each with the sentence that explains
 *  what it lets agents do. Clicks are ignored while `busy`. */
export function ApprovalLevelChoices<T extends string>({ label, value, choices, onChange, busy = false }: {
  /** Accessible name of the group. */
  label: string;
  value: T;
  choices: ReadonlyArray<ApprovalChoice<T>>;
  onChange: (value: T) => void;
  busy?: boolean;
}) {
  const id = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = Math.max(0, choices.findIndex((choice) => choice.value === value));
  return (
    <div
      className="approval-choices"
      role="radiogroup"
      aria-label={label}
      aria-busy={busy || undefined}
      onKeyDown={(event) => moveRadioFocus(event, refs.current)}
    >
      {choices.map((choice, index) => {
        const checked = choice.value === value;
        return (
          <button
            key={choice.value}
            ref={(node) => { refs.current[index] = node; }}
            type="button"
            role="radio"
            className="approval-choice"
            data-level={choice.level}
            aria-checked={checked}
            aria-labelledby={`${id}-${index}-title`}
            aria-describedby={`${id}-${index}-detail`}
            tabIndex={index === selected ? 0 : -1}
            onClick={() => { if (!busy && !checked) onChange(choice.value); }}
          >
            <span className="approval-choice-mark" aria-hidden="true"><Icon icon={choice.icon} size="md" /></span>
            <span className="approval-choice-copy">
              <span className="approval-choice-title" id={`${id}-${index}-title`}>{choice.title}</span>
              <span className="approval-choice-detail" id={`${id}-${index}-detail`}>{choice.detail}</span>
            </span>
            <span className="approval-choice-check" aria-hidden="true">
              {checked && <Icon icon={CheckIcon} size="sm" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}
