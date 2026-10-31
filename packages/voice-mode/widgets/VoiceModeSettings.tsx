// Settings → Voice mode. Only conversation behavior lives here; the voice,
// speed and recognition engines are the Voice page's, linked from the top.
// Replies (spoken or silent) is switched in the voice window itself.
import { useEffect, useState } from "react";
import { Button, TextInput } from "@polyth/web/ui";
import { isImeComposing } from "@polyth/web-sdk";
import { PageHead, Row, Section, Seg, Toggle } from "../../../apps/web/src/components/settings/parts.tsx";
import { parsePhraseList, type VoiceCommandId, type VoiceCommandPhrases } from "../src/commands.ts";
import type { NarrationStatus } from "../src/narrateRoutes.ts";
import type {
  VoiceBargeIn,
  VoiceNarrationCadence,
  VoiceNarrator,
  VoicePause,
  VoicePresentation,
  VoiceRecognitionChoice,
  VoiceThoughts,
  VoiceTurnTaking,
} from "../src/prefs.ts";
import { formatVoiceString, type VoiceModeStrings } from "../src/strings.ts";
import { getVoiceModePrefs, setVoiceModePrefs, useVoiceModePrefs } from "./prefsStore.ts";

/** One command's phrases, edited as a comma list and saved on blur. */
function PhraseField({ id, label, hint, phrases, disabled }: {
  id: VoiceCommandId;
  label: string;
  hint: string;
  phrases: readonly string[];
  disabled: boolean;
}) {
  const joined = phrases.join(", ");
  const [draft, setDraft] = useState(joined);
  useEffect(() => { setDraft(joined); }, [joined]);
  const save = () => {
    const next = parsePhraseList(draft);
    if (next.join(", ") === joined) {
      setDraft(joined);
      return;
    }
    setVoiceModePrefs({ commandPhrases: { ...getVoiceModePrefs().commandPhrases, [id]: next } });
  };
  return (
    <Row label={label} hint={hint} itemId={`voice-mode.command.${id}`} layout="stacked" disabled={disabled}>
      <TextInput
        className="voice-command-phrases"
        value={draft}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === "Enter") event.currentTarget.blur(); }}
      />
    </Row>
  );
}

