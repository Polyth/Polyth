import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { DictationError } from "./providers.ts";

export const SHERPA_RUNTIME_VERSION = "1.13.7";

export type LocalRuntimeState = "missing" | "downloading" | "installed" | "failed" | "unsupported";

interface RuntimePackage {
  name: string;
  url: string;
  sha512: string;
}

interface PlatformRuntime {
  platform: NodeJS.Platform;
  arch: string;
  package: RuntimePackage;
}

const CORE: RuntimePackage = {
  name: "sherpa-onnx-node",
  url: `https://registry.npmjs.org/sherpa-onnx-node/-/sherpa-onnx-node-${SHERPA_RUNTIME_VERSION}.tgz`,
  sha512: "0XGV7arGngBCnol0m8OLyqlnaUm19Q1KmetVj1DDBdymXa1upmAHZDwNdN47gjsEhqE5hXUEyc1vRQoXrNhNVg==",
};

const PLATFORMS: readonly PlatformRuntime[] = [
  {
    platform: "darwin", arch: "arm64",
    package: {
      name: "sherpa-onnx-darwin-arm64",
      url: `https://registry.npmjs.org/sherpa-onnx-darwin-arm64/-/sherpa-onnx-darwin-arm64-${SHERPA_RUNTIME_VERSION}.tgz`,
      sha512: "5NCE50hAvr3n2pdett0SgfPBJXaFZE0bqHwbHyiq+IKZ8Ids0l4M0VrG+ImGYIafCwie+oC3uAJ+pKj9xg/k+w==",
    },
  },
  {
    platform: "darwin", arch: "x64",
    package: {
      name: "sherpa-onnx-darwin-x64",
      url: `https://registry.npmjs.org/sherpa-onnx-darwin-x64/-/sherpa-onnx-darwin-x64-${SHERPA_RUNTIME_VERSION}.tgz`,
      sha512: "N3o+T+wn9WaQmsKV5DD8bTHdo+WN2+sXwmZcGJZiDjtOMR2zFz7uVCZnYCmEAMgvChC+oHcF5RvEEKcRCAu6Pw==",
    },
  },
  {
    platform: "linux", arch: "arm64",
    package: {
      name: "sherpa-onnx-linux-arm64",
      url: `https://registry.npmjs.org/sherpa-onnx-linux-arm64/-/sherpa-onnx-linux-arm64-${SHERPA_RUNTIME_VERSION}.tgz`,
      sha512: "TFCVpXyTh69buhOtTS8KIfkRXOVKY4Y1qjAktSItrKS4A0chnnrlXO5bKWoNAPeI6fMxTF/uvMYbYgcvjEMfNg==",
    },
  },
  {
    platform: "linux", arch: "x64",
    package: {
      name: "sherpa-onnx-linux-x64",
      url: `https://registry.npmjs.org/sherpa-onnx-linux-x64/-/sherpa-onnx-linux-x64-${SHERPA_RUNTIME_VERSION}.tgz`,
      sha512: "npmxn5WwmAmlthgBhmbZ33t3i2j4mJwQt46dMEb3j7d41y1/uJrjrVAfa/DkvV+vn49ZWfcQ2UEWDipaZBVhuw==",
    },
  },
  {
    platform: "win32", arch: "ia32",
    package: {
      name: "sherpa-onnx-win-ia32",
      url: `https://registry.npmjs.org/sherpa-onnx-win-ia32/-/sherpa-onnx-win-ia32-${SHERPA_RUNTIME_VERSION}.tgz`,
      sha512: "sTwtpxPQ76XLn0giAbvknIDEDKD3XXi2mo2AVROEucf1pIK1DjQl+LjLkalTeFoQqbC4J3xGx/g+xgcHQD1dsw==",
    },
  },
  {
    platform: "win32", arch: "x64",
    package: {
      name: "sherpa-onnx-win-x64",
      url: `https://registry.npmjs.org/sherpa-onnx-win-x64/-/sherpa-onnx-win-x64-${SHERPA_RUNTIME_VERSION}.tgz`,
      sha512: "wBV1o+/zgsMrOjfCFIgGrH6S28xq6CqRCLSavCOjTZ6cqr80yGc07DUHxqsHFPZvfoJU+2JF5L2l3gyWFWoWdQ==",
    },
  },
] as const;

