import type {
  TaskTrackerPersonDto,
  TaskTrackerPriority,
  TaskTrackerTaskDto,
  TaskTrackerViewerDto,
} from "@polyth/contracts";
import { tt } from "./i18n.ts";

/**
 * Assignee filtering, browser-side over the tasks a board loaded. A filter is
 * a set of tokens: the viewer ("me"), "unassigned", or a person key. Several
 * tokens mean any of them. Tokens survive reloads (device memory), so "me"
 * stays "me" whoever the account is, and a person who is not on the board
 * simply matches nothing.
 */

export const ME = "me";
export const UNASSIGNED = "unassigned";

/** Stable per tracker: the account id, else the name for trackers or older
 *  servers that only send names. */
export const personKey = (person: Pick<TaskTrackerPersonDto, "id" | "name">): string =>
  person.id ? `id:${person.id}` : `name:${person.name.trim().toLocaleLowerCase()}`;

/** A task's assignees with ids where the tracker gave them. */
export const taskPeople = (task: TaskTrackerTaskDto): TaskTrackerPersonDto[] =>
  task.assigneePeople && task.assigneePeople.length > 0
    ? task.assigneePeople
    : task.assignees.filter(Boolean).map((name) => ({ id: "", name }));

const isViewer = (person: TaskTrackerPersonDto, viewer: TaskTrackerPersonDto | null): boolean => {
  if (!viewer) return false;
  if (person.id && viewer.id) return person.id === viewer.id;
  return person.name.trim().toLocaleLowerCase() === viewer.name.trim().toLocaleLowerCase();
};

/** The viewer when the board may call them "me"; null otherwise. */
export const ownViewer = (viewer: TaskTrackerViewerDto | null | undefined): TaskTrackerPersonDto | null =>
  viewer?.own ? viewer.person : null;

export function matchesAssignees(
  task: TaskTrackerTaskDto,
  selected: ReadonlySet<string>,
  me: TaskTrackerPersonDto | null,
): boolean {
  if (selected.size === 0) return true;
  const people = taskPeople(task);
  if (people.length === 0) return selected.has(UNASSIGNED);
  return people.some((person) =>
    selected.has(personKey(person)) || (selected.has(ME) && isViewer(person, me)));
}

export interface PersonOption {
  key: string;
  person: TaskTrackerPersonDto;
  /** Tasks on the board assigned to this person. */
  count: number;
  me: boolean;
}

/**
 * Everyone assigned on the board, the viewer first, then by how much they
 * hold, then by name. The viewer is listed even with nothing assigned, so
 * "Mine" can say so.
 */
export function boardPeople(
  tasks: readonly TaskTrackerTaskDto[],
  me: TaskTrackerPersonDto | null,
): { people: PersonOption[]; unassigned: number } {
  const byKey = new Map<string, PersonOption>();
  let unassigned = 0;
  for (const task of tasks) {
    const people = taskPeople(task);
    if (people.length === 0) unassigned++;
    const counted = new Set<string>();
    for (const person of people) {
      const key = personKey(person);
      if (counted.has(key)) continue;
      counted.add(key);
      const current = byKey.get(key);
      if (current) {
        current.count++;
        // A later task may carry the avatar an earlier one lacked.
        if (!current.person.avatarUrl && person.avatarUrl) current.person = person;
      } else {
        byKey.set(key, { key, person, count: 1, me: isViewer(person, me) });
      }
    }
  }
  if (me && ![...byKey.values()].some((option) => option.me)) {
    byKey.set(personKey(me), { key: personKey(me), person: me, count: 0, me: true });
  }
  const people = [...byKey.values()].sort((left, right) =>
    Number(right.me) - Number(left.me)
    || right.count - left.count
    || left.person.name.localeCompare(right.person.name));
  return { people, unassigned };
}

/** The tokens a filter set reads as, with the viewer's own key folded into
 *  "me", so choosing yourself in the full list and tapping "Mine" agree. */
export function normalizeAssignees(
  tokens: Iterable<string>,
  me: TaskTrackerPersonDto | null,
): Set<string> {
  const mine = me ? personKey(me) : null;
  const next = new Set<string>();
  for (const token of tokens) {
    if (typeof token !== "string" || !token || token.length > 300) continue;
    next.add(mine && token === mine ? ME : token);
  }
  return next;
}

/** A short name for what the filter shows: the trigger text and the empty
 *  state's subject. */
export function assigneeSummary(
  selected: ReadonlySet<string>,
  people: readonly PersonOption[],
): string {
  if (selected.size === 0) return tt("tasktrackers.people.everyone");
  if (selected.size > 1) return tt("tasktrackers.people.peopleCount", { count: selected.size });
  const [token] = [...selected];
  if (token === ME) return tt("tasktrackers.people.mine");
  if (token === UNASSIGNED) return tt("tasktrackers.people.unassigned");
  return people.find((option) => option.key === token)?.person.name ?? tt("tasktrackers.people.onePerson");
}

/** "No tasks assigned to you" and friends, for a filter that hides everything. */
export function emptyAssigneeTitle(selected: ReadonlySet<string>, people: readonly PersonOption[]): string {
  if (selected.size !== 1) return tt("tasktrackers.people.noneChosen");
  const [token] = [...selected];
  if (token === ME) return tt("tasktrackers.people.nothingForYou");
  if (token === UNASSIGNED) return tt("tasktrackers.people.allAssigned");
  const name = people.find((option) => option.key === token)?.person.name;
  return name ? tt("tasktrackers.people.noTasksFor", { name }) : tt("tasktrackers.people.thatPersonNoTasks");
}

export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => [...part][0]!.toLocaleUpperCase())
    .join("") || "?";

/** One of a few token tints per person, stable across boards and reloads. */
export const AVATAR_TONES = ["accent", "blue", "purple", "green", "amber"] as const;

export const avatarTone = (key: string): (typeof AVATAR_TONES)[number] => {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length]!;
};

const PRIORITY_KEYS = {
  urgent: "tasktrackers.people.priority.urgent",
  high: "tasktrackers.people.priority.high",
  medium: "tasktrackers.people.priority.medium",
  low: "tasktrackers.people.priority.low",
  none: "tasktrackers.people.priority.none",
} as const;

export function priorityLabel(priority: TaskTrackerPriority): string {
  return tt(PRIORITY_KEYS[priority]);
}
