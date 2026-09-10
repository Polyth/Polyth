import { useState, type ReactNode } from "react";
import { Button, Menu } from "../../../apps/web/src/components/ui/index.ts";
import EmptyState from "../../../apps/web/src/components/EmptyState.tsx";
import type { CoachCommitmentDto, CoachHomeDto } from "./api.ts";
import type { CoachClient } from "./store.ts";
import { useCoach } from "./store.ts";

const formatEstimate = (minutes?: number): string | null => {
  if (!minutes) return null;
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `~${hours}h ${rest}m` : `~${hours}h`;
};
const formatWhen = (epoch?: number, timeZone?: string): string | null => {
  if (!epoch) return null;
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone }).format(epoch); }
  catch { return null; }
};

function Status({ error, onRetry }: { error?: string; onRetry: () => void }) {
  return error ? <EmptyState variant="compact" title="Coach couldn't refresh" description={error} actionLabel="Retry" onAction={onRetry} />
    : <div className="coach-loading" role="status">Loading Coach…</div>;
}

function CommitmentActions({ item, client }: { item: CoachCommitmentDto; client: CoachClient }) {
  const { busy } = useCoach(client);
  const pending = busy.has(`commitment:${item.id}`);
  return <div className="coach-row-actions">
    <Button size="sm" disabled={pending} onClick={() => void client.complete(item.id)}>Done</Button>
    <Menu label={`Move ${item.title}`} title="Make room for this" entries={[
      { id: "hour", label: "In one hour", disabled: pending, onSelect: () => void client.reschedule(item.id, Date.now() + 3_600_000) },
      { id: "day", label: "In 24 hours", disabled: pending, onSelect: () => void client.reschedule(item.id, Date.now() + 86_400_000) },
      { id: "week", label: "In one week", disabled: pending, onSelect: () => void client.reschedule(item.id, Date.now() + 604_800_000) },
    ]}>{(trigger) => <Button {...trigger} size="sm" variant="ghost" disabled={pending}>Later</Button>}</Menu>
    <Menu label={`More actions for ${item.title}`} title="Adjust this commitment" entries={[
      { id: "blocked", label: "Help me get unstuck", disabled: pending || busy.has("talk"), onSelect: () => void client.talk("Coach · Unblock", `Help me get unstuck on commitment ${item.id}: ${item.title}. Read its current state first; do not mark it skipped or done.`) },
      ...[["no-time", "No time"], ["too-large", "Too large"], ["priorities-changed", "Priorities changed"]].map(([id, reason]) => ({
        id: id!, label: `Skip · ${reason}`, disabled: pending, onSelect: () => void client.skip(item.id, reason),
      })),
      { id: "skip", label: "Skip without reason", disabled: pending, onSelect: () => void client.skip(item.id) },
    ]}>{(trigger) => <Button {...trigger} size="sm" variant="ghost" disabled={pending}>More</Button>}</Menu>
  </div>;
}

export function CommitmentRow({ item, client, compact = false }: {
  item: CoachCommitmentDto; client: CoachClient; compact?: boolean;
}) {
  const { home } = useCoach(client);
  const meta = [formatEstimate(item.estimateMinutes), formatWhen(item.dueAt ?? item.plannedFor, home?.profile.timeZone)].filter(Boolean);
  return <div className={`coach-commitment${compact ? " coach-commitment--compact" : ""}`}>
    <div className="coach-commitment-copy"><strong>{item.title}</strong>{meta.length > 0 && <span className="coach-meta">{meta.join(" · ")}</span>}</div>
    <CommitmentActions item={item} client={client} />
  </div>;
}

