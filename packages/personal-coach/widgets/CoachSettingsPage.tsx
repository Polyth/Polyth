import { useEffect, useState } from "react";
import { PageHead } from "../../../apps/web/src/components/settings/parts.tsx";
import {
  Button,
  Select,
  Switch,
  TextInput,
} from "../../../apps/web/src/components/ui/index.ts";
import type {
  CoachApi,
  CoachProfileDto,
  CoachSettingsPatch,
} from "./api.ts";
import type { CoachClient } from "./store.ts";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = async () => {
    setError("");
    try {
      const settings = await api.settings();
      setProfile(settings.profile);
      setDraft({
        tone: settings.profile.tone,
        initiative: settings.profile.initiative,
        timeZone: settings.profile.timeZone,
        challengeAssumptions: settings.profile.challengeAssumptions,
      });
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
      setDraft({
        tone: next.tone,
        initiative: next.initiative,
        timeZone: next.timeZone,
        challengeAssumptions: next.challengeAssumptions,
      });
      setSaved(true);
      await client.refresh();
    } catch (cause) {
      setError(friendlyError("Save Personal Coach settings", cause));
    } finally {
      setBusy(false);
    }
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
              <div className="set-row-hint">How readily Coach raises useful next steps during a conversation. Scheduled check-ins remain explicit Schedule tasks.</div>
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

          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-label">Setup</div>
              <div className="set-row-hint">{profile.onboardingState === "complete" ? "Initial Coach setup is complete." : "Coach will finish its short setup in chat."}</div>
            </div>
            <div className="set-row-control">
              <span className="tag">{profile.onboardingState}</span>
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
