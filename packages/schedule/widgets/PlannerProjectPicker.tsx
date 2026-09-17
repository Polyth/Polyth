import { useMemo, useState, type ReactNode, type RefObject } from "react";
import type { Project } from "@polyth/contracts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { useShellMode } from "../../../apps/web/src/responsiveShell.ts";
import {
  CheckIcon,
  Icon,
  ResponsiveOverlay,
  TextInput,
} from "../../../apps/web/src/components/ui/index.ts";
import ProjectGlyph from "../../../apps/web/src/components/ProjectGlyph.tsx";

export function PlannerProjectMark({ project }: { project: Project }): ReactNode {
  return (
    <ProjectGlyph
      project={project}
      maskClassName="planner-project-mask project-glyph-mask"
    />
  );
}

export default function PlannerProjectPicker({
  open,
  onClose,
  anchorRef,
  projects,
  value,
  onChange,
  includeAll = false,
  title,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  projects: readonly Project[];
  value: string | null;
  onChange: (projectId: string | null) => void;
  includeAll?: boolean;
  title: string;
}) {
  const [query, setQuery] = useState("");
  const phone = useShellMode() === "phone";
  const searchable = projects.length >= 8;
  const needle = query.trim().toLocaleLowerCase();
  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of projects) {
      const name = (project.name || project.path).trim();
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }, [projects]);
  const shown = useMemo(() => {
    if (!needle) return projects;
    return projects.filter((project) => {
      const hay = `${project.name} ${project.path}`.toLocaleLowerCase();
      return hay.includes(needle);
    });
  }, [needle, projects]);

  return (
    <ResponsiveOverlay
      open={open}
      onClose={() => {
        setQuery("");
        onClose();
      }}
      title={title}
      desktop="dialog"
      dialogSize="sm"
      phone="popover"
      anchorRef={anchorRef}
      stableAnchor
      className="planner-picker-overlay"
      sheetSize={searchable ? "tall" : "auto"}
      initialFocus={!phone && searchable ? ".planner-picker-search" : undefined}
    >
      <div className="planner-picker">
        {searchable && (
          <TextInput
            className="planner-picker-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tr("scheduleview.searchProjects")}
            aria-label={tr("scheduleview.searchProjects")}
          />
        )}
        <div role="listbox" aria-label={title}>
          {includeAll && (
            <button
              type="button"
              role="option"
              className={`planner-picker-row${value === null ? " is-selected" : ""}`}
              aria-selected={value === null}
              onClick={() => {
                onChange(null);
                setQuery("");
                onClose();
              }}
            >
              <span className="planner-picker-copy">{tr("scheduleview.allProjects")}</span>
              {value === null && <Icon icon={CheckIcon} size="sm" />}
            </button>
          )}
          {shown.map((project) => {
            const selected = value === project.id;
            const name = project.name || project.path;
            const duplicate = (nameCounts.get(name.trim()) ?? 0) > 1;
            return (
              <button
                key={project.id}
                type="button"
                role="option"
                className={`planner-picker-row${selected ? " is-selected" : ""}`}
                aria-selected={selected}
                onClick={() => {
                  onChange(project.id);
                  setQuery("");
                  onClose();
                }}
              >
                <span className="planner-project-mark">
                  <PlannerProjectMark project={project} />
                </span>
                <span className="planner-picker-copy">
                  <span>{name}</span>
                  {duplicate && project.path && project.path !== name && (
                    <span className="planner-picker-path">{project.path}</span>
                  )}
                </span>
                {selected && <Icon icon={CheckIcon} size="sm" />}
              </button>
            );
          })}
        </div>
      </div>
    </ResponsiveOverlay>
  );
}
