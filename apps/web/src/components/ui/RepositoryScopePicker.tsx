import Picker from "../Picker.tsx";
import { tr } from "../../i18n/index.ts";

export interface RepositoryScopeOption { id: string; alias: string; detail?: string }

type Selection =
  | { mode: "one" | "all"; value: string | null; onChange(value: string | null): void }
  | { mode: "subset"; value: readonly string[]; onChange(value: readonly string[]): void };

export type RepositoryScopePickerProps = Selection & {
  repositories: readonly RepositoryScopeOption[];
  label?: string;
  disabled?: boolean;
};

/** Repository scope belongs to the calling surface, never global navigation. */
export default function RepositoryScopePicker(props: RepositoryScopePickerProps) {
  const items = props.repositories.map((repository) => ({
    id: repository.id, label: repository.alias, group: "", detail: repository.detail,
  }));
  if (props.mode === "all") items.unshift({ id: "", label: tr("worktreesessiondialog.allRepositoriesShort"), group: "", detail: undefined });
  return <Picker
    label={props.label ?? tr("worktreesessiondialog.repositories")}
    items={items}
    disabled={props.disabled}
    mobileSheet
    {...(props.mode === "subset" ? { values: props.value } : { value: props.value ?? "" })}
    onPick={(id) => {
      if (props.mode === "subset") {
        props.onChange(props.value.includes(id) ? props.value.filter((value) => value !== id) : [...props.value, id]);
      } else props.onChange(id || null);
    }}
  />;
}
