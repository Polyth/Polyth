import { useMemo } from "react";
import type { TaskTrackerPersonDto } from "@polyth/contracts";
import Picker from "../../../apps/web/src/components/Picker.tsx";
import {
  CloseIcon,
  IconButton,
  LayersIcon,
  Menu,
  SharedIcon,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import { PersonAvatar, UnassignedAvatar } from "./glyphs.tsx";
import { tt } from "./i18n.ts";
import { assigneeSummary, ME, UNASSIGNED, type PersonOption } from "./people.ts";

/** Faces shown as one-tap filters before the full list. */
const QUICK_PEOPLE = 5;


const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

/**
 * Assignee filter: the full searchable list (multi-select), then one-tap
 * chips for "Mine", the people holding the most tasks and "Unassigned".
 * On a narrow board the chips scroll sideways in their own row.
 */
export function PeopleFilter({
  people,
  unassigned,
  selected,
  me,
  onChange,
}: {
  people: readonly PersonOption[];
  unassigned: number;
  selected: ReadonlySet<string>;
  me: TaskTrackerPersonDto | null;
  onChange: (next: Set<string>) => void;
}) {
  const mine = people.find((option) => option.me);
  const others = people.filter((option) => !option.me);
  const toggle = (token: string) => {
    const next = new Set(selected);
    if (next.has(token)) next.delete(token);
    else next.add(token);
    onChange(next);
  };
  // The busiest people, plus anyone chosen from the full list, so every
  // active filter is visible and one tap away from off.
  const quick = useMemo(() => {
    const top = others.filter((option) => option.count > 0).slice(0, QUICK_PEOPLE);
    const chosen = others.filter((option) => selected.has(option.key) && !top.includes(option));
    return [...top, ...chosen];
  }, [others, selected]);
  const summary = assigneeSummary(selected, people);
  const items = [
    ...(mine ? [{ id: ME, label: tt("tasktrackers.filters.you", { name: mine.person.name }), group: "", detail: String(mine.count) }] : []),
    ...(unassigned > 0 || selected.has(UNASSIGNED) ? [{ id: UNASSIGNED, label: tt("tasktrackers.filters.unassigned"), group: "", detail: String(unassigned) }] : []),
    ...others.map((option) => ({ id: option.key, label: option.person.name, group: tt("tasktrackers.filters.people"), detail: String(option.count) })),
  ];
  const optionOf = (id: string) => people.find((option) => option.key === id);

  return (
    <div className="tt-people" role="group" aria-label={tt("tasktrackers.filters.filterByAssignee")}>
      <Picker
        className={`tt-people-picker${selected.size > 0 ? " active" : ""}`}
        label={tt("tasktrackers.filters.assignee")}
        ariaLabel={tt("tasktrackers.filters.assigneeFilter", { summary })}
        searchPlaceholder={tt("tasktrackers.filters.findPerson")}
        values={[...selected]}
        items={items}
        onPick={toggle}
        displayValue={summary}
        triggerIcon={<SharedIcon size={14} aria-hidden="true" />}
        searchable={items.length > 7}
        emptyMessage={tt("tasktrackers.filters.nobodyAssigned")}
        itemIcon={(item) => item.id === UNASSIGNED
          ? <UnassignedAvatar />
          : item.id === ME
            ? me ? <PersonAvatar person={me} size="xs" /> : null
            : optionOf(item.id) ? <PersonAvatar person={optionOf(item.id)!.person} size="xs" /> : null}
        {...(selected.size > 0 ? { footerAction: { label: tt("tasktrackers.filters.showEveryone"), run: () => onChange(new Set()) } } : {})}
      />
      <div className="tt-people-chips">
        {mine && (
          <button
            type="button"
            className="tt-people-chip mine"
            aria-pressed={selected.has(ME)}
            aria-label={tt(mine.count === 1 ? "tasktrackers.filters.mineAriaOne" : "tasktrackers.filters.mineAria", { count: mine.count })}
            onClick={() => toggle(ME)}
          >
            <PersonAvatar person={mine.person} size="xs" />
            <span>{tt("tasktrackers.filters.mine")}</span>
            <b aria-hidden="true">{mine.count}</b>
          </button>
        )}
        {quick.map((option) => (
          <button
            key={option.key}
            type="button"
            className="tt-people-chip person"
            aria-pressed={selected.has(option.key)}
            aria-label={option.count === 1
              ? tt("tasktrackers.filters.personCountOne", { name: option.person.name, count: option.count })
              : tt("tasktrackers.filters.personCount", { name: option.person.name, count: option.count })}
            title={option.count === 1
              ? tt("tasktrackers.filters.personTitleOne", { name: option.person.name, count: option.count })
              : tt("tasktrackers.filters.personTitle", { name: option.person.name, count: option.count })}
            onClick={() => toggle(option.key)}
          >
            <PersonAvatar person={option.person} size="xs" />
            <span className="tt-people-name">{firstName(option.person.name)}</span>
          </button>
        ))}
        {(unassigned > 0 || selected.has(UNASSIGNED)) && (
          <button
            type="button"
            className="tt-people-chip unassigned"
            aria-pressed={selected.has(UNASSIGNED)}
            aria-label={tt(unassigned === 1 ? "tasktrackers.filters.unassignedAriaOne" : "tasktrackers.filters.unassignedAria", { count: unassigned })}
            onClick={() => toggle(UNASSIGNED)}
          >
            <UnassignedAvatar />
            <span>{tt("tasktrackers.filters.unassigned")}</span>
            <b aria-hidden="true">{unassigned}</b>
          </button>
        )}
      </div>
      {selected.size > 0 && (
        <IconButton
          icon={CloseIcon}
          size="sm"
          className="tt-people-clear"
          label={tt("tasktrackers.filters.showEveryoneTasks")}
          onClick={() => onChange(new Set())}
        />
      )}
    </div>
  );
}

export type ListGrouping = "status" | "assignee" | "none";

export const isListGrouping = (value: unknown): value is ListGrouping =>
  value === "status" || value === "assignee" || value === "none";

/** How the board shows its tasks: the list's grouping (list view only) and
 *  whether finished work stays on the board. */
export function DisplayMenu({
  list,
  grouping,
  showCompleted,
  onGrouping,
  onShowCompleted,
}: {
  list: boolean;
  grouping: ListGrouping;
  showCompleted: boolean;
  onGrouping: (value: ListGrouping) => void;
  onShowCompleted: (value: boolean) => void;
}) {
  const groupings: Array<[ListGrouping, string]> = [
    ["status", tt("tasktrackers.filters.status")],
    ["assignee", tt("tasktrackers.filters.assignee")],
    ["none", tt("tasktrackers.filters.noGrouping")],
  ];
  const entries: MenuEntry[] = [
    ...(list
      ? [
          { heading: tt("tasktrackers.filters.groupBy") },
          ...groupings.map(([value, label]) => ({
            id: `group-${value}`,
            label,
            kind: "radio" as const,
            checked: grouping === value,
            onSelect: () => onGrouping(value),
          })),
          "separator" as const,
        ]
      : []),
    {
      id: "show-completed",
      label: tt("tasktrackers.filters.showCompleted"),
      kind: "switch",
      checked: showCompleted,
      onSelect: () => onShowCompleted(!showCompleted),
    },
  ];
  return (
    <Menu label={tt("tasktrackers.filters.displayOptions")} title={tt("tasktrackers.filters.display")} align="end" entries={entries}>
      {(trigger) => <IconButton {...trigger} icon={LayersIcon} size="sm" label={tt("tasktrackers.filters.displayOptions")} className="tt-display-trigger" />}
    </Menu>
  );
}
