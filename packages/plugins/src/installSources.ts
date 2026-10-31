import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { extractZipBuffer } from "./zipExtract.ts";
import { downloadPublicHttps, MAX_INSTALL_BYTES } from "./networkBroker.ts";
import { describeInstallSource } from "./installSourceContract.ts";

export { describeInstallSource, isRepositorySource, isSupportedInstallSource } from "./installSourceContract.ts";

/** Provider-owned archive acquisition after a public HTTP 404. null permits
 * the checkout fallback; failures propagate so denied authentication cannot be hidden. */
export type RepositoryArchiveDownloader = (source: string, maxBytes: number) => Promise<Buffer | null>;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export interface StageSourceOptions {
  source: string;
  staging: string;
  trustedDir?: string;
  allowDevPath?: boolean;
  downloadRepository?: RepositoryArchiveDownloader;
}

export interface StagedSource {
  pkgDir: string;
  /** True only when bytes came through an operator-controlled local checkout/path. */
  trustedLocal?: boolean;
}

/** Every file `loadCanonicalManifest` may read a package's manifest from. */
const SOURCE_MANIFEST_FILES = ["polyth-package.json", "package.json", "polyth-plugin.json"] as const;
const MAX_CHECKOUT_FILES = 10_000;
const REPOSITORY_CLONE_TIMEOUT_MS = 60_000;

function runCheckoutCommand(command: string, args: string[], cwd: string): boolean {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: "pipe",
    timeout: REPOSITORY_CLONE_TIMEOUT_MS,
  });
  return !result.error && result.status === 0;
}

function validateCheckout(root: string): void {
  let files = 0;
  let bytes = 0;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === ".git") {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        fail("invalid-input", "repository checkout contains symbolic links");
      }
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (!stat.isFile()) fail("invalid-input", "repository checkout contains an unsupported file type");
      files++;
      bytes += stat.size;
      if (files > MAX_CHECKOUT_FILES) fail("invalid-input", "repository checkout contains too many files");
      if (bytes > MAX_INSTALL_BYTES) fail("invalid-input", "repository checkout is too large");
    }
  };
  walk(root);
}

function stageAuthenticatedRepository(
  staging: string,
  input: { host: string; path: string; ref: string },
): StagedSource | null {
  const checkout = join(staging, "checkout");
  const reset = () => rmSync(checkout, { recursive: true, force: true });
  const branch = input.ref !== "HEAD"
    ? ["--branch", input.ref, "--single-branch"]
    : [];

  const attempts: Array<{ command: string; args: string[] }> = [];
  if (input.host === "github.com" || input.host === "www.github.com") {
    attempts.push({
      command: "gh",
      args: ["repo", "clone", input.path, checkout, "--", "--depth=1", "--no-tags", ...branch],
    });
  }
  attempts.push({
    command: "git",
    args: ["clone", "--depth=1", "--no-tags", ...branch, `https://${input.host}/${input.path}.git`, checkout],
  });
  attempts.push({
    command: "git",
    args: ["clone", "--depth=1", "--no-tags", ...branch, `git@${input.host}:${input.path}.git`, checkout],
  });

  for (const attempt of attempts) {
    reset();
    if (!runCheckoutCommand(attempt.command, attempt.args, staging)) continue;
    validateCheckout(checkout);
    return { pkgDir: findPackageRoot(checkout), trustedLocal: true };
  }
  reset();
  return null;
}

function assertInside(base: string, target: string, code: string, message: string): void {
  const root = resolve(base);
  const dest = normalize(resolve(target));
  if (dest !== root && !dest.startsWith(root + sep)) fail(code, message);
}

/** The directory an operator-local source names: `file:` under the trusted
 *  plugin directory, or a `path:`/`dir:` development path where those are
 *  allowed. null for every other source; a disallowed or escaping local
 *  source throws exactly as staging it would. */
export function localSourceDir(
  source: string,
  opts: Pick<StageSourceOptions, "trustedDir" | "allowDevPath">,
): string | null {
  const trimmed = source.trim();
  if (trimmed.startsWith("file:")) {
    const rel = trimmed.slice(5);
    if (!opts.trustedDir) return fail("invalid-input", "file installs are disabled (no trusted plugin directory configured)");
    if (isAbsolute(rel)) return fail("invalid-path", "file source must be relative to the trusted plugin directory");
    const base = resolve(opts.trustedDir);
    const target = normalize(resolve(base, rel));
    assertInside(base, target, "invalid-path", "file source escapes the trusted plugin directory");
    return target;
  }
  if (trimmed.startsWith("path:") || trimmed.startsWith("dir:")) {
    if (!opts.allowDevPath) return fail("invalid-input", "local development paths are disabled");
    return resolve(trimmed.slice(trimmed.startsWith("dir:") ? 4 : 5));
  }
  return null;
}

/** A change stamp for a local source: a hash of every file a manifest can be
 *  loaded from (`loadCanonicalManifest`'s lookup). A new version needs a
 *  changed manifest; other edits, and a sync that swaps in identical content,
 *  leave the stamp alone. null when the directory cannot be read. */
