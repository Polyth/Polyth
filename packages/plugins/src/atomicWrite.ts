// Atomic file replace for the JSON-backed state that server and feature
// packages keep under the data dir: write a uniquely named sibling temp file,
// then rename it over the target so readers only ever see a complete file.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { open, rename, stat, unlink } from "node:fs/promises";

const tempPathFor = (path: string): string =>
  `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;

const existingModeSync = (path: string): number | undefined => {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
};

const existingMode = async (path: string): Promise<number | undefined> => {
  try {
    return (await stat(path)).mode & 0o777;
  } catch {
    return undefined;
  }
};

const resolvedMode = (explicit: number | undefined, existing: number | undefined): number | undefined =>
  explicit !== undefined ? explicit : existing;

const CREATE_EXCL = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;

const cleanupTempSync = (tmp: string): void => {
  try { unlinkSync(tmp); } catch { /* already gone or never created */ }
};

const cleanupTemp = async (tmp: string): Promise<void> => {
  await unlink(tmp).catch(() => {});
};

const applyExactModeSync = (fd: number, mode: number | undefined): void => {
  if (mode === undefined || process.platform === "win32") return;
  fchmodSync(fd, mode);
};

/** Exclusive sibling temp with `mode` applied before any bytes are written.
 *  Not part of the public package export map. */
export function openExclusiveTempSync(tmp: string, mode: number | undefined): number {
  const fd = openSync(tmp, CREATE_EXCL, mode ?? 0o666);
  applyExactModeSync(fd, mode);
  return fd;
}

/** Replace `path` with `data`.
 *  Explicit `mode` (e.g. 0o600) is applied at temp-file creation, before any
 *  bytes are written. When `mode` is omitted and the target already exists, its
 *  permission bits are preserved the same way. A new file with no explicit mode
 *  keeps umask defaults. Windows ignores Unix permission bits. */
export function atomicWriteSync(path: string, data: string, mode?: number): void {
  const tmp = tempPathFor(path);
  const resolved = resolvedMode(mode, existingModeSync(path));
  let fd: number | undefined;
  let created = false;
  try {
    fd = openExclusiveTempSync(tmp, resolved);
    created = true;
    writeSync(fd, data, undefined, "utf8");
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* still unlink the temp */ }
    }
    if (created) cleanupTempSync(tmp);
    throw error;
  }
}

export async function atomicWrite(path: string, data: string, mode?: number): Promise<void> {
  const tmp = tempPathFor(path);
  const resolved = resolvedMode(mode, await existingMode(path));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(tmp, CREATE_EXCL, resolved ?? 0o666);
    created = true;
    if (resolved !== undefined && process.platform !== "win32") await handle.chmod(resolved);
    await handle.writeFile(data, "utf8");
    await handle.close();
    handle = undefined;
    await rename(tmp, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await cleanupTemp(tmp);
    throw error;
  }
}
