import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
} from "node:fs";
import {
  readdir,
  rename,
  rm,
  stat,
  statfs,
} from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { DictationError } from "./providers.ts";

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

/** Safe default until Polyth has comparable end-to-end benchmarks on target hardware. */
export const DEFAULT_LOCAL_MODEL_ID = "nemotron-3.5-streaming-0.6b-560ms";

export const localModelCatalog = (): readonly LocalModelDescriptor[] => NEMOTRON_MODELS;

export interface LocalModelManager {
  list(): Promise<LocalModelStatus[]>;
  status(id: string): Promise<LocalModelStatus>;
  download(id: string): Promise<LocalModelStatus>;
  /** Stop in-flight explicit downloads but keep partials for later resume. */
  cancelAll(): Promise<void>;
  remove(id: string): Promise<void>;
  path(id: string): Promise<string | null>;
}

interface ActiveDownload {
  controller: AbortController;
  promise: Promise<LocalModelStatus>;
  downloadedBytes: number;
  error?: string;
}

const modelOf = (id: string): LocalModelDescriptor => {
  const model = localModelCatalog().find((entry) => entry.id === id);
  if (!model) throw new DictationError("local_model_missing", `Unknown local dictation model: ${id}`);
  return model;
};

const sha256File = async (file: string): Promise<string> => {
  const hash = createHash("sha256");
  const stream = createReadStream(file);
  stream.on("data", (chunk) => hash.update(chunk));
  await finished(stream);
  return hash.digest("hex");
};

const extractTarBz2 = async (archive: string, destination: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xjf", archive, "-C", destination], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 8_192) stderr += chunk;
    });
    child.once("error", (error) => reject(new DictationError(
      "local_model_failed",
      `Could not extract local ASR model: ${error.message}. A compatible tar executable is required.`,
      { cause: error },
    )));
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new DictationError(
        "local_model_failed",
        `Local ASR model extraction failed${stderr.trim() ? `: ${stderr.trim()}` : ` (tar exit ${code})`}`,
      ));
    });
  });
};

const formatBytes = (bytes: number): string => `${Math.ceil(bytes / (1024 * 1024))} MiB`;

