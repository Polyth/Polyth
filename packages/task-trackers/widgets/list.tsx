import type { ReactNode } from "react";
import type {
  TaskTrackerPersonDto,
  TaskTrackerStatusCategory,
  TaskTrackerTaskDto,
} from "@polyth/contracts";
import { ChevronDownIcon } from "../../../apps/web/src/components/ui/index.ts";
import type { ListGrouping } from "./filters.tsx";
import { PersonAvatar, UnassignedAvatar } from "./glyphs.tsx";
import { tt } from "./i18n.ts";
import type { KanbanLane } from "./kanban.tsx";
import { personKey, taskPeople, type PersonOption } from "./people.ts";

/** One section of the list: a status (in board order) or an assignee. */
export interface ListGroup {
  id: string;
  name: string;
  category?: TaskTrackerStatusCategory;
  /** An assignee section's person; null for Unassigned. */
  person?: TaskTrackerPersonDto | null;
  tasks: TaskTrackerTaskDto[];
}

/**
 * The list's sections. By status they follow the kanban's lanes; by assignee
 * the viewer comes first and Unassigned last, and a task with several
 * assignees (Trello) sits under each of them. Empty sections are left out.
 */
export function listGroups(
  grouping: ListGrouping,
  lanes: readonly KanbanLane[],
  tasks: readonly TaskTrackerTaskDto[],
  people: readonly PersonOption[],
): ListGroup[] {
  if (grouping === "none") return tasks.length > 0 ? [{ id: "all", name: "", tasks: [...tasks] }] : [];
  if (grouping === "status") {
    return lanes
      .filter((lane) => lane.tasks.length > 0)
      .map((lane) => ({ id: `status:${lane.id}`, name: lane.name, category: lane.category, tasks: lane.tasks }));
  }
  const groups = new Map<string, ListGroup>();
  for (const option of people) {
    groups.set(option.key, { id: `person:${option.key}`, name: option.me ? tt("tasktrackers.list.you", { name: option.person.name }) : option.person.name, person: option.person, tasks: [] });
  }
  const unassigned: ListGroup = { id: "person:none", name: tt("tasktrackers.list.unassigned"), person: null, tasks: [] };
  for (const task of tasks) {
    const assigned = taskPeople(task);
    if (assigned.length === 0) unassigned.tasks.push(task);
    for (const person of assigned) {
      const key = personKey(person);
      let group = groups.get(key);
      if (!group) {
        group = { id: `person:${key}`, name: person.name, person, tasks: [] };
        groups.set(key, group);
      }
      if (!group.tasks.includes(task)) group.tasks.push(task);
    }
  }
  return [...groups.values(), unassigned].filter((group) => group.tasks.length > 0);
}

/** A grouped (or flat) task list. Section headers collapse their rows. */
export function TaskList({
  label,
  grouping,
  groups,
  collapsed,
  onToggle,
  renderRow,
  footer,
}: {
  label: string;
  grouping: ListGrouping;
  groups: readonly ListGroup[];
  collapsed: ReadonlySet<string>;
  onToggle: (groupId: string) => void;
  renderRow: (task: TaskTrackerTaskDto, groupId: string) => ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className={`tt-list group-${grouping}`} aria-label={label}>
      <div className="tt-list-head" aria-hidden="true">
        <span>{tt("tasktrackers.list.task")}</span>
        {grouping !== "status" && <span>{tt("tasktrackers.list.status")}</span>}
        {grouping !== "assignee" && <span>{tt("tasktrackers.list.assignee")}</span>}
      </div>
      {groups.map((group) => {
        const open = !collapsed.has(group.id);
        return (
          <section className="tt-list-group" key={group.id} aria-label={group.name || label}>
            {grouping !== "none" && (
              <button
                type="button"
                className="tt-list-group-head"
                aria-expanded={open}
                onClick={() => onToggle(group.id)}
              >
                <ChevronDownIcon className="tt-list-group-chevron" size={14} aria-hidden="true" />
                {group.category !== undefined && <span className={`tt-column-dot ${group.category}`} aria-hidden="true" />}
                {group.person !== undefined && (group.person ? <PersonAvatar person={group.person} size="xs" /> : <UnassignedAvatar />)}
                <strong>{group.name}</strong>
                <span className="tt-column-count">{group.tasks.length}</span>
              </button>
            )}
            {open && group.tasks.map((task) => renderRow(task, group.id))}
          </section>
        );
      })}
      {footer}
    </div>
  );
}
