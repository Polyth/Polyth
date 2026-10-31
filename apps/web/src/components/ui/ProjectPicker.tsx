// The canonical project picker: the same compact chip + searchable anchored
// popover used above the composer in the new-session view (SessionContextBar).
// Every surface that chooses among projects renders this component so desktop
// and phone differ only through Picker's shared form-factor presentation.
import type { ReactNode } from "react";
import { projectPickerItems, type ProjectPickerEntry } from "../../projectPicker.ts";
import Picker from "../Picker.tsx";
import ProjectGlyph from "../ProjectGlyph.tsx";
import { Icon } from "../../icons.tsx";

export type { ProjectPickerEntry };

export interface ProjectPickerProps {
  label: string;
  projects: readonly ProjectPickerEntry[];
  value?: string | null;
  onPick: (id: string) => void;
  /** Extra leading option (e.g. "All projects"); picking it reports "". */
  allLabel?: string;
  ariaLabel?: string;
  className?: string;
  popoverClassName?: string;
  disabled?: boolean;
  emptyMessage?: string;
  searchPlaceholder?: string;
  triggerIcon?: ReactNode;
  /** Trigger text shown when nothing is selected (e.g. "No project"). */
  placeholder?: string;
  /** Secondary row text; defaults to the project path (blank when unnamed). */
  itemDetail?: (project: ProjectPickerEntry) => string;
}

export default function ProjectPicker({
  label,
  projects,
  value,
  onPick,
  allLabel,
  ariaLabel,
  className,
  popoverClassName,
  disabled,
  emptyMessage,
  searchPlaceholder,
  triggerIcon,
  placeholder,
  itemDetail,
}: ProjectPickerProps) {
  // Projects are recognised by their own glyph (icon + color), so the chip
  // and every row show it; the folder icon is only the no-project fallback.
  const byId = new Map(projects.map((project) => [project.id, project]));
  const selected = value ? byId.get(value) : undefined;
  return (
    <Picker
      label={label}
      items={projectPickerItems(projects, allLabel, itemDetail)}
      value={value ?? ""}
      onPick={onPick}
      triggerIcon={triggerIcon ?? (selected ? <ProjectGlyph project={selected} /> : <Icon.files />)}
      itemIcon={(item) => {
        const project = byId.get(item.id);
        return project ? <ProjectGlyph project={project} /> : null;
      }}
      {...(ariaLabel !== undefined ? { ariaLabel } : {})}
      {...(className !== undefined ? { className } : {})}
      popoverClassName={`picker-project-pop${popoverClassName ? ` ${popoverClassName}` : ""}`}
      {...(disabled !== undefined ? { disabled } : {})}
      {...(emptyMessage !== undefined ? { emptyMessage } : {})}
      {...(searchPlaceholder !== undefined ? { searchPlaceholder } : {})}
      {...(placeholder !== undefined ? { placeholder } : {})}
    />
  );
}
