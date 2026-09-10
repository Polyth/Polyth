import { useEffect, useState } from "react";
import { PageHead } from "../../../apps/web/src/components/settings/parts.tsx";
import {
  Button,
  confirmAlert,
  Select,
  Switch,
  TextInput,
} from "../../../apps/web/src/components/ui/index.ts";
import type {
  CoachApi,
  CoachProfileDto,
  CoachReminderPatch,
  CoachRemindersDto,
  CoachSettingsPatch,
} from "./api.ts";
import type { CoachClient } from "./store.ts";

const minuteText = (value: number): string => {
  const minute = Math.max(0, Math.min(1439, Math.trunc(value)));
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
};

const minuteValue = (value: string): number | undefined => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  return hour * 60 + minute;
};

const reminderPatch = (response: CoachRemindersDto): CoachReminderPatch | null => {
  const settings = response.settings;
  if (!response.available || !settings) return null;
  return {
    dailyCheckIn: settings.dailyCheckIn.enabled,
    dailyMinuteOfDay: settings.dailyCheckIn.minuteOfDay,
    weeklyReview: settings.weeklyReview.enabled,
    weeklyDay: settings.weeklyReview.day,
    weeklyMinuteOfDay: settings.weeklyReview.minuteOfDay,
  };
};

const profileDraft = (profile: CoachProfileDto): CoachSettingsPatch => ({
  tone: profile.tone,
  initiative: profile.initiative,
  timeZone: profile.timeZone,
  challengeAssumptions: profile.challengeAssumptions,
});

