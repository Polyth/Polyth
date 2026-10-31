import { useEffect, useId, useState, type ChangeEvent } from "react";
import type { CoachSetupPreferences } from "./journeyApi.ts";
import { useCoach } from "./store.ts";
import GoalsPanel from "./GoalsPanel.tsx";
import ReviewPanel from "./ReviewPanel.tsx";
import type { CoachUiProps } from "./parts.tsx";
import { t } from "./strings.ts";

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
      .catch((cause) => { if (live) { setAvailable(false); setError(friendlyError(t("coach.setup.error.reminders"), cause)); } });
    return () => { live = false; };
  }, [api, friendlyError]);
  const patch = (value: Partial<CoachSetupPreferences>) => setPreferences((current) => ({ ...current, ...value }));
  const disabled = busy.has("setup");
  const remindersOn = preferences.dailyCheckIn || preferences.weeklyReview;
  return <form className="coach-form" onSubmit={(event) => { event.preventDefault(); void client.finishSetup(preferences); }}>
    <div className="coach-intro"><h2>{t("coach.setup.introTitle")}</h2><p>{t("coach.setup.introBody")}</p></div>
    <fieldset disabled={disabled} className="coach-preferences">
      <legend>{t("coach.setup.communication")}</legend>
      <Select label={t("coach.setup.styleLabel")} ariaLabel={t("coach.setup.styleLabel")} value={preferences.tone} onChange={(tone: string) => patch({ tone: tone as CoachSetupPreferences["tone"] })} options={[
        { value: "supportive", label: t("coach.settings.style.supportive"), detail: t("coach.settings.style.supportiveDetail") },
        { value: "balanced", label: t("coach.settings.style.balanced"), detail: t("coach.settings.style.balancedDetail") },
        { value: "direct", label: t("coach.settings.style.direct"), detail: t("coach.settings.style.directDetail") },
      ]} />
      <label className="coach-field" htmlFor={`${id}-zone`}><span>{t("coach.settings.timeZone")}</span><TextInput {...{ id: `${id}-zone`, maxLength: 120, spellCheck: false }} value={preferences.timeZone} placeholder="Europe/Kyiv" onChange={(event) => patch({ timeZone: event.target.value })} /></label>
      <details className="coach-history"><summary>{t("coach.setup.conversationPreferences")}</summary><div className="coach-form">
        <Select label={t("coach.settings.initiative")} ariaLabel={t("coach.settings.initiativeLabel")} value={preferences.initiative} onChange={(initiative: string) => patch({ initiative: initiative as CoachSetupPreferences["initiative"] })} options={[
          { value: "reactive", label: t("coach.setup.initiative.reactive") },
          { value: "balanced", label: t("coach.setup.initiative.balanced") },
          { value: "proactive", label: t("coach.setup.initiative.proactive") },
        ]} />
        <Select label={t("coach.settings.challenge")} ariaLabel={t("coach.settings.challenge")} value={String(preferences.challengeAssumptions)} onChange={(value: string) => patch({ challengeAssumptions: value === "true" })} options={[
          { value: "false", label: t("coach.setup.challenge.onlyWhenAsked") },
          { value: "true", label: t("coach.setup.challenge.pointOut") },
        ]} />
      </div></details>
    </fieldset>
    <fieldset disabled={disabled || available !== true} className="coach-preferences">
      <legend>{t("coach.setup.remindersLegend")}</legend>
      <p className="coach-meta">{t("coach.setup.remindersBody")}</p>
      <div className="coach-preference-row"><Select label={t("coach.settings.daily")} ariaLabel={t("coach.settings.daily")} value={String(preferences.dailyCheckIn)} onChange={(value: string) => patch({ dailyCheckIn: value === "true" })} options={[
        { value: "false", label: t("coach.setup.off") }, { value: "true", label: t("coach.setup.everyDay") },
      ]} />{preferences.dailyCheckIn && <TextInput type="time" aria-label={t("coach.settings.dailyTime")} value={clock(preferences.dailyMinuteOfDay)} onChange={(event) => patch({ dailyMinuteOfDay: minuteOfDay(event.target.value, preferences.dailyMinuteOfDay) })} />}</div>
      <div className="coach-preference-row"><Select label={t("coach.settings.weekly")} ariaLabel={t("coach.settings.weekly")} value={String(preferences.weeklyReview)} onChange={(value: string) => patch({ weeklyReview: value === "true" })} options={[
        { value: "false", label: t("coach.setup.off") }, { value: "true", label: t("coach.setup.everyWeek") },
      ]} />{preferences.weeklyReview && <>
        <Select label={t("coach.setup.reviewDay")} ariaLabel={t("coach.settings.weeklyDay")} value={String(preferences.weeklyDay)} onChange={(value: string) => patch({ weeklyDay: Number(value) })} options={[
          { value: "1", label: t("coach.settings.day.monday") }, { value: "2", label: t("coach.settings.day.tuesday") }, { value: "3", label: t("coach.settings.day.wednesday") }, { value: "4", label: t("coach.settings.day.thursday") }, { value: "5", label: t("coach.settings.day.friday") }, { value: "6", label: t("coach.settings.day.saturday") }, { value: "0", label: t("coach.settings.day.sunday") },
        ]} />
        <TextInput type="time" aria-label={t("coach.settings.weeklyTime")} value={clock(preferences.weeklyMinuteOfDay)} onChange={(event) => patch({ weeklyMinuteOfDay: minuteOfDay(event.target.value, preferences.weeklyMinuteOfDay) })} />
      </>}</div>
    </fieldset>
    {available === null && <p className="coach-meta" role="status">{t("coach.setup.checkingAvailability")}</p>}
    {available === false && <p className="coach-meta">{t("coach.setup.remindersUnavailable")}</p>}
    {error && <p className="coach-meta" role="status">{error}</p>}
    <p className="coach-meta">{remindersOn ? t("coach.setup.onlySelected") : t("coach.setup.noReminders")}</p>
    <Button type="submit" variant="primary" busy={disabled}>{remindersOn ? t("coach.setup.finish") : t("coach.setup.finishWithout")}</Button>
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
    <nav className="coach-steps" aria-label={t("coach.setup.stepsAria")}>{[
      ["direction", t("coach.setup.step.direction")], ["plan", t("coach.setup.step.plan")], ["preferences", t("coach.setup.step.preferences")],
    ].map(([key, label], index) => <Button key={key} size="sm" variant={step === key ? "quiet" : "ghost"} disabled={busy} aria-current={step === key ? "step" : undefined} onClick={() => setStep(key as typeof step)}><span className="coach-step-number" aria-hidden>{index + 1}</span>{label}</Button>)}</nav>
    {step === "direction" && <form className="coach-form" onSubmit={(event) => {
      event.preventDefault();
      if (text.trim() && !busy) {
        if (state === "started") void client.talk(text.trim());
        else void client.start(text.trim(), localTimeZone());
      }
    }}>
      <div className="coach-intro"><span className="coach-kicker">{t("coach.setup.kicker")}</span><h2>{t("coach.setup.directionTitle")}</h2><p>{t("coach.setup.directionBody")}</p></div>
      <label className="coach-field" htmlFor={id}><span>{t("coach.setup.step.direction")}</span><Textarea id={id} rows={4} value={text} maxLength={4000} placeholder={t("coach.setup.directionPlaceholder")} disabled={busy} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)} /></label>
      <div className="coach-starters" aria-label={t("coach.setup.examplesAria")}>{[
        [t("coach.setup.starter.ship"), t("coach.setup.starter.shipText")],
        [t("coach.setup.starter.learn"), t("coach.setup.starter.learnText")],
        [t("coach.setup.starter.routine"), t("coach.setup.starter.routineText")],
      ].map(([label, example]) => <Button key={label} size="sm" variant="ghost" disabled={busy} onClick={() => setText(example!)}>{label}</Button>)}</div>
      <div className="coach-actions"><Button type="submit" variant="primary" busy={snapshot.busy.has("talk")} disabled={!text.trim()}>{snapshot.talkStage === "opening" ? t("coach.ask.opening") : snapshot.busy.has("talk") ? t("coach.setup.starting") : t("coach.setup.startWithThis")}</Button><Button variant="ghost" disabled={busy} onClick={() => setStep("plan")}>{t("coach.setup.setUpManually")}</Button></div>
      {state === "started" && <Button variant="ghost" disabled={busy} onClick={() => void client.talk()}>{t("coach.setup.continueSetup")}</Button>}
      <p className="coach-meta">{t("coach.setup.savedNote")}</p>
    </form>}
    {step === "plan" && <div className="coach-form">
      <div className="coach-intro"><h2>{t("coach.setup.planTitle")}</h2><p>{t("coach.setup.planBody")}</p></div>
      <div className="coach-actions"><Button size="sm" variant="primary" busy={snapshot.busy.has("talk")} onClick={() => void client.talk()}>{state === "started" ? t("coach.setup.continueWithCoach") : t("coach.setup.helpMeChoose")}</Button><Button size="sm" variant="ghost" onClick={() => setReview(!review)}>{review ? t("coach.setup.showMyGoals") : t("coach.setup.reviewSuggestions")}</Button></div>
      {review ? <ReviewPanel {...props} /> : <GoalsPanel {...props} selectedGoalId={goalId} onSelectGoal={setGoalId} />}
      <Button variant="primary" disabled={busy} onClick={() => setStep("preferences")}>{t("coach.setup.choosePreferences")}</Button>
      <p className="coach-meta">{t("coach.setup.planNote")}</p>
    </div>}
    {step === "preferences" && <Preferences {...props} />}
  </div>;
}
