import { useEffect, useId, useState, type ChangeEvent } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { CoachCommitmentDto, CoachGoalDto, CoachPlanDetailDto, CoachPlanDto, CoachProposalDto } from "./api.ts";
import type { CoachJourneyApi } from "./journeyApi.ts";
import type { CoachClient } from "./store.ts";
import { useCoach } from "./store.ts";
import { CommitmentRow } from "./CoachView.tsx";
import ProposalCard from "./ProposalCard.tsx";

export interface CoachUiProps {
  api: CoachJourneyApi;
  client: CoachClient;
  ui: WebPackageHost["ui"]["components"];
  friendlyError(action: string, cause: unknown): string;
}

export function QuickCommitment({ api, client, ui, friendlyError, goalId }: CoachUiProps & { goalId?: string }) {
  const { Button, TextInput } = ui;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = useId();
  return <form className="coach-quick-add" onSubmit={(event) => {
    event.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true); setError("");
    void api.createCommitment({ title: text.trim(), plannedFor: Date.now(), ...(goalId ? { goalId } : {}) })
      .then(async () => { setText(""); await client.refresh(); })
      .catch((cause) => setError(friendlyError("Add next step", cause)))
      .finally(() => setBusy(false));
  }}>
    <label className="coach-field" htmlFor={id}><span>A small next step</span><TextInput {...{ id, maxLength: 240 }} value={text} placeholder="Something you can actually do today" disabled={busy} onChange={(event) => setText(event.target.value)} /></label>
    <Button type="submit" size="sm" busy={busy} disabled={!text.trim()}>Add step</Button>
    {error && <p className="coach-inline-error" role="alert">{error}</p>}
  </form>;
}

function GoalEditor({ goal, onSaved, ...props }: CoachUiProps & { goal: CoachGoalDto; onSaved(): void }) {
  const { api, client, ui, friendlyError } = props;
  const { TextInput, Textarea, Button } = ui;
  const [title, setTitle] = useState(goal.title), [outcome, setOutcome] = useState(goal.desiredOutcome ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const id = useId();
  return <form className="coach-form" onSubmit={(event) => {
    event.preventDefault(); if (busy || !title.trim()) return;
    setBusy(true); setError("");
    void api.updateGoal(goal.id, { title: title.trim(), desiredOutcome: outcome.trim() })
      .then(async () => { await client.refresh(); onSaved(); })
      .catch((cause) => setError(friendlyError("Save goal", cause))).finally(() => setBusy(false));
  }}>
    <label className="coach-field" htmlFor={`${id}-title`}><span>Goal</span><TextInput {...{ id: `${id}-title`, maxLength: 240 }} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label className="coach-field" htmlFor={`${id}-outcome`}><span>What would success look like?</span><Textarea id={`${id}-outcome`} rows={2} maxLength={1000} value={outcome} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setOutcome(event.target.value)} /></label>
    <div className="coach-actions"><Button type="submit" size="sm" busy={busy} disabled={!title.trim()}>Save</Button><Button size="sm" variant="ghost" disabled={busy} onClick={onSaved}>Cancel</Button></div>
    {error && <p className="coach-inline-error" role="alert">{error}</p>}
  </form>;
}