const platformRuntime = (platform: string = process.platform, arch: string = process.arch): PlatformRuntime | undefined =>
  PLATFORMS.find((entry) => entry.platform === platform && entry.arch === arch);

export interface LocalRuntimeStatus {
  state: LocalRuntimeState;
  version: string;
  platform: string;
  arch: string;
  downloadedBytes: number;
  totalBytes?: number;
  path?: string;
  error?: string;
}

export interface LocalRuntimeManager {
  status(): Promise<LocalRuntimeStatus>;
  download(): Promise<LocalRuntimeStatus>;
  /** Stop an in-flight explicit download but keep partials for a later resume. */
  cancel(): Promise<void>;
  remove(): Promise<void>;
  path(): Promise<string | null>;
}

interface ActiveDownload {
  controller: AbortController;
  promise: Promise<LocalRuntimeStatus>;
  downloadedBytes: number;
  totalBytes?: number;
}

const sha512File = async (file: string): Promise<string> => {
  const hash = createHash("sha512");
  const stream = createReadStream(file);
  stream.on("data", (chunk) => hash.update(chunk));
  await finished(stream);
  return hash.digest("base64");
};

const extractTgz = async (archive: string, destination: string): Promise<void> => {
  await mkdir(destination, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archive, "--strip-components=1", "-C", destination], {
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
      `Could not extract local ASR runtime: ${error.message}. A compatible tar executable is required.`,
      { cause: error },
    )));
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new DictationError(
          "local_model_failed",
          `Local ASR runtime extraction failed${stderr.trim() ? `: ${stderr.trim()}` : ` (tar exit ${code})`}`,
        )));
  });
};

