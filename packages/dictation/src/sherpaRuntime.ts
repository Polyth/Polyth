import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { DictationError } from "./providers.ts";

const VERSION = "1.13.7";
const NODE_PACKAGE = {
  name: "sherpa-onnx-node",
  integrity: "sha512-0XGV7arGngBCnol0m8OLyqlnaUm19Q1KmetVj1DDBdymXa1upmAHZDwNdN47gjsEhqE5hXUEyc1vRQoXrNhNVg==",
};

const PLATFORM_PACKAGES: Record<string, { name: string; integrity: string }> = {
  "darwin-arm64": {
    name: "sherpa-onnx-darwin-arm64",
    integrity: "sha512-5NCE50hAvr3n2pdett0SgfPBJXaFZE0bqHwbHyiq+IKZ8Ids0l4M0VrG+ImGYIafCwie+oC3uAJ+pKj9xg/k+w==",
  },
  "darwin-x64": {
    name: "sherpa-onnx-darwin-x64",
    integrity: "sha512-N3o+T+wn9WaQmsKV5DD8bTHdo+WN2+sXwmZcGJZiDjtOMR2zFz7uVCZnYCmEAMgvChC+oHcF5RvEEKcRCAu6Pw==",
  },
  "linux-arm64": {
    name: "sherpa-onnx-linux-arm64",
    integrity: "sha512-TFCVpXyTh69buhOtTS8KIfkRXOVKY4Y1qjAktSItrKS4A0chnnrlXO5bKWoNAPeI6fMxTF/uvMYbYgcvjEMfNg==",
  },
  "linux-x64": {
    name: "sherpa-onnx-linux-x64",
    integrity: "sha512-npmxn5WwmAmlthgBhmbZ33t3i2j4mJwQt46dMEb3j7d41y1/uJrjrVAfa/DkvV+vn49ZWfcQ2UEWDipaZBVhuw==",
  },
  "win32-ia32": {
    name: "sherpa-onnx-win-ia32",
    integrity: "sha512-sTwtpxPQ76XLn0giAbvknIDEDKD3XXi2mo2AVROEucf1pIK1DjQl+LjLkalTeFoQqbC4J3xGx/g+xgcHQD1dsw==",
  },
  "win32-x64": {
    name: "sherpa-onnx-win-x64",
    integrity: "sha512-wBV1o+/zgsMrOjfCFIgGrH6S28xq6CqRCLSavCOjTZ6cqr80yGc07DUHxqsHFPZvfoJU+2JF5L2l3gyWFWoWdQ==",
  },
};

export const sherpaRuntimePath = (modelsRoot: string): string =>
  join(modelsRoot, ".runtime", `sherpa-onnx-${VERSION}`);

const verifyIntegrity = async (file: string, integrity: string): Promise<void> => {
  const [algorithm, expected] = integrity.split("-", 2);
  if (algorithm !== "sha512" || !expected) {
    throw new DictationError("local_model_failed", "Unsupported sherpa runtime integrity metadata");
  }
  const hash = createHash("sha512");
  const stream = createReadStream(file);
  stream.on("data", (chunk) => hash.update(chunk));
  await finished(stream);
  if (hash.digest("base64") !== expected) {
    throw new DictationError("local_model_failed", "Sherpa runtime integrity verification failed");
  }
};

const extractTgz = async (archive: string, destination: string): Promise<void> => {
  await mkdir(destination, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archive, "-C", destination, "--strip-components=1"], {
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
      `Could not extract sherpa runtime: ${error.message}. A compatible tar executable is required.`,
      { cause: error },
    )));
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new DictationError(
          "local_model_failed",
          `Sherpa runtime extraction failed${stderr.trim() ? `: ${stderr.trim()}` : ` (tar exit ${code})`}`,
        )));
  });
};

const tarballUrl = (name: string): string =>
  `https://registry.npmjs.org/${name}/-/${name}-${VERSION}.tgz`;

export async function ensureSherpaRuntime(options: {
  modelsRoot: string;
  fetchFn?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const runtime = sherpaRuntimePath(options.modelsRoot);
  if (existsSync(join(runtime, "node_modules", "sherpa-onnx-node", "package.json"))) return runtime;

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const platformPackage = PLATFORM_PACKAGES[`${platform}-${arch}`];
  if (!platformPackage) {
    throw new DictationError(
      "provider_unavailable",
      `Local Nemotron is not packaged for ${platform}/${arch}`,
    );
  }

  const fetchFn = options.fetchFn ?? fetch;
  const runtimeParent = join(options.modelsRoot, ".runtime");
  const staging = `${runtime}.staging-${process.pid}`;
  const downloads = join(runtimeParent, ".downloads");
  mkdirSync(downloads, { recursive: true });
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, "node_modules"), { recursive: true });

  try {
    for (const pkg of [NODE_PACKAGE, platformPackage]) {
      const archive = join(downloads, `${pkg.name}-${VERSION}.tgz.part`);
      const response = await fetchFn(tarballUrl(pkg.name), { signal: options.signal });
      if (!response.ok || !response.body) {
        throw new DictationError("network_error", `Sherpa runtime download failed for ${pkg.name}: HTTP ${response.status}`);
      }
      const output = createWriteStream(archive, { flags: "w" });
      const body = Readable.fromWeb(response.body as never);
      for await (const chunk of body) {
        if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (!output.write(chunk)) await new Promise<void>((resolve) => output.once("drain", resolve));
      }
      output.end();
      await finished(output);
      await verifyIntegrity(archive, pkg.integrity);
      await extractTgz(archive, join(staging, "node_modules", pkg.name));
      await rm(archive, { force: true });
    }

    await rm(runtime, { recursive: true, force: true });
    await rename(staging, runtime);
    return runtime;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (options.signal?.aborted) {
      throw new DictationError("session_expired", "Sherpa runtime installation was cancelled", { cause: error });
    }
    throw error instanceof DictationError
      ? error
      : new DictationError("local_model_failed", error instanceof Error ? error.message : String(error), { cause: error });
  }
}