export function createLocalModelManager(options: {
  root: string;
  fetchFn?: typeof fetch;
  /** Test/platform seam; defaults to the filesystem containing root. */
  availableBytes?: () => Promise<number>;
}): LocalModelManager {
  const root = options.root;
  const fetchFn = options.fetchFn ?? fetch;
  const downloadsDir = join(root, ".downloads");
  const stagingDir = join(root, ".staging");
  mkdirSync(downloadsDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });
  const active = new Map<string, ActiveDownload>();
  const failures = new Map<string, string>();
  const availableBytes = options.availableBytes ?? (async () => {
    const fs = await statfs(root);
    return Number(fs.bavail) * Number(fs.bsize);
  });

  const finalDir = (id: string) => join(root, id);
  const partialFile = (id: string) => join(downloadsDir, `${id}.tar.bz2.part`);
  const stageDir = (id: string) => join(stagingDir, `${id}-${process.pid}`);

  const status = async (id: string): Promise<LocalModelStatus> => {
    const model = modelOf(id);
    const running = active.get(id);
    if (running) {
      return {
        id: model.id,
        label: model.label,
        provider: model.provider,
        languages: model.languages,
        streaming: model.streaming,
        latencyMs: model.latencyMs,
        ...(model.preset ? { preset: model.preset } : {}),
        archiveBytes: model.archiveBytes,
        state: "downloading",
        downloadedBytes: running.downloadedBytes,
        totalBytes: model.archiveBytes,
      };
    }
    if (existsSync(finalDir(id))) {
      return {
        id: model.id,
        label: model.label,
        provider: model.provider,
        languages: model.languages,
        streaming: model.streaming,
        latencyMs: model.latencyMs,
        ...(model.preset ? { preset: model.preset } : {}),
        archiveBytes: model.archiveBytes,
        state: "installed",
        downloadedBytes: model.archiveBytes,
        totalBytes: model.archiveBytes,
        path: finalDir(id),
      };
    }
    const partial = partialFile(id);
    const downloadedBytes = existsSync(partial) ? (await stat(partial)).size : 0;
    const failure = failures.get(id);
    return {
      id: model.id,
      label: model.label,
      provider: model.provider,
      languages: model.languages,
      streaming: model.streaming,
      latencyMs: model.latencyMs,
      ...(model.preset ? { preset: model.preset } : {}),
      archiveBytes: model.archiveBytes,
      state: failure ? "failed" : "missing",
      downloadedBytes,
      totalBytes: model.archiveBytes,
      ...(failure ? { error: failure } : {}),
    };
  };

  const install = async (model: LocalModelDescriptor, controller: AbortController): Promise<LocalModelStatus> => {
    const partial = partialFile(model.id);
    const staging = stageDir(model.id);
    const running = active.get(model.id)!;
    failures.delete(model.id);

    try {
      let offset = existsSync(partial) ? (await stat(partial)).size : 0;
      if (offset > model.archiveBytes) {
        await rm(partial, { force: true });
        offset = 0;
      }
      running.downloadedBytes = offset;

      const requiredFree = Math.max(0, model.archiveBytes - offset) + model.archiveBytes * 2;
      const free = await availableBytes();
      if (Number.isFinite(free) && free < requiredFree) {
        throw new DictationError(
          "local_model_failed",
          `Not enough free disk space for ${model.label}: need about ${formatBytes(requiredFree)}, have ${formatBytes(free)}`,
        );
      }

      const headers = offset > 0 ? { Range: `bytes=${offset}-` } : undefined;
      const response = await fetchFn(model.archiveUrl, { headers, signal: controller.signal });
      if (offset > 0 && response.status === 200) {
        await rm(partial, { force: true });
        offset = 0;
        running.downloadedBytes = 0;
      } else if (offset > 0 && response.status !== 206) {
        throw new DictationError("network_error", `Local model resume failed: HTTP ${response.status}`);
      }
      if (offset === 0 && !response.ok) {
        throw new DictationError("network_error", `Local model download failed: HTTP ${response.status}`);
      }
      if (!response.body) throw new DictationError("network_error", "Local model download returned no body");

      const output = createWriteStream(partial, { flags: offset > 0 ? "a" : "w" });
      const body = Readable.fromWeb(response.body as never);
      for await (const chunk of body) {
        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const bytes = chunk as Buffer;
        if (!output.write(bytes)) await new Promise<void>((resolve) => output.once("drain", resolve));
        running.downloadedBytes += bytes.byteLength;
        if (running.downloadedBytes > model.archiveBytes) {
          throw new DictationError("local_model_failed", "Local model download exceeded the expected size");
        }
      }
      output.end();
      await finished(output);

      const fileSize = (await stat(partial)).size;
      if (fileSize !== model.archiveBytes) {
        throw new DictationError(
          "local_model_failed",
          `Local model size mismatch: expected ${model.archiveBytes}, got ${fileSize}`,
        );
      }
      const digest = await sha256File(partial);
      if (digest !== model.sha256) {
        await rm(partial, { force: true });
        throw new DictationError("local_model_failed", "Local model SHA-256 verification failed; the partial download was discarded");
      }

      await rm(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      await extractTarBz2(partial, staging);
      const entries = await readdir(staging, { withFileTypes: true });
      const dirs = entries.filter((entry) => entry.isDirectory());
      if (dirs.length !== 1) {
        throw new DictationError("local_model_failed", "Local model archive has an unexpected directory layout");
      }
      const extracted = join(staging, dirs[0]!.name);
      if (existsSync(finalDir(model.id))) await rm(finalDir(model.id), { recursive: true, force: true });
      await rename(extracted, finalDir(model.id));
      await rm(staging, { recursive: true, force: true });
      await rm(partial, { force: true });
      failures.delete(model.id);
      return status(model.id);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      if (controller.signal.aborted) {
        throw new DictationError("session_expired", "Local model download was cancelled", { cause: error });
      }
      const failure = error instanceof DictationError
        ? error
        : new DictationError("local_model_failed", error instanceof Error ? error.message : String(error), { cause: error });
      failures.set(model.id, failure.message);
      throw failure;
    }
  };

  const cancelAll = async (): Promise<void> => {
    const running = [...active.values()];
    if (!running.length) return;
    for (const download of running) download.controller.abort();
    await Promise.allSettled(running.map((download) => download.promise));
  };

  return {
    async list() {
      return Promise.all(localModelCatalog().map((model) => status(model.id)));
    },
    status,
    async download(id) {
      const model = modelOf(id);
      if (existsSync(finalDir(id))) return status(id);
      const existing = active.get(id);
      if (existing) return existing.promise;
      const controller = new AbortController();
      const entry: ActiveDownload = {
        controller,
        downloadedBytes: existsSync(partialFile(id)) ? (await stat(partialFile(id))).size : 0,
        promise: Promise.resolve(null as never),
      };
      active.set(id, entry);
      entry.promise = install(model, controller).finally(() => {
        if (active.get(id) === entry) active.delete(id);
      });
      return entry.promise;
    },
    cancelAll,
    async remove(id) {
      modelOf(id);
      const running = active.get(id);
      if (running) {
        running.controller.abort();
        await running.promise.catch(() => {});
      }
      await rm(finalDir(id), { recursive: true, force: true });
      await rm(partialFile(id), { force: true });
      await rm(stageDir(id), { recursive: true, force: true });
      failures.delete(id);
    },
    async path(id) {
      modelOf(id);
      return existsSync(finalDir(id)) ? finalDir(id) : null;
    },
  };
}
