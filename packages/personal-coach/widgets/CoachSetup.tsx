import { useEffect, useId, useState, type ChangeEvent } from "react";
import type { CoachSetupPreferences } from "./journeyApi.ts";
import { useCoach } from "./store.ts";
import GoalsPanel from "./GoalsPanel.tsx";
import ReviewPanel from "./ReviewPanel.tsx";
import type { CoachUiProps } from "./parts.tsx";

const localTimeZone = (): string => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
};
const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const minuteOfDay = (value: string, fallback: number) => {
  if (!/^\d{2}:\d{2}$/.test(value)) return fallback;
  const [hours, minutes] = value.split(":").map(Number);
  return hours! < 24 && minutes! < 60 ? hours! * 60 + minutes! : fallback;
};

function Preferences({ client, api, ui, friendlyError }: CoachUiProps) {
  const { home, busy } = useCoach(client);
  const { Button, Select, TextInput } = ui;
  const profile = home!.profile;
  const [preferences, setPreferences] = useState<CoachSetupPreferences>(() => ({
    confirm: true,
    tone: profile.tone,
    initiative: profile.initiative,
    timeZone: profile.onboardingState === "new" ? localTimeZone() : profile.timeZone,
    challengeAssumptions: profile.challengeAssumptions,
    dailyCheckIn: false, dailyMinuteOfDay: 480,
    weeklyReview: false, weeklyDay: 0, weeklyMinuteOfDay: 1080,
  }));
  const [available, setAvailable] = useState<boolean | null>(null), [error, setError] = useState("");
  const id = useId();
  useEffect(() => {
    let live = true;
    void api.reminders().then((response) => { if (live) setAvailable(response.available); })
      .catch((cause) => { if (live) { setAvailable(false); setError(friendlyError("Check reminders", cause)); } });
    return () => { live = false; };
  }, [api, friendlyError]);
  const patch = (value: Partial<CoachSetupPreferences>) => setPreferences((current) => ({ ...current, ...value }));
  const disabled = busy.has("setup");
  const remindersOn = preferences.dailyCheckIn || preferences.weeklyReview;
  return <form className="coach-form" onSubmit={(event) => { event.preventDefault(); void client.finishSetup(preferences); }}>
    <div className="coach-intro"><h2>Make Coach work for you.</h2><p>Keep it quiet, or choose a little more support. You can change all of this later.</p></div>
    <fieldset disabled={disabled} className="coach-preferences">
      <legend>Communication</legend>
      <Select label="Coaching style" ariaLabel="Coaching style" value={preferences.tone} onChange={(tone: string) => patch({ tone: tone as CoachSetupPreferences["tone"] })} options={[
        { value: "supportive", label: "Supportive", detail: "Encouraging and gentle" }, { value: "balanced", label: "Balanced", detail: "Calm and practical" }, { value: "direct", label: "Direct", detail: "Concise and candid" },
      ]} />
      <label className="coach-field" htmlFor={`${id}-zone`}><span>Time zone</span><TextInput {...{ id: `${id}-zone`, maxLength: 120, spellCheck: false }} value={preferences.timeZone} placeholder="Europe/Kyiv" onChange={(event) => patch({ timeZone: event.target.value })} /></label>
      <details className="coach-history"><summary>Conversation preferences</summary><div className="coach-form">
        <Select label="Initiative" ariaLabel="Coach initiative" value={preferences.initiative} onChange={(initiative: string) => patch({ initiative: initiative as CoachSetupPreferences["initiative"] })} options={[
          { value: "reactive", label: "Wait for me to ask" }, { value: "balanced", label: "Raise important things" }, { value: "proactive", label: "Actively suggest next steps" },
        ]} />
        <Select label="Challenge my assumptions" ariaLabel="Challenge my assumptions" value={String(preferences.challengeAssumptions)} onChange={(value: string) => patch({ challengeAssumptions: value === "true" })} options={[
          { value: "false", label: "Only when I ask" }, { value: "true", label: "Point out useful contradictions" },
        ]} />
      </div></details>
    </fieldset>
    <fieldset disabled={disabled || available !== true} className="coach-preferences">
      <legend>Reminders · optional</legend>
      <p className="coach-meta">Off by default. Each enabled reminder starts a scheduled Coach conversation and may use model tokens.</p>
      <div className="coach-preference-row"><Select label="Daily check-in" ariaLabel="Daily check-in" value={String(preferences.dailyCheckIn)} onChange={(value: string) => patch({ dailyCheckIn: value === "true" })} options={[
        { value: "false", label: "Off" }, { value: "true", label: "Every day" },
      ]} />{preferences.dailyCheckIn && <TextInput type="time" aria-label="Daily check-in time" value={clock(preferences.dailyMinuteOfDay)} onChange={(event) => patch({ dailyMinuteOfDay: minuteOfDay(event.target.value, preferences.dailyMinuteOfDay) })} />}</div>
      <div className="coach-preference-row"><Select label="Weekly review" ariaLabel="Weekly review" value={String(preferences.weeklyReview)} onChange={(value: string) => patch({ weeklyReview: value === "true" })} options={[
        { value: "false", label: "Off" }, { value: "true", label: "Every week" },
      ]} />{preferences.weeklyReview && <>
        <Select label="Review day" ariaLabel="Weekly review day" value={String(preferences.weeklyDay)} onChange={(value: string) => patch({ weeklyDay: Number(value) })} options={[
          { value: "1", label: "Monday" }, { value: "2", label: "Tuesday" }, { value: "3", label: "Wednesday" }, { value: "4", label: "Thursday" }, { value: "5", label: "Friday" }, { value: "6", label: "Saturday" }, { value: "0", label: "Sunday" },
        ]} />
        <TextInput type="time" aria-label="Weekly review time" value={clock(preferences.weeklyMinuteOfDay)} onChange={(event) => patch({ weeklyMinuteOfDay: minuteOfDay(event.target.value, preferences.weeklyMinuteOfDay) })} />
      </>}</div>
    </fieldset>
    {available === null && <p className="coach-meta" role="status">Checking reminder availability… You can finish with reminders off.</p>}
    {available === false && <p className="coach-meta">Reminders are unavailable. You can still finish setup and use Coach.</p>}
    {error && <p className="coach-meta" role="status">{error}</p>}
    <p className="coach-meta">{remindersOn ? "Only the reminders selected above will be enabled." : "No daily or weekly reminders will be enabled."}</p>
    <Button type="submit" variant="primary" busy={disabled}>Finish setup{remindersOn ? "" : " without reminders"}</Button>
  </form>;
}

