import { useState, type ReactNode } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { CoachCommitmentDto, CoachDueRoutineDto, CoachGoalDto } from "./api.ts";
import type { CoachJourneyApi } from "./journeyApi.ts";
import type { CoachClient } from "./store.ts";
import { useCoach } from "./store.ts";
import { t } from "./strings.ts";

export type CoachUi = WebPackageHost["ui"]["components"];

export interface CoachUiProps {
  api: CoachJourneyApi;
  client: CoachClient;
  ui: CoachUi;
  friendlyError(action: string, cause: unknown): string;
}

/** A goal in the top priority band is the user's primary goal. The band is an
 *  implementation detail; "Primary" is the concept people see and control. */
export const isPrimaryGoal = (goal: CoachGoalDto): boolean => goal.priority === 3;

export function formatEstimate(minutes?: number): string | null {
  if (!minutes) return null;
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `~${hours}h ${rest}m` : `~${hours}h`;
}

export function formatWhen(epoch?: number, timeZone?: string, withTime = true): string | null {
  if (!epoch) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      ...(withTime ? { timeStyle: "short" as const } : {}),
      ...(timeZone ? { timeZone } : {}),
    }).format(epoch);
  } catch {
    return null;
  }
}

export function formatClock(minuteOfDay?: number): string | null {
  if (minuteOfDay === undefined) return null;
  return `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;
}

/** Times of day the "Move" menu offers, resolved against the viewer's clock. */
const laterToday = (): number => {
  const target = new Date();
  target.setHours(target.getHours() + 3, 0, 0, 0);
  return target.getTime();
};
const tomorrowMorning = (): number => {
  const target = new Date();
  target.setDate(target.getDate() + 1);
  target.setHours(9, 0, 0, 0);
  return target.getTime();
};
const nextWeek = (): number => {
  const target = new Date();
  target.setDate(target.getDate() + 7);
  target.setHours(9, 0, 0, 0);
  return target.getTime();
};
export const startOfToday = (): number => {
  const target = new Date();
  target.setHours(target.getHours() + 1, 0, 0, 0);
  return target.getTime();
};

export function CoachError({ message, ui, onRetry }: { message: string; ui: CoachUi; onRetry?: () => void }) {
  const { Button } = ui;
  return <div className="coach-inline-error" role="alert">
    <span>{message}</span>
    {onRetry && <Button size="sm" variant="ghost" onClick={onRetry}>{t("coach.workspace.retry")}</Button>}
  </div>;
}

/**
 * Done is the one primary affordance. Rescheduling is a menu, and everything
 * secondary or destructive lives behind "More" — never a permanent row of four
 * buttons on every card.
 */
export function ActionControls({ item, client, ui, compact = false }: {
  item: CoachCommitmentDto;
  client: CoachClient;
  ui: CoachUi;
  compact?: boolean;
}) {
  const { Button, Menu } = ui;
  const { busy } = useCoach(client);
  const pending = busy.has(`commitment:${item.id}`);
  const moveEntries = [
    { id: "hour", label: t("coach.action.moveHour"), disabled: pending, onSelect: () => void client.reschedule(item.id, laterToday()) },
    { id: "tomorrow", label: t("coach.action.moveTomorrow"), disabled: pending, onSelect: () => void client.reschedule(item.id, tomorrowMorning()) },
    { id: "week", label: t("coach.action.moveWeek"), disabled: pending, onSelect: () => void client.reschedule(item.id, nextWeek()) },
  ];
  const moreEntries = [
    {
      id: "discuss",
      label: t("coach.action.unblock"),
      disabled: pending || busy.has("talk"),
      onSelect: () => void client.talk(
        `Help me get unstuck on commitment ${item.id}: ${item.title}. Read its current state first; do not mark it skipped or done.`,
      ),
    },
    ...([["no-time", t("coach.action.reasonNoTime")], ["too-large", t("coach.action.reasonTooLarge")], ["priorities", t("coach.action.reasonPriorities")]] as const)
      .map(([id, reason]) => ({
        id,
        label: t("coach.action.skipReason", { reason }),
        disabled: pending,
        onSelect: () => void client.skip(item.id, reason),
      })),
    { id: "skip", label: t("coach.action.skip"), disabled: pending, onSelect: () => void client.skip(item.id) },
  ];
  return <div className={`coach-row-actions${compact ? " coach-row-actions--compact" : ""}`}>
    <Button size="sm" disabled={pending} onClick={() => void client.complete(item.id)}>{t("coach.action.done")}</Button>
    <Menu label={t("coach.action.moveFor", { title: item.title })} title={t("coach.action.move")} entries={moveEntries}>
      {(trigger: Record<string, unknown>) => (
        <Button {...trigger} size="sm" variant="ghost" disabled={pending}>{t("coach.action.move")}</Button>
      )}
    </Menu>
    <Menu label={t("coach.action.moreFor", { title: item.title })} title={t("coach.action.more")} entries={moreEntries}>
      {(trigger: Record<string, unknown>) => (
        <Button {...trigger} size="sm" variant="ghost" disabled={pending}>{t("coach.action.more")}</Button>
      )}
    </Menu>
  </div>;
}

export function ActionRow({ item, client, ui, goal, timeZone, trailing }: {
  item: CoachCommitmentDto;
  client: CoachClient;
  ui: CoachUi;
  goal?: CoachGoalDto;
  timeZone?: string;
  trailing?: ReactNode;
}) {
  const meta = [
    goal ? t("coach.today.towards", { title: goal.title }) : null,
    formatEstimate(item.estimateMinutes),
    formatWhen(item.dueAt ?? item.plannedFor, timeZone),
  ].filter(Boolean);
  return <div className="coach-row">
    <div className="coach-row-copy">
      <span className="coach-row-title">{item.title}</span>
      {meta.length > 0 && <span className="coach-meta">{meta.join(" · ")}</span>}
    </div>
    {trailing ?? <ActionControls item={item} client={client} ui={ui} />}
  </div>;
}

export function RoutineRow({ due, client, ui }: { due: CoachDueRoutineDto; client: CoachClient; ui: CoachUi }) {
  const { Button } = ui;
  const { busy } = useCoach(client);
  const pending = busy.has(`routine:${due.routine.id}`);
  const clock = formatClock(due.routine.preferredMinuteOfDay);
  return <div className={`coach-row coach-routine${due.status ? ` coach-routine--${due.status}` : ""}`}>
    <div className="coach-row-copy">
      <span className="coach-row-title">{due.routine.title}</span>
      <span className="coach-meta">
        {[clock, due.status === "done" ? t("coach.routines.doneState") : due.status === "skipped" ? t("coach.routines.skippedState") : null]
          .filter(Boolean).join(" · ")}
      </span>
    </div>
    <div className="coach-row-actions">
      {due.status
        ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => void client.resolveRoutine(due.routine.id, "reopen")}>
            {t("coach.routines.reopen")}
          </Button>
        : <>
            <Button size="sm" disabled={pending} onClick={() => void client.resolveRoutine(due.routine.id, "done")}>
              {t("coach.routines.done")}
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => void client.resolveRoutine(due.routine.id, "skip")}>
              {t("coach.routines.skip")}
            </Button>
          </>}
    </div>
  </div>;
}

const SCALE = [1, 2, 3, 4, 5] as const;

/**
 * Lightweight, optional self-report. Discrete values only, and nothing is
 * preselected — an unsaved default would be a number the user never observed.
 */
export function CheckIn({ client, ui }: { client: CoachClient; ui: CoachUi }) {
  const { Button } = ui;
  const snapshot = useCoach(client);
  const saved = snapshot.home?.checkIn;
  const [editing, setEditing] = useState(false);
  const [energy, setEnergy] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);

  if (saved && !editing) {
    return <div className="coach-checkin coach-checkin--recorded">
      <span className="coach-meta">{t("coach.checkin.recorded", { energy: saved.energy, focus: saved.focus })}</span>
      <Button size="sm" variant="ghost" onClick={() => { setEnergy(saved.energy); setFocus(saved.focus); setEditing(true); }}>
        {t("coach.checkin.edit")}
      </Button>
    </div>;
  }

  const scale = (label: string, value: number | null, onPick: (next: number) => void) => (
    <div className="coach-scale" role="group" aria-label={label}>
      <span className="coach-scale-label">{label}</span>
      <div className="coach-scale-options">
        {SCALE.map((option) => (
          <button
            key={option}
            type="button"
            className={`coach-scale-option${value === option ? " selected" : ""}`}
            aria-pressed={value === option}
            aria-label={`${label} ${option} of 5`}
            onClick={() => onPick(option)}
          >{option}</button>
        ))}
      </div>
    </div>
  );

  return <div className="coach-checkin">
    {scale(t("coach.checkin.energy"), energy, setEnergy)}
    {scale(t("coach.checkin.focus"), focus, setFocus)}
    <Button
      size="sm"
      busy={snapshot.busy.has("checkin")}
      disabled={energy === null || focus === null}
      onClick={() => {
        if (energy === null || focus === null) return;
        void client.checkIn(energy, focus).then(() => {
          if (!client.getSnapshot().error) setEditing(false);
        });
      }}
    >{t("coach.checkin.save")}</Button>
  </div>;
}
