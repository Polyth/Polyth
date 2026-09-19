import { useEffect, useState } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import type {
  CoachApi,
  CoachProfileDto,
  CoachReminderPatch,
  CoachRemindersDto,
  CoachSettingsPatch,
} from "./api.ts";
import type { CoachUi } from "./parts.tsx";
import type { CoachClient } from "./store.ts";
import { t } from "./strings.ts";

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

const setupStatus = (state: CoachProfileDto["onboardingState"]): string => {
  if (state === "complete") return t("coach.settings.setupStatus.complete");
  if (state === "started") return t("coach.settings.setupStatus.started");
  return t("coach.settings.setupStatus.new");
};

export default function CoachSettingsPage({
  api,
  client,
  ui,
  Dialog,
  friendlyError,
}: {
  api: CoachApi;
  client: CoachClient;
  ui: CoachUi;
  Dialog: WebPackageHost["ui"]["Dialog"];
  friendlyError(action: string, cause: unknown): string;
}) {
  const { Button, Checkbox, Select, TextInput } = ui;
  const [profile, setProfile] = useState<CoachProfileDto | null>(null);
  const [draft, setDraft] = useState<CoachSettingsPatch>({});
  const [reminders, setReminders] = useState<CoachRemindersDto | null>(null);
  const [reminderDraft, setReminderDraft] = useState<CoachReminderPatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

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
      setError(friendlyError(t("coach.error.loadSettings"), cause));
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
      setError(friendlyError(t("coach.error.saveSettings"), cause));
    } finally {
      setBusy(false);
    }
  };

  const resetState = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result = await api.resetState();
      setProfile(result.profile);
      setDraft(profileDraft(result.profile));
      setReminders(null);
      setReminderDraft(null);
      setConfirmReset(false);
      await client.refresh();
    } catch (cause) {
      setError(friendlyError(t("coach.error.resetSettings"), cause));
    } finally {
      setBusy(false);
    }
  };

  const updateReminder = (patch: Partial<CoachReminderPatch>) => {
    setReminderDraft((current) => current ? { ...current, ...patch } : current);
  };

  return (
    <div className="personal-coach-root personal-coach-settings" data-settings-item="personal-coach-behavior">
      <header className="coach-settings-head">
        <h2>{t("coach.settings.title")}</h2>
        <p>{t("coach.settings.blurb")}</p>
      </header>

      {!profile && !error && <div role="status">{t("coach.settings.loading")}</div>}
      {error && <div className="form-error" role="alert">{error}</div>}

      {profile && (
        <>
          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-label">{t("coach.settings.style")}</div>
              <div className="set-row-hint">{t("coach.settings.styleHint")}</div>
            </div>
            <div className="set-row-control">
              <Select
                label={t("coach.settings.styleLabel")}
                ariaLabel={t("coach.settings.styleLabel")}
                value={draft.tone ?? profile.tone}
                onChange={(tone: string) => setDraft((current) => ({ ...current, tone: tone as CoachProfileDto["tone"] }))}
                options={[
                  { value: "supportive", label: t("coach.settings.style.supportive"), detail: t("coach.settings.style.supportiveDetail") },
                  { value: "balanced", label: t("coach.settings.style.balanced"), detail: t("coach.settings.style.balancedDetail") },
                  { value: "direct", label: t("coach.settings.style.direct"), detail: t("coach.settings.style.directDetail") },
                ]}
              />
            </div>
          </div>

          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-label">{t("coach.settings.initiative")}</div>
              <div className="set-row-hint">{t("coach.settings.initiativeHint")}</div>
            </div>
            <div className="set-row-control">
              <Select
                label={t("coach.settings.initiativeLabel")}
                ariaLabel={t("coach.settings.initiativeLabel")}
                value={draft.initiative ?? profile.initiative}
                onChange={(initiative: string) => setDraft((current) => ({ ...current, initiative: initiative as CoachProfileDto["initiative"] }))}
                options={[
                  { value: "reactive", label: t("coach.settings.initiative.reactive"), detail: t("coach.settings.initiative.reactiveDetail") },
                  { value: "balanced", label: t("coach.settings.initiative.balanced"), detail: t("coach.settings.initiative.balancedDetail") },
                  { value: "proactive", label: t("coach.settings.initiative.proactive"), detail: t("coach.settings.initiative.proactiveDetail") },
                ]}
              />
            </div>
          </div>

          <div className="set-row">
            <div className="set-row-text">
              <Checkbox
                checked={draft.challengeAssumptions ?? profile.challengeAssumptions}
                onChange={(challengeAssumptions: boolean) => setDraft((current) => ({ ...current, challengeAssumptions }))}
                label={t("coach.settings.challenge")}
                description={t("coach.settings.challengeHint")}
              />
            </div>
          </div>

          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-label">{t("coach.settings.timeZone")}</div>
              <div className="set-row-hint">{t("coach.settings.timeZoneHint")}</div>
            </div>
            <div className="set-row-control">
              <TextInput
                aria-label={t("coach.settings.timeZoneLabel")}
                value={draft.timeZone ?? profile.timeZone}
                placeholder="Europe/Kyiv"
                onChange={(event) => setDraft((current) => ({ ...current, timeZone: event.target.value }))}
              />
            </div>
          </div>

          {profile.onboardingState === "complete" && reminders?.available && reminderDraft && (
            <>
              <div className="set-row" data-settings-item="personal-coach-reminders">
                <div className="set-row-text">
                  <Checkbox
                    checked={reminderDraft.dailyCheckIn}
                    onChange={(dailyCheckIn: boolean) => updateReminder({ dailyCheckIn })}
                    label={t("coach.settings.daily")}
                    description={t("coach.settings.dailyHint")}
                  />
                </div>
                <div className="set-row-control set-add-form">
                  <TextInput
                    type="time"
                    aria-label={t("coach.settings.dailyTime")}
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
                  <Checkbox
                    checked={reminderDraft.weeklyReview}
                    onChange={(weeklyReview: boolean) => updateReminder({ weeklyReview })}
                    label={t("coach.settings.weekly")}
                    description={t("coach.settings.weeklyHint")}
                  />
                </div>
                <div className="set-row-control set-add-form">
                  <Select
                    label={t("coach.settings.weeklyDay")}
                    ariaLabel={t("coach.settings.weeklyDay")}
                    disabled={!reminderDraft.weeklyReview}
                    value={String(reminderDraft.weeklyDay)}
                    onChange={(value: string) => updateReminder({ weeklyDay: Number(value) })}
                    options={[
                      { value: "1", label: t("coach.settings.day.monday") },
                      { value: "2", label: t("coach.settings.day.tuesday") },
                      { value: "3", label: t("coach.settings.day.wednesday") },
                      { value: "4", label: t("coach.settings.day.thursday") },
                      { value: "5", label: t("coach.settings.day.friday") },
                      { value: "6", label: t("coach.settings.day.saturday") },
                      { value: "0", label: t("coach.settings.day.sunday") },
                    ]}
                  />
                  <TextInput
                    type="time"
                    aria-label={t("coach.settings.weeklyTime")}
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
                <div className="set-row-label">{t("coach.settings.scheduled")}</div>
                <div className="set-row-hint">{t("coach.settings.scheduleUnavailable")}</div>
              </div>
              <div className="set-row-control"><span className="tag">{t("coach.settings.unavailable")}</span></div>
            </div>
          )}

          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-label">{t("coach.settings.setup")}</div>
              <div className="set-row-hint">
                {profile.onboardingState === "complete" ? t("coach.settings.setupComplete") : t("coach.settings.setupPending")}
              </div>
            </div>
            <div className="set-row-control"><span className="tag">{setupStatus(profile.onboardingState)}</span></div>
          </div>

          <div className="set-row" data-settings-item="personal-coach-data">
            <div className="set-row-text">
              <div className="set-row-label">{t("coach.settings.state")}</div>
              <div className="set-row-hint">{t("coach.settings.stateHint")}</div>
            </div>
            <div className="set-row-control">
              <Button variant="danger" disabled={busy} onClick={() => setConfirmReset(true)}>{t("coach.settings.reset")}</Button>
            </div>
          </div>

          <div className="set-add-form">
            <Button variant="primary" busy={busy} onClick={() => void save()}>{t("coach.settings.save")}</Button>
            {saved && <span className="set-row-hint" role="status">{t("coach.settings.saved")}</span>}
          </div>
        </>
      )}

      {confirmReset && (
        <Dialog title={t("coach.settings.resetTitle")} onClose={() => { if (!busy) setConfirmReset(false); }}>
          <div className="coach-settings-confirm">
            <p>{t("coach.settings.resetBody")}</p>
            <div className="coach-settings-confirm-actions">
              <Button variant="danger" busy={busy} onClick={() => void resetState()}>{t("coach.settings.resetConfirm")}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmReset(false)}>{t("coach.settings.resetCancel")}</Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
