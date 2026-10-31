// Built-in voices (Settings → Voice → Read aloud → Polyth voice). Voices run on
// the Polyth server; the picker recommends the best one for the reading
// language and installs it — speech engine included — in one step.
import { useEffect, useMemo, useRef, useState } from "react";
import type { LocalVoiceDescriptor, LocalVoiceQuality } from "../src/localVoiceCatalog.ts";
import { setVoicePrefs, useVoicePrefs } from "./voice.tsx";
import { EmptyState, ErrorState, Row } from "../../../apps/web/src/components/settings/parts.tsx";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Select, StopIcon } from "../../../apps/web/src/components/ui/index.ts";

type VoiceView = Omit<LocalVoiceDescriptor, "archiveUrl" | "sha256"> & {
  state: "missing" | "downloading" | "installed" | "failed";
  downloadedBytes: number;
  totalBytes: number;
  error?: string;
  /** Synthesis seconds per audio second, measured on this server. */
  realtimeFactor?: number;
};

interface VoicesResponse {
  runtime: { state: "missing" | "downloading" | "installed" | "failed" | "unsupported"; error?: string };
  voices: VoiceView[];
}

// What a preview says, in the voice's own language.
const SAMPLES: Record<string, string> = {
  en: "Hi! This is how I sound when I read replies aloud.",
  uk: "Привіт! Ось так я звучу, коли читаю відповіді вголос.",
  de: "Hallo! So klinge ich, wenn ich Antworten vorlese.",
  fr: "Bonjour ! Voici ma voix quand je lis les réponses à voix haute.",
  es: "¡Hola! Así sueno cuando leo las respuestas en voz alta.",
  it: "Ciao! Ecco come suono quando leggo le risposte ad alta voce.",
  pt: "Olá! É assim que eu soo quando leio as respostas em voz alta.",
  pl: "Cześć! Tak brzmię, gdy czytam odpowiedzi na głos.",
  ar: "مرحبًا! هكذا يبدو صوتي عندما أقرأ الردود بصوت عالٍ.",
  zh: "你好！这就是我朗读回复时的声音。",
  hi: "नमस्ते! जब मैं जवाब पढ़कर सुनाता हूँ तो मेरी आवाज़ ऐसी होती है।",
};

const QUALITY_RANK: Record<LocalVoiceQuality, number> = { clear: 0, basic: 1, natural: 2 };

const primary = (lang: string) => lang.toLowerCase().split("-")[0]!;

const voiceLangs = (voice: VoiceView): string[] =>
  voice.speakers?.length ? [...new Set(voice.speakers.map((speaker) => speaker.lang))] : [...voice.languages];

const speaks = (voice: VoiceView, lang: string): boolean => voiceLangs(voice).some((value) => primary(value) === primary(lang));

const languageName = (code: string): string => {
  try {
    const name = new Intl.DisplayNames([getLocale()], { type: "language" }).of(code);
    if (name) return name.charAt(0).toLocaleUpperCase(getLocale()) + name.slice(1);
  } catch { /* unknown tag */ }
  return code;
};

const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / 1_000_000));

const qualityLabel = (quality: LocalVoiceQuality) =>
  quality === "natural" ? tr("settings.voicepage.localQualityNatural")
    : quality === "clear" ? tr("settings.voicepage.localQualityClear")
      : tr("settings.voicepage.localQualityBasic");

/** Fast, clear voices first, exact region before the language's others. */
function rank(voices: VoiceView[], lang: string): VoiceView[] {
  const exact = (voice: VoiceView) => voiceLangs(voice).some((value) => value.toLowerCase() === lang.toLowerCase()) ? 0 : 1;
  return voices
    .filter((voice) => speaks(voice, lang))
    .sort((a, b) => QUALITY_RANK[a.quality] - QUALITY_RANK[b.quality] || exact(a) - exact(b));
}

async function voicesRequest(path: string, method = "GET"): Promise<VoicesResponse> {
  const response = await fetch(path, { method });
  const body = await response.json().catch(() => ({})) as VoicesResponse & { message?: string };
  if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
  return body;
}

