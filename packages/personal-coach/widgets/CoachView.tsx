import { useState, type ReactNode } from "react";
import Button from "../../../apps/web/src/components/ui/Button.tsx";
import EmptyState from "../../../apps/web/src/components/EmptyState.tsx";
import type { CoachCommitmentDto, CoachGoalDto, CoachHomeDto } from "./api.ts";
import type { CoachClient } from "./store.ts";
import { useCoach } from "./store.ts";

const formatEstimate = (minutes?: number): string | null => {
  if (!minutes) return null;
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `~${hours}h ${rest}m` : `~${hours}h`;
};

const formatWhen = (epoch?: number): string | null => {
  if (!epoch) return null;
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(epoch);
  } catch {
    return null;
  }
};

function Status({ error, onRetry }: { error?: string; onRetry: () => void }) {
  if (error) {
    return (
      <EmptyState
        variant="compact"
        title="Coach couldn't refresh"
        description={error}
        actionLabel="Retry"
        onAction={onRetry}
      />
    );
  }
  return <div className="coach-loading" role="status">Loading Coach…</div>;
}

function CommitmentRow({
  item,
  client,
  compact = false,
}: {
  item: CoachCommitmentDto;
  client: CoachClient;
  compact?: boolean;
}) {
  const { busy } = useCoach(client);
  const pending = busy.has(`commitment:${item.id}`);
  const estimate = formatEstimate(item.estimateMinutes);
  const when = formatWhen(item.dueAt ?? item.plannedFor);
  return (
    <div className={`coach-commitment${compact ? " coach-commitment--compact" : ""}`}>
      <div className="coach-commitment-copy">
        <strong>{item.title}</strong>
        {(estimate || when) && (
          <span className="coach-meta">{[estimate, when].filter(Boolean).join(" · ")}</span>
        )}
      </div>
      <div className="coach-row-actions">
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => void client.skip(item.id)}>
          Skip
        </Button>
        <Button size="sm" disabled={pending} onClick={() => void client.complete(item.id)}>
          Done
        </Button>
      </div>
    </div>
  );
}

function GoalRow({ goal }: { goal: CoachGoalDto }) {
  return (
    <div className="coach-goal-row">
      <span className="coach-goal-mark" aria-hidden />
      <div>
        <strong>{goal.title}</strong>
        {goal.desiredOutcome && <span className="coach-meta">{goal.desiredOutcome}</span>}
      </div>
    </div>
  );
}

export function CheckIn({ client, condensed = false }: { client: CoachClient; condensed?: boolean }) {
  const snapshot = useCoach(client);
  const [energy, setEnergy] = useState(3);
  const [focus, setFocus] = useState(3);
  const saved = snapshot.home?.lastCheckIn;
  const pending = snapshot.busy.has("checkin");

  if (saved) {
    return (
      <div className={`coach-checkin-summary${condensed ? " coach-checkin-summary--condensed" : ""}`}>
        <span>Energy <strong>{saved.energy}/5</strong></span>
        <span>Focus <strong>{saved.focus}/5</strong></span>
      </div>
    );
  }

  return (
    <div className={`coach-checkin${condensed ? " coach-checkin--condensed" : ""}`}>
      <label>
        <span>Energy</span>
        <input aria-label="Energy" type="range" min="1" max="5" step="1" value={energy} onChange={(event) => setEnergy(Number(event.target.value))} />
        <strong>{energy}</strong>
      </label>
      <label>
        <span>Focus</span>
        <input aria-label="Focus" type="range" min="1" max="5" step="1" value={focus} onChange={(event) => setFocus(Number(event.target.value))} />
        <strong>{focus}</strong>
      </label>
      <Button size="sm" busy={pending} onClick={() => void client.checkIn(energy, focus)}>
        Save
      </Button>
    </div>
  );
}

function Attention({ home }: { home: CoachHomeDto }) {
  if (!home.attention) return null;
  return (
    <div className="coach-attention" role="status">
      <strong>{home.attention.kind === "overdue" ? "Needs attention" : "Today is overloaded"}</strong>
      <span>
        {home.attention.kind === "overdue"
          ? `${home.attention.count} open ${home.attention.count === 1 ? "commitment is" : "commitments are"} from an earlier day.`
          : `${home.attention.count} commitments landed today. Keep the top three and move what can wait.`}
      </span>
    </div>
  );
}

