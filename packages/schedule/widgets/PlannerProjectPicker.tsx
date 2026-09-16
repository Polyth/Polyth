import { useMemo, useState, type ReactNode } from "react";
import type { Project } from "@polyth/contracts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { useShellMode } from "../../../apps/web/src/responsiveShell.ts";
import {
  CheckIcon,
  FolderIcon,
  Icon,
  ResponsiveOverlay,
  TextInput,
} from "../../../apps/web/src/components/ui/index.ts";

export function PlannerProjectMark({ project }: { project: Project }): ReactNode {
  if (project.icon?.startsWith("/assets/project-icons/")) {
    return (
      <span
        className="planner-project-mask"
        aria-hidden="true"
        style={{ WebkitMaskImage: `url("${project.icon}")`, maskImage: `url("${project.icon}")` }}
      />
    );
  }
  if (project.icon?.startsWith("data:image/")) {
    return <img className="planner-project-img" src={project.icon} alt="" />;
  }
  if (project.icon) return <span aria-hidden="true">{project.icon}</span>;
  return <Icon icon={FolderIcon} size="sm" />;
}

export default function PlannerProjectPicker({
  open,
  onClose,
  projects,
  value,
  onChange,
  includeAll = false,
  title,
}: {
  open: boolean;
  onClose: () => void;
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
      className="planner-picker-overlay"
      sheetSize={searchable ? "tall" : "auto"}
      {...(searchable && phone
        ? {
            sheetSearch: {
              value: query,
              onChange: setQuery,
              placeholder: tr("scheduleview.searchProjects"),
              ariaLabel: tr("scheduleview.searchProjects"),
            },
          }
        : {})}
    >
      <div className="planner-picker">
        {searchable && !phone && (
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
                <span className="planner-project-mark" style={project.color ? { color: project.color } : undefined}>
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
