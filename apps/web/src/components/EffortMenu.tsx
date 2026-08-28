import { thinkingVariantLabel } from "@polyth/models/model-presentation";
import { tr } from "../i18n/index.ts";
import { Icon } from "../icons.tsx";
import { AssistIcon, Menu, type MenuEntry } from "./ui/index.ts";
import UiIcon from "./ui/Icon.tsx";

export interface EffortMenuProps {
  variants: readonly string[];
  value?: string;
  onPick: (thinking: string | undefined) => void;
  /** Phones dismiss the software keyboard before the sheet raises. */
  onWillOpen?: () => void;
}

/** Discrete reasoning effort: an anchored radio menu or phone sheet. */
export default function EffortMenu({
  variants,
  value,
  onPick,
  onWillOpen,
}: EffortMenuProps) {
  const label = value ? thinkingVariantLabel(value) : tr("composer.auto");
  const entries: MenuEntry[] = [
    {
      id: "auto",
      label: tr("composer.auto"),
      detail: tr("composer.modelDefaultReasoningEffort"),
      kind: "radio",
      checked: !value,
      onSelect: () => onPick(undefined),
    },
    ...variants.map((variant): MenuEntry => ({
      id: variant,
      label: thinkingVariantLabel(variant),
      kind: "radio",
      checked: value === variant,
      onSelect: () => onPick(variant),
    })),
  ];

  return (
    <Menu
      label={tr("composer.thinkingEffortValue", { value: label })}
      title={tr("composer.thinking")}
      entries={entries}
      className="composer-effort-menu"
    >
      {(trigger) => (
        <button
          type="button"
          className="config-chip composer-effort-chip"
          title={tr("composer.thinkingEffortValue", { value: label })}
          {...trigger}
          onClick={() => {
            trigger.onClick();
            onWillOpen?.();
          }}
        >
          <span className="config-chip-icon" aria-hidden="true">
            <UiIcon icon={AssistIcon} size="sm" />
          </span>
          <span className="config-chip-text">{label}</span>
          <span className="config-chip-caret" aria-hidden="true"><Icon.chevronDown /></span>
        </button>
      )}
    </Menu>
  );
}
