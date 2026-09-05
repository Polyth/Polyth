// F8: server-owned voice engine settings (data/voice.json). Only REFERENCES to
// secrets are stored — apiKeyEnv names an environment variable; the value is
// resolved at call time and never persisted or returned. URLs are explicit
// user input saved through PUT (egress goes only where the user pointed it).
import { mkdirSync, readFileSync } from "node:fs";
import { atomicWriteSync } from "./atomicWrite.ts";
import { dirname } from "node:path";

export interface VoiceSttSettings {
  /** "" = unconfigured; browser Web Speech stays the honest default. */
  baseUrl: string;
  model: string;
  language: string;
  /** Name of the env var holding the API key — a reference, never a value. */
  apiKeyEnv: string;
}

export interface VoiceTtsSettings {
  baseUrl: string;
  model: string;
  voice: string;
  apiKeyEnv: string;
}

export interface VoiceSettings {
  stt: VoiceSttSettings;
  tts: VoiceTtsSettings;
}

export interface VoiceSettingsService {
  get(): VoiceSettings;
  put(next: unknown): VoiceSettings;
  /** Resolve the STT/TTS API key value from the env ref, if any. */
  resolveKey(section: "stt" | "tts"): string | undefined;
}

const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const defaults = (): VoiceSettings => ({
  stt: { baseUrl: "", model: "", language: "", apiKeyEnv: "" },
  tts: { baseUrl: "", model: "", voice: "", apiKeyEnv: "" },
});

const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

const checkUrl = (url: string, label: string): void => {
  if (!url) return;
  let u: URL;
  try { u = new URL(url); } catch { throw err("invalid-input", `${label} URL is invalid`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw err("invalid-input", `${label} URL must be http(s)`);
};

// Env refs are names, not values — refuse anything that looks like a secret
// pasted by mistake (long, or containing non-identifier characters).
const checkEnvRef = (ref: string, label: string): void => {
  if (!ref) return;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(ref)) {
    throw err("invalid-input", `${label} API key must be an environment variable NAME (the value is read from the server environment)`);
  }
};

export function createVoiceSettings(opts: { file: string; env?: Record<string, string | undefined> }): VoiceSettingsService {
  mkdirSync(dirname(opts.file), { recursive: true });
  const env = opts.env ?? process.env;

  const sanitize = (raw: unknown): VoiceSettings => {
    const d = defaults();
    const r = (raw ?? {}) as { stt?: Record<string, unknown>; tts?: Record<string, unknown> };
    const out: VoiceSettings = {
      stt: {
        baseUrl: str(r.stt?.baseUrl, 1024) || d.stt.baseUrl,
        model: str(r.stt?.model),
        language: str(r.stt?.language, 32),
        apiKeyEnv: str(r.stt?.apiKeyEnv, 128),
      },
      tts: {
        baseUrl: str(r.tts?.baseUrl, 1024) || d.tts.baseUrl,
        model: str(r.tts?.model),
        voice: str(r.tts?.voice),
        apiKeyEnv: str(r.tts?.apiKeyEnv, 128),
      },
    };
    checkUrl(out.stt.baseUrl, "speech-to-text");
    checkUrl(out.tts.baseUrl, "text-to-speech");
    checkEnvRef(out.stt.apiKeyEnv, "speech-to-text");
    checkEnvRef(out.tts.apiKeyEnv, "text-to-speech");
    return out;
  };

  let settings: VoiceSettings;
  try {
    settings = sanitize(JSON.parse(readFileSync(opts.file, "utf8")));
  } catch {
    settings = defaults();
  }

  return {
    get: () => structuredClone(settings),
    put(next) {
      settings = sanitize(next);
      atomicWriteSync(opts.file, JSON.stringify(settings, null, 2));
      return structuredClone(settings);
    },
    resolveKey(section) {
      const ref = settings[section].apiKeyEnv;
      const value = ref ? env[ref] : undefined;
      return value || undefined;
    },
  };
}