export function localSourceFingerprint(dir: string): string | null {
  try {
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  const hash = createHash("sha256");
  for (const name of SOURCE_MANIFEST_FILES) {
    let bytes: Buffer | null = null;
    try {
      bytes = readFileSync(join(dir, name));
    } catch {
      // Absent: hashed as such below.
    }
    hash.update(bytes ? `${name}:${bytes.length}:` : `${name}:-;`);
    if (bytes) hash.update(bytes);
  }
  return hash.digest("hex");
}

export async function stageInstallSource(opts: StageSourceOptions): Promise<StagedSource> {
  const source = opts.source.trim();
  mkdirSync(opts.staging, { recursive: true });

  if (source.startsWith("upload:")) {
    return fail(
      "invalid-input",
      "this package was installed from an uploaded archive; upload a new archive to update it",
    );
  }

  if (source.startsWith("npm:") || source.startsWith("git:") || source.startsWith("git+")) {
    return fail(
      "invalid-input",
      "git and npm package sources are disabled; use https://, zip:https://, a forge repository URL, file:, or a local .zip",
    );
  }

  const localDir = localSourceDir(source, opts);
  if (localDir !== null) {
    const rel = source.slice(source.startsWith("dir:") ? 4 : 5);
    if (!existsSync(localDir)) {
      return fail("not-found", source.startsWith("file:") ? `no plugin at ${rel}` : `no package at ${rel}`);
    }
    cpSync(localDir, opts.staging, { recursive: true });
    return { pkgDir: opts.staging, trustedLocal: true };
  }

  const described = describeInstallSource(source, opts.allowDevPath);
  if (described.kind === "archive-url") {
    const url = described.archiveUrl ?? fail("invalid-input", "install URL could not be resolved");
    if (!url.startsWith("https://")) fail("invalid-input", "archive installs must use https");
    const buf = await downloadPublicHttps(url, { maxBytes: MAX_INSTALL_BYTES });
    await extractZipBuffer(buf, opts.staging);
    return { pkgDir: findPackageRoot(opts.staging), trustedLocal: false };
  }

  if (described.kind === "repository") {
    const url = described.archiveUrl ?? fail("invalid-input", "repository archive URL could not be resolved");
    if (!url.startsWith("https://")) fail("invalid-input", "repository archives must use https");
    let archiveError: unknown;
    try {
      const buf = await downloadPublicHttps(url, { maxBytes: MAX_INSTALL_BYTES });
      await extractZipBuffer(buf, opts.staging);
      return { pkgDir: findPackageRoot(opts.staging), trustedLocal: false };
    } catch (cause) {
      archiveError = cause;
      rmSync(opts.staging, { recursive: true, force: true });
      mkdirSync(opts.staging, { recursive: true });
    }

    const missingPublicArchive =
      (archiveError as { httpStatus?: number } | null)?.httpStatus === 404;
    if (missingPublicArchive) {
      const authenticated = await opts.downloadRepository?.(source, MAX_INSTALL_BYTES);
      if (authenticated) {
        if (authenticated.length > MAX_INSTALL_BYTES) fail("invalid-input", "zip archive is too large");
        await extractZipBuffer(authenticated, opts.staging);
        return { pkgDir: findPackageRoot(opts.staging), trustedLocal: false };
      }
    }
    if (
      missingPublicArchive
      && described.repositoryHost
      && described.repositoryPath
      && described.repositoryRef
    ) {
      const checkout = stageAuthenticatedRepository(opts.staging, {
        host: described.repositoryHost,
        path: described.repositoryPath,
        ref: described.repositoryRef,
      });
      if (checkout) return checkout;
    }
    if (missingPublicArchive) {
      fail("invalid-input", `Repository archive not found (HTTP 404): ${described.label}. The repository or ref may be missing or private. For private GitHub repositories, sign in with gh or configure an SSH key on the Polyth host, then retry. You can also upload a package ZIP.`);
    }
    throw archiveError;
  }

  if (described.kind === "zip-path") {
    if (!existsSync(source) || !statSync(source).isFile()) return fail("not-found", `no archive at ${source}`);
    const size = statSync(source).size;
    if (size > MAX_INSTALL_BYTES) fail("invalid-input", "zip archive is too large");
    await extractZipBuffer(readFileSync(source), opts.staging);
    return { pkgDir: findPackageRoot(opts.staging), trustedLocal: false };
  }

  return fail(
    "invalid-input",
    'source must be https://, zip:https://, a forge repository URL, file:relative-path, or a local .zip',
  );
}

/** Stage an archive the user uploaded through the settings page. The buffer is
 *  untrusted: extraction applies the same zip hardening as a downloaded one,
 *  and nothing is ever written outside `staging`. */
export async function stageArchiveBuffer(buf: Buffer, staging: string): Promise<StagedSource> {
  mkdirSync(staging, { recursive: true });
  await extractZipBuffer(buf, staging);
  return { pkgDir: findPackageRoot(staging) };
}

export function findPackageRoot(dir: string): string {
  if (hasManifest(dir)) return dir;
  if (!existsSync(dir)) return dir;
  const kids = readdirSync(dir).filter((name) => !name.startsWith("."));
  const nested = kids
    .map((name) => join(dir, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory() && hasManifest(path);
      } catch {
        return false;
      }
    });
  if (nested.length > 1) {
    fail("invalid-input", "zip archive has multiple package roots; publish with the manifest at the archive root");
  }
  return nested[0] ?? dir;
}

function hasManifest(dir: string): boolean {
  return existsSync(join(dir, "polyth-package.json")) || existsSync(join(dir, "polyth-plugin.json"));
}

export async function extractZipToTemp(buf: Buffer): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "polyth-zip-"));
  try {
    await extractZipBuffer(buf, dir);
    return dir;
  } catch (cause) {
    rmSync(dir, { recursive: true, force: true });
    throw cause;
  }
}