export function GoalsPanel(props: CoachUiProps) {
  const { api, client, ui, friendlyError } = props;
  const { Button, TextInput, Select } = ui;
  const snapshot = useCoach(client);
  const [data, setData] = useState<{ goals: CoachGoalDto[]; commitments: CoachCommitmentDto[] } | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0), [busy, setBusy] = useState<string | null>(null);
  const [title, setTitle] = useState(""), [editing, setEditing] = useState<string | null>(null);
  const [filter, setFilter] = useState("active");
  const id = useId();
  useEffect(() => {
    let live = true; setError("");
    void Promise.all([api.goals(), api.commitments()]).then(([goals, commitments]) => { if (live) setData({ goals, commitments }); })
      .catch((cause) => { if (live) setError(friendlyError("Load goals", cause)); });
    return () => { live = false; };
  }, [api, friendlyError, snapshot.home?.revision, retry]);
  const changeStatus = async (goal: CoachGoalDto, status: CoachGoalDto["status"]) => {
    if (busy) return;
    setBusy(goal.id); setError("");
    try { await api.updateGoal(goal.id, { status }); await client.refresh(); setRetry((n) => n + 1); }
    catch (cause) { setError(friendlyError("Update goal", cause)); }
    finally { setBusy(null); }
  };
  const goals = data?.goals.filter((goal) => filter === "all" || goal.status === filter) ?? [];
  return <div className="coach-detail-panel">
    <div className="coach-section-head"><h3>Where you're heading</h3><Select label="Goal status" ariaLabel="Goal status" value={filter} onChange={setFilter} options={[
      { value: "active", label: "Active" }, { value: "paused", label: "Paused" }, { value: "completed", label: "Completed" }, { value: "all", label: "All goals" },
    ]} /></div>
    <form className="coach-quick-add" onSubmit={(event) => {
      event.preventDefault(); if (!title.trim() || busy) return;
      setBusy("new"); setError("");
      void api.createGoal({ title: title.trim() }).then(async () => { setTitle(""); setFilter("active"); await client.refresh(); setRetry((n) => n + 1); })
        .catch((cause) => setError(friendlyError("Add goal", cause))).finally(() => setBusy(null));
    }}><label className="coach-field" htmlFor={id}><span>A direction that matters</span><TextInput {...{ id, maxLength: 240 }} value={title} disabled={busy === "new"} placeholder="For example, ship a first public beta" onChange={(event) => setTitle(event.target.value)} /></label><Button type="submit" size="sm" busy={busy === "new"} disabled={!title.trim() || busy !== null}>Add goal</Button></form>
    {error && <div className="coach-inline-error" role="alert">{error}<Button size="sm" variant="ghost" onClick={() => setRetry((n) => n + 1)}>Refresh</Button></div>}
    {!data && !error && <p role="status" className="coach-meta">Loading goals…</p>}
    {data && goals.length === 0 && <p className="coach-quiet">{filter === "active" ? "Start with one meaningful direction. You don't need a perfect plan." : "No goals in this view."}</p>}
    {goals.map((goal) => <article key={goal.id} className="coach-goal-detail">
      {editing === goal.id ? <GoalEditor {...props} goal={goal} onSaved={() => { setEditing(null); setRetry((n) => n + 1); }} /> : <>
        <div className="coach-section-head"><h3>{goal.title}</h3><span className="coach-meta">{goal.status}</span></div>
        {goal.desiredOutcome && <p className="coach-meta">{goal.desiredOutcome}</p>}
        <div className="coach-actions">
          <Button size="sm" variant="ghost" onClick={() => setEditing(goal.id)}>Edit</Button>
          <Button size="sm" variant="ghost" busy={snapshot.busy.has("talk")} onClick={() => void client.talk("Coach · Goal review", `Review goal ${goal.id}: ${goal.title}. Read its stored details and open commitments. Help me choose a realistic next step; strategic changes need my approval.`)}>Discuss</Button>
          {goal.status === "active" && <><Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void changeStatus(goal, "paused")}>Pause</Button><Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void changeStatus(goal, "completed")}>Complete goal</Button></>}
          {goal.status !== "active" && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void changeStatus(goal, "active")}>Resume</Button>}
        </div>
      </>}
      <div className="coach-list">{data?.commitments.filter((item) => item.goalId === goal.id).map((item) => <CommitmentRow key={item.id} item={item} client={client} />)}</div>
      {goal.status === "active" && <QuickCommitment {...props} goalId={goal.id} />}
    </article>)}
    {data && data.commitments.some((item) => !item.goalId) && <section className="coach-section" aria-label="Other commitments"><h3>Other commitments</h3>{data.commitments.filter((item) => !item.goalId).map((item) => <CommitmentRow key={item.id} item={item} client={client} />)}</section>}
  </div>;
}