export function createLocalRuntimeManager(options: {
  root: string;
  fetchFn?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
}): LocalRuntimeManager {
  const root = options.root;
  const fetchFn = options.fetchFn ?? fetch;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const native = platformRuntime(platform, arch);
  const downloadsDir = join(root, ".downloads");
  const stagingDir = join(root, ".staging");
  const finalDir = join(root, `sherpa-onnx-node-${SHERPA_RUNTIME_VERSION}`);
  mkdirSync(downloadsDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });
  let active: ActiveDownload | null = null;
  let failure: string | undefined;

  const partialFile = (pkg: RuntimePackage): string => join(downloadsDir, `${pkg.name}-${SHERPA_RUNTIME_VERSION}.tgz.part`);
  const stageDir = (): string => join(stagingDir, `sherpa-${process.pid}`);
  const installedStatus = (): LocalRuntimeStatus => ({
    state: "installed",
    version: SHERPA_RUNTIME_VERSION,
    platform,
    arch,
    downloadedBytes: 0,
    path: finalDir,
  });

  const status = async (): Promise<LocalRuntimeStatus> => {
    if (!native) {
      return {
        state: "unsupported",
        version: SHERPA_RUNTIME_VERSION,
        platform,
        arch,
        downloadedBytes: 0,
        error: `sherpa-onnx-node ${SHERPA_RUNTIME_VERSION} has no published binary for ${platform}/${arch}`,
      };
    }
    if (existsSync(finalDir)) return installedStatus();
    if (active) {
      return {
        state: "downloading",
        version: SHERPA_RUNTIME_VERSION,
        platform,
        arch,
        downloadedBytes: active.downloadedBytes,
        ...(active.totalBytes ? { totalBytes: active.totalBytes } : {}),
      };
    }
    let downloadedBytes = 0;
    for (const pkg of [CORE, native.package]) {
      const partial = partialFile(pkg);
      if (existsSync(partial)) downloadedBytes += (await stat(partial)).size;
    }
    return {
      state: failure ? "failed" : "missing",
      version: SHERPA_RUNTIME_VERSION,
      platform,
      arch,
      downloadedBytes,
      ...(failure ? { error: failure } : {}),
    };
  };

  const downloadPackage = async (pkg: RuntimePackage, controller: AbortController, running: ActiveDownload): Promise<string> => {
    const partial = partialFile(pkg);
    let offset = existsSync(partial) ? (await stat(partial)).size : 0;
    running.downloadedBytes += offset;
    const headers = offset > 0 ? { Range: `bytes=${offset}-` } : undefined;
    const response = await fetchFn(pkg.url, { headers, signal: controller.signal });
    if (offset > 0 && response.status === 200) {
      running.downloadedBytes -= offset;
      await rm(partial, { force: true });
      offset = 0;
    } else if (offset > 0 && response.status !== 206) {
      throw new DictationError("network_error", `Local ASR runtime resume failed for ${pkg.name}: HTTP ${response.status}`);
    }
    if (offset === 0 && !response.ok) {
      throw new DictationError("network_error", `Local ASR runtime download failed for ${pkg.name}: HTTP ${response.status}`);
    }
    if (!response.body) throw new DictationError("network_error", `Local ASR runtime download returned no body for ${pkg.name}`);

    const contentLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(contentLength) && contentLength > 0) {
      running.totalBytes = (running.totalBytes ?? 0) + offset + contentLength;
    }
    const output = createWriteStream(partial, { flags: offset > 0 ? "a" : "w" });
    const body = Readable.fromWeb(response.body as never);
    for await (const chunk of body) {
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const bytes = chunk as Buffer;
      if (!output.write(bytes)) await new Promise<void>((resolve) => output.once("drain", resolve));
      running.downloadedBytes += bytes.byteLength;
    }
    output.end();
    await finished(output);

    const digest = await sha512File(partial);
    if (digest !== pkg.sha512) {
      await rm(partial, { force: true });
      throw new DictationError("local_model_failed", `SHA-512 verification failed for local ASR runtime package ${pkg.name}`);
    }
    return partial;
  };

  const install = async (controller: AbortController, running: ActiveDownload): Promise<LocalRuntimeStatus> => {
    if (!native) throw new DictationError("provider_unavailable", `Local ASR runtime is unsupported on ${platform}/${arch}`);
    const staging = stageDir();
    failure = undefined;
    try {
      const coreArchive = await downloadPackage(CORE, controller, running);
      const platformArchive = await downloadPackage(native.package, controller, running);
      await rm(staging, { recursive: true, force: true });
      const modules = join(staging, "node_modules");
      await mkdir(modules, { recursive: true });
      await extractTgz(coreArchive, join(modules, CORE.name));
      await extractTgz(platformArchive, join(modules, native.package.name));
      writeFileSync(join(staging, "bootstrap.cjs"), "// createRequire anchor for package-owned sherpa runtime\n");
      if (existsSync(finalDir)) await rm(finalDir, { recursive: true, force: true });
      await rename(staging, finalDir);
      await rm(coreArchive, { force: true });
      await rm(platformArchive, { force: true });
      failure = undefined;
      return installedStatus();
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      if (controller.signal.aborted) {
        throw new DictationError("session_expired", "Local ASR runtime download was cancelled", { cause: error });
      }
      const normalized = error instanceof DictationError
        ? error
        : new DictationError("local_model_failed", error instanceof Error ? error.message : String(error), { cause: error });
      failure = normalized.message;
      throw normalized;
    }
  };

  const cancel = async (): Promise<void> => {
    const running = active;
    if (!running) return;
    running.controller.abort();
    await running.promise.catch(() => {});
    // Cancellation is lifecycle, not a failed installation. Keep partials so a
    // later explicit download can resume from the verified HTTP Range boundary.
    if (failure === "Local ASR runtime download was cancelled") failure = undefined;
  };

  return {
    status,
    async download() {
      if (!native) return status();
      if (existsSync(finalDir)) return installedStatus();
      if (active) return active.promise;
      const controller = new AbortController();
      const running: ActiveDownload = {
        controller,
        downloadedBytes: 0,
        promise: Promise.resolve(null as never),
      };
      active = running;
      running.promise = install(controller, running).finally(() => {
        if (active === running) active = null;
      });
      return running.promise;
    },
    cancel,
    async remove() {
      await cancel();
      await rm(finalDir, { recursive: true, force: true });
      if (native) {
        await rm(partialFile(CORE), { force: true });
        await rm(partialFile(native.package), { force: true });
      }
      await rm(stageDir(), { recursive: true, force: true });
      failure = undefined;
    },
    async path() {
      return native && existsSync(finalDir) ? finalDir : null;
    },
  };
}