export default function VoiceModeSettings({
  strings, openVoiceSettings, openSmallModelSettings, loadNarrationStatus, commandPhrases,
}: {
  strings: VoiceModeStrings;
  openVoiceSettings(): void;
  /** Settings → Sessions → Small model. */
  openSmallModelSettings(): void;
  /** Whether the account has a small model; null when it cannot be read. */
  loadNarrationStatus(): Promise<NarrationStatus | null>;
  /** The phrases in effect (custom or the language defaults). */
  commandPhrases(): VoiceCommandPhrases;
}) {
  const prefs = useVoiceModePrefs();
  const phrases = commandPhrases();
  const commandsOff = !prefs.commands;
  // Full thoughts are read as they stream; the cadence paces steps and brief thoughts.
  const narrationOff = !prefs.actions && prefs.thoughts !== "brief";
  const [status, setStatus] = useState<NarrationStatus | null>(null);
  const wantsModel = prefs.narrator === "model";
  useEffect(() => {
    if (!wantsModel) return;
    let live = true;
    void loadNarrationStatus().then((value) => { if (live) setStatus(value); });
    return () => { live = false; };
  }, [wantsModel, loadNarrationStatus]);
  const commandRows: Array<[VoiceCommandId, string, string]> = [
    ["stop", strings.commandStop, ""],
    ["sendNow", strings.commandSendNow, strings.commandSendNowHint],
    ["send", strings.commandSend, strings.commandSendHint],
    ["cancel", strings.commandCancel, strings.commandCancelHint],
  ];
  return (
    <div className="pkg-voice-mode">
      <PageHead blurb={strings.settingsBlurb} />
      <Section title={strings.title}>
        <Row label={strings.voiceSettings} hint={strings.voiceSettingsHint} itemId="voice-mode.voice">
          <Button size="sm" variant="ghost" onClick={openVoiceSettings}>{strings.openVoiceSettings}</Button>
        </Row>
        <Row label={strings.turnTaking} hint={strings.turnTakingHint} itemId="voice-mode.turn-taking">
          <Seg<VoiceTurnTaking>
            value={prefs.turnTaking}
            label={strings.turnTaking}
            options={[["auto", strings.turnAuto], ["manual", strings.turnManual]]}
            onChange={(turnTaking) => setVoiceModePrefs({ turnTaking })}
          />
        </Row>
        <Row label={strings.pause} hint={strings.pauseHint} itemId="voice-mode.pause" disabled={prefs.turnTaking === "manual"}>
          <Seg<VoicePause>
            value={prefs.pause}
            label={strings.pause}
            disabled={prefs.turnTaking === "manual"}
            options={[["quick", strings.pauseQuick], ["normal", strings.pauseNormal], ["patient", strings.pausePatient]]}
            onChange={(pause) => setVoiceModePrefs({ pause })}
          />
        </Row>
        <Row label={strings.bargeIn} hint={strings.bargeInHint} itemId="voice-mode.barge-in" disabled={prefs.feedback === "silent"}>
          <Seg<VoiceBargeIn>
            value={prefs.bargeIn}
            label={strings.bargeIn}
            disabled={prefs.feedback === "silent"}
            options={[["auto", strings.bargeInAuto], ["on", strings.bargeInOn], ["off", strings.bargeInOff]]}
            onChange={(bargeIn) => setVoiceModePrefs({ bargeIn })}
          />
        </Row>
        <Row label={strings.recognition} hint={strings.recognitionHint} itemId="voice-mode.recognition">
          <Seg<VoiceRecognitionChoice>
            value={prefs.recognition}
            label={strings.recognition}
            options={[["dictation", strings.recognitionDictation], ["browser", strings.recognitionBrowser]]}
            onChange={(recognition) => setVoiceModePrefs({ recognition })}
          />
        </Row>
        <Row label={strings.presentation} hint={strings.presentationHint} itemId="voice-mode.presentation">
          <Seg<VoicePresentation>
            value={prefs.presentation}
            label={strings.presentation}
            options={[["compact", strings.presentationCompact], ["immersive", strings.presentationImmersive]]}
            onChange={(presentation) => setVoiceModePrefs({ presentation })}
          />
        </Row>
        <Row label={strings.captions} hint={strings.captionsHint} itemId="voice-mode.captions">
          <Toggle on={prefs.captions} onChange={(captions) => setVoiceModePrefs({ captions })} label={strings.captions} />
        </Row>
        <Row label={strings.sounds} hint={strings.soundsHint} itemId="voice-mode.sounds" disabled={prefs.feedback === "silent"}>
          <Toggle on={prefs.sounds && prefs.feedback !== "silent"} disabled={prefs.feedback === "silent"}
            onChange={(sounds) => setVoiceModePrefs({ sounds })} label={strings.sounds} />
        </Row>
      </Section>
      <Section title={strings.whileWorking} hint={strings.whileWorkingHint}>
        <Row label={strings.thoughts} hint={strings.thoughtsHint} itemId="voice-mode.thoughts">
          <Seg<VoiceThoughts>
            value={prefs.thoughts}
            label={strings.thoughts}
            options={[["off", strings.thoughtsOff], ["brief", strings.thoughtsBrief], ["full", strings.thoughtsFull]]}
            onChange={(thoughts) => setVoiceModePrefs({ thoughts })}
          />
        </Row>
        <Row label={strings.actions} hint={strings.actionsHint} itemId="voice-mode.actions">
          <Toggle on={prefs.actions} onChange={(actions) => setVoiceModePrefs({ actions })} label={strings.actions} />
        </Row>
        <Row label={strings.cadence} hint={strings.cadenceHint} itemId="voice-mode.cadence" disabled={narrationOff}>
          <Seg<VoiceNarrationCadence>
            value={prefs.narrationCadence}
            label={strings.cadence}
            disabled={narrationOff}
            options={[["key", strings.cadenceKey], ["every", strings.cadenceEvery]]}
            onChange={(narrationCadence) => setVoiceModePrefs({ narrationCadence })}
          />
        </Row>
        <Row label={strings.narrator} hint={strings.narratorHint} itemId="voice-mode.narrator" disabled={narrationOff}>
          <Seg<VoiceNarrator>
            value={prefs.narrator}
            label={strings.narrator}
            disabled={narrationOff}
            options={[["templates", strings.narratorTemplates], ["model", strings.narratorModel]]}
            onChange={(narrator) => setVoiceModePrefs({ narrator })}
          />
        </Row>
        {wantsModel && status && (
          <Row
            label={status.configured ? formatVoiceString(strings.narratorModelReady, { model: status.label ?? "" }) : strings.narratorModelMissing}
            itemId="voice-mode.narrator-model"
            disabled={narrationOff}
          >
            <Button size="sm" variant="ghost" onClick={openSmallModelSettings}>
              {status.configured ? strings.narratorChange : strings.narratorSetUp}
            </Button>
          </Row>
        )}
      </Section>
      <Section
        title={strings.commandsTitle}
        hint={strings.commandPhrasesHint}
        action={Object.keys(prefs.commandPhrases).length
          ? <Button size="sm" variant="ghost" onClick={() => setVoiceModePrefs({ commandPhrases: {} })}>{strings.resetCommands}</Button>
          : undefined}
      >
        <Row label={strings.commands} hint={strings.commandsHint} itemId="voice-mode.commands">
          <Toggle on={prefs.commands} onChange={(commands) => setVoiceModePrefs({ commands })} label={strings.commands} />
        </Row>
        {commandRows.map(([id, label, hint]) => (
          <PhraseField key={id} id={id} label={label} hint={hint} phrases={phrases[id]} disabled={commandsOff} />
        ))}
      </Section>
    </div>
  );
}