export function PlansPanel(props: CoachUiProps) {
  const { api, client, ui, friendlyError } = props;
  const { Button, Select } = ui;
  const snapshot = useCoach(client);
  const [data, setData] = useState<{ plans: CoachPlanDto[]; proposals: CoachProposalDto[] } | null>(null);
  const [selected, setSelected] = useState(""), [detail, setDetail] = useState<CoachPlanDetailDto | null>(null);
  const [error, setError] = useState(""), [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true; setError("");
    void Promise.all([api.plans(), api.proposals()]).then(([plans, proposals]) => {
      if (!live) return;
      setData({ plans, proposals });
      setSelected((current) => plans.some((plan) => plan.id === current) ? current : plans[0]?.id ?? "");
    }).catch((cause) => { if (live) setError(friendlyError("Load plan", cause)); });
    return () => { live = false; };
  }, [api, friendlyError, snapshot.home?.revision, retry]);
  useEffect(() => {
    let live = true; setDetail(null);
    if (selected) void api.plan(selected).then((plan) => { if (live) setDetail(plan); })
      .catch((cause) => { if (live) setError(friendlyError("Load plan details", cause)); });
    return () => { live = false; };
  }, [api, friendlyError, selected, snapshot.home?.revision, retry]);
  const revisions = detail ? [...detail.revisions].sort((a, b) => b.revision - a.revision) : [];
  return <div className="coach-detail-panel">
    <div className="coach-section-head"><h3>A plan you can change</h3><Button size="sm" variant="ghost" busy={snapshot.busy.has("talk")} onClick={() => void client.talk("Coach · Plan", "Help me make or adjust my plan using my current goals and commitments. Read the existing plan first. Present strategic changes as proposals, not automatic changes.")}>Discuss plan</Button></div>
    <p className="coach-meta">Suggestions stay separate from what you've agreed to. Apply only what feels realistic.</p>
    {error && <div className="coach-inline-error" role="alert">{error}<Button size="sm" variant="ghost" onClick={() => setRetry((n) => n + 1)}>Retry</Button></div>}
    {!data && !error && <p className="coach-meta" role="status">Loading plan…</p>}
    {data && <section className="coach-section" aria-label="Suggestions to review"><h3>For your review{data.proposals.length ? ` · ${data.proposals.length}` : ""}</h3>
      {data.proposals.length ? data.proposals.map((proposal) => <ProposalCard key={proposal.id} proposalId={proposal.id} api={api} client={client} friendlyError={friendlyError} />) : <p className="coach-quiet">No pending suggestions. Nothing changes without your approval.</p>}
    </section>}
    {data && data.plans.length > 0 && <section className="coach-section" aria-label="Current plan">
      {data.plans.length > 1 && <Select label="Current plan" ariaLabel="Current plan" value={selected} onChange={setSelected} options={data.plans.map((plan) => ({ value: plan.id, label: plan.title }))} />}
      {detail ? <><h3>{detail.title}</h3><p>{revisions[0]?.summary ?? "No revision summary yet."}</p>
        <span className="coach-meta">Revision {detail.currentRevision}</span>
        {revisions.length > 1 && <details className="coach-history"><summary>How this plan evolved</summary>{revisions.slice(1).map((revision) => <article key={revision.revision}><strong>Revision {revision.revision}</strong><p>{revision.summary}</p><span className="coach-meta">{new Date(revision.createdAt).toLocaleDateString()}</span></article>)}</details>}
      </> : !error && <p className="coach-meta" role="status">Loading current plan…</p>}
    </section>}
    {data?.plans.length === 0 && <p className="coach-quiet">No formal plan yet. A goal and one next step are already a good start.</p>}
  </div>;
}
