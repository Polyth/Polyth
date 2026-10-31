import type { ReactNode } from "react";
import type { Project } from "@polyth/contracts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { ProjectPicker } from "../../../apps/web/src/components/ui/index.ts";
import ProjectGlyph from "../../../apps/web/src/components/ProjectGlyph.tsx";

export function PlannerProjectMark({ project }: { project: Project }): ReactNode {
  return (
    <ProjectGlyph
      project={project}
      maskClassName="planner-project-mask project-glyph-mask"
    />
  );
}

/**
 * The planner's project chooser. It delegates to the host's canonical
 * ProjectPicker so the schedule surface matches the project picker above the
 * composer on both desktop and phone instead of carrying its own overlay.
 */
export default function PlannerProjectPicker({
  projects,
  value,
  onChange,
  includeAll = false,
  label,
  className,
  disabled,
}: {
  projects: readonly Project[];
  value: string | null;
  onChange: (projectId: string | null) => void;
  includeAll?: boolean;
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <ProjectPicker
      label={label}
      projects={projects}
      value={value ?? ""}
      onPick={(id) => onChange(id || null)}
      {...(includeAll ? { allLabel: tr("scheduleview.allProjects") } : {})}
      {...(className !== undefined ? { className } : {})}
      {...(disabled !== undefined ? { disabled } : {})}
      emptyMessage={tr("scheduleview.noProjectsYet")}
    />
  );
}
