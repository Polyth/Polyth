// Voice settings: dictation (speech→text) and read-aloud (text→speech).
// F8 adds engine pickers (browser | server), the server endpoint settings
// (URL/model + API-key env REFERENCE, saved explicitly — the target host is
// always visible here), pitch/volume, and summarize-speak.
import { useEffect, useState } from "react";
import { speechSupport } from "@polyth/dictation";
import { api, type VoiceSettingsDto } from "../../api.ts";
import { setVoicePrefs, speak, stopSpeaking, useVoicePrefs } from "../../voice.tsx";
import { EmptyState, PageHead, Row, Seg, Toggle } from "./parts.tsx";

const LANGS = ["en-US", "en-GB", "de-DE", "fr-FR", "es-ES", "it-IT", "pt-BR", "ja-JP", "ko-KR", "zh-CN"];

function ServerEndpointForm({ server, onSaved }: { server: VoiceSettingsDto; onSaved: (s: VoiceSettingsDto) => void }) {
  const [stt, setStt] = useState(server.stt);
  const [tts, setTts] = useState(server.tts);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const save = async () => {
    setBusy(true);
    setMsg("");
    try {
      const saved = await api.voiceSettingsSave({ stt, tts });
      onSaved(saved);
      setStt(saved.stt);
      setTts(saved.tts);
      setMsg("Saved. The capability flips immediately — no restart needed.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mcp-form" data-settings-item="voice.server">
      <div className="stat-label">Speech-to-text server <span className="muted">(OpenAI-compatible /audio/transcriptions)</span></div>
      <div className="mcp-form-row">
        <input value={stt.baseUrl} placeholder="https://host/v1 (empty = browser only)"
          onChange={(e) => setStt({ ...stt, baseUrl: e.target.value })} aria-label="STT base URL" />
        <input value={stt.model} placeholder="model (whisper-1)" style={{ maxWidth: 140 }}
          onChange={(e) => setStt({ ...stt, model: e.target.value })} aria-label="STT model" />
      </div>
      <div className="mcp-form-row">
        <input value={stt.language} placeholder="language (en)" style={{ maxWidth: 120 }}
          onChange={(e) => setStt({ ...stt, language: e.target.value })} aria-label="STT language" />
        <input value={stt.apiKeyEnv} placeholder="API key env var name (e.g. WHISPER_API_KEY)"
          onChange={(e) => setStt({ ...stt, apiKeyEnv: e.target.value })} aria-label="STT API key env var" />
      </div>

      <div className="stat-label">Text-to-speech server <span className="muted">(OpenAI-compatible /audio/speech; non-standard params are stripped)</span></div>
      <div className="mcp-form-row">
        <input value={tts.baseUrl} placeholder="https://host/v1 (empty = browser only)"
          onChange={(e) => setTts({ ...tts, baseUrl: e.target.value })} aria-label="TTS base URL" />
        <input value={tts.model} placeholder="model (tts-1)" style={{ maxWidth: 140 }}
          onChange={(e) => setTts({ ...tts, model: e.target.value })} aria-label="TTS model" />
      </div>
      <div className="mcp-form-row">
        <input value={tts.voice} placeholder="voice (alloy)" style={{ maxWidth: 120 }}
          onChange={(e) => setTts({ ...tts, voice: e.target.value })} aria-label="TTS voice" />
        <input value={tts.apiKeyEnv} placeholder="API key env var name"
          onChange={(e) => setTts({ ...tts, apiKeyEnv: e.target.value })} aria-label="TTS API key env var" />
      </div>

      {msg && <div className={/Saved/.test(msg) ? "knowledge-notice" : "form-error"}>{msg}</div>}
      <div className="mcp-form-row">
        <span className="muted" style={{ fontSize: 11.5 }}>
          Keys are read from the server's environment by NAME — values are never stored or shown.
        </span>
        <span className="header-spacer" />
        <button className="small-btn" disabled={busy} onClick={() => void save()}>Save server settings</button>
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
    try {
      await api.ttsSpeak("Polyth server voice check.");
      setTtsTestMsg("✓ server returned an audio clip");
    } catch (e) {
      setTtsTestMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <>
      <PageHead title="Voice" blurb="Dictation and read-aloud — browser engines by default, OpenAI-compatible servers when configured." />
      {!support.stt && !support.tts && (
        <EmptyState title="Speech is not supported in this browser" body="Dictation needs the Web Speech API (Chrome, Edge, Safari) or a configured server engine." />
      )}
      <Row label="Dictation" hint={support.stt || streaming?.available ? "Shows the mic button in the composer; your speech is inserted as text." : "Not supported in this browser."} itemId="voice.dictation">
        <Toggle on={prefs.dictation} onChange={(v) => setVoicePrefs({ dictation: v })} label="Dictation" />
      </Row>
      <Row
        label="Dictation engine"
        hint={streaming?.available
          ? `Server transcription via ${streaming.engine} with reconnect-safe audio replay.`
          : streaming?.reason ?? "No server speech-to-text engine; the browser engine is used."}
        itemId="voice.streaming"
      >
        <Seg
          value={prefs.sttEngine}
          options={[["browser", "Browser"], ["server", "Server"]]}
          onChange={(v) => setVoicePrefs({ sttEngine: v })}
        />
      </Row>
      <Row label="Read replies aloud" hint="Speaks each completed assistant reply in the active session.">
        <Toggle on={prefs.tts} onChange={(v) => setVoicePrefs({ tts: v })} label="Read replies aloud" />
      </Row>
      <Row
        label="Read-aloud engine"
        hint={server?.ttsConfigured
          ? `Server clips from ${(() => { try { return new URL(server.tts.baseUrl).host; } catch { return server.tts.baseUrl; } })()} (buffered, then played through WebAudio).`
          : "No text-to-speech server configured; the browser voice is used."}
        itemId="voice.ttsEngine"
      >
        <Seg
          value={prefs.ttsEngine}
          options={[["browser", "Browser"], ["server", "Server"]]}
          onChange={(v) => setVoicePrefs({ ttsEngine: v })}
        />
      </Row>
      <Row label="Summarize before speaking" hint="Long replies are condensed by the Small Model first; falls back to the full text." itemId="voice.summarize">
        <Toggle on={prefs.summarize} onChange={(v) => setVoicePrefs({ summarize: v })} label="Summarize before speaking" />
      </Row>
      <Row label="Language" hint="Used for both recognition and speech.">
        <select value={prefs.lang} onChange={(e) => setVoicePrefs({ lang: e.target.value })}>
          {[prefs.lang, ...LANGS.filter((l) => l !== prefs.lang)].map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </Row>
      <Row label="Speech rate" hint={`${prefs.rate.toFixed(1)}×`}>
        <input
          type="range" min={0.5} max={2} step={0.1} value={prefs.rate}
          onChange={(e) => setVoicePrefs({ rate: Number(e.target.value) })}
        />
      </Row>
      <Row label="Pitch" hint={`${prefs.pitch.toFixed(1)}×`} itemId="voice.pitch">
        <input
          type="range" min={0.5} max={2} step={0.1} value={prefs.pitch}
          onChange={(e) => setVoicePrefs({ pitch: Number(e.target.value) })}
        />
      </Row>
      <Row label="Volume" hint={`${Math.round(prefs.volume * 100)}%`} itemId="voice.volume">
        <input
          type="range" min={0} max={1} step={0.05} value={prefs.volume}
          onChange={(e) => setVoicePrefs({ volume: Number(e.target.value) })}
        />
      </Row>
      {voices.length > 0 && (
        <Row label="Browser voice">
          <select value={prefs.voice ?? ""} onChange={(e) => setVoicePrefs({ voice: e.target.value || undefined })}>
            <option value="">Default</option>
            {voices.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
          </select>
        </Row>
      )}
      <Row label="Test">
        <button className="small-btn" onClick={() => speak("Polyth voice check — this is how replies will sound.")}>Speak sample</button>
        {server?.ttsConfigured && <button className="small-btn" onClick={() => void testServerTts()}>Test server TTS</button>}
        <button className="small-btn" onClick={stopSpeaking}>Stop</button>
        {ttsTestMsg && <span className={ttsTestMsg.startsWith("✓") ? "muted" : "form-error"}>{ttsTestMsg}</span>}
      </Row>

      {server && (
        <ServerEndpointForm
          server={server}
          onSaved={(s) => { setServer(s); refreshCapability(); }}
        />
      )}
    </>
  );
}
