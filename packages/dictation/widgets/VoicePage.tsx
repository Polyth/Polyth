// Voice settings: dictation (speech→text) and read-aloud (text→speech).
// F8 adds engine pickers (browser | server), the server endpoint settings
// (URL/model + API-key env REFERENCE, saved explicitly — the target host is
// always visible here), pitch/volume, and summarize-speak.
import { useEffect, useState } from "react";
import { speechSupport } from "@polyth/dictation";
import { api, type VoiceSettingsDto } from "@polyth/session/web-api";
import { setVoicePrefs, speak, stopSpeaking, useVoicePrefs } from "./voice.tsx";
import { EmptyState, PageHead, Row, Seg, Toggle } from "../../../apps/web/src/components/settings/parts.tsx";
import { formatNumber, tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Select, StopIcon, TextInput } from "../../../apps/web/src/components/ui/index.ts";

const LANGS = ["en-US", "en-GB", "de-DE", "fr-FR", "es-ES", "it-IT", "pt-BR", "ja-JP", "ko-KR", "zh-CN"];

function ServerEndpointForm({ server, onSaved }: { server: VoiceSettingsDto; onSaved: (s: VoiceSettingsDto) => void }) {
  const [stt, setStt] = useState(server.stt);
  const [tts, setTts] = useState(server.tts);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);

  const save = async () => {
    setBusy(true);
    setMsg("");
    setSaveFailed(false);
    try {
      const saved = await api.voiceSettingsSave({ stt, tts });
      onSaved(saved);
      setStt(saved.stt);
      setTts(saved.tts);
      setMsg(tr("settings.voicepage.savedCapabilityUpdated"));
    } catch (e) {
      setSaveFailed(true);
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mcp-form" data-settings-item="voice.server">
      <div className="stat-label">{tr("settings.voicepage.speechToTextServer")}{" "}<span className="muted">{tr("settings.voicepage.openaiCompatibleAudioTranscriptions")}</span></div>
      <div className="mcp-form-row">
        <TextInput value={stt.baseUrl} placeholder={tr("settings.voicepage.httpsHostV1EmptyBrowserOnly")}
          onChange={(e) => setStt({ ...stt, baseUrl: e.target.value })} aria-label={tr("settings.voicepage.sttBaseUrl")} />
        <TextInput value={stt.model} placeholder={tr("settings.voicepage.modelWhisper1")} style={{ maxWidth: 140 }}
          onChange={(e) => setStt({ ...stt, model: e.target.value })} aria-label={tr("settings.voicepage.sttModel")} />
      </div>
      <div className="mcp-form-row">
        <TextInput value={stt.language} placeholder={tr("settings.voicepage.languageEn")} style={{ maxWidth: 120 }}
          onChange={(e) => setStt({ ...stt, language: e.target.value })} aria-label={tr("settings.voicepage.sttLanguage")} />
        <TextInput value={stt.apiKeyEnv} placeholder={tr("settings.voicepage.apiKeyEnvVarNameEG")}
          onChange={(e) => setStt({ ...stt, apiKeyEnv: e.target.value })} aria-label={tr("settings.voicepage.sttApiKeyEnvVar")} />
      </div>

      <div className="stat-label">{tr("settings.voicepage.textToSpeechServer")}{" "}<span className="muted">{tr("settings.voicepage.openaiCompatibleAudioSpeechNonStandardParams")}</span></div>
      <div className="mcp-form-row">
        <TextInput value={tts.baseUrl} placeholder={tr("settings.voicepage.httpsHostV1EmptyBrowserOnly")}
          onChange={(e) => setTts({ ...tts, baseUrl: e.target.value })} aria-label={tr("settings.voicepage.ttsBaseUrl")} />
        <TextInput value={tts.model} placeholder={tr("settings.voicepage.modelTts1")} style={{ maxWidth: 140 }}
          onChange={(e) => setTts({ ...tts, model: e.target.value })} aria-label={tr("settings.voicepage.ttsModel")} />
      </div>
      <div className="mcp-form-row">
        <TextInput value={tts.voice} placeholder={tr("settings.voicepage.voiceAlloy")} style={{ maxWidth: 120 }}
          onChange={(e) => setTts({ ...tts, voice: e.target.value })} aria-label={tr("settings.voicepage.ttsVoice")} />
        <TextInput value={tts.apiKeyEnv} placeholder={tr("settings.voicepage.apiKeyEnvVarName")}
          onChange={(e) => setTts({ ...tts, apiKeyEnv: e.target.value })} aria-label={tr("settings.voicepage.ttsApiKeyEnvVar")} />
      </div>

      {msg && <div className={saveFailed ? "form-error" : "form-success"}>{msg}</div>}
      <div className="mcp-form-row">
        <span className="muted voice-form-note">
          {tr("settings.voicepage.keysAreReadFromTheServerS")}</span>
        <span className="header-spacer" />
        <Button size="sm" variant="primary" busy={busy} onClick={() => void save()}>{tr("settings.voicepage.saveServerSettings")}</Button>
      </div>
    </div>
  );
}