export function CheckIn({ client, condensed = false }: { client: CoachClient; condensed?: boolean }) {
  const snapshot = useCoach(client);
  const [energy, setEnergy] = useState(3), [focus, setFocus] = useState(3);
  const [editing, setEditing] = useState(false);
  const saved = snapshot.home?.lastCheckIn;
  if (saved && !editing) return <div className={`coach-checkin-summary${condensed ? " coach-checkin-summary--condensed" : ""}`}>
    <span>Energy <strong>{saved.energy}/5</strong></span><span>Focus <strong>{saved.focus}/5</strong></span>
    <Button size="sm" variant="ghost" onClick={() => { setEnergy(saved.energy); setFocus(saved.focus); setEditing(true); }}>Update</Button>
  </div>;
  return <div className={`coach-checkin${condensed ? " coach-checkin--condensed" : ""}`}>
    <label><span>Energy</span><input aria-label="Energy" type="range" min="1" max="5" step="1" value={energy} onChange={(event) => setEnergy(Number(event.target.value))} /><strong>{energy}</strong></label>
    <label><span>Focus</span><input aria-label="Focus" type="range" min="1" max="5" step="1" value={focus} onChange={(event) => setFocus(Number(event.target.value))} /><strong>{focus}</strong></label>
    <Button size="sm" busy={snapshot.busy.has("checkin")} onClick={() => void client.checkIn(energy, focus).then(() => { if (!client.getSnapshot().error) setEditing(false); })}>Save</Button>
  </div>;
}

function Attention({ home }: { home: CoachHomeDto }) {
  if (!home.attention) return null;
  return <div className="coach-attention" role="status">
    <strong>{home.attention.kind === "overdue" ? "A little replanning may help" : "Make some room today"}</strong>
    <span>{home.attention.kind === "overdue"
      ? `${home.attention.count} open commitments are from an earlier day. You can move them or let them go.`
      : `${home.attention.count} commitments landed today. Keep what matters and move what can wait.`}</span>
  </div>;
}

export default function CoachView({ client }: { client: CoachClient }) {
  const snapshot = useCoach(client);
  if (!snapshot.home) return <div className="personal-coach-root"><Status error={snapshot.error} onRetry={() => void client.refresh()} /></div>;
  const home = snapshot.home, focus = home.today.mainFocus ?? home.nextAction;
  const remaining = home.today.commitments.filter((item) => item.id !== focus?.id);
  const goal = home.activeGoals.find((item) => item.id === focus?.goalId);
  // An empty day is still a useful Coach Home, never a return to onboarding.
  return <div className="personal-coach-root coach-home">
    <section className="coach-focus-section" aria-label="Today's focus">
      {focus ? <div className="coach-focus">
        <span className="coach-kicker">Your next step</span><h2>{focus.title}</h2>
        {goal && <p className="coach-meta">Toward {goal.title}</p>}
        <div className="coach-focus-meta">{[formatEstimate(focus.estimateMinutes), formatWhen(focus.dueAt ?? focus.plannedFor, home.profile.timeZone)].filter(Boolean).join(" · ")}</div>
        <CommitmentActions item={focus} client={client} />
      </div> : <div className="coach-focus"><span className="coach-kicker">Room to breathe</span><h2>Nothing you need to do right now.</h2><p className="coach-meta">Add a small next step, or leave today open.</p></div>}
    </section>
    <Attention home={home} />
    {remaining.length > 0 && <section className="coach-section" aria-label="Also today">
      <div className="coach-section-head"><h3>Also today</h3>{home.today.overflowCount > 0 && <span className="coach-meta">+{home.today.overflowCount} in Goals</span>}</div>
      <div className="coach-list">{remaining.map((item) => <CommitmentRow key={item.id} item={item} client={client} />)}</div>
    </section>}
    {home.today.dueRoutines.length > 0 && <section className="coach-section" aria-label="Routines today">
      <h3>Routines today</h3><div className="coach-routine-list">{home.today.dueRoutines.map((routine) => <div className="coach-routine-row" key={routine.id}>
        <span>{routine.title}</span>{routine.preferredMinuteOfDay !== undefined && <span className="coach-meta">{String(Math.floor(routine.preferredMinuteOfDay / 60)).padStart(2, "0")}:{String(routine.preferredMinuteOfDay % 60).padStart(2, "0")}</span>}
      </div>)}</div>
    </section>}
    <section className="coach-section" aria-label="Check-in"><div className="coach-section-head"><h3>How are you arriving today?</h3><span className="coach-meta">Optional</span></div><CheckIn client={client} /></section>
    {home.insight && <section className="coach-insight" aria-label="Current insight"><span className="coach-kicker">Worth noticing · a hypothesis</span><p>{home.insight.statement}</p><span className="coach-meta">{home.insight.confidence} confidence</span></section>}
    {home.reviewDue && <div className="coach-review-due"><div><strong>A moment to reflect</strong><span>Review what worked and change only what needs changing.</span></div><Button size="sm" variant="ghost" busy={snapshot.busy.has("talk")} onClick={() => void client.talk("Coach · Weekly review")}>Review week</Button></div>}
  </div>;
}

