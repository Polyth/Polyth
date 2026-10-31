import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, posix } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

const SKIP_DIRS = new Set(["node_modules", ".git", ".polyth"]);

type Entry = { name: string; path: string; mode: number };

function walk(root: string, current: string, entries: Entry[]): void {
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
      mode: info.mode,
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
  const files: Entry[] = [];
  walk(dir, dir, files);
  return zip(files);
}

/** Minimal deflate zip writer: UTF-8 names, unix modes, a fixed 1980-01-01
 *  timestamp so the same tree always packs to the same bytes. No zip64, so a
 *  package stays under 65535 files and 4 GiB. */
function zip(files: Entry[]): Buffer {
  if (files.length > 0xffff) throw Object.assign(new Error("package has too many files"), { code: "invalid-input" });
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const data = readFileSync(file.path);
    const packed = deflateRawSync(data);
    const name = Buffer.from(file.name, "utf8");
    if (data.length > 0xfffffffe || offset > 0xfffffffe) {
      throw Object.assign(new Error("package is too large"), { code: "invalid-input" });
    }
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4);
    head.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(((file.mode & 0o777) | 0o100000) * 0x10000, 38);
    entry.writeUInt32LE(offset, 42);
    local.push(head, name, packed);
    central.push(entry, name);
    offset += head.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