export default function CoachSettingsPage({
  api,
  client,
  friendlyError,
}: {
  api: CoachApi;
  client: CoachClient;
  friendlyError(action: string, cause: unknown): string;
}) {
  const [profile, setProfile] = useState<CoachProfileDto | null>(null);
  const [draft, setDraft] = useState<CoachSettingsPatch>({});
  const [reminders, setReminders] = useState<CoachRemindersDto | null>(null);
  const [reminderDraft, setReminderDraft] = useState<CoachReminderPatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = async () => {
    setError("");
    try {
      const settings = await api.settings();
      setProfile(settings.profile);
      setDraft(profileDraft(settings.profile));
      if (settings.profile.onboardingState === "complete") {
        const nextReminders = await api.reminders();
        setReminders(nextReminders);
        setReminderDraft(reminderPatch(nextReminders));
      } else {
        setReminders(null);
        setReminderDraft(null);
      }
    } catch (cause) {
      setError(friendlyError("Load Personal Coach settings", cause));
    }
  };

  useEffect(() => { void load(); }, []);

  const save = async () => {
    if (!profile || busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const next = await api.updateSettings(draft);
      setProfile(next);
      setDraft(profileDraft(next));
      if (next.onboardingState === "complete" && reminders?.available && reminderDraft) {
        const nextReminders = await api.updateReminders(reminderDraft);
        setReminders(nextReminders);
        setReminderDraft(reminderPatch(nextReminders));
      }
      setSaved(true);
      await client.refresh();
    } catch (cause) {
      setError(friendlyError("Save Personal Coach settings", cause));
    } finally {
      setBusy(false);
    }
  };

  const resetState = async () => {
    if (busy) return;
    const confirmed = await confirmAlert(
      "Delete Coach goals, commitments, routines, plans, check-ins, reflections, insights, and Coach-owned schedules? Existing Polyth chat transcripts and your Coach style/time-zone preferences stay.",
      { title: "Reset Coach state?", confirmLabel: "Reset Coach", destructive: true },
    );
    if (!confirmed) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result = await api.resetState();
      setProfile(result.profile);
      setDraft(profileDraft(result.profile));
      setReminders(null);
      setReminderDraft(null);
      await client.refresh();
    } catch (cause) {
      setError(friendlyError("Reset Personal Coach state", cause));
    } finally {
      setBusy(false);
    }
  };

  const updateReminder = (patch: Partial<CoachReminderPatch>) => {
    setReminderDraft((current) => current ? { ...current, ...patch } : current);
  };

  return (
    <div className="personal-coach-settings" data-settings-item="personal-coach-behavior">
      <PageHead
        title="Personal Coach"
        blurb="Tune how Coach communicates and how proactively it helps. Goals, commitments, and plans stay unchanged."
      />

      {!profile && !error && <div role="status">Loading Coach settings…</div>}
      {error && <div className="form-error" role="alert">{error}</div>}

      {profile && (
        <>
          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-label">Style</div>
              <div className="set-row-hint">How Coach phrases guidance. This does not create separate personas or separate memory.</div>
            </div>
            <div className="set-row-control">
              <Select
                label="Coach style"
                ariaLabel="Coach style"
                value={draft.tone ?? profile.tone}
                onChange={(tone) => setDraft((current) => ({ ...current, tone: tone as CoachProfileDto["tone"] }))}
                options={[
                  { value: "supportive", label: "Supportive", detail: "Encouraging and gentle" },
                  { value: "balanced", label: "Balanced", detail: "Calm and practical" },
                  { value: "direct", label: "Direct", detail: "Concise and candid" },
                ]}
              />
            </div>
          </div>

          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-label">Initiative</div>
              <div className="set-row-hint">How readily Coach raises useful next steps during a conversation. Scheduled check-ins are controlled below.</div>
            </div>
            <div className="set-row-control">
              <Select
                label="Coach initiative"
                ariaLabel="Coach initiative"
                value={draft.initiative ?? profile.initiative}
                onChange={(initiative) => setDraft((current) => ({ ...current, initiative: initiative as CoachProfileDto["initiative"] }))}
                options={[
                  { value: "reactive", label: "Reactive", detail: "Wait for me to ask" },
                  { value: "balanced", label: "Balanced", detail: "Raise important things when useful" },
                  { value: "proactive", label: "Proactive", detail: "Actively surface next steps" },
                ]}
              />
            </div>
          </div>

          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-label" id="coach-challenge-label">Challenge my assumptions</div>
              <div className="set-row-hint">Let Coach point out weak assumptions or contradictions when they materially affect the plan.</div>
            </div>
            <div className="set-row-control">
              <Switch
                labelledBy="coach-challenge-label"
                checked={draft.challengeAssumptions ?? profile.challengeAssumptions}
                onChange={(challengeAssumptions) => setDraft((current) => ({ ...current, challengeAssumptions }))}
              />
            </div>
          </div>

          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-label">Time zone</div>
              <div className="set-row-hint">IANA zone used for Today, routines, and Coach-created schedules.</div>
            </div>
            <div className="set-row-control">
              <TextInput
                aria-label="Coach time zone"
                value={draft.timeZone ?? profile.timeZone}
                spellCheck={false}
                placeholder="Europe/Kyiv"
                onChange={(event) => setDraft((current) => ({ ...current, timeZone: event.target.value }))}
              />
            </div>
          </div>

          {profile.onboardingState === "complete" && reminders?.available && reminderDraft && (
            <>
              <div className="set-row" data-settings-item="personal-coach-reminders">
                <div className="set-row-text">
                  <div className="set-row-label" id="coach-daily-label">Daily check-in</div>
                  <div className="set-row-hint">One short scheduled Coach session. No background model work happens between runs.</div>
                </div>
                <div className="set-row-control set-add-form">
                  <Switch
                    labelledBy="coach-daily-label"
                    checked={reminderDraft.dailyCheckIn}
                    onChange={(dailyCheckIn) => updateReminder({ dailyCheckIn })}
                  />
                  <TextInput
                    type="time"
                    aria-label="Daily check-in time"
                    disabled={!reminderDraft.dailyCheckIn}
                    value={minuteText(reminderDraft.dailyMinuteOfDay)}
                    onChange={(event) => {
                      const value = minuteValue(event.target.value);
                      if (value !== undefined) updateReminder({ dailyMinuteOfDay: value });
                    }}
                  />
                </div>
              </div>

              <div className="set-row">
                <div className="set-row-text">
                  <div className="set-row-label" id="coach-weekly-label">Weekly review</div>
                  <div className="set-row-hint">Review durable activity and propose changes only when there is evidence.</div>
                </div>
                <div className="set-row-control set-add-form">
                  <Switch
                    labelledBy="coach-weekly-label"
                    checked={reminderDraft.weeklyReview}
                    onChange={(weeklyReview) => updateReminder({ weeklyReview })}
                  />
                  <Select
                    label="Weekly review day"
                    ariaLabel="Weekly review day"
                    disabled={!reminderDraft.weeklyReview}
                    value={String(reminderDraft.weeklyDay)}
                    onChange={(value) => updateReminder({ weeklyDay: Number(value) })}
                    options={[
                      { value: "1", label: "Monday" },
                      { value: "2", label: "Tuesday" },
                      { value: "3", label: "Wednesday" },
                      { value: "4", label: "Thursday" },
                      { value: "5", label: "Friday" },
                      { value: "6", label: "Saturday" },
                      { value: "0", label: "Sunday" },
                    ]}
                  />
                  <TextInput
                    type="time"
                    aria-label="Weekly review time"
                    disabled={!reminderDraft.weeklyReview}
                    value={minuteText(reminderDraft.weeklyMinuteOfDay)}
                    onChange={(event) => {
                      const value = minuteValue(event.target.value);
                      if (value !== undefined) updateReminder({ weeklyMinuteOfDay: value });
                    }}
                  />
                </div>
              </div>
            </>
          )}

          {profile.onboardingState === "complete" && reminders && !reminders.available && (
            <div className="set-row">
              <div className="set-row-text">
                <div className="set-row-label">Scheduled check-ins</div>
                <div className="set-row-hint">The Schedule package is unavailable. Coach itself still works normally.</div>
              </div>
              <div className="set-row-control"><span className="tag">Unavailable</span></div>
            </div>
          )}

          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-label">Setup</div>
              <div className="set-row-hint">{profile.onboardingState === "complete" ? "Initial Coach setup is complete." : "Coach will finish its short setup in chat."}</div>
            </div>
            <div className="set-row-control">
              <span className="tag">{profile.onboardingState}</span>
            </div>
          </div>

          <div className="set-row" data-settings-item="personal-coach-data">
            <div className="set-row-text">
              <div className="set-row-label">Coach state</div>
              <div className="set-row-hint">Clear goals, commitments, routines, plans, check-ins, reflections, insights, and Coach-owned schedules. Existing chat transcripts and communication preferences stay.</div>
            </div>
            <div className="set-row-control">
              <Button variant="danger" disabled={busy} onClick={() => void resetState()}>Reset Coach state</Button>
            </div>
          </div>

          <div className="set-add-form">
            <Button variant="primary" busy={busy} onClick={() => void save()}>Save changes</Button>
            {saved && <span className="set-row-hint" role="status">Saved</span>}
          </div>
        </>
      )}
    </div>
  );
}
