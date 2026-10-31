/// <reference path="./vendor.d.ts" />
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fromBuffer } from "yauzl";
import { isSafePackagePath } from "@polyth/package-sdk/manifest";

const MAX_FILES = 512;
const MAX_UNCOMPRESSED = 32 * 1024 * 1024;
const MAX_COMPRESSED = 64 * 1024 * 1024;
const MAX_RATIO = 100;
const UNIX_SYMLINK = 0o120000;

function invalidInput(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid-input" });
}

function fail(message: string): never {
  throw invalidInput(message);
}

function decodePath(name: string): string | null {
  const normalized = name.replace(/\\/g, "/");
  if (normalized.endsWith("/")) return null;
  const trimmed = normalized.replace(/^\.\//, "");
  if (!isSafePackagePath(trimmed)) fail(`zip entry path is unsafe: ${name}`);
  return posix.normalize(trimmed);
}

function isSymlink(entry: { versionMadeBy: number; externalFileAttributes: number }): boolean {
  const unix = (entry.versionMadeBy >> 8) === 3;
  if (!unix) return false;
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return mode === UNIX_SYMLINK;
}

function limitingTransform(onChunk: (n: number) => void): Transform {
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        onChunk(chunk.length);
        cb(null, chunk);
      } catch (cause) {
        cb(cause as Error);
      }
    },
  });
}

export async function extractZipBuffer(buf: Buffer, dest: string): Promise<string[]> {
  if (buf.length > MAX_COMPRESSED) fail("zip archive is too large");
  return new Promise((resolve, reject) => {
    let settled = false;
    let zipHandle: { close(): void } | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try { zipHandle?.close(); } catch { /* already closed */ }
      fn();
    };
    const rejectOnce = (cause: unknown) => finish(() => reject(cause));
    const resolveOnce = (value: string[]) => finish(() => resolve(value));
    fromBuffer(buf, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return rejectOnce(err ?? fail("zip archive is invalid"));
      zipHandle = zip;
      const written: string[] = [];
      const seen = new Set<string>();
      let actualTotal = 0;
      let count = 0;
      zip.on("entry", (entry) => {
        if (settled) return;
        count += 1;
        if (count > MAX_FILES) return rejectOnce(invalidInput("zip archive has too many files"));
        if (entry.generalPurposeBitFlag & 0x0001) {
          return rejectOnce(invalidInput("encrypted zip entries are not supported"));
        }
        if (isSymlink(entry)) return rejectOnce(invalidInput("zip symlinks are not allowed"));
        let rel: string | null;
        try {
          rel = decodePath(entry.fileName);
        } catch (cause) {
          return rejectOnce(cause);
        }
        if (rel === null) {
          zip.readEntry();
          return;
        }
        if (seen.has(rel)) return rejectOnce(invalidInput(`duplicate zip destination: ${rel}`));
        seen.add(rel);
        if (entry.compressedSize > MAX_COMPRESSED) return rejectOnce(invalidInput("zip archive is too large"));
        if (entry.uncompressedSize > MAX_UNCOMPRESSED) {
          return rejectOnce(invalidInput("zip uncompressed size exceeds limit"));
        }
        if (entry.uncompressedSize > 1024 * 1024 && entry.compressedSize > 0
          && entry.uncompressedSize / entry.compressedSize > MAX_RATIO) {
          return rejectOnce(invalidInput("zip compression ratio exceeds limit"));
        }
        const out = join(dest, rel);
        mkdirSync(dirname(out), { recursive: true });
        zip.openReadStream(entry, (openErr, stream) => {
          if (settled) return;
          if (openErr || !stream) {
            return rejectOnce(openErr ?? invalidInput("zip entry could not be read"));
          }
          const sink = createWriteStream(out);
          let entryActual = 0;
          const limiter = limitingTransform((n) => {
            entryActual += n;
            actualTotal += n;
            if (entryActual > MAX_UNCOMPRESSED || actualTotal > MAX_UNCOMPRESSED) {
              stream.destroy();
              sink.destroy();
              throw invalidInput("zip uncompressed size exceeds limit");
            }
          });
          void pipeline(stream, limiter, sink).then(() => {
            if (settled) return;
            written.push(rel!);
            zip.readEntry();
          }).catch((cause) => {
            stream.destroy();
            sink.destroy();
            rejectOnce(cause);
          });
        });
      });
      zip.on("end", () => resolveOnce(written));
      zip.on("error", (cause) => rejectOnce(cause));
      zip.readEntry();
    });
  });
}
