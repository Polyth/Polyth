// Voice settings: provider-neutral dictation + read-aloud. Provider/model names
// are capability data, while user-facing common labels continue to use the
// package's existing i18n keys.
import { useEffect, useMemo, useState } from "react";
import {
  providerCapabilities,
  providerCatalog,
  speechSupport,
  type DictationLatencyPreference,
  type DictationProviderId,
  type DictationTransport,
} from "@polyth/dictation";
import { api, type VoiceSettingsDto } from "@polyth/session/web-api";
import { setVoicePrefs, speak, stopSpeaking, useVoicePrefs } from "./voice.tsx";
import { EmptyState, PageHead, Row, Seg, Toggle } from "../../../apps/web/src/components/settings/parts.tsx";
import { formatNumber, tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Select, StopIcon, TextInput } from "../../../apps/web/src/components/ui/index.ts";

const LANGS = ["auto", "uk-UA", "en-US", "en-GB", "de-DE", "fr-FR", "es-ES", "it-IT", "pt-BR", "ja-JP", "ko-KR", "zh-CN"];

interface DictationSettingsDto {
  provider: DictationProviderId;
  transport: DictationTransport;
  model: string;
  localModel: string;
  language: string;
  contextInjection: boolean;
  cloudFallback: boolean;
  latencyPreference: DictationLatencyPreference;
  apiKeyEnv: string;
}

type ServerVoiceSettings = VoiceSettingsDto & {
  dictation: DictationSettingsDto;
  dictationKeyConfigured?: boolean;
};

interface ProviderView {
  id: DictationProviderId;
  label: string;
  transports: readonly DictationTransport[];
  defaultModel?: string;
  available: boolean;
  reason?: string;
  local: boolean;
  publicApi: boolean;
}

interface LocalModelView {
  id: string;
  label: string;
  state: "missing" | "downloading" | "installed" | "failed";
  downloadedBytes: number;
  totalBytes: number;
  languages: readonly string[];
  error?: string;
}

const providerEnv = (provider: DictationProviderId): string => {
  switch (provider) {
    case "elevenlabs": return "ELEVENLABS_API_KEY";
    case "openai-live":
    case "openai-transcribe":
    case "openai-compatible": return "OPENAI_API_KEY";
    case "deepgram": return "DEEPGRAM_API_KEY";
    case "speechmatics": return "SPEECHMATICS_API_KEY";
    case "wispr": return "WISPR_API_KEY";
    default: return "";
  }
};

const fetchJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
};

function ServerEndpointForm({ server, onSaved }: { server: ServerVoiceSettings; onSaved: (s: ServerVoiceSettings) => void }) {
  const [stt, setStt] = useState(server.stt);
  const [tts, setTts] = useState(server.tts);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => { setStt(server.stt); setTts(server.tts); }, [server]);

  const save = async () => {
    setBusy(true);
    setMsg("");
    setSaveFailed(false);
    try {
      // Include the current provider block so old server-endpoint edits can
      // never reset dictation routing, even against a server without the
      // compatibility merge added in this change.
      const next = { stt, tts, dictation: server.dictation };
      const saved = await api.voiceSettingsSave(next) as ServerVoiceSettings;
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
        <TextInput value={stt.model} placeholder={tr("settings.voicepage.modelWhisper1")} style={{ maxWidth: 180 }}
          onChange={(e) => setStt({ ...stt, model: e.target.value })} aria-label={tr("settings.voicepage.sttModel")} />
      </div>
      <div className="mcp-form-row">
        <TextInput value={stt.language} placeholder={tr("settings.voicepage.languageEn")} style={{ maxWidth: 140 }}
          onChange={(e) => setStt({ ...stt, language: e.target.value })} aria-label={tr("settings.voicepage.sttLanguage")} />
        <TextInput value={stt.apiKeyEnv} placeholder={tr("settings.voicepage.apiKeyEnvVarNameEG")}
          onChange={(e) => setStt({ ...stt, apiKeyEnv: e.target.value })} aria-label={tr("settings.voicepage.sttApiKeyEnvVar")} />
      </div>

      <div className="stat-label">{tr("settings.voicepage.textToSpeechServer")}{" "}<span className="muted">{tr("settings.voicepage.openaiCompatibleAudioSpeechNonStandardParams")}</span></div>
      <div className="mcp-form-row">
        <TextInput value={tts.baseUrl} placeholder={tr("settings.voicepage.httpsHostV1EmptyBrowserOnly")}
          onChange={(e) => setTts({ ...tts, baseUrl: e.target.value })} aria-label={tr("settings.voicepage.ttsBaseUrl")} />
        <TextInput value={tts.model} placeholder={tr("settings.voicepage.modelTts1")} style={{ maxWidth: 180 }}
          onChange={(e) => setTts({ ...tts, model: e.target.value })} aria-label={tr("settings.voicepage.ttsModel")} />
      </div>
      <div className="mcp-form-row">
        <TextInput value={tts.voice} placeholder={tr("settings.voicepage.voiceAlloy")} style={{ maxWidth: 140 }}
          onChange={(e) => setTts({ ...tts, voice: e.target.value })} aria-label={tr("settings.voicepage.ttsVoice")} />
        <TextInput value={tts.apiKeyEnv} placeholder={tr("settings.voicepage.apiKeyEnvVarName")}
          onChange={(e) => setTts({ ...tts, apiKeyEnv: e.target.value })} aria-label={tr("settings.voicepage.ttsApiKeyEnvVar")} />
      </div>

      {msg && <div className={saveFailed ? "form-error" : "form-success"}>{msg}</div>}
      <div className="mcp-form-row">
        <span className="muted voice-form-note">{tr("settings.voicepage.keysAreReadFromTheServerS")}</span>
        <span className="header-spacer" />
        <Button size="sm" variant="primary" busy={busy} onClick={() => void save()}>{tr("settings.voicepage.saveServerSettings")}</Button>
      </div>
    </div>
  );
}

