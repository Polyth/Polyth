// Random-access reads from a large, untrusted archive on disk. `extractZipBuffer`
// unpacks a package and caps it at a package's size; a repository archive can
// hold thousands of files of which a caller wants a few, so nothing is extracted
// here and every read is bounded by the caller.
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { open, type Entry, type ZipFile } from "yauzl";

const MAX_ENTRIES = 50_000;
const MAX_RATIO = 200;
const UNIX_TYPE_MASK = 0o170000;
const UNIX_SYMLINK = 0o120000;
const UNIX_REGULAR = 0o100000;

const invalid = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });

export interface ZipArchiveEntry {
  /** Forward-slash path, checked: never absolute and never through `..`. */
  path: string;
  bytes: number;
  compressedBytes: number;
  executable: boolean;
  modifiedAt: number;
}

export interface ZipArchive {
  /** The archive comment; `git archive` stores the commit id there. */
  comment: string;
  /** Regular files only. Directories and symbolic links are never listed. */
  entries: ZipArchiveEntry[];
  /** One file's bytes, refused above `maxBytes` before and during decompression. */
  read(path: string, maxBytes: number): Promise<Buffer>;
  close(): void;
}

const safePath = (name: string): string | undefined => {
  const path = name.replace(/\\/g, "/");
  if (!path || path.startsWith("/") || path.includes("\0") || /^[A-Za-z]:/.test(path)) return undefined;
  const parts = path.split("/");
  if (parts.some((part) => part === "..")) return undefined;
  return parts.filter((part) => part && part !== ".").join("/") || undefined;
};

/** Reads the archive's directory. A caller must `close()` the result. */
export function openZipArchive(file: string): Promise<ZipArchive> {
  return new Promise((resolve, reject) => {
    open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (openError, zip?: ZipFile) => {
      if (openError || !zip) {
        reject(invalid(openError?.message ?? "zip archive is invalid"));
        return;
      }
      const raw = new Map<string, Entry>();
      const entries: ZipArchiveEntry[] = [];
      let settled = false;
      const fail = (cause: Error) => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch { /* already closed */ }
        reject(cause);
      };
      zip.on("error", fail);
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({
          comment: zip.comment ?? "",
          entries,
          close() {
            try { zip.close(); } catch { /* already closed */ }
          },
          async read(path, maxBytes) {
            const entry = raw.get(path);
            if (!entry) throw Object.assign(new Error("no such file in the archive"), { code: "not-found" });
            if (entry.uncompressedSize > maxBytes) throw invalid("file is too large");
            const stream = await new Promise<NodeJS.ReadableStream>((done, failed) => {
              zip.openReadStream(entry, (error, opened) => {
                if (error || !opened) failed(error ?? invalid("zip entry could not be read"));
                else done(opened);
              });
            });
            const chunks: Buffer[] = [];
            let total = 0;
            await pipeline(stream, new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                total += chunk.length;
                if (total > maxBytes) {
                  callback(invalid("file is too large"));
                  return;
                }
                chunks.push(chunk);
                callback();
              },
            }));
            return Buffer.concat(chunks, total);
          },
        });
      });
      zip.on("entry", (entry: Entry) => {
        if (settled) return;
        if (raw.size >= MAX_ENTRIES) return fail(invalid("zip archive has too many files"));
        if (entry.generalPurposeBitFlag & 0x0001) return fail(invalid("encrypted zip entries are not supported"));
        const madeOnUnix = (entry.versionMadeBy >> 8) === 3;
        const mode = entry.externalFileAttributes >>> 16;
        const type = mode & UNIX_TYPE_MASK;
        const directory = entry.fileName.endsWith("/");
        // A symbolic link is skipped rather than followed or refused: repositories
        // legitimately hold them, and nothing here can reach their target.
        const regular = !directory && (!madeOnUnix || type === 0 || type === UNIX_REGULAR);
        if (regular) {
          const path = safePath(entry.fileName);
          if (!path) return fail(invalid(`zip entry path is unsafe: ${entry.fileName}`));
          if (raw.has(path)) return fail(invalid(`duplicate zip entry: ${path}`));
          if (entry.uncompressedSize > 1024 * 1024
            && entry.compressedSize > 0
            && entry.uncompressedSize / entry.compressedSize > MAX_RATIO) {
            return fail(invalid("zip compression ratio exceeds limit"));
          }
          raw.set(path, entry);
          entries.push({
            path,
            bytes: entry.uncompressedSize,
            compressedBytes: entry.compressedSize,
            executable: madeOnUnix && (mode & 0o111) !== 0,
            modifiedAt: entry.getLastModDate().getTime(),
          });
        } else if (!directory && type !== UNIX_SYMLINK) {
          return fail(invalid("zip archive holds an unsupported file type"));
        }
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}
