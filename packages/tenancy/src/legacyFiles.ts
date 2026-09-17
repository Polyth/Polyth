// Operator-only legacy source I/O. Never follow a source symlink or report raw
// parser/OS errors, which can embed credentials. Hash large stores incrementally.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";

export const LEGACY_JSON_MAX_BYTES = 64 * 1024 * 1024;
export interface LegacyFileDigest { present: boolean; sha256?: string; bytes?: number }
export const legacyFileError = (code: string): Error => Object.assign(new Error(code), { code });
const unchanged = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

function readChecked(file: string, collect: boolean, maximum: number): { digest: LegacyFileDigest; data: Buffer | null } {
  let fd: number | undefined;
  let initial: BigIntStats;
  try { initial = lstatSync(file, { bigint: true }); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { digest: { present: false }, data: null };
    throw legacyFileError("unreadable-source");
  }
  if (!initial.isFile() || initial.isSymbolicLink()) throw legacyFileError("unsafe-source-file");
  if (initial.size > BigInt(maximum)) throw legacyFileError("source-too-large");
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!unchanged(initial, fstatSync(fd, { bigint: true }))) throw legacyFileError("source-changed");
    const hash = createHash("sha256"), chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      bytes += n;
      if (bytes > maximum || BigInt(bytes) > initial.size) throw legacyFileError("source-changed");
      const part = buffer.subarray(0, n);
      hash.update(part);
      if (collect) chunks.push(Buffer.from(part));
    }
    if (BigInt(bytes) !== initial.size || !unchanged(initial, fstatSync(fd, { bigint: true }))
      || !unchanged(initial, lstatSync(file, { bigint: true }))) throw legacyFileError("source-changed");
    return { digest: { present: true, sha256: hash.digest("hex"), bytes }, data: collect ? Buffer.concat(chunks) : null };
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    throw legacyFileError(["source-changed", "source-too-large", "unsafe-source-file"].includes(code ?? "") ? code! : "unreadable-source");
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** JSON authority inputs are bounded; a larger source needs an explicit
 * migration design, not an unbounded allocation on the server request path. */
export function readLegacyFile(file: string): { digest: LegacyFileDigest; data: Buffer | null } {
  return readChecked(file, true, LEGACY_JSON_MAX_BYTES);
}
export function digestLegacyFile(file: string): LegacyFileDigest {
  return readChecked(file, false, Number.MAX_SAFE_INTEGER).digest;
}
/** SQLite can create an empty WAL while opening a checkpointed database read
 * only. An empty auxiliary file has no committed payload; nonempty bytes are
 * always fingerprinted, and unsafe files are still rejected before this step. */
export function digestLegacySidecar(file: string): LegacyFileDigest {
  const digest = digestLegacyFile(file);
  return digest.bytes === 0 ? { present: false } : digest;
}
export function canonicalLegacyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalLegacyJson(item ?? null)).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).filter(key => row[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalLegacyJson(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
