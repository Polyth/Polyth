import { useEffect, useState } from "react";
import type { TaskTrackerPersonDto, TaskTrackerPriorityDto } from "@polyth/contracts";
import { avatarTone, initialsOf, personKey, priorityLabel } from "./people.ts";
import { tt } from "./i18n.ts";

/** A person's picture, else their initials on a tint that stays theirs. */
export function PersonAvatar({
  person,
  size = "sm",
  label,
}: {
  person: TaskTrackerPersonDto;
  size?: "xs" | "sm" | "md";
  /** Accessible name when the avatar stands alone; decorative otherwise. */
  label?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [person.avatarUrl]);
  const tone = avatarTone(personKey(person));
  return (
    <span
      className={`tt-person-avatar ${size} tone-${tone}`}
      {...(label ? { role: "img", "aria-label": label, title: label } : { "aria-hidden": true })}
    >
      {person.avatarUrl && !failed
        ? <img src={person.avatarUrl} alt="" referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setFailed(true)} />
        : initialsOf(person.name)}
    </span>
  );
}

/** Overlapping avatars, three at most, then a count. */
export function AvatarStack({ people, max = 3 }: { people: readonly TaskTrackerPersonDto[]; max?: number }) {
  if (people.length === 0) return null;
  const shown = people.slice(0, max);
  const names = people.map((person) => person.name).join(", ");
  return (
    <span className="tt-avatar-stack" role="img" aria-label={tt("tasktrackers.people.assignedTo", { names })} title={names}>
      {shown.map((person) => <PersonAvatar key={personKey(person)} person={person} size="xs" />)}
      {people.length > shown.length && <span className="tt-avatar-more" aria-hidden="true">+{people.length - shown.length}</span>}
    </span>
  );
}

/** The empty circle Unassigned shows in place of a face. */
export function UnassignedAvatar({ size = "xs" }: { size?: "xs" | "sm" | "md" }) {
  return <span className={`tt-person-avatar ${size} unassigned`} aria-hidden="true" />;
}

/** Signal bars for high/medium/low, an alert tile for urgent; nothing for
 *  no priority, so unprioritized cards stay quiet. `reserve` keeps the
 *  space in a list row, so keys line up under each other. */
export function PriorityGlyph({ priority, reserve = false }: { priority: TaskTrackerPriorityDto | undefined; reserve?: boolean }) {
  if (!priority) return null;
  if (priority.level === "none") return reserve ? <span className="tt-priority none" aria-hidden="true" /> : null;
  const plain = priorityLabel(priority.level);
  const label = priority.name && priority.name !== plain ? `${plain} (${priority.name})` : plain;
  if (priority.level === "urgent") {
    return (
      <span className="tt-priority urgent" role="img" aria-label={label} title={label}>
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
          <path className="tt-priority-ink" d="M7 3.8v4" strokeWidth="1.6" strokeLinecap="round" />
          <circle className="tt-priority-dot" cx="7" cy="10.2" r=".95" />
        </svg>
      </span>
    );
  }
  const filled = priority.level === "high" ? 3 : priority.level === "medium" ? 2 : 1;
  return (
    <span className={`tt-priority ${priority.level}`} role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 14 14" aria-hidden="true">
        {[0, 1, 2].map((bar) => (
          <rect
            key={bar}
            x={1.5 + bar * 4}
            y={9 - bar * 3}
            width="3"
            height={4 + bar * 3}
            rx="1"
            fill="currentColor"
            opacity={bar < filled ? 1 : 0.28}
          />
        ))}
      </svg>
    </span>
  );
}