export default function CoachSetup(props: CoachUiProps) {
  const { client, ui } = props;
  const { Button, Textarea } = ui;
  const snapshot = useCoach(client);
  const state = snapshot.home!.profile.onboardingState;
  const [step, setStep] = useState<"direction" | "plan" | "preferences">(state === "started" || snapshot.home!.activeGoals.length > 0 ? "plan" : "direction");
  const [text, setText] = useState("");
  const [review, setReview] = useState(false);
  const [goalId, setGoalId] = useState<string | null>(null);
  const id = useId();
  useEffect(() => { if (state === "started") setStep((current) => current === "direction" ? "plan" : current); }, [state]);
  const busy = snapshot.busy.has("talk") || snapshot.busy.has("setup");
  return <div className="coach-setup">
    <nav className="coach-steps" aria-label="Coach setup progress">{[
      ["direction", "Your direction"], ["plan", "First steps"], ["preferences", "Your preferences"],
    ].map(([key, label], index) => <Button key={key} size="sm" variant={step === key ? "quiet" : "ghost"} disabled={busy} aria-current={step === key ? "step" : undefined} onClick={() => setStep(key as typeof step)}><span className="coach-step-number" aria-hidden>{index + 1}</span>{label}</Button>)}</nav>
    {step === "direction" && <form className="coach-form" onSubmit={(event) => {
      event.preventDefault();
      if (text.trim() && !busy) {
        if (state === "started") void client.talk(text.trim());
        else void client.start(text.trim(), localTimeZone());
      }
    }}>
      <div className="coach-intro"><span className="coach-kicker">Less planning. A clearer next step.</span><h2>What would you like to make progress on?</h2><p>Tell Coach what matters and what's getting in the way. Together you'll choose a direction and a realistic first step.</p></div>
      <label className="coach-field" htmlFor={id}><span>Your direction</span><Textarea id={id} rows={4} value={text} maxLength={4000} placeholder="I'd like to…" disabled={busy} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)} /></label>
      <div className="coach-starters" aria-label="Examples">{[
        ["Ship a project", "I'd like to ship a project, but I need help deciding what matters first."],
        ["Learn something", "I'd like to learn something consistently without overloading my week."],
        ["Build a routine", "I'd like to build a realistic routine that fits the time I actually have."],
      ].map(([label, example]) => <Button key={label} size="sm" variant="ghost" disabled={busy} onClick={() => setText(example!)}>{label}</Button>)}</div>
      <div className="coach-actions"><Button type="submit" variant="primary" busy={snapshot.busy.has("talk")} disabled={!text.trim()}>{snapshot.talkStage === "opening" ? "Opening conversation…" : snapshot.busy.has("talk") ? "Starting Coach…" : "Start with this"}</Button><Button variant="ghost" disabled={busy} onClick={() => setStep("plan")}>Set up manually</Button></div>
      {state === "started" && <Button variant="ghost" disabled={busy} onClick={() => void client.talk()}>Continue the setup conversation</Button>}
      <p className="coach-meta">Your saved goals stay in this Space, not in one chat. Model-generated plans need your approval.</p>
    </form>}
    {step === "plan" && <div className="coach-form">
      <div className="coach-intro"><h2>Start small. Make it yours.</h2><p>Keep one useful goal and a next step. You can create them yourself or review Coach's suggestions.</p></div>
      <div className="coach-actions"><Button size="sm" variant="primary" busy={snapshot.busy.has("talk")} onClick={() => void client.talk()}>{state === "started" ? "Continue with Coach" : "Help me choose"}</Button><Button size="sm" variant="ghost" onClick={() => setReview(!review)}>{review ? "Show my goals" : "Review suggestions"}</Button></div>
      {review ? <ReviewPanel {...props} /> : <GoalsPanel {...props} selectedGoalId={goalId} onSelectGoal={setGoalId} />}
      <Button variant="primary" disabled={busy} onClick={() => setStep("preferences")}>Choose preferences</Button>
      <p className="coach-meta">A formal plan is optional. You can also leave this empty and add a goal later.</p>
    </div>}
    {step === "preferences" && <Preferences {...props} />}
  </div>;
}