export default function VoicePage() {
  const prefs = useVoicePrefs();
  const support = speechSupport(typeof window !== "undefined" ? window : undefined);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [streaming, setStreaming] = useState<{ available: boolean; engine?: string; reason?: string } | null>(null);
  const [server, setServer] = useState<VoiceSettingsDto | null>(null);
  const [ttsTestMsg, setTtsTestMsg] = useState("");
  const [ttsTestFailed, setTtsTestFailed] = useState(false);

  const refreshCapability = () => void api.dictationCapability().then(setStreaming);
  useEffect(() => {
    refreshCapability();
    void api.voiceSettings().then(setServer).catch(() => setServer(null));
  }, []);

  useEffect(() => {
    if (!support.tts) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return () => { window.speechSynthesis.onvoiceschanged = null; };
  }, [support.tts]);

  const testServerTts = async () => {
    setTtsTestMsg("");
    setTtsTestFailed(false);
    try {
      await api.ttsSpeak(tr("settings.voicepage.serverVoiceCheckSample"));
      setTtsTestMsg(tr("settings.voicepage.serverReturnedAudioClip"));
    } catch (e) {
      setTtsTestFailed(true);
      setTtsTestMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="pkg-dictation">
      <PageHead title={tr("settings.voicepage.voice")} blurb={tr("settings.voicepage.dictationAndReadAloudBrowserEnginesBy")} />
      {!support.stt && !support.tts && (
        <EmptyState title={tr("settings.voicepage.speechIsNotSupportedInThisBrowser")} body={tr("settings.voicepage.dictationNeedsTheWebSpeechApiChrome")} />
      )}
      <Row label={tr("settings.voicepage.dictation")} hint={support.stt || streaming?.available ? tr("settings.voicepage.showsTheMicButtonInTheComposer") : tr("settings.voicepage.notSupportedInThisBrowser")} itemId="voice.dictation">
        <Toggle on={prefs.dictation} onChange={(v) => setVoicePrefs({ dictation: v })} label={tr("settings.voicepage.dictation")} />
      </Row>
      <Row
        label={tr("settings.voicepage.dictationEngine")}
        hint={streaming?.available
          ? tr("settings.voicepage.serverTranscriptionViaValueWithReconnectSafe", { engine: streaming.engine })
          : streaming?.reason ?? tr("settings.voicepage.browserEngineFallback")}
        itemId="voice.streaming"
      >
        <Seg
          value={prefs.sttEngine}
          options={[
            ["browser", tr("packages.onboarding.tours.builtin.browser")],
            ["server", tr("ssh.sshprojectsource.server")],
          ]}
          onChange={(v) => setVoicePrefs({ sttEngine: v })}
        />
      </Row>
      <Row label={tr("settings.voicepage.readRepliesAloud")} hint={tr("settings.voicepage.speaksEachCompletedAssistantReplyInThe")}>
        <Toggle on={prefs.tts} onChange={(v) => setVoicePrefs({ tts: v })} label={tr("settings.voicepage.readRepliesAloud")} />
      </Row>
      <Row
        label={tr("settings.voicepage.readAloudEngine")}
        hint={server?.ttsConfigured
          ? tr("settings.voicepage.serverClipsFromValueBufferedThenPlayed", { value: (() => { try { return new URL(server.tts.baseUrl).host; } catch { return server.tts.baseUrl; } })() })
          : tr("settings.voicepage.noTextToSpeechServerConfiguredThe")}
        itemId="voice.ttsEngine"
      >
        <Seg
          value={prefs.ttsEngine}
          options={[
            ["browser", tr("packages.onboarding.tours.builtin.browser")],
            ["server", tr("ssh.sshprojectsource.server")],
          ]}
          onChange={(v) => setVoicePrefs({ ttsEngine: v })}
        />
      </Row>
      <Row label={tr("settings.voicepage.summarizeBeforeSpeaking")} hint={tr("settings.voicepage.longRepliesAreCondensedByTheSmall")} itemId="voice.summarize">
        <Toggle on={prefs.summarize} onChange={(v) => setVoicePrefs({ summarize: v })} label={tr("settings.voicepage.summarizeBeforeSpeaking")} />
      </Row>
      <Row label={tr("settings.voicepage.language")} hint={tr("settings.voicepage.usedForBothRecognitionAndSpeech")}>
        <Select
          value={prefs.lang}
          label={prefs.lang}
          options={[prefs.lang, ...LANGS.filter((language) => language !== prefs.lang)].map((language) => ({ value: language, label: language }))}
          onChange={(lang) => setVoicePrefs({ lang })}
        />
      </Row>
      <Row label={tr("settings.voicepage.speechRate")} hint={tr("settings.voicepage.value", {
        value: formatNumber(prefs.rate, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      })}>
        <input
          type="range" min={0.5} max={2} step={0.1} value={prefs.rate}
          onChange={(e) => setVoicePrefs({ rate: Number(e.target.value) })}
        />
      </Row>
      <Row label={tr("settings.voicepage.pitch")} hint={tr("settings.voicepage.value", {
        value: formatNumber(prefs.pitch, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      })} itemId="voice.pitch">
        <input
          type="range" min={0.5} max={2} step={0.1} value={prefs.pitch}
          onChange={(e) => setVoicePrefs({ pitch: Number(e.target.value) })}
        />
      </Row>
      <Row label={tr("settings.voicepage.volume")} hint={`${Math.round(prefs.volume * 100)}%`} itemId="voice.volume">
        <input
          type="range" min={0} max={1} step={0.05} value={prefs.volume}
          onChange={(e) => setVoicePrefs({ volume: Number(e.target.value) })}
        />
      </Row>
      {voices.length > 0 && (
        <Row label={tr("settings.voicepage.browserVoice")}>
          <Select
            value={prefs.voice ?? ""}
            label={prefs.voice || tr("settings.voicepage.default")}
            options={[
              { value: "", label: tr("settings.voicepage.default") },
              ...voices.map((voice) => ({ value: voice.name, label: voice.name })),
            ]}
            onChange={(voice) => setVoicePrefs({ voice: voice || undefined })}
          />
        </Row>
      )}
      <Row label={tr("settings.voicepage.test")}>
        <Button
          size="sm"
          onClick={() => speak(tr("settings.voicepage.voiceCheckSample"))}
        >
          {tr("settings.voicepage.speakSample")}
        </Button>
        {server?.ttsConfigured && <Button size="sm" onClick={() => void testServerTts()}>{tr("settings.voicepage.testServerTts")}</Button>}
        <Button size="sm" variant="danger" iconStart={StopIcon} onClick={stopSpeaking}>{tr("common.stop")}</Button>
        {ttsTestMsg && <span className={ttsTestFailed ? "form-error" : "muted"}>{ttsTestMsg}</span>}
      </Row>

      {server && (
        <ServerEndpointForm
          server={server}
          onSaved={(s) => { setServer(s); refreshCapability(); }}
        />
      )}
    </div>
  );
}
