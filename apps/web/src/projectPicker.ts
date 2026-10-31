import type { Project } from "@polyth/contracts";
import type { PickerItem } from "./picker.ts";

/** Appearance fields (icon, color, remote) render the project's own glyph. */
export interface ProjectPickerEntry extends Pick<Project, "icon" | "color" | "remote"> {
  id: string;
  name?: string | undefined;
  path: string;
}

/** One mapping for every project picker: name over path, path as the detail. */
export function projectPickerItems(
  projects: readonly ProjectPickerEntry[],
  allLabel?: string,
  itemDetail?: (project: ProjectPickerEntry) => string,
): PickerItem[] {
  const items: PickerItem[] = projects.map((project) => ({
    id: project.id,
    label: project.name || project.path,
    group: "",
    detail: itemDetail ? itemDetail(project) : project.name ? project.path : "",
  }));
  if (allLabel !== undefined) {
    items.unshift({ id: "", label: allLabel, group: "", detail: "" });
  }
  return items;
}
