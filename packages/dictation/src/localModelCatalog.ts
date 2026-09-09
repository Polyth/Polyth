export type LocalModelState = "missing" | "downloading" | "installed" | "failed";
export type LocalModelPreset = "ultra" | "fast" | "balanced" | "accurate";

export interface LocalModelDescriptor {
  id: string;
  label: string;
  provider: "local-nemotron" | "local-parakeet";
  languages: readonly string[];
  streaming: boolean;
  /** Upstream streaming chunk/latency preset, not an end-to-end benchmark. */
  latencyMs: number;
  preset?: LocalModelPreset;
  archiveUrl: string;
  archiveBytes: number;
  sha256: string;
}

export interface LocalModelStatus extends Omit<LocalModelDescriptor, "archiveUrl" | "sha256"> {
  state: LocalModelState;
  downloadedBytes: number;
  totalBytes: number;
  path?: string;
  error?: string;
}

const NEMOTRON_LANGUAGES = [
  "ar", "de", "en", "es", "fr", "hi", "it", "ja", "ko", "nl",
  "pl", "pt", "ru", "sv", "tr", "uk-UA", "vi", "zh",
] as const;

const nemotron = (
  latencyMs: 80 | 160 | 560 | 1120,
  preset: LocalModelPreset,
  label: string,
  archiveBytes: number,
  sha256: string,
): LocalModelDescriptor => ({
  id: `nemotron-3.5-streaming-0.6b-${latencyMs}ms`,
  label: `${label} · Nemotron 3.5 Streaming 0.6B · ${latencyMs} ms · int8`,
  provider: "local-nemotron",
  languages: NEMOTRON_LANGUAGES,
  streaming: true,
  latencyMs,
  preset,
  archiveUrl: `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-${latencyMs}ms-int8-2026-06-11.tar.bz2`,
  archiveBytes,
  sha256,
});

const NEMOTRON_MODELS: readonly LocalModelDescriptor[] = [
  nemotron(
    80,
    "ultra",
    "Ultra",
    475_274_007,
    "fb170128c496db33a1fb9f5f9f823257f42f911224ee218bb429f3c2eaf90a8d",
  ),
  nemotron(
    160,
    "fast",
    "Fast",
    475_273_363,
    "a81909a1780d84cff16d73c15e13e67d9d81d8839faf14870d507d8499f7a61a",
  ),
  nemotron(
    560,
    "balanced",
    "Balanced",
    475_271_763,
    "c6bf5e0df765f9d5b43bc9e0536d4b4b3e7d40bdf5ecf13e45f134c51c05ae3a",
  ),
  nemotron(
    1120,
    "accurate",
    "Accurate",
    475_276_334,
    "adbdd5e9fef87300c37cebfcfc4f1ebe56845c860c8a760af0a1dd65ce9beed3",
  ),
] as const;

/** Balanced multilingual preset until comparative end-to-end benchmarks justify another default. */
export const DEFAULT_LOCAL_MODEL_ID = "nemotron-3.5-streaming-0.6b-560ms";

export const localModelCatalog = (): readonly LocalModelDescriptor[] => NEMOTRON_MODELS;
