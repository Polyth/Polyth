// Voice settings: provider-neutral dictation + read-aloud. Provider/model names
// are capability data; every other user-facing string goes through the
// package's i18n catalog.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DEFAULT_LOCAL_MODEL_ID,
  installOnDeviceSpeech,
  onDeviceSpeechAvailability,
  providerCapabilities,
  providerCatalog,
  rankVoices,
  TTS_PROVIDERS,
  ttsProviderInfo,
  recognitionCtor,
  speechSupport,
  voiceTier,
  type OnDeviceSpeechAvailability,
  type DictationLatencyPreference,
  type DictationProcessingPolicy,
  type DictationProviderId,
  type DictationTransport,
  type TtsProviderId,
} from "@polyth/dictation";
import { api, type VoiceSettingsDto } from "@polyth/session/web-api";
import { setVoicePrefs, speak, stopSpeaking, useSpeechPlayback, useVoicePrefs } from "./voice.tsx";
import LocalVoicePicker from "./LocalVoicePicker.tsx";
import {
  EmptyState, ErrorState, FormField, PageHead, Row, SaveBar, Section, Seg, Toggle,
  type SaveStatusState,
} from "../../../apps/web/src/components/settings/parts.tsx";
import { formatNumber, getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Select, StopIcon, TextInput } from "../../../apps/web/src/components/ui/index.ts";

const LANGS = ["auto", "uk-UA", "en-US", "en-GB", "de-DE", "fr-FR", "es-ES", "it-IT", "pt-BR", "ja-JP", "ko-KR", "zh-CN"];

interface DictationSettingsDto {
  provider: DictationProviderId;
  transport: DictationTransport;
  model: string;
  localModel: string;
  language: string;
  contextInjection: boolean;
  processingPolicy: DictationProcessingPolicy;
  fallbackProvider?: DictationProviderId;
  fallbackApiKeyEnv: string;
  /** Compatibility mirror for older servers/clients. */
  cloudFallback: boolean;
  latencyPreference: DictationLatencyPreference;
  apiKeyEnv: string;
}

type ServerVoiceSettings = VoiceSettingsDto & {
  dictation: DictationSettingsDto;
  dictationKeyConfigured?: boolean;
  fallbackKeyConfigured?: boolean;
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
  extension?: boolean;
}

interface LocalModelView {
  id: string;
  label: string;
  preset?: "ultra" | "fast" | "balanced" | "accurate";
  state: "missing" | "downloading" | "installed" | "failed";
  downloadedBytes: number;
  totalBytes: number;
  languages: readonly string[];
  error?: string;
}

interface LocalRuntimeView {
  state: "missing" | "downloading" | "installed" | "failed" | "unsupported";
  version: string;
  platform: string;
  arch: string;
  downloadedBytes: number;
  totalBytes?: number;
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

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const languageLabel = (code: string): string => {
  if (!code || code === "auto") return tr("settings.voicepage.autoDetect");
  try {
    const name = new Intl.DisplayNames([getLocale()], { type: "language" }).of(code);
    if (name) return name.charAt(0).toLocaleUpperCase(getLocale()) + name.slice(1);
  } catch { /* unknown tag: show it as typed */ }
  return code;
};

const languageOptions = (current: string) =>
  [current || "auto", ...LANGS.filter((language) => language !== (current || "auto"))]
    .map((language) => ({ value: language, label: languageLabel(language) }));

const policyOptions = (provider: DictationProviderId): DictationProcessingPolicy[] => {
  if (provider === "web-speech") return ["browser-fallback"];
  const capability = providerCapabilities(provider);
  return capability?.local
    ? ["local-only", "prefer-local", "auto-fallback"]
    : ["prefer-cloud", "auto-fallback", "browser-fallback"];
};

const policyLabel = (policy: DictationProcessingPolicy): string => {
  switch (policy) {
    case "local-only": return tr("settings.voicepage.policyLocalOnly");
    case "prefer-local": return tr("settings.voicepage.policyPreferLocal");
    case "prefer-cloud": return tr("settings.voicepage.policyPreferCloud");
    case "auto-fallback": return tr("settings.voicepage.policyAutoFallback");
    case "browser-fallback": return tr("settings.voicepage.policyBrowserFallback");
  }
};

const transportLabel = (transport: DictationTransport): string => {
  switch (transport) {
    case "auto": return tr("settings.voicepage.transportAuto");
    case "direct-browser": return tr("settings.voicepage.transportDirect");
    case "server-proxy": return tr("settings.voicepage.transportServer");
    case "local-worker": return tr("settings.voicepage.transportLocal");
  }
};

const providerName = (id: DictationProviderId | undefined, providers: ProviderView[]): string =>
  id ? providers.find((item) => item.id === id)?.label ?? providerCapabilities(id)?.label ?? id : "";

const processingDescription = (settings: DictationSettingsDto, providers: ProviderView[]): string => {
  const engine = providerName(settings.provider, providers);
  const fallback = providerName(settings.fallbackProvider, providers);
  const local = Boolean(providerCapabilities(settings.provider)?.local);
  switch (settings.processingPolicy) {
    case "local-only":
      return tr("settings.voicepage.policyLocalOnlyHint");
    case "prefer-local":
      return fallback
        ? tr("settings.voicepage.policyPreferLocalHint", { fallback })
        : tr("settings.voicepage.policyNoBackupHint");
    case "prefer-cloud":
      return tr("settings.voicepage.policyPreferCloudHint", { engine });
    case "auto-fallback":
      if (!local) return tr("settings.voicepage.policyAutoCloudHint", { engine });
      return fallback
        ? tr("settings.voicepage.policyAutoLocalHint", { fallback })
        : tr("settings.voicepage.policyNoBackupHint");
    case "browser-fallback":
      return settings.provider === "web-speech"
        ? tr("settings.voicepage.policyBrowserOnlyHint")
        : tr("settings.voicepage.policyBrowserFallbackHint", { engine });
  }
};

type Tone = "ok" | "warn" | "error" | "muted";

/** Small status pill; the server reports availability as terse English, so the
 *  known reasons are rewritten into plain sentences here. */
function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`voice-status is-${tone}`}>{children}</span>;
}

