// Voice settings: dictation (speech→text) and read-aloud (text→speech).
import { useEffect, useState } from "react";
import { speechSupport } from "@polyth/dictation";
import { setVoicePrefs, speak, stopSpeaking, useVoicePrefs } from "../../voice.tsx";
import { pluginOn, togglePlugin } from "../../prefs.ts";
import { EmptyState, PageHead, Row, Toggle } from "./parts.tsx";

const LANGS = ["en-US", "en-GB", "de-DE", "fr-FR", "es-ES", "it-IT", "pt-BR", "ja-JP", "ko-KR", "zh-CN"];

export default function VoicePage() {
  const prefs = useVoicePrefs();
  const support = speechSupport(typeof window !== "undefined" ? window : undefined);
  const pluginEnabled = pluginOn("dictation");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    if (!support.tts) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return () => { window.speechSynthesis.onvoiceschanged = null; };
  }, [support.tts]);

  return (
    <>
      <PageHead title="Voice" blurb="Dictation and read-aloud use the browser's speech engines — nothing extra to install." />
      {!support.stt && !support.tts && (
        <EmptyState title="Speech is not supported in this browser" body="Dictation needs the Web Speech API (Chrome, Edge, Safari)." />
      )}
      <Row label="Voice plugin" hint="Shows the mic button in the composer and voice commands in the palette.">
        <Toggle on={pluginEnabled} onChange={() => togglePlugin("dictation")} label="Voice plugin" />
      </Row>
      <Row label="Dictation" hint={support.stt ? "Mic button inserts your speech into the composer." : "Not supported in this browser."}>
        <Toggle on={prefs.dictation} onChange={(v) => setVoicePrefs({ dictation: v })} label="Dictation" />
      </Row>
      <Row label="Read replies aloud" hint={support.tts ? "Speaks each completed assistant reply in the active session." : "Not supported in this browser."}>
        <Toggle on={prefs.tts} onChange={(v) => setVoicePrefs({ tts: v })} label="Read replies aloud" />
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
      {voices.length > 0 && (
        <Row label="Voice">
          <select value={prefs.voice ?? ""} onChange={(e) => setVoicePrefs({ voice: e.target.value || undefined })}>
            <option value="">Default</option>
            {voices.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
          </select>
        </Row>
      )}
      {support.tts && (
        <Row label="Test">
          <button className="small-btn" onClick={() => speak("Polyth voice check — this is how replies will sound.")}>Speak sample</button>
          <button className="small-btn" onClick={stopSpeaking}>Stop</button>
        </Row>
      )}
    </>
  );
}
