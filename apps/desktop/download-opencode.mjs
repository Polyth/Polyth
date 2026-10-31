import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(join(here, "opencode.json"), "utf8"));
const platform = process.env.POLYTH_TARGET_PLATFORM ?? process.platform;
const arch = process.env.POLYTH_TARGET_ARCH ?? process.env.npm_config_arch ?? process.arch;
const key = `${platform}-${arch}`;
const target = lock.targets[key];

if (!target) {
  throw new Error(`No pinned OpenCode binary for ${key}`);
}

const url = target.tarball;
const work = await mkdtemp(join(tmpdir(), "polyth-opencode-"));

// CI runners occasionally fail to reach the npm registry (connect timeouts,
// 5xx edge responses). A failed connection costs seconds; a failed job
// throws away the Rust and Electron builds that preceded it, so retry a few
// times with a short backoff before giving up.
const DOWNLOAD_ATTEMPTS = Number(process.env.POLYTH_OPENCODE_DOWNLOAD_ATTEMPTS ?? 4);
const RETRY_DELAY_MS = 5_000;

async function attemptDownload(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (response.ok) return { bytes: Buffer.from(await response.arrayBuffer()) };
  const error = new Error(`OpenCode download failed: ${response.status} ${response.statusText}`);
  // 4xx means the pinned tarball is wrong; retrying cannot fix that.
  return { error, retryable: response.status >= 500 };
}

async function download(url) {
  for (let attempt = 1; ; attempt += 1) {
    let outcome;
    try {
      outcome = await attemptDownload(url);
    } catch (error) {
      // fetch() rejects on connection-level failures (DNS, connect timeout, reset).
      outcome = { error, retryable: true };
    }
    if (outcome.bytes) return outcome.bytes;
    if (!outcome.retryable || attempt >= DOWNLOAD_ATTEMPTS) throw outcome.error;
    const delay = RETRY_DELAY_MS * attempt;
    const reason = outcome.error?.cause?.message ?? outcome.error?.message ?? String(outcome.error);
    console.warn(`[desktop] OpenCode download attempt ${attempt}/${DOWNLOAD_ATTEMPTS} failed (${reason}); retrying in ${delay / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

try {
  console.log(`[desktop] downloading OpenCode ${lock.version} for ${key}`);
  const bytes = await download(url);
  const digest = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (digest !== target.integrity) {
    throw new Error(`OpenCode integrity mismatch for ${target.package}: expected ${target.integrity}, got ${digest}`);
  }

  const archivePath = join(work, basename(new URL(url).pathname));
  await writeFile(archivePath, bytes);
  const unpack = join(work, "unpack");
  await mkdir(unpack);
  // GNU tar on Windows treats an absolute `C:\\...` archive path as the
  // remote `host:path` form. Keep both paths relative to the temp directory
  // so extraction works on Windows and POSIX runners alike.
  const extracted = spawnSync("tar", ["-xf", basename(archivePath), "-C", "unpack"], {
    cwd: work,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (extracted.status !== 0) {
    throw new Error(`Could not extract ${target.package}: ${extracted.stderr || extracted.stdout}`);
  }

  const executableName = platform === "win32" ? "opencode.exe" : "opencode";
  const source = join(unpack, "package", "bin", executableName);
  if (!(await lstat(source)).isFile()) {
    throw new Error(`${target.package} must contain a regular file at package/bin/${executableName}`);
  }
  const outputDir = process.env.POLYTH_OPENCODE_OUTPUT_DIR ?? join(here, "resources", "opencode", key);
  const output = join(outputDir, platform === "win32" ? "opencode.exe" : "opencode");
  await mkdir(outputDir, { recursive: true });
  await rm(join(outputDir, platform === "win32" ? "opencode" : "opencode.exe"), { force: true });
  await copyFile(source, output);
  if (platform !== "win32") await chmod(output, 0o755);
  await writeFile(join(outputDir, "provenance.json"), `${JSON.stringify({
    version: lock.version,
    platform,
    arch,
    package: target.package,
    tarball: target.tarball,
    integrity: target.integrity,
  }, null, 2)}\n`);

  if (platform === process.platform && arch === process.arch) {
    const checked = spawnSync(output, ["--version"], { encoding: "utf8" });
    const reportedVersion = checked.stdout.trim().replace(/^opencode v/, "");
    if (checked.status !== 0 || reportedVersion !== lock.version) {
      throw new Error(`Downloaded OpenCode version check failed: ${checked.stderr || checked.stdout}`);
    }
  }
  console.log(`[desktop] OpenCode ${lock.version} ready at ${output}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