function WidgetShell({ children, label }: { children: ReactNode; label: string }) {
  return <section className="personal-coach-root coach-widget" aria-label={label}>{children}</section>;
}
export function TodayWidget({ client }: { client: CoachClient }) {
  const snapshot = useCoach(client);
  if (!snapshot.home) return <WidgetShell label="Today"><Status error={snapshot.error} onRetry={() => void client.refresh()} /></WidgetShell>;
  const home = snapshot.home, focus = home.today.mainFocus ?? home.nextAction;
  return <WidgetShell label="Today"><div className="coach-widget-label">Today</div>
    <strong className="coach-widget-focus">{focus?.title ?? (home.reviewDue ? "Weekly review is due." : "Nothing urgent.")}</strong>
    {focus && <span className="coach-meta">{formatEstimate(focus.estimateMinutes) ?? formatWhen(focus.dueAt ?? focus.plannedFor, home.profile.timeZone) ?? "Main focus"}</span>}
    <div className="coach-widget-actions">
      {focus && <Button size="sm" busy={snapshot.busy.has(`commitment:${focus.id}`)} onClick={() => void client.complete(focus.id)}>Done</Button>}
      {home.reviewDue && <Button size="sm" variant="ghost" busy={snapshot.busy.has("talk")} onClick={() => void client.talk("Coach · Weekly review")}>Review</Button>}
      <Button size="sm" variant="ghost" busy={snapshot.busy.has("talk")} onClick={() => void client.talk()}>Talk</Button>
    </div></WidgetShell>;
}
export function NextActionWidget({ client }: { client: CoachClient }) {
  const snapshot = useCoach(client);
  if (!snapshot.home) return <WidgetShell label="Next action"><Status error={snapshot.error} onRetry={() => void client.refresh()} /></WidgetShell>;
  const next = snapshot.home.nextAction;
  return <WidgetShell label="Next action"><div className="coach-widget-label">Next</div><strong className="coach-widget-focus">{next?.title ?? "Nothing queued"}</strong>
    {next && <span className="coach-meta">{formatEstimate(next.estimateMinutes) ?? formatWhen(next.dueAt ?? next.plannedFor, snapshot.home.profile.timeZone) ?? "When you're ready"}</span>}
  </WidgetShell>;
}
export function CommitmentsWidget({ client }: { client: CoachClient }) {
  const snapshot = useCoach(client);
  if (!snapshot.home) return <WidgetShell label="Commitments"><Status error={snapshot.error} onRetry={() => void client.refresh()} /></WidgetShell>;
  return <WidgetShell label="Commitments"><div className="coach-widget-label">Commitments</div>{snapshot.home.today.commitments.length === 0
    ? <span className="coach-meta">Nothing committed for today.</span>
    : <div className="coach-list">{snapshot.home.today.commitments.map((item) => <CommitmentRow key={item.id} item={item} client={client} compact />)}</div>}</WidgetShell>;
}
export function GoalWidget({ client }: { client: CoachClient }) {
  const snapshot = useCoach(client);
  if (!snapshot.home) return <WidgetShell label="Goal"><Status error={snapshot.error} onRetry={() => void client.refresh()} /></WidgetShell>;
  const goal = snapshot.home.activeGoals[0];
  return <WidgetShell label="Goal"><div className="coach-widget-label">Goal</div><strong className="coach-widget-focus">{goal?.title ?? "No active goal"}</strong>
    {goal?.desiredOutcome && <span className="coach-meta">{goal.desiredOutcome}</span>}
    {!goal && <Button size="sm" variant="ghost" busy={snapshot.busy.has("talk")} onClick={() => void client.talk()}>Choose one</Button>}
  </WidgetShell>;
}
export function CheckInWidget({ client }: { client: CoachClient }) {
  const snapshot = useCoach(client);
  if (!snapshot.home) return <WidgetShell label="Check-in"><Status error={snapshot.error} onRetry={() => void client.refresh()} /></WidgetShell>;
  return <WidgetShell label="Check-in"><div className="coach-widget-label">Check-in</div><CheckIn client={client} condensed /></WidgetShell>;
}