function EmptyCoach({ client }: { client: CoachClient }) {
  const { busy } = useCoach(client);
  return (
    <EmptyState
      variant="panel"
      title="What would you like to make progress on?"
      description="Tell Coach what matters. It will turn the useful parts into goals and commitments you can keep across chats."
      actionLabel={busy.has("talk") ? "Opening…" : "Talk to Coach"}
      onAction={() => void client.talk()}
    />
  );
}

function hasUsefulState(home: CoachHomeDto): boolean {
  return home.activeGoals.length > 0
    || home.today.commitments.length > 0
    || home.today.overdueCount > 0
    || home.today.dueRoutines.length > 0
    || Boolean(home.nextAction);
}

export default function CoachView({ client }: { client: CoachClient }) {
  const snapshot = useCoach(client);
  if (!snapshot.home) return <div className="personal-coach-root"><Status error={snapshot.error} onRetry={() => void client.refresh()} /></div>;
  if (!hasUsefulState(snapshot.home)) return <div className="personal-coach-root"><EmptyCoach client={client} /></div>;

  const home = snapshot.home;
  const focus = home.today.mainFocus ?? home.nextAction;
  const focusEstimate = focus ? formatEstimate(focus.estimateMinutes) : null;
  const focusWhen = focus ? formatWhen(focus.dueAt ?? focus.plannedFor) : null;
  return (
    <div className="personal-coach-root coach-home">
      {snapshot.error && <div className="coach-inline-error" role="status">{snapshot.error}</div>}

      <section className="coach-focus-section" aria-labelledby="coach-today-heading">
        <div className="coach-section-label" id="coach-today-heading">Today</div>
        {focus ? (
          <div className="coach-focus">
            <span className="coach-kicker">Main focus</span>
            <h2>{focus.title}</h2>
            {(focusEstimate || focusWhen) && (
              <div className="coach-focus-meta">
                {focusEstimate && <span>{focusEstimate}</span>}
                {focusWhen && <span>{focusWhen}</span>}
              </div>
            )}
          </div>
        ) : (
          <p className="coach-quiet">Nothing urgent right now.</p>
        )}
      </section>

      <Attention home={home} />

      {home.today.commitments.length > 0 && (
        <section className="coach-section" aria-labelledby="coach-commitments-heading">
          <div className="coach-section-head">
            <h3 id="coach-commitments-heading">Commitments</h3>
            {home.today.overflowCount > 0 && <span className="coach-meta">+{home.today.overflowCount} later</span>}
          </div>
          <div className="coach-list">
            {home.today.commitments.map((item) => <CommitmentRow key={item.id} item={item} client={client} />)}
          </div>
        </section>
      )}

      {home.today.dueRoutines.length > 0 && (
        <section className="coach-section" aria-labelledby="coach-routines-heading">
          <div className="coach-section-head"><h3 id="coach-routines-heading">Routines today</h3></div>
          <div className="coach-routine-list">
            {home.today.dueRoutines.map((routine) => (
              <div className="coach-routine-row" key={routine.id}>
                <span>{routine.title}</span>
                {routine.preferredMinuteOfDay !== undefined && (
                  <span className="coach-meta">{String(Math.floor(routine.preferredMinuteOfDay / 60)).padStart(2, "0")}:{String(routine.preferredMinuteOfDay % 60).padStart(2, "0")}</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="coach-section" aria-labelledby="coach-checkin-heading">
        <div className="coach-section-head"><h3 id="coach-checkin-heading">Check-in</h3></div>
        <CheckIn client={client} />
      </section>

      {home.activeGoals.length > 0 && (
        <section className="coach-section" aria-labelledby="coach-goals-heading">
          <div className="coach-section-head"><h3 id="coach-goals-heading">Active goals</h3></div>
          <div className="coach-goal-list">{home.activeGoals.map((goal) => <GoalRow key={goal.id} goal={goal} />)}</div>
        </section>
      )}

      {home.insight && (
        <section className="coach-insight" aria-label="Current insight">
          <span className="coach-kicker">Worth noticing</span>
          <p>{home.insight.statement}</p>
          <span className="coach-meta">{home.insight.confidence} confidence</span>
        </section>
      )}

      <div className="coach-footer">
        <Button variant="primary" busy={snapshot.busy.has("talk")} onClick={() => void client.talk()}>
          Talk to Coach
        </Button>
      </div>
    </div>
  );
}

function WidgetShell({ children, label }: { children: ReactNode; label: string }) {
  return <section className="personal-coach-root coach-widget" aria-label={label}>{children}</section>;
}

export function TodayWidget({ client }: { client: CoachClient }) {
  const snapshot = useCoach(client);
  if (!snapshot.home) return <WidgetShell label="Today"><Status error={snapshot.error} onRetry={() => void client.refresh()} /></WidgetShell>;
  const home = snapshot.home;
  const focus = home.today.mainFocus ?? home.nextAction;
  if (!focus && home.today.dueRoutines.length === 0) {
    return <WidgetShell label="Today"><div className="coach-widget-empty"><strong>Nothing urgent.</strong><Button size="sm" variant="ghost" onClick={() => void client.talk()}>Plan</Button></div></WidgetShell>;
  }
  return (
    <WidgetShell label="Today">
      <div className="coach-widget-label">Today</div>
      {focus && <><strong className="coach-widget-focus">{focus.title}</strong><span className="coach-meta">{formatEstimate(focus.estimateMinutes) ?? formatWhen(focus.dueAt ?? focus.plannedFor) ?? "Main focus"}</span></>}
      <div className="coach-widget-actions">
        {focus && <Button size="sm" busy={snapshot.busy.has(`commitment:${focus.id}`)} onClick={() => void client.complete(focus.id)}>Done</Button>}
        <Button size="sm" variant="ghost" busy={snapshot.busy.has("talk")} onClick={() => void client.talk()}>Talk</Button>
      </div>
    </WidgetShell>
  );
}

export function NextActionWidget({ client }: { client: CoachClient }) {
  const snapshot = useCoach(client);
  if (!snapshot.home) return <WidgetShell label="Next action"><Status error={snapshot.error} onRetry={() => void client.refresh()} /></WidgetShell>;
  const next = snapshot.home.nextAction;
  return (
    <WidgetShell label="Next action">
      <div className="coach-widget-label">Next</div>
      <strong className="coach-widget-focus">{next?.title ?? "Nothing queued"}</strong>
      {next && <span className="coach-meta">{formatEstimate(next.estimateMinutes) ?? formatWhen(next.dueAt ?? next.plannedFor) ?? "When you're ready"}</span>}
    </WidgetShell>
  );
}

export function CommitmentsWidget({ client }: { client: CoachClient }) {
  const snapshot = useCoach(client);
  if (!snapshot.home) return <WidgetShell label="Commitments"><Status error={snapshot.error} onRetry={() => void client.refresh()} /></WidgetShell>;
  return (
    <WidgetShell label="Commitments">
      <div className="coach-widget-label">Commitments</div>
      {snapshot.home.today.commitments.length === 0
        ? <span className="coach-meta">Nothing committed for today.</span>
        : <div className="coach-list">{snapshot.home.today.commitments.map((item) => <CommitmentRow key={item.id} item={item} client={client} compact />)}</div>}
    </WidgetShell>
  );
}

export function GoalWidget({ client }: { client: CoachClient }) {
  const snapshot = useCoach(client);
  if (!snapshot.home) return <WidgetShell label="Goal"><Status error={snapshot.error} onRetry={() => void client.refresh()} /></WidgetShell>;
  const goal = snapshot.home.activeGoals[0];
  return (
    <WidgetShell label="Goal">
      <div className="coach-widget-label">Goal</div>
      <strong className="coach-widget-focus">{goal?.title ?? "No active goal"}</strong>
      {goal?.desiredOutcome && <span className="coach-meta">{goal.desiredOutcome}</span>}
      {!goal && <Button size="sm" variant="ghost" busy={snapshot.busy.has("talk")} onClick={() => void client.talk()}>Choose one</Button>}
    </WidgetShell>
  );
}

export function CheckInWidget({ client }: { client: CoachClient }) {
  const snapshot = useCoach(client);
  if (!snapshot.home) return <WidgetShell label="Check-in"><Status error={snapshot.error} onRetry={() => void client.refresh()} /></WidgetShell>;
  return <WidgetShell label="Check-in"><div className="coach-widget-label">Check-in</div><CheckIn client={client} condensed /></WidgetShell>;
}
