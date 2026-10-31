// Folder download as a .zip, streamed. Owned code instead of a dependency:
// a ZIP (no ZIP64) is three small record types, deflate and CRC-32 come from
// node:zlib. Every file goes through the FileService, so the same path jail,
// symlink refusal and SSH transport apply as for a single-file download.
import { crc32, deflateRaw } from "node:zlib";
import { promisify } from "node:util";
import path from "node:path";
import { LIST_MAX_ENTRIES, MAX_RAW_BYTES, type FileEntry, type FileService } from "./index.ts";

const deflate = promisify(deflateRaw);

/** Uncompressed total a single archive may hold (well under ZIP's 4 GiB). */
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_ARCHIVE_FILES = LIST_MAX_ENTRIES;

/** Formats that are compressed already: stored, not deflated again. */
const STORED_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
  ".mp4", ".m4v", ".mov", ".webm", ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".flac",
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".7z", ".rar", ".jar", ".woff", ".woff2",
]);

export interface ArchiveOptions {
  /** Include dot-files and dot-folders (the tree's "Show hidden"). */
  hidden?: boolean;
  /** Leave Git-ignored files out (the tree's "Hide ignored"). */
  skipIgnored?: boolean;
}

export interface ArchivePlan {
  /** Folder the archive is made of ("" = root). */
  dir: string;
  /** Top-level folder name inside the archive and the download's base name. */
  name: string;
  files: FileEntry[];
  bytes: number;
  /** Why this archive cannot be made, or null. */
  refusal: { reason: "empty" | "too-many" | "too-large" | "file-too-large"; path?: string } | null;
}

export async function planArchive(files: FileService, root: string, dir: string, opts: ArchiveOptions = {}): Promise<ArchivePlan> {
  const listing = await files.list(root, { path: dir, hidden: opts.hidden === true, limit: MAX_ARCHIVE_FILES });
  const entries = opts.skipIgnored ? listing.entries.filter((entry) => !entry.ignored) : listing.entries;
  const name = (dir ? path.posix.basename(dir) : path.basename(root)) || "files";
  let bytes = 0;
  let refusal: ArchivePlan["refusal"] = null;
  for (const entry of entries) {
    const size = entry.size ?? 0;
    if (size > MAX_RAW_BYTES) { refusal = { reason: "file-too-large", path: entry.path }; break; }
    bytes += size;
  }
  if (!refusal && listing.truncated) refusal = { reason: "too-many" };
  if (!refusal && bytes > MAX_ARCHIVE_BYTES) refusal = { reason: "too-large" };
  if (!refusal && entries.length === 0) refusal = { reason: "empty" };
  return { dir, name, files: entries, bytes, refusal };
}

/** DOS date/time in local time, clamped to the format's 1980 epoch. */
function dosDateTime(ms: number | undefined): { time: number; date: number } {
  const value = new Date(ms ?? Date.now());
  if (value.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
    date: ((value.getFullYear() - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
  };
}

interface CentralRecord { name: Buffer; crc: number; method: number; compressed: number; size: number; time: number; date: number; offset: number }

/** Write the planned files as one ZIP through `write` (which must apply
 *  backpressure). Bytes are read one file at a time. */
export async function writeArchive(
  files: FileService,
  root: string,
  plan: ArchivePlan,
  write: (chunk: Buffer) => Promise<void>,
): Promise<void> {
  const records: CentralRecord[] = [];
  let offset = 0;
  const emit = async (chunk: Buffer) => { await write(chunk); offset += chunk.length; };
  const prefix = plan.dir ? `${plan.dir}/` : "";
  for (const entry of plan.files) {
    const raw = await files.readRaw(root, entry.path);
    const data = Buffer.from(raw.data);
    const inner = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path;
    const name = Buffer.from(`${plan.name}/${inner}`, "utf8");
    const crc = crc32(data);
    let method = 0;
    let body = data;
    if (!STORED_EXT.has(path.extname(entry.path).toLowerCase()) && data.length > 0) {
      const packed = await deflate(data);
      if (packed.length < data.length) { method = 8; body = packed; }
    }
    const { time, date } = dosDateTime(entry.mtime);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    records.push({ name, crc, method, compressed: body.length, size: data.length, time, date, offset });
    await emit(Buffer.concat([header, name]));
    await emit(body);
  }
  const directoryStart = offset;
  for (const record of records) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: Unix, spec 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(record.method, 10);
    central.writeUInt16LE(record.time, 12);
    central.writeUInt16LE(record.date, 14);
    central.writeUInt32LE(record.crc, 16);
    central.writeUInt32LE(record.compressed, 20);
    central.writeUInt32LE(record.size, 24);
    central.writeUInt16LE(record.name.length, 28);
    central.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // regular file, rw-r--r--
    central.writeUInt32LE(record.offset, 42);
    await emit(Buffer.concat([central, record.name]));
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(records.length, 8);
  end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(offset - directoryStart, 12);
  end.writeUInt32LE(directoryStart, 16);
  await emit(end);
}
