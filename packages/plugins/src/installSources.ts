import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { extractZipBuffer } from "./zipExtract.ts";
import { downloadPublicHttps } from "./networkBroker.ts";

export { isSupportedInstallSource } from "./installSourceContract.ts";

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export interface StageSourceOptions {
  source: string;
  staging: string;
  trustedDir?: string;
  allowDevPath?: boolean;
}

export interface StagedSource {
  pkgDir: string;
}

function assertInside(base: string, target: string, code: string, message: string): void {
  const root = resolve(base);
  const dest = normalize(resolve(target));
  if (dest !== root && !dest.startsWith(root + sep)) fail(code, message);
}

export async function stageInstallSource(opts: StageSourceOptions): Promise<StagedSource> {
  const source = opts.source.trim();
  mkdirSync(opts.staging, { recursive: true });

  if (source.startsWith("file:") || source.startsWith("path:") || source.startsWith("dir:")) {
    const prefix = source.startsWith("file:") ? 5 : source.startsWith("path:") ? 5 : 4;
    const rel = source.slice(prefix);
    if (source.startsWith("file:")) {
      if (!opts.trustedDir) return fail("invalid-input", "file installs are disabled (no trusted plugin directory configured)");
      if (isAbsolute(rel)) return fail("invalid-path", "file source must be relative to the trusted plugin directory");
      const base = resolve(opts.trustedDir);
      const target = normalize(resolve(base, rel));
      assertInside(base, target, "invalid-path", "file source escapes the trusted plugin directory");
      if (!existsSync(target)) return fail("not-found", `no plugin at ${rel}`);
      cpSync(target, opts.staging, { recursive: true });
      return { pkgDir: opts.staging };
    }
    if (!opts.allowDevPath) return fail("invalid-input", "local development paths are disabled");
    const target = resolve(rel);
    if (!existsSync(target)) return fail("not-found", `no package at ${rel}`);
    cpSync(target, opts.staging, { recursive: true });
    return { pkgDir: opts.staging };
  }

  if (source.startsWith("npm:") || source.startsWith("git:") || source.startsWith("git+")) {
    return fail(
      "invalid-input",
      "git and npm package sources are disabled; use https://, zip:https://, file:, or a local .zip",
    );
  }

  if (source.startsWith("zip:") || source.startsWith("https://")) {
    const url = source.startsWith("zip:") ? source.slice(4) : source;
    if (!url.startsWith("https://")) fail("invalid-input", "zip installs must use https");
    const parsed = new URL(url);
    if (parsed.username || parsed.password) fail("invalid-input", "zip URL must not contain credentials");
    const buf = await downloadPublicHttps(url);
    await extractZipBuffer(buf, opts.staging);
    return { pkgDir: findPackageRoot(opts.staging) };
  }

  if (source.endsWith(".zip") && existsSync(source) && statSync(source).isFile()) {
    const size = statSync(source).size;
    if (size > 64 * 1024 * 1024) fail("invalid-input", "zip archive is too large");
    await extractZipBuffer(readFileSync(source), opts.staging);
    return { pkgDir: findPackageRoot(opts.staging) };
  }

  return fail(
    "invalid-input",
    'source must be https://, zip:https://, file:relative-path, or a local .zip',
  );
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