const engineStatus = (
  provider: DictationProviderId,
  view: ProviderView | undefined,
  apiKeyEnv: string,
): { tone: Tone; text: string } | null => {
  if (!view) return null;
  if (view.available) return { tone: "ok", text: tr("settings.voicepage.statusReady") };
  const reason = view.reason ?? "";
  const capability = providerCapabilities(provider);
  if (reason.startsWith("missing ") || (!capability?.local && providerEnv(provider) && reason === "not configured for this route")) {
    return { tone: "warn", text: tr("settings.voicepage.statusKeyMissing", { env: apiKeyEnv || providerEnv(provider) }) };
  }
  if (reason === "local sherpa runtime is not downloaded") return { tone: "warn", text: tr("settings.voicepage.statusRuntimeMissing") };
  if (reason === "local model is not downloaded") return { tone: "warn", text: tr("settings.voicepage.statusModelMissing") };
  if (provider === "openai-compatible") return { tone: "warn", text: tr("settings.voicepage.statusServerMissing") };
  if (capability?.publicApi === false) return { tone: "muted", text: tr("settings.voicepage.statusPrivateAdapter") };
  return reason ? { tone: "muted", text: reason } : null;
};

const percent = (done: number, total: number | undefined): number =>
  total ? Math.min(100, Math.round((done / total) * 100)) : 0;

/** Inline two-step delete so a download is never removed by a stray click. */
function DeleteButton({ busy, onConfirm }: { busy: boolean; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  if (!armed) return <Button size="sm" variant="ghost" busy={busy} onClick={() => setArmed(true)}>{tr("settings.voicepage.delete")}</Button>;
  return (
    <span className="voice-confirm" role="group" aria-label={tr("settings.voicepage.deleteConfirm")}>
      <Button size="sm" variant="ghost" onClick={() => setArmed(false)}>{tr("settings.voicepage.cancel")}</Button>
      <Button size="sm" variant="danger" busy={busy} onClick={() => { setArmed(false); onConfirm(); }}>{tr("settings.voicepage.delete")}</Button>
    </span>
  );
}

function RangeControl({ label, value, min, max, step, readout, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  readout: string;
  onChange: (value: number) => void;
}) {
  return (
    <span className="voice-range">
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label} aria-valuetext={readout}
        onChange={(event) => onChange(Number(event.target.value))} />
      <output aria-hidden="true">{readout}</output>
    </span>
  );
}

function useSaveState() {
  const [status, setStatus] = useState<SaveStatusState>("idle");
  const [error, setError] = useState("");
  return {
    status,
    error,
    start: () => { setStatus("saving"); setError(""); },
    done: () => setStatus("saved"),
    fail: (cause: unknown) => { setStatus("error"); setError(errorMessage(cause)); },
  };
}

