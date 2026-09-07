/// <reference path="./vendor.d.ts" />
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, posix } from "node:path";
import { ZipFile } from "yazl";

const SKIP_DIRS = new Set(["node_modules", ".git", ".polyth"]);

function walk(root: string, current: string, entries: Array<{ name: string; path: string }>): void {
  for (const name of readdirSync(current).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(current, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      throw Object.assign(new Error(`symlink in package source: ${name}`), { code: "invalid-input" });
    }
    if (info.isDirectory()) {
      walk(root, path, entries);
      continue;
    }
    if (!info.isFile()) continue;
    entries.push({
      name: posix.normalize(relative(root, path).split("\\").join("/")),
      path,
    });
  }
}

function requiredFiles(dir: string): string[] {
  const files: string[] = [];
  const tryRead = (file: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const v1 = tryRead(join(dir, "polyth-package.json"));
  const pkg = tryRead(join(dir, "package.json"));
  const document = v1 ?? (pkg?.polyth && typeof pkg.polyth === "object" ? pkg.polyth as Record<string, unknown> : null);
  if (!document) {
    throw Object.assign(new Error("package has no polyth-package.json manifest"), { code: "invalid-input" });
  }
  const runtime = document.runtime && typeof document.runtime === "object"
    ? document.runtime as { ui?: { entry?: unknown }; server?: unknown }
    : undefined;
  if (typeof runtime?.ui?.entry === "string") files.push(runtime.ui.entry);
  if (typeof runtime?.server === "string") files.push(runtime.server);
  return files;
}

/** Pack a package directory. Skips `.git`, `.polyth`, and `node_modules`; other files including dotfiles are included. */
export async function packDirectory(dir: string): Promise<Buffer> {
  for (const asset of requiredFiles(dir)) {
    const path = join(dir, asset);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw Object.assign(new Error(`missing required asset ${asset}`), { code: "invalid-input" });
    }
  }
  const files: Array<{ name: string; path: string }> = [];
  walk(dir, dir, files);
  const zip = new ZipFile();
  for (const file of files) {
    zip.addFile(file.path, file.name);
  }
  zip.end();
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve());
    zip.outputStream.on("error", reject);
  });
  return Buffer.concat(chunks);
}