function DictationProviderForm({
  server,
  providers,
  models,
  onSaved,
  onRefreshProviders,
  onRefreshModels,
}: {
  server: ServerVoiceSettings;
  providers: ProviderView[];
  models: LocalModelView[];
  onSaved: (settings: ServerVoiceSettings) => void;
  onRefreshProviders: () => Promise<void>;
  onRefreshModels: () => Promise<void>;
}) {
  const [value, setValue] = useState<DictationSettingsDto>(server.dictation);
  const [busy, setBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => setValue(server.dictation), [server]);

  const capability = providerCapabilities(value.provider);
  const providerView = providers.find((item) => item.id === value.provider);
  const localModel = models.find((item) => item.id === value.localModel) ?? models[0];
  const transportOptions = capability?.transports ?? ["auto"];

  const changeProvider = (provider: DictationProviderId) => {
    const nextCapability = providerCapabilities(provider);
    const preferredTransport: DictationTransport = provider === "web-speech" ? "direct-browser"
      : provider.startsWith("local-") ? "local-worker" : "auto";
    setValue((current) => ({
      ...current,
      provider,
      transport: nextCapability?.transports.includes(preferredTransport) ? preferredTransport : nextCapability?.transports[0] ?? "auto",
      model: nextCapability?.defaultModel ?? "",
      apiKeyEnv: providerEnv(provider),
    }));
  };

  const save = async () => {
    setBusy(true);
    setMsg("");
    setFailed(false);
    try {
      const next = { stt: server.stt, tts: server.tts, dictation: value };
      const saved = await api.voiceSettingsSave(next) as ServerVoiceSettings;
      onSaved(saved);
      setValue(saved.dictation);
      setVoicePrefs({
        sttEngine: saved.dictation.provider === "web-speech" ? "browser" : "server",
        dictationProvider: saved.dictation.provider,
        dictationTransport: saved.dictation.transport,
        dictationModel: saved.dictation.model || undefined,
        localModel: saved.dictation.localModel || undefined,
        lang: saved.dictation.language || "auto",
        contextInjection: saved.dictation.contextInjection,
        cloudFallback: saved.dictation.cloudFallback,
        latencyPreference: saved.dictation.latencyPreference,
      });
      await Promise.all([onRefreshProviders(), onRefreshModels()]);
      setMsg(tr("settings.voicepage.savedCapabilityUpdated"));
    } catch (error) {
      setFailed(true);
      setMsg(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const modelAction = async (action: "download" | "delete") => {
    if (!localModel) return;
    setModelBusy(true);
    setFailed(false);
    setMsg("");
    try {
      await fetchJson(
        `/api/dictation/models/${encodeURIComponent(localModel.id)}${action === "download" ? "/download" : ""}`,
        { method: action === "download" ? "POST" : "DELETE" },
      );
      await onRefreshModels();
    } catch (error) {
      setFailed(true);
      setMsg(error instanceof Error ? error.message : String(error));
    } finally {
      setModelBusy(false);
    }
  };

  const progress = localModel && localModel.totalBytes > 0
    ? Math.min(100, Math.round((localModel.downloadedBytes / localModel.totalBytes) * 100))
    : 0;

  return (
    <div className="mcp-form" data-settings-item="voice.dictation-provider">
      <div className="stat-label">{tr("settings.voicepage.dictationEngine")}</div>
      <div className="mcp-form-row">
        <Select
          value={value.provider}
          label={capability?.label ?? value.provider}
          options={providerCatalog().map((provider) => ({ value: provider.id, label: provider.label }))}
          onChange={(provider) => changeProvider(provider as DictationProviderId)}
        />
        <Select
          value={value.transport}
          label={value.transport}
          options={transportOptions.map((transport) => ({ value: transport, label: transport }))}
          onChange={(transport) => setValue({ ...value, transport: transport as DictationTransport })}
        />
      </div>
      <div className="mcp-form-row">
        <TextInput
          value={value.model}
          placeholder={capability?.defaultModel ?? "model"}
          onChange={(event) => setValue({ ...value, model: event.target.value })}
          aria-label={tr("settings.voicepage.sttModel")}
        />
        <Select
          value={value.language || "auto"}
          label={value.language || "auto"}
          options={[value.language || "auto", ...LANGS.filter((language) => language !== value.language)].map((language) => ({ value: language, label: language }))}
          onChange={(language) => setValue({ ...value, language })}
        />
      </div>
      {!capability?.local && value.provider !== "web-speech" && (
        <TextInput
          value={value.apiKeyEnv}
          placeholder={tr("settings.voicepage.apiKeyEnvVarName")}
          onChange={(event) => setValue({ ...value, apiKeyEnv: event.target.value })}
          aria-label={tr("settings.voicepage.sttApiKeyEnvVar")}
        />
      )}
      <div className="mcp-form-row">
        <Toggle on={value.contextInjection} onChange={(contextInjection) => setValue({ ...value, contextInjection })} label="Context injection" />
        <Toggle on={value.cloudFallback} onChange={(cloudFallback) => setValue({ ...value, cloudFallback })} label="Cloud fallback" />
        <Select
          value={value.latencyPreference}
          label={value.latencyPreference}
          options={["lowest", "balanced", "quality"].map((latency) => ({ value: latency, label: latency }))}
          onChange={(latencyPreference) => setValue({ ...value, latencyPreference: latencyPreference as DictationLatencyPreference })}
        />
      </div>
      {providerView?.reason && <div className={providerView.available ? "form-success" : "muted"}>{providerView.reason}</div>}
      {capability?.publicApi === false && <div className="muted">No verified public Voice Interface API contract is available for this provider.</div>}

      {value.provider === "local-nemotron" && localModel && (
        <div className="mcp-form" data-settings-item="voice.local-model">
          <div className="stat-label">{localModel.label}</div>
          <div className="mcp-form-row">
            <Select
              value={value.localModel || localModel.id}
              label={localModel.label}
              options={models.map((model) => ({ value: model.id, label: model.label }))}
              onChange={(localModelId) => setValue({ ...value, localModel: localModelId })}
            />
            <span className="muted">{localModel.state}{localModel.state === "downloading" ? ` · ${progress}%` : ""}</span>
            {localModel.state === "installed" ? (
              <Button size="sm" variant="danger" busy={modelBusy} onClick={() => void modelAction("delete")}>Delete</Button>
            ) : (
              <Button size="sm" busy={modelBusy} disabled={localModel.state === "downloading"} onClick={() => void modelAction("download")}>
                {localModel.state === "failed" ? "Retry" : "Download"}
              </Button>
            )}
          </div>
          {localModel.state === "downloading" && <progress value={localModel.downloadedBytes} max={localModel.totalBytes} />}
          {localModel.error && <div className="form-error">{localModel.error}</div>}
          <div className="muted">Explicit download only · {Math.round(localModel.totalBytes / (1024 * 1024))} MiB · Ukrainian supported</div>
        </div>
      )}

      {msg && <div className={failed ? "form-error" : "form-success"}>{msg}</div>}
      <div className="mcp-form-row">
        <span className="muted voice-form-note">{tr("settings.voicepage.keysAreReadFromTheServerS")}</span>
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
  const [server, setServer] = useState<ServerVoiceSettings | null>(null);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [models, setModels] = useState<LocalModelView[]>([]);
  const [ttsTestMsg, setTtsTestMsg] = useState("");
  const [ttsTestFailed, setTtsTestFailed] = useState(false);

  const refreshCapability = () => void api.dictationCapability().then(setStreaming).catch(() => setStreaming(null));
  const refreshProviders = async () => {
    const result = await fetchJson<{ providers: ProviderView[] }>("/api/voice/providers");
    setProviders(result.providers);
  };
  const refreshModels = async () => {
    const result = await fetchJson<{ models: LocalModelView[] }>("/api/dictation/models");
    setModels(result.models);
  };

  useEffect(() => {
    refreshCapability();
    void api.voiceSettings().then((value) => setServer(value as ServerVoiceSettings)).catch(() => setServer(null));
    void refreshProviders().catch(() => setProviders([]));
    void refreshModels().catch(() => setModels([]));
  }, []);

  const downloading = useMemo(() => models.some((model) => model.state === "downloading"), [models]);
  useEffect(() => {
    if (!downloading) return;
    const timer = window.setInterval(() => void refreshModels().catch(() => {}), 1_000);
    return () => window.clearInterval(timer);
  }, [downloading]);

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
      {!support.stt && !support.tts && !streaming?.available && (
        <EmptyState title={tr("settings.voicepage.speechIsNotSupportedInThisBrowser")} body={tr("settings.voicepage.dictationNeedsTheWebSpeechApiChrome")} />
      )}
      <Row label={tr("settings.voicepage.dictation")} hint={support.stt || streaming?.available ? tr("settings.voicepage.showsTheMicButtonInTheComposer") : streaming?.reason ?? tr("settings.voicepage.notSupportedInThisBrowser")} itemId="voice.dictation">
        <Toggle on={prefs.dictation} onChange={(dictation) => setVoicePrefs({ dictation })} label={tr("settings.voicepage.dictation")} />
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
          onChange={(sttEngine) => setVoicePrefs({ sttEngine })}
        />
      </Row>

      {server && (
        <DictationProviderForm
          server={server}
          providers={providers}
          models={models}
          onSaved={(saved) => { setServer(saved); refreshCapability(); }}
          onRefreshProviders={refreshProviders}
          onRefreshModels={refreshModels}
        />
      )}

      <Row label={tr("settings.voicepage.readRepliesAloud")} hint={tr("settings.voicepage.speaksEachCompletedAssistantReplyInThe")}>
        <Toggle on={prefs.tts} onChange={(tts) => setVoicePrefs({ tts })} label={tr("settings.voicepage.readRepliesAloud")} />
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
          onChange={(ttsEngine) => setVoicePrefs({ ttsEngine })}
        />
      </Row>
      <Row label={tr("settings.voicepage.summarizeBeforeSpeaking")} hint={tr("settings.voicepage.longRepliesAreCondensedByTheSmall")} itemId="voice.summarize">
        <Toggle on={prefs.summarize} onChange={(summarize) => setVoicePrefs({ summarize })} label={tr("settings.voicepage.summarizeBeforeSpeaking")} />
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
        <input type="range" min={0.5} max={2} step={0.1} value={prefs.rate} onChange={(e) => setVoicePrefs({ rate: Number(e.target.value) })} />
      </Row>
      <Row label={tr("settings.voicepage.pitch")} hint={tr("settings.voicepage.value", {
        value: formatNumber(prefs.pitch, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      })} itemId="voice.pitch">
        <input type="range" min={0.5} max={2} step={0.1} value={prefs.pitch} onChange={(e) => setVoicePrefs({ pitch: Number(e.target.value) })} />
      </Row>
      <Row label={tr("settings.voicepage.volume")} hint={`${Math.round(prefs.volume * 100)}%`} itemId="voice.volume">
        <input type="range" min={0} max={1} step={0.05} value={prefs.volume} onChange={(e) => setVoicePrefs({ volume: Number(e.target.value) })} />
      </Row>
      {voices.length > 0 && (
        <Row label={tr("settings.voicepage.browserVoice")}>
          <Select
            value={prefs.voice ?? ""}
            label={prefs.voice || tr("settings.voicepage.default")}
            options={[{ value: "", label: tr("settings.voicepage.default") }, ...voices.map((voice) => ({ value: voice.name, label: voice.name }))]}
            onChange={(voice) => setVoicePrefs({ voice: voice || undefined })}
          />
        </Row>
      )}
      <Row label={tr("settings.voicepage.test")}>
        <Button size="sm" onClick={() => speak(tr("settings.voicepage.voiceCheckSample"))}>{tr("settings.voicepage.speakSample")}</Button>
        {server?.ttsConfigured && <Button size="sm" onClick={() => void testServerTts()}>{tr("settings.voicepage.testServerTts")}</Button>}
        <Button size="sm" variant="danger" iconStart={StopIcon} onClick={stopSpeaking}>{tr("common.stop")}</Button>
        {ttsTestMsg && <span className={ttsTestFailed ? "form-error" : "muted"}>{ttsTestMsg}</span>}
      </Row>

      {server && <ServerEndpointForm server={server} onSaved={(saved) => { setServer(saved); refreshCapability(); }} />}
    </div>
  );
}