/** One-off preview of a specific installed voice, independent of the queue. */
function usePreview() {
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState("");
  const audio = useRef<HTMLAudioElement | null>(null);
  const stop = () => {
    audio.current?.pause();
    audio.current = null;
    setPlaying(null);
  };
  useEffect(() => stop, []);
  const play = async (voice: VoiceView, lang: string, speaker: number | undefined) => {
    stop();
    setError("");
    setPlaying(voice.id);
    try {
      const response = await fetch("/api/tts/local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: SAMPLES[primary(lang)] ?? SAMPLES.en, voice: voice.id, lang, ...(speaker !== undefined ? { speaker } : {}) }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? `HTTP ${response.status}`);
      }
      const url = URL.createObjectURL(await response.blob());
      const element = new Audio(url);
      audio.current = element;
      element.onended = () => { URL.revokeObjectURL(url); if (audio.current === element) stop(); };
      await element.play();
    } catch (cause) {
      setPlaying(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return { playing, error, play, stop };
}

export default function LocalVoicePicker({ lang }: { lang: string }) {
  const prefs = useVoicePrefs();
  const [data, setData] = useState<VoicesResponse | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [allLanguages, setAllLanguages] = useState(false);
  const preview = usePreview();

  const refresh = () => voicesRequest("/api/tts/voices").then((next) => { setData(next); setFailure(null); }).catch(setFailure);
  useEffect(() => { void refresh(); }, []);
  const busy = data?.voices.some((voice) => voice.state === "downloading") || data?.runtime.state === "downloading";
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const voices = data?.voices ?? [];
  const forLanguage = useMemo(() => rank(voices, lang), [voices, lang]);
  const selected = voices.find((voice) => voice.id === prefs.localVoice);
  // A voice already on the server beats one that still has to download.
  const recommended = forLanguage.find((voice) => voice.state === "installed") ?? forLanguage[0];
  const ready = selected?.state === "installed";
  // The recommendation card already shows its voice; the list holds the rest.
  const shown = (allLanguages ? [...forLanguage, ...voices.filter((voice) => !speaks(voice, lang))] : forLanguage)
    .filter((voice) => ready || voice.id !== recommended?.id);

  const install = async (voice: VoiceView) => {
    setVoicePrefs({ localVoice: voice.id, localSpeaker: undefined });
    try { setData(await voicesRequest(`/api/tts/voices/${encodeURIComponent(voice.id)}/download`, "POST")); }
    catch (cause) { setFailure(cause); }
  };
  const remove = async (voice: VoiceView) => {
    try { setData(await voicesRequest(`/api/tts/voices/${encodeURIComponent(voice.id)}`, "DELETE")); }
    catch (cause) { setFailure(cause); }
  };

  if (failure && !data) return <ErrorState compact title={tr("settings.voicepage.localUnavailable")} error={failure} onRetry={() => void refresh()} />;
  if (!data) return <EmptyState compact busy title={tr("settings.voicepage.loading")} />;
  if (data.runtime.state === "unsupported") {
    return <p className="voice-note">{data.runtime.error ?? tr("settings.voicepage.localUnavailable")}</p>;
  }

  const speakers = selected?.speakers?.filter((speaker) => primary(speaker.lang) === primary(lang)) ?? [];
  const speakerOptions = speakers.length ? speakers : selected?.speakers ?? [];
  const engineMissing = data.runtime.state !== "installed";

  const slowNote = (voice: VoiceView) => voice.realtimeFactor !== undefined
    ? voice.realtimeFactor > 1 ? tr("settings.voicepage.localSlow", { value: voice.realtimeFactor.toFixed(1) }) : ""
    : voice.engine === "kokoro" ? tr("settings.voicepage.localSlowUnknown") : "";

  const actions = (voice: VoiceView) => {
    const inUse = voice.id === prefs.localVoice;
    switch (voice.state) {
      case "installed":
        return (
          <>
            <Button size="sm" variant="ghost"
              iconStart={preview.playing === voice.id ? StopIcon : undefined}
              onClick={() => preview.playing === voice.id ? preview.stop() : void preview.play(voice, speaks(voice, lang) ? lang : voiceLangs(voice)[0]!, inUse ? prefs.localSpeaker : undefined)}>
              {preview.playing === voice.id ? tr("common.stop") : tr("settings.voicepage.localPreview")}
            </Button>
            {inUse
              ? <span className="voice-status is-ok">{tr("settings.voicepage.localInUse")}</span>
              : <Button size="sm" onClick={() => setVoicePrefs({ localVoice: voice.id, localSpeaker: undefined })}>{tr("settings.voicepage.localUse")}</Button>}
            {!inUse && <Button size="sm" variant="ghost" onClick={() => void remove(voice)}>{tr("settings.voicepage.delete")}</Button>}
          </>
        );
      case "downloading":
        return <span className="voice-status is-muted">{tr("settings.voicepage.downloading", { value: Math.min(100, Math.round((voice.downloadedBytes / Math.max(1, voice.totalBytes)) * 100)) })}</span>;
      default:
        return (
          <Button size="sm" variant={voice.state === "failed" ? "danger" : undefined} onClick={() => void install(voice)}>
            {voice.state === "failed" ? tr("settings.voicepage.retry") : tr("settings.voicepage.localDownloadSize", { size: megabytes(voice.archiveBytes) })}
          </Button>
        );
    }
  };

  return (
    <div className="voice-local">
      {!ready && (recommended ? (
        <div className="voice-local-hero">
          <div>
            <p className="voice-local-hero-title">{tr("settings.voicepage.localRecommended", { language: languageName(lang) })}</p>
            <p className="voice-local-hero-voice">
              <strong>{recommended.label}</strong> · {qualityLabel(recommended.quality)}
              {recommended.state !== "installed" ? ` · ${tr("settings.voicepage.localSize", { size: megabytes(recommended.archiveBytes) })}` : ""}
            </p>
            {recommended.state !== "installed" && (
              <p className="voice-note">
                {engineMissing ? `${tr("settings.voicepage.localEngineNote")} ` : ""}{tr("settings.voicepage.localNotInstalledFallback")}
              </p>
            )}
          </div>
          {recommended.state === "downloading"
            ? <span className="voice-status is-muted">{tr("settings.voicepage.downloading", { value: Math.min(100, Math.round((recommended.downloadedBytes / Math.max(1, recommended.totalBytes)) * 100)) })}</span>
            : recommended.state === "installed"
              ? <Button onClick={() => setVoicePrefs({ localVoice: recommended.id, localSpeaker: undefined })}>{tr("settings.voicepage.localUse")}</Button>
              : <Button variant="primary" onClick={() => void install(recommended)}>{tr("settings.voicepage.localDownloadUse")}</Button>}
        </div>
      ) : (
        <p className="voice-note">{tr("settings.voicepage.localNoVoiceForLanguage", { language: languageName(lang) })}</p>
      ))}

      {selected?.speakers?.length && ready ? (
        <Row label={tr("settings.voicepage.localSpeaker")} itemId="voice.local-speaker">
          <Select
            value={String(prefs.localSpeaker ?? "")}
            label={speakerOptions.find((speaker) => speaker.id === prefs.localSpeaker)?.name ?? tr("settings.voicepage.default")}
            ariaLabel={tr("settings.voicepage.localSpeaker")}
            options={[
              { value: "", label: tr("settings.voicepage.default") },
              ...speakerOptions.map((speaker) => ({ value: String(speaker.id), label: `${speaker.name} · ${languageName(speaker.lang)}` })),
            ]}
            onChange={(value) => setVoicePrefs({ localSpeaker: value === "" ? undefined : Number(value) })}
          />
        </Row>
      ) : null}

      {shown.length > 0 && <ul className="voice-local-list" aria-label={tr("settings.voicepage.localVoices")}>
        {shown.map((voice) => {
          const note = slowNote(voice);
          return (
            <li key={voice.id} className="voice-local-item" data-active={voice.id === prefs.localVoice || undefined}>
              <div className="voice-local-meta">
                <span className="voice-local-name">{voice.label}</span>
                <span className="voice-local-detail">
                  {voiceLangs(voice).length > 2
                    ? tr("settings.voicepage.localLanguages", { count: voiceLangs(voice).length })
                    : voiceLangs(voice).map(languageName).join(", ")}
                  {" · "}{qualityLabel(voice.quality)}
                  {voice.state !== "installed" ? ` · ${tr("settings.voicepage.localSize", { size: megabytes(voice.archiveBytes) })}` : ""}
                </span>
                {note && <span className="voice-local-warn">{note}</span>}
                {voice.state === "failed" && voice.error && <span className="settings-field-error">{voice.error}</span>}
                {voice.state === "downloading" && <progress className="voice-progress" value={voice.downloadedBytes} max={voice.totalBytes} />}
              </div>
              <div className="voice-local-actions">{actions(voice)}</div>
            </li>
          );
        })}
      </ul>}
      {preview.error && <p className="settings-field-error" role="alert">{preview.error}</p>}
      <Button size="sm" variant="quiet" onClick={() => setAllLanguages((value) => !value)}>
        {allLanguages ? tr("settings.voicepage.localShowMine", { language: languageName(lang) }) : tr("settings.voicepage.localShowAll")}
      </Button>
    </div>
  );
}