// Known OpenAI-compatible endpoints. Groq's speech recognition has a free
// tier (an API key is still required); Kokoro-FastAPI runs free and local on
// its default port. Both only fill the form — nothing is saved until Save.
const STT_PRESETS = {
  groq: { baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo", apiKeyEnv: "GROQ_API_KEY" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "whisper-1", apiKeyEnv: "OPENAI_API_KEY" },
} as const;

const TTS_PRESETS = {
  kokoro: { baseUrl: "http://localhost:8880/v1", model: "kokoro", voice: "af_heart", apiKeyEnv: "" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "tts-1", voice: "alloy", apiKeyEnv: "OPENAI_API_KEY" },
} as const;

function PresetBar({ label, presets }: { label: string; presets: Array<{ id: string; label: string; apply: () => void }> }) {
  return (
    <div className="voice-presets" role="group" aria-label={label}>
      <span className="voice-presets-label">{label}</span>
      {presets.map((preset) => (
        <Button key={preset.id} size="sm" variant="quiet" onClick={preset.apply}>{preset.label}</Button>
      ))}
    </div>
  );
}

/** A key typed here goes to the server and never comes back; the field only
 *  knows whether one is saved. `undefined` keeps it, `null` removes it. */
type KeyDraft = string | null | undefined;

const keyChanges = (drafts: Array<[slot: string, draft: KeyDraft]>): Record<string, string | null> | undefined => {
  const keys = Object.fromEntries(drafts.filter(([, draft]) => draft !== undefined)) as Record<string, string | null>;
  return Object.keys(keys).length ? keys : undefined;
};

function KeyInput({ field, label, stored, draft, onDraft }: {
  field?: { id: string; "aria-describedby"?: string };
  label: string;
  stored: boolean;
  draft: KeyDraft;
  onDraft: (next: KeyDraft) => void;
}) {
  const removing = draft === null;
  return (
    <span className="voice-key">
      <TextInput
        {...field}
        type="password"
        autoComplete="off"
        spellCheck={false}
        className="voice-mono"
        value={typeof draft === "string" ? draft : ""}
        placeholder={tr(removing ? "settings.voicepage.apiKeyRemovePending"
          : stored ? "settings.voicepage.apiKeySavedPlaceholder" : "settings.voicepage.apiKeyPlaceholder")}
        aria-label={label}
        onChange={(event) => onDraft(event.target.value || undefined)}
      />
      {stored && (
        <Button size="sm" variant="ghost" onClick={() => onDraft(removing ? undefined : null)}>
          {tr(removing ? "settings.voicepage.cancel" : "settings.voicepage.apiKeyRemove")}
        </Button>
      )}
    </span>
  );
}

/** The browser's on-device recognizer for the dictation language, where the
 *  browser offers one (`SpeechRecognition.available`). Downloading a language
 *  pack is the user's explicit choice. */
function OnDeviceRow({ lang, enabled }: { lang: string; enabled: boolean }) {
  const [state, setState] = useState<OnDeviceSpeechAvailability | "checking">("checking");
  const [busy, setBusy] = useState(false);
  const target = !lang || lang === "auto" ? navigator.language : lang;
  useEffect(() => {
    let cancelled = false;
    setState("checking");
    void onDeviceSpeechAvailability(window, target).then((value) => { if (!cancelled) setState(value); });
    return () => { cancelled = true; };
  }, [target]);
  const status = state === "checking" ? <Status tone="muted">{tr("settings.voicepage.checking")}</Status>
    : state === "available" ? <Status tone="ok">{tr("settings.voicepage.onDeviceReady")}</Status>
    : state === "downloadable" ? <Status tone="muted">{tr("settings.voicepage.onDeviceDownloadable")}</Status>
    : state === "downloading" ? <Status tone="muted">{tr("settings.voicepage.onDeviceDownloading")}</Status>
    : <Status tone="muted">{tr("settings.voicepage.onDeviceUnavailable")}</Status>;
  return (
    <Row label={tr("settings.voicepage.onDevice")} hint={<>{tr("settings.voicepage.onDeviceHint")} {status}</>} itemId="voice.on-device">
      {state === "downloadable" && (
        <Button size="sm" busy={busy} onClick={() => {
          setBusy(true);
          setState("downloading");
          void installOnDeviceSpeech(window, target)
            .then(() => onDeviceSpeechAvailability(window, target))
            .then(setState)
            .finally(() => setBusy(false));
        }}>{tr("settings.voicepage.download")}</Button>
      )}
      <Toggle on={enabled} onChange={(onDeviceSpeech) => setVoicePrefs({ onDeviceSpeech })} label={tr("settings.voicepage.onDevice")} />
    </Row>
  );
}

type TtsSettings = Required<ServerVoiceSettings["tts"]>;

/** Older servers omit the provider fields; they only speak OpenAI-compatible. */
const ttsSettings = (tts: ServerVoiceSettings["tts"]): TtsSettings => ({
  provider: "openai-compatible", secretKeyEnv: "", region: "", ...tts,
});

/** Where the server voice comes from, for the read-aloud hint. */
const ttsSource = (tts: ServerVoiceSettings["tts"]): string => {
  const settings = ttsSettings(tts);
  if (settings.provider !== "openai-compatible") return ttsProviderInfo(settings.provider).label;
  try { return new URL(settings.baseUrl).host; } catch { return settings.baseUrl; }
};

/** The voice service Read aloud uses when Server is picked. */
function TtsServerForm({ server, onSaved }: { server: ServerVoiceSettings; onSaved: (s: ServerVoiceSettings) => void }) {
  const [tts, setTts] = useState(() => ttsSettings(server.tts));
  const [keyDraft, setKeyDraft] = useState<KeyDraft>(undefined);
  const [secretDraft, setSecretDraft] = useState<KeyDraft>(undefined);
  const save = useSaveState();
  const info = ttsProviderInfo(tts.provider);
  const keySlot = `tts:${tts.provider}`;
  const secretSlot = `tts-secret:${tts.provider}`;
  const storedKeys = server.storedKeys ?? [];

  const reset = () => {
    setTts(ttsSettings(server.tts));
    setKeyDraft(undefined);
    setSecretDraft(undefined);
  };
  useEffect(reset, [server]);

  const dirty = JSON.stringify(tts) !== JSON.stringify(ttsSettings(server.tts))
    || keyDraft !== undefined || secretDraft !== undefined;

  // A new service starts from its own defaults; nothing is saved until Save.
  const chooseProvider = (provider: TtsProviderId) => {
    if (provider === tts.provider) return;
    const next = ttsProviderInfo(provider);
    // Keys are stored per service; one typed for the old service is dropped.
    setKeyDraft(undefined);
    setSecretDraft(undefined);
    setTts({
      provider,
      baseUrl: next.needsBaseUrl ? tts.baseUrl : "",
      model: next.defaultModel,
      voice: next.defaultVoice,
      apiKeyEnv: next.defaultApiKeyEnv,
      secretKeyEnv: next.defaultSecretKeyEnv,
      region: next.defaultRegion,
    });
  };

  const submit = async () => {
    save.start();
    try {
      const keys = keyChanges([[keySlot, keyDraft], ...(info.needsSecret ? [[secretSlot, secretDraft] as [string, KeyDraft]] : [])]);
      const next = { stt: server.stt, tts, dictation: server.dictation, ...(keys ? { keys } : {}) };
      const saved = await api.voiceSettingsSave(next) as ServerVoiceSettings;
      onSaved(saved);
      setTts(ttsSettings(saved.tts));
      setKeyDraft(undefined);
      setSecretDraft(undefined);
      save.done();
    } catch (cause) {
      save.fail(cause);
    }
  };

  return (
    <>
      <Row label={tr("settings.voicepage.ttsProvider")} {...(info.freeTier ? { hint: tr("settings.voicepage.ttsFreeTier", { value: info.freeTier }) } : {})} itemId="voice.ttsProvider">
        <Select
          value={tts.provider}
          label={info.label}
          ariaLabel={tr("settings.voicepage.ttsProvider")}
          options={TTS_PROVIDERS.map((provider) => ({ value: provider.id, label: provider.label }))}
          onChange={(provider) => chooseProvider(provider as TtsProviderId)}
        />
      </Row>
      <div className="voice-server-group">
        {info.needsBaseUrl && (
          <PresetBar label={tr("settings.voicepage.quickSetup")} presets={[
            { id: "kokoro", label: tr("settings.voicepage.presetKokoro"), apply: () => setTts({ ...tts, ...TTS_PRESETS.kokoro }) },
            { id: "openai", label: tr("settings.voicepage.presetOpenAI"), apply: () => setTts({ ...tts, ...TTS_PRESETS.openai }) },
          ]} />
        )}
        <div className="voice-server-grid">
          {info.needsBaseUrl && (
            <FormField label={tr("settings.voicepage.serverUrl")} hint={tr("settings.voicepage.serverUrlTtsHint")}>
              {(field) => <TextInput {...field} value={tts.baseUrl} placeholder="https://host/v1" onChange={(e) => setTts({ ...tts, baseUrl: e.target.value })} />}
            </FormField>
          )}
          <FormField label={tr("settings.voicepage.model")} optional>
            {(field) => <TextInput {...field} value={tts.model} placeholder={info.defaultModel || tr("settings.voicepage.default")} onChange={(e) => setTts({ ...tts, model: e.target.value })} />}
          </FormField>
          <FormField label={tr("settings.voicepage.voiceName")} optional>
            {(field) => <TextInput {...field} value={tts.voice} placeholder={info.defaultVoice} onChange={(e) => setTts({ ...tts, voice: e.target.value })} />}
          </FormField>
          {info.needsRegion && (
            <FormField label={tr("settings.voicepage.region")} optional>
              {(field) => <TextInput {...field} className="voice-mono" value={tts.region} placeholder={info.defaultRegion} onChange={(e) => setTts({ ...tts, region: e.target.value })} />}
            </FormField>
          )}
          <FormField label={tr("settings.voicepage.apiKey")} hint={tr("settings.voicepage.apiKeyHint")} optional={info.needsBaseUrl}>
            {(field) => <KeyInput field={field} label={tr("settings.voicepage.apiKey")} stored={storedKeys.includes(keySlot)} draft={keyDraft} onDraft={setKeyDraft} />}
          </FormField>
          {info.needsSecret && (
            <FormField label={tr("settings.voicepage.secretKey")} hint={tr("settings.voicepage.apiKeyHint")}>
              {(field) => <KeyInput field={field} label={tr("settings.voicepage.secretKey")} stored={storedKeys.includes(secretSlot)} draft={secretDraft} onDraft={setSecretDraft} />}
            </FormField>
          )}
          <FormField label={tr("settings.voicepage.apiKeyVariable")} hint={tr("settings.voicepage.apiKeyVariableHint")} optional>
            {(field) => <TextInput {...field} className="voice-mono" value={tts.apiKeyEnv} placeholder={info.defaultApiKeyEnv || "OPENAI_API_KEY"} onChange={(e) => setTts({ ...tts, apiKeyEnv: e.target.value })} />}
          </FormField>
          {info.needsSecret && (
            <FormField label={tr("settings.voicepage.secretKeyVariable")} hint={tr("settings.voicepage.apiKeyVariableHint")} optional>
              {(field) => <TextInput {...field} className="voice-mono" value={tts.secretKeyEnv} placeholder={info.defaultSecretKeyEnv} onChange={(e) => setTts({ ...tts, secretKeyEnv: e.target.value })} />}
            </FormField>
          )}
        </div>
      </div>
      <p className="voice-note">{tr(info.needsBaseUrl ? "settings.voicepage.ttsPresetHint" : "settings.voicepage.ttsHostedHint", { provider: info.label })}</p>
      <SaveBar
        dirty={dirty}
        saving={save.status === "saving"}
        status={save.status}
        {...(save.error ? { error: save.error } : {})}
        onSave={() => void submit()}
        onDiscard={reset}
      />
    </>
  );
}

function DictationProviderForm({
  server,
  providers,
  models,
  runtime,
  onSaved,
  onRefreshProviders,
  onRefreshModels,
}: {
  server: ServerVoiceSettings;
  providers: ProviderView[];
  models: LocalModelView[];
  runtime: LocalRuntimeView | null;
  onSaved: (settings: ServerVoiceSettings) => void;
  onRefreshProviders: () => Promise<void>;
  onRefreshModels: () => Promise<void>;
}) {
  const [value, setValue] = useState<DictationSettingsDto>(server.dictation);
  // The OpenAI-compatible engine's server URL; saved with the engine.
  const [sttUrl, setSttUrl] = useState(server.stt.baseUrl);
  const [keyDraft, setKeyDraft] = useState<KeyDraft>(undefined);
  const [fallbackKeyDraft, setFallbackKeyDraft] = useState<KeyDraft>(undefined);
  const [modelBusy, setModelBusy] = useState(false);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const save = useSaveState();

  const reset = () => {
    setValue(server.dictation);
    setSttUrl(server.stt.baseUrl);
    setKeyDraft(undefined);
    setFallbackKeyDraft(undefined);
  };
  useEffect(reset, [server]);
  const storedKeys = server.storedKeys ?? [];

  const capability = providerCapabilities(value.provider);
  const isLocal = Boolean(capability?.local);
  const isBrowser = value.provider === "web-speech";
  const localModel = models.find((item) => item.id === (value.localModel || DEFAULT_LOCAL_MODEL_ID))
    ?? models.find((item) => item.id === DEFAULT_LOCAL_MODEL_ID)
    ?? models[0];
  const transportOptions = capability?.transports ?? ["auto"];
  const policies = policyOptions(value.provider);
  const needsFallbackProvider = isLocal
    && (value.processingPolicy === "prefer-local" || value.processingPolicy === "auto-fallback");
  const fallbackCandidates = providerCatalog().filter((provider) =>
    !provider.local && provider.id !== value.provider,
  );
  const status = engineStatus(value.provider, providers.find((item) => item.id === value.provider), value.apiKeyEnv);
  const fallbackStatus = value.fallbackProvider
    ? engineStatus(value.fallbackProvider, providers.find((item) => item.id === value.fallbackProvider), value.fallbackApiKeyEnv)
    : null;
  const isCustomServer = value.provider === "openai-compatible";
  const dirty = JSON.stringify(value) !== JSON.stringify(server.dictation) || sttUrl !== server.stt.baseUrl
    || keyDraft !== undefined || fallbackKeyDraft !== undefined;

  const changeProvider = (provider: DictationProviderId) => {
    const nextCapability = providerCapabilities(provider);
    const preferredTransport: DictationTransport = provider === "web-speech" ? "direct-browser"
      : provider === "local-nemotron" ? "local-worker" : "auto";
    const processingPolicy: DictationProcessingPolicy = provider === "web-speech"
      ? "browser-fallback"
      : nextCapability?.local ? "local-only" : "prefer-cloud";
    // Keys are stored per engine; one typed for the old engine is dropped.
    setKeyDraft(undefined);
    setFallbackKeyDraft(undefined);
    setValue((current) => ({
      ...current,
      provider,
      transport: nextCapability?.transports.includes(preferredTransport) ? preferredTransport : nextCapability?.transports[0] ?? "auto",
      model: nextCapability?.defaultModel ?? "",
      localModel: provider === "local-nemotron" ? current.localModel || DEFAULT_LOCAL_MODEL_ID : current.localModel,
      apiKeyEnv: providerEnv(provider),
      processingPolicy,
      fallbackProvider: undefined,
      fallbackApiKeyEnv: "",
      cloudFallback: false,
    }));
  };

  const changePolicy = (processingPolicy: DictationProcessingPolicy) => {
    const keepFallback = isLocal
      && (processingPolicy === "prefer-local" || processingPolicy === "auto-fallback");
    setValue((current) => ({
      ...current,
      processingPolicy,
      ...(keepFallback ? {} : { fallbackProvider: undefined, fallbackApiKeyEnv: "" }),
      cloudFallback: keepFallback && Boolean(current.fallbackProvider),
    }));
  };

  const changeFallback = (fallbackProvider: string) => {
    const provider = fallbackProvider ? fallbackProvider as DictationProviderId : undefined;
    setFallbackKeyDraft(undefined);
    setValue((current) => ({
      ...current,
      ...(provider ? { fallbackProvider: provider } : { fallbackProvider: undefined }),
      fallbackApiKeyEnv: provider ? providerEnv(provider) : "",
      cloudFallback: Boolean(provider)
        && (current.processingPolicy === "prefer-local" || current.processingPolicy === "auto-fallback"),
    }));
  };

  const submit = async () => {
    save.start();
    try {
      const cloudFallback = Boolean(value.fallbackProvider)
        && (value.processingPolicy === "prefer-local" || value.processingPolicy === "auto-fallback");
      const dictation = { ...value, cloudFallback };
      const keys = keyChanges([
        [`dictation:${value.provider}`, keyDraft],
        ...(value.fallbackProvider ? [[`dictation:${value.fallbackProvider}`, fallbackKeyDraft] as [string, KeyDraft]] : []),
      ]);
      const next = { stt: { ...server.stt, baseUrl: sttUrl.trim() }, tts: server.tts, dictation, ...(keys ? { keys } : {}) };
      const saved = await api.voiceSettingsSave(next) as ServerVoiceSettings;
      onSaved(saved);
      setValue(saved.dictation);
      setKeyDraft(undefined);
      setFallbackKeyDraft(undefined);
      setVoicePrefs({
        sttEngine: saved.dictation.provider === "web-speech" ? "browser" : "server",
        dictationProvider: saved.dictation.provider,
        dictationTransport: saved.dictation.transport,
        dictationModel: saved.dictation.model || undefined,
        localModel: saved.dictation.localModel || undefined,
        lang: saved.dictation.language || "auto",
        contextInjection: saved.dictation.contextInjection,
        processingPolicy: saved.dictation.processingPolicy,
        fallbackProvider: saved.dictation.fallbackProvider,
        cloudFallback: saved.dictation.cloudFallback,
        latencyPreference: saved.dictation.latencyPreference,
      });
      await Promise.all([onRefreshProviders(), onRefreshModels()]);
      save.done();
    } catch (cause) {
      save.fail(cause);
    }
  };

  const modelAction = async (action: "download" | "delete") => {
    if (!localModel) return;
    setModelBusy(true);
    setActionError("");
    try {
      await fetchJson(
        `/api/dictation/models/${encodeURIComponent(localModel.id)}${action === "download" ? "/download" : ""}`,
        { method: action === "download" ? "POST" : "DELETE" },
      );
      await Promise.all([onRefreshModels(), onRefreshProviders()]);
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setModelBusy(false);
    }
  };

  const runtimeAction = async (action: "download" | "delete") => {
    setRuntimeBusy(true);
    setActionError("");
    try {
      await fetchJson("/api/dictation/runtime", { method: action === "download" ? "POST" : "DELETE" });
      await Promise.all([onRefreshModels(), onRefreshProviders()]);
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setRuntimeBusy(false);
    }
  };

  const downloadState = (state: LocalModelView["state"] | LocalRuntimeView["state"], done: number, total: number | undefined) => {
    switch (state) {
      case "installed": return <Status tone="ok">{tr("settings.voicepage.installed")}</Status>;
      case "downloading": return <Status tone="muted">{tr("settings.voicepage.downloading", { value: percent(done, total) })}</Status>;
      case "failed": return <Status tone="error">{tr("settings.voicepage.downloadFailed")}</Status>;
      case "unsupported": return <Status tone="muted">{tr("settings.voicepage.unsupportedDevice")}</Status>;
      default: return <Status tone="muted">{tr("settings.voicepage.notDownloaded")}</Status>;
    }
  };

  return (
    <>
      <Row
        label={tr("settings.voicepage.engine")}
        hint={status ? <Status tone={status.tone}>{status.text}</Status> : undefined}
        itemId="voice.dictation-provider"
      >
        <Select
          value={value.provider}
          label={capability?.label ?? value.provider}
          ariaLabel={tr("settings.voicepage.engine")}
          options={providerCatalog().map((provider) => ({ value: provider.id, label: provider.label }))}
          onChange={(provider) => changeProvider(provider as DictationProviderId)}
        />
      </Row>
      {isCustomServer && (
        <Row
          label={tr("settings.voicepage.serverUrl")}
          hint={(
            <>
              {tr("settings.voicepage.sttServerUrlHint")}
              <PresetBar label={tr("settings.voicepage.quickSetup")} presets={([["groq", "presetGroq"], ["openai", "presetOpenAI"]] as const).map(([id, label]) => ({
                id,
                label: tr(`settings.voicepage.${label}`),
                apply: () => {
                  const preset = STT_PRESETS[id];
                  setSttUrl(preset.baseUrl);
                  setValue((current) => ({ ...current, model: preset.model, apiKeyEnv: preset.apiKeyEnv }));
                },
              }))} />
            </>
          )}
          itemId="voice.server"
        >
          <TextInput
            value={sttUrl}
            placeholder="https://host/v1"
            onChange={(event) => setSttUrl(event.target.value)}
            aria-label={tr("settings.voicepage.serverUrl")}
          />
        </Row>
      )}
      {!isLocal && !isBrowser && (
        <Row label={tr("settings.voicepage.apiKey")} hint={tr("settings.voicepage.apiKeyHint")} itemId="voice.dictation-key">
          <KeyInput label={tr("settings.voicepage.apiKey")} stored={storedKeys.includes(`dictation:${value.provider}`)} draft={keyDraft} onDraft={setKeyDraft} />
        </Row>
      )}
      {!isLocal && !isBrowser && (
        <Row label={tr("settings.voicepage.apiKeyVariable")} hint={tr("settings.voicepage.apiKeyVariableHint")}>
          <TextInput
            className="voice-mono"
            value={value.apiKeyEnv}
            placeholder={providerEnv(value.provider)}
            onChange={(event) => setValue({ ...value, apiKeyEnv: event.target.value })}
            aria-label={tr("settings.voicepage.apiKeyVariable")}
          />
        </Row>
      )}
      {!isLocal && !isBrowser && (
        <Row label={tr("settings.voicepage.model")} hint={tr("settings.voicepage.modelHint")}>
          <TextInput
            value={value.model}
            placeholder={capability?.defaultModel ?? ""}
            onChange={(event) => setValue({ ...value, model: event.target.value })}
            aria-label={tr("settings.voicepage.model")}
          />
        </Row>
      )}

      {value.provider === "local-nemotron" && (
        <>
          <Row label={tr("settings.voicepage.speechRuntime")} hint={tr("settings.voicepage.speechRuntimeHint")} itemId="voice.local-runtime">
            {runtime ? (
              <>
                {downloadState(runtime.state, runtime.downloadedBytes, runtime.totalBytes)}
                {runtime.state === "installed" ? (
                  <DeleteButton busy={runtimeBusy} onConfirm={() => void runtimeAction("delete")} />
                ) : runtime.state !== "unsupported" ? (
                  <Button size="sm" busy={runtimeBusy} disabled={runtime.state === "downloading"} onClick={() => void runtimeAction("download")}>
                    {runtime.state === "failed" ? tr("settings.voicepage.retry") : tr("settings.voicepage.download")}
                  </Button>
                ) : null}
              </>
            ) : <Status tone="muted">{tr("settings.voicepage.checking")}</Status>}
          </Row>
          {runtime?.state === "downloading" && runtime.totalBytes ? (
            <progress className="voice-progress" value={runtime.downloadedBytes} max={runtime.totalBytes} />
          ) : null}
          {runtime?.error && <p className={runtime.state === "unsupported" ? "voice-note" : "settings-field-error"}>{runtime.error}</p>}

          {localModel && (
            <Row
              label={tr("settings.voicepage.localModel")}
              hint={tr("settings.voicepage.localModelHint", { size: Math.round(localModel.totalBytes / (1024 * 1024)) })}
              itemId="voice.local-model"
              top
            >
              <span className="voice-stack">
                <Select
                  value={value.localModel || DEFAULT_LOCAL_MODEL_ID}
                  label={localModel.label}
                  ariaLabel={tr("settings.voicepage.localModel")}
                  options={models.map((model) => ({ value: model.id, label: model.label }))}
                  onChange={(localModelId) => setValue({ ...value, localModel: localModelId })}
                />
                <span className="voice-inline">
                  {downloadState(localModel.state, localModel.downloadedBytes, localModel.totalBytes)}
                  {localModel.state === "installed" ? (
                    <DeleteButton busy={modelBusy} onConfirm={() => void modelAction("delete")} />
                  ) : (
                    <Button size="sm" busy={modelBusy} disabled={localModel.state === "downloading"} onClick={() => void modelAction("download")}>
                      {localModel.state === "failed" ? tr("settings.voicepage.retry") : tr("settings.voicepage.download")}
                    </Button>
                  )}
                </span>
              </span>
            </Row>
          )}
          {localModel?.state === "downloading" && <progress className="voice-progress" value={localModel.downloadedBytes} max={localModel.totalBytes} />}
          {localModel?.error && <p className="settings-field-error">{localModel.error}</p>}
        </>
      )}

      <Row label={tr("settings.voicepage.spokenLanguage")} hint={tr("settings.voicepage.spokenLanguageHint")}>
        <Select
          value={value.language || "auto"}
          label={languageLabel(value.language)}
          ariaLabel={tr("settings.voicepage.spokenLanguage")}
          options={languageOptions(value.language)}
          onChange={(language) => setValue({ ...value, language })}
        />
      </Row>
      {transportOptions.length > 1 && (
        <Row label={tr("settings.voicepage.connection")} hint={tr("settings.voicepage.connectionHint")}>
          <Select
            value={value.transport}
            label={transportLabel(value.transport)}
            ariaLabel={tr("settings.voicepage.connection")}
            options={transportOptions.map((transport) => ({ value: transport, label: transportLabel(transport) }))}
            onChange={(transport) => setValue({ ...value, transport: transport as DictationTransport })}
          />
        </Row>
      )}
      <Row label={tr("settings.voicepage.priority")} hint={tr("settings.voicepage.priorityHint")}>
        <Seg
          value={value.latencyPreference}
          label={tr("settings.voicepage.priority")}
          options={[
            ["lowest", tr("settings.voicepage.priorityFastest")],
            ["balanced", tr("settings.voicepage.priorityBalanced")],
            ["quality", tr("settings.voicepage.priorityAccurate")],
          ]}
          onChange={(latencyPreference) => setValue({ ...value, latencyPreference })}
        />
      </Row>
      <Row label={tr("settings.voicepage.useChatContext")} hint={tr("settings.voicepage.useChatContextHint")}>
        <Toggle on={value.contextInjection} onChange={(contextInjection) => setValue({ ...value, contextInjection })} label={tr("settings.voicepage.useChatContext")} />
      </Row>
      {policies.length > 1 && (
        <Row label={tr("settings.voicepage.ifItFails")} hint={processingDescription(value, providers)}>
          <Select
            value={value.processingPolicy}
            label={policyLabel(value.processingPolicy)}
            ariaLabel={tr("settings.voicepage.ifItFails")}
            options={policies.map((policy) => ({ value: policy, label: policyLabel(policy) }))}
            onChange={(policy) => changePolicy(policy as DictationProcessingPolicy)}
          />
        </Row>
      )}
      {needsFallbackProvider && (
        <Row
          label={tr("settings.voicepage.backupEngine")}
          hint={fallbackStatus ? <Status tone={fallbackStatus.tone}>{fallbackStatus.text}</Status> : tr("settings.voicepage.backupEngineHint")}
        >
          <Select
            value={value.fallbackProvider ?? ""}
            label={value.fallbackProvider ? providerName(value.fallbackProvider, providers) : tr("settings.voicepage.noBackup")}
            ariaLabel={tr("settings.voicepage.backupEngine")}
            options={[
              { value: "", label: tr("settings.voicepage.noBackup") },
              ...fallbackCandidates.map((provider) => ({ value: provider.id, label: provider.label })),
            ]}
            onChange={changeFallback}
          />
        </Row>
      )}
      {needsFallbackProvider && value.fallbackProvider && (
        <Row label={tr("settings.voicepage.backupApiKey")} hint={tr("settings.voicepage.apiKeyHint")}>
          <KeyInput label={tr("settings.voicepage.backupApiKey")} stored={storedKeys.includes(`dictation:${value.fallbackProvider}`)} draft={fallbackKeyDraft} onDraft={setFallbackKeyDraft} />
        </Row>
      )}
      {needsFallbackProvider && value.fallbackProvider && (
        <Row label={tr("settings.voicepage.backupApiKeyVariable")} hint={tr("settings.voicepage.apiKeyVariableHint")}>
          <TextInput
            className="voice-mono"
            value={value.fallbackApiKeyEnv}
            placeholder={providerEnv(value.fallbackProvider)}
            onChange={(event) => setValue({ ...value, fallbackApiKeyEnv: event.target.value })}
            aria-label={tr("settings.voicepage.backupApiKeyVariable")}
          />
        </Row>
      )}

      {actionError && <p className="settings-field-error" role="alert">{actionError}</p>}
      <SaveBar
        dirty={dirty}
        saving={save.status === "saving"}
        status={save.status}
        {...(save.error ? { error: save.error } : {})}
        onSave={() => void submit()}
        onDiscard={reset}
      />
    </>
  );
}

export default function VoicePage() {
  const prefs = useVoicePrefs();
  const playback = useSpeechPlayback();
  const support = speechSupport(typeof window !== "undefined" ? window : undefined);
  const onDeviceApi = typeof (recognitionCtor(typeof window !== "undefined" ? window : undefined) as unknown as { available?: unknown } | null)?.available === "function";
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [streaming, setStreaming] = useState<{ available: boolean; engine?: string; reason?: string } | null>(null);
  const [server, setServer] = useState<ServerVoiceSettings | null>(null);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [models, setModels] = useState<LocalModelView[]>([]);
  const [runtime, setRuntime] = useState<LocalRuntimeView | null>(null);
  const [ttsTest, setTtsTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [backendError, setBackendError] = useState<unknown>(null);
  const [backendBusy, setBackendBusy] = useState(true);

  const refreshCapability = () => void api.dictationCapability().then(setStreaming).catch(() => setStreaming(null));
  const refreshProviders = async () => {
    const result = await fetchJson<{ providers: ProviderView[] }>("/api/voice/providers");
    setProviders(result.providers);
  };
  const refreshModels = async () => {
    const result = await fetchJson<{ models: LocalModelView[]; runtime?: LocalRuntimeView }>("/api/dictation/models");
    setModels(result.models);
    setRuntime(result.runtime ?? null);
  };

  const refreshBackend = async () => {
    setBackendBusy(true);
    setBackendError(null);
    try {
      const [settings] = await Promise.all([
        api.voiceSettings(),
        refreshProviders(),
        refreshModels(),
      ]);
      setServer(settings as ServerVoiceSettings);
      refreshCapability();
    } catch (error) {
      setServer(null);
      setProviders([]);
      setModels([]);
      setRuntime(null);
      setBackendError(error ?? new Error(tr("settings.voicepage.unavailable")));
    } finally {
      setBackendBusy(false);
    }
  };

  useEffect(() => {
    void refreshBackend();
  }, []);

  const downloading = useMemo(
    () => models.some((model) => model.state === "downloading") || runtime?.state === "downloading",
    [models, runtime?.state],
  );
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
    setTtsTest(null);
    try {
      await api.ttsSpeak(tr("settings.voicepage.serverVoiceCheckSample"));
      setTtsTest({ ok: true, text: tr("settings.voicepage.serverVoiceWorks") });
    } catch (e) {
      setTtsTest({ ok: false, text: errorMessage(e) });
    }
  };

  const ttsHost = server?.ttsConfigured ? ttsSource(server.tts) : "";
  // Voices that can speak the read-aloud language, best first; the automatic
  // choice names the voice it resolves to so "Best available" is not a guess.
  const speechLang = !prefs.lang || prefs.lang === "auto" ? (typeof navigator !== "undefined" ? navigator.language : "en-US") : prefs.lang;
  const rankedVoices = useMemo(() => {
    const ranked = rankVoices(voices, speechLang);
    return ranked.length ? ranked : voices;
  }, [voices, speechLang]);
  const voiceLabel = (voice: SpeechSynthesisVoice) => {
    const tier = voiceTier(voice);
    return tier === "natural" ? `${voice.name} · ${tr("settings.voicepage.voiceNatural")}`
      : tier === "enhanced" ? `${voice.name} · ${tr("settings.voicepage.voiceEnhanced")}`
        : voice.name;
  };
  const bestVoiceLabel = rankedVoices[0]
    ? tr("settings.voicepage.bestVoiceValue", { voice: rankedVoices[0].name })
    : tr("settings.voicepage.default");
  const decimal = (value: number) => formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const speaking = playback.phase === "loading" || playback.phase === "playing";
  const playbackError = playback.phase === "error" && playback.key === "voice.sample" ? playback.error : "";

  return (
    <div className="pkg-dictation">
      <PageHead blurb={tr("settings.voicepage.blurb")} />
      {!support.stt && !support.tts && !streaming?.available && !backendBusy && (
        <EmptyState compact icon="mic" title={tr("settings.voicepage.speechIsNotSupportedInThisBrowser")} body={tr("settings.voicepage.dictationNeedsTheWebSpeechApiChrome")} />
      )}

      <Section title={tr("settings.voicepage.dictation")}>
        <Row label={tr("settings.voicepage.showMicButton")} hint={support.stt || streaming?.available ? tr("settings.voicepage.showsTheMicButtonInTheComposer") : streaming?.reason ?? tr("settings.voicepage.notSupportedInThisBrowser")} itemId="voice.dictation">
          <Toggle on={prefs.dictation} onChange={(dictation) => setVoicePrefs({ dictation })} label={tr("settings.voicepage.showMicButton")} />
        </Row>
        {support.stt && (
          <Row label={tr("settings.voicepage.spokenPunctuation")} hint={tr("settings.voicepage.spokenPunctuationHint")} itemId="voice.spoken-punctuation">
            <Toggle on={prefs.spokenPunctuation} onChange={(spokenPunctuation) => setVoicePrefs({ spokenPunctuation })} label={tr("settings.voicepage.spokenPunctuation")} />
          </Row>
        )}
        {onDeviceApi && <OnDeviceRow lang={server?.dictation.language || prefs.lang} enabled={prefs.onDeviceSpeech} />}
        <p className="voice-note">{tr("settings.voicepage.micTips")}</p>
      </Section>

      <Section title={tr("settings.voicepage.recognition")} hint={tr("settings.voicepage.recognitionHint")}>
        {backendError ? (
          <ErrorState compact title={tr("settings.voicepage.recognitionUnavailable")} error={backendError} onRetry={() => void refreshBackend()} />
        ) : server ? (
          <DictationProviderForm
            server={server}
            providers={providers}
            models={models}
            runtime={runtime}
            onSaved={(saved) => { setServer(saved); refreshCapability(); }}
            onRefreshProviders={refreshProviders}
            onRefreshModels={refreshModels}
          />
        ) : (
          <EmptyState compact busy title={tr("settings.voicepage.loading")} />
        )}
      </Section>

      <Section title={tr("settings.voicepage.readAloud")}>
        <Row
          label={tr("settings.voicepage.readAloudEngine")}
          hint={prefs.ttsEngine === "local"
            ? tr("settings.voicepage.ttsLocalHint")
            : prefs.ttsEngine === "server"
              ? server?.ttsConfigured
                ? tr("settings.voicepage.serverVoiceFrom", { value: ttsHost })
                : server && !ttsProviderInfo(ttsSettings(server.tts).provider).needsBaseUrl
                  // Saved, but the hosted service has no key yet — not "unsaved".
                  ? tr("settings.voicepage.ttsKeyMissing", { provider: ttsProviderInfo(ttsSettings(server.tts).provider).label })
                  : tr("settings.voicepage.ttsServerSetup")
              : tr("settings.voicepage.ttsBrowserHint")}
          itemId="voice.ttsEngine"
        >
          <Seg
            value={prefs.ttsEngine}
            label={tr("settings.voicepage.readAloudEngine")}
            options={[
              ["local", tr("settings.voicepage.engineLocal")],
              ["browser", tr("settings.voicepage.engineBrowser")],
              ["server", tr("settings.voicepage.engineServer")],
            ]}
            onChange={(ttsEngine) => setVoicePrefs({ ttsEngine })}
          />
        </Row>
        <Row label={tr("settings.voicepage.language")} hint={tr("settings.voicepage.readAloudLanguageHint")}>
          <Select
            value={prefs.lang}
            label={languageLabel(prefs.lang)}
            ariaLabel={tr("settings.voicepage.language")}
            options={languageOptions(prefs.lang)}
            onChange={(lang) => setVoicePrefs({ lang })}
          />
        </Row>
        {/* Each engine shows only its own choices, right under it. */}
        {prefs.ttsEngine === "local" && <LocalVoicePicker lang={speechLang} />}
        {prefs.ttsEngine === "server" && server && (
          <TtsServerForm server={server} onSaved={(saved) => { setServer(saved); refreshCapability(); }} />
        )}
        {prefs.ttsEngine === "browser" && voices.length > 0 && (
          <Row label={tr("settings.voicepage.browserVoice")} hint={tr("settings.voicepage.browserVoiceHint")}>
            <Select
              value={prefs.voice ?? ""}
              label={prefs.voice || bestVoiceLabel}
              ariaLabel={tr("settings.voicepage.browserVoice")}
              options={[
                { value: "", label: bestVoiceLabel },
                ...rankedVoices.map((voice) => ({ value: voice.name, label: voiceLabel(voice) })),
              ]}
              onChange={(voice) => setVoicePrefs({ voice: voice || undefined })}
            />
          </Row>
        )}
        <Row label={tr("settings.voicepage.speechRate")}>
          <RangeControl label={tr("settings.voicepage.speechRate")} value={prefs.rate} min={0.5} max={2} step={0.1}
            readout={tr("settings.voicepage.value", { value: decimal(prefs.rate) })} onChange={(rate) => setVoicePrefs({ rate })} />
        </Row>
        {prefs.ttsEngine === "browser" && (
          <Row label={tr("settings.voicepage.pitch")} itemId="voice.pitch">
            <RangeControl label={tr("settings.voicepage.pitch")} value={prefs.pitch} min={0.5} max={2} step={0.1}
              readout={tr("settings.voicepage.value", { value: decimal(prefs.pitch) })} onChange={(pitch) => setVoicePrefs({ pitch })} />
          </Row>
        )}
        <Row label={tr("settings.voicepage.volume")} itemId="voice.volume">
          <RangeControl label={tr("settings.voicepage.volume")} value={prefs.volume} min={0} max={1} step={0.05}
            readout={`${Math.round(prefs.volume * 100)}%`} onChange={(volume) => setVoicePrefs({ volume })} />
        </Row>
        <Row label={tr("settings.voicepage.summarizeBeforeSpeaking")} hint={tr("settings.voicepage.summarizeHint")} itemId="voice.summarize">
          <Toggle on={prefs.summarize} onChange={(summarize) => setVoicePrefs({ summarize })} label={tr("settings.voicepage.summarizeBeforeSpeaking")} />
        </Row>
        {/* Built-in voices preview themselves, in their own language. */}
        {prefs.ttsEngine !== "local" && (
          <Row
            label={tr("settings.voicepage.tryIt")}
            hint={playbackError
              ? <span className="settings-field-error">{playbackError}</span>
              : ttsTest
                ? <span className={ttsTest.ok ? "voice-ok" : "settings-field-error"}>{ttsTest.text}</span>
                : tr("settings.voicepage.tryItHint")}
          >
            {prefs.ttsEngine === "server" && server?.ttsConfigured && <Button size="sm" variant="ghost" onClick={() => void testServerTts()}>{tr("settings.voicepage.testServerTts")}</Button>}
            {speaking
              ? <Button size="sm" iconStart={StopIcon} onClick={stopSpeaking}>{tr("common.stop")}</Button>
              : <Button size="sm" onClick={() => speak(tr("settings.voicepage.voiceCheckSample"))}>{tr("settings.voicepage.speakSample")}</Button>}
          </Row>
        )}
      </Section>

    </div>
  );
}
