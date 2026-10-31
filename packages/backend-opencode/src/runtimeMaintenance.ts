import { constants, type Dir } from "node:fs";
import { lstat, open, opendir, realpath, rename, rm, rmdir, stat, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OPEN_CODE_QUARANTINE_TTL_MS, OPEN_CODE_RUNTIME_STALE_TTL_MS, parseOpenCodeRuntimeMetadata, type OpenCodeRuntimeMetadata } from "./runtimeStorage.ts";

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fdPath = (handle: FileHandle): string => `/proc/self/fd/${handle.fd}`;
const databaseNames = new Set(["opencode.db", "opencode.db-wal", "opencode.db-shm"]);
const RETIRED_PREFIX = ".retired-";
const missing = (path: string) => stat(path).then(() => false, (error: { code?: unknown }) => error.code === "ENOENT");
type BlockReason = "runtime-occupied" | "canonical-reference" | "release-unproven" | "identity-mismatch"
  | "legacy-metadata" | "unsafe-path" | "generation-changed" | "lease-denied" | "unsupported-boundary" | "stopping";

async function metadataAt(directory: FileHandle): Promise<OpenCodeRuntimeMetadata | undefined> {
  const file = await open(join(fdPath(directory), "runtime.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size <= 0 || info.size > 32 * 1024) return;
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size) return;
    return parseOpenCodeRuntimeMetadata(bytes.toString("utf8", 0, bytesRead));
  } finally { await file.close(); }
}

/** Local Linux quarantine owner. Only recognized cache DB files can be removed;
 * live DBs, authority receipts and canonical storage are outside this boundary.
 * Directory FDs pin the owned tree so a replaced parent symlink cannot redirect
 * deletion. Other platforms fail closed until they have an equivalent boundary. */
export function createOpenCodeStorageMaintenance(options: {
  root: string;
  withRemovalLease(runtimeDir: string, metadata: OpenCodeRuntimeMetadata, remove: () => Promise<void>): Promise<void | BlockReason>;
  intervalMs?: number;
  maxEntries?: number;
  now?: () => number;
}) {
  const lifetime = new AbortController();
  const now = options.now ?? Date.now;
  const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(1, Math.min(64, Math.floor(options.maxEntries!))) : 32;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flight: Promise<void> | undefined;
  let started = false;
  let root: { path: string; file: FileHandle; entries: Dir; dev: number; ino: number } | undefined;
  let current: { path: string; file: FileHandle; quarantine: FileHandle; entries: Dir; metadata: OpenCodeRuntimeMetadata } | undefined;
  let status: { state: "idle" | "running" | "blocked" | "stopped"; inspected: number; removed: number; error?: string; blockedReason?: BlockReason } = { state: "idle", inspected: 0, removed: 0 };

  const closeCurrent = async () => {
    const value = current; current = undefined;
    if (!value) return;
    await value.entries.close().catch(() => {});
    await Promise.allSettled([value.quarantine.close(), value.file.close()]);
  };
  const closeRoot = async () => {
    await closeCurrent();
    const value = root; root = undefined;
    if (!value) return;
    await value.entries.close().catch(() => {});
    await value.file.close().catch(() => {});
  };
  const openRoot = async () => {
    const requested = resolve(options.root);
    if ((await lstat(requested)).isSymbolicLink()) throw Object.assign(new Error("unsafe root"), { code: "unsafe-path" });
    const path = await realpath(requested);
    const file = await open(path, directoryFlags);
    try {
      const info = await file.stat();
      root = { path, file, entries: await opendir(fdPath(file)), dev: info.dev, ino: info.ino };
    } catch (error) { await file.close(); throw error; }
  };
  const rootUnchanged = async () => {
    if (!root) return false;
    const info = await lstat(root.path);
    return !info.isSymbolicLink() && info.dev === root.dev && info.ino === root.ino;
  };
  const openCurrent = async (name: string) => {
    const file = await open(join(fdPath(root!.file), name), directoryFlags);
    let quarantine: FileHandle | undefined;
    try {
      const metadata = await metadataAt(file);
      if (!metadata?.runtimeGeneration) { status.state = "blocked"; status.blockedReason = "legacy-metadata"; await file.close(); return; }
      if (now() - Date.parse(metadata.lastOpenedAt) > OPEN_CODE_RUNTIME_STALE_TTL_MS && await missing(metadata.runtimeLocation.cwd)) {
        try { await retire(name, file, metadata); } finally { await file.close(); }
        return;
      }
      quarantine = await open(join(fdPath(file), "quarantine"), directoryFlags);
      current = { path: join(root!.path, name), file, quarantine, entries: await opendir(fdPath(quarantine)), metadata };
    } catch (error) {
      await Promise.allSettled([quarantine?.close() ?? Promise.resolve(), file.close()]);
      const code = String((error as { code?: unknown }).code);
      if (!["ENOENT", "ENOTDIR", "ELOOP"].includes(code)) throw error;
      if (code !== "ENOENT") { status.state = "blocked"; status.blockedReason = "unsafe-path"; }
    }
  };
  /** A store whose checkout is gone (a released isolate, a deleted worktree)
   * can no longer host a runtime. The same lease that guards quarantine
   * pruning admits removing it whole. It leaves the lookup namespace by
   * rename first, so an allocation racing a crash finds no half-removed store. */
  const retire = async (name: string, file: FileHandle, metadata: OpenCodeRuntimeMetadata) => {
    let admitted = false;
    const reason = await options.withRemovalLease(join(root!.path, name), metadata, async () => {
      if (lifetime.signal.aborted || !await rootUnchanged()) return;
      const location = await lstat(join(fdPath(root!.file), name));
      const pinned = await file.stat();
      if (location.isSymbolicLink() || location.dev !== pinned.dev || location.ino !== pinned.ino) { status.blockedReason = "unsafe-path"; return; }
      if (JSON.stringify(await metadataAt(file)) !== JSON.stringify(metadata)) { status.blockedReason = "generation-changed"; return; }
      if (!await missing(metadata.runtimeLocation.cwd)) return;
      const doomed = `${RETIRED_PREFIX}${name}`;
      await rename(join(fdPath(root!.file), name), join(fdPath(root!.file), doomed));
      await rm(join(fdPath(root!.file), doomed), { recursive: true, force: true });
      admitted = true;
      status.removed++;
    });
    if (!admitted) { status.state = "blocked"; status.blockedReason ??= reason || "lease-denied"; }
  };
  const prune = async (name: string) => {
    const owner = current!;
    const candidate = await open(join(fdPath(owner.quarantine), name), directoryFlags);
    try {
      const info = await candidate.stat();
      const namedTime = Number(name.split("-", 1)[0]);
      const created = Number.isFinite(namedTime) && namedTime > 0 ? namedTime : info.mtimeMs;
      if (now() - created <= OPEN_CODE_QUARANTINE_TTL_MS) return;
      let admitted = false;
      const reason = await options.withRemovalLease(owner.path, owner.metadata, async () => {
        if (lifetime.signal.aborted || !await rootUnchanged()) return;
        const location = await lstat(owner.path);
        const pinned = await owner.file.stat();
        const quarantineLocation = await lstat(join(fdPath(owner.file), "quarantine"));
        const quarantinePinned = await owner.quarantine.stat();
        if (location.isSymbolicLink() || location.dev !== pinned.dev || location.ino !== pinned.ino
          || quarantineLocation.isSymbolicLink() || quarantineLocation.dev !== quarantinePinned.dev || quarantineLocation.ino !== quarantinePinned.ino) { status.blockedReason = "unsafe-path"; return; }
        if (JSON.stringify(await metadataAt(owner.file)) !== JSON.stringify(owner.metadata)) { status.blockedReason = "generation-changed"; return; }
        const files: string[] = [];
        const entries = await opendir(fdPath(candidate));
        try {
          for (let count = 0; count <= databaseNames.size; count++) {
            const entry = await entries.read();
            if (!entry) break;
            if (!databaseNames.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) return;
            const child = await lstat(join(fdPath(candidate), entry.name));
            if (!child.isFile() || child.isSymbolicLink() || now() - child.mtimeMs <= OPEN_CODE_QUARANTINE_TTL_MS) return;
            files.push(entry.name);
            if (count === databaseNames.size) return;
          }
        } finally { await entries.close(); }
        for (const file of files) {
          if (lifetime.signal.aborted) return;
          await unlink(join(fdPath(candidate), file));
        }
        if (lifetime.signal.aborted) return;
        const currentInfo = await lstat(join(fdPath(owner.quarantine), name));
        if (currentInfo.dev !== info.dev || currentInfo.ino !== info.ino || currentInfo.isSymbolicLink()) return;
        await rmdir(join(fdPath(owner.quarantine), name));
        admitted = true;
        status.removed++;
      });
      if (!admitted) { status.state = "blocked"; status.blockedReason ??= reason || "lease-denied"; }
    } finally { await candidate.close(); }
  };
  const run = async () => {
    status = { state: "running", inspected: 0, removed: 0 };
    try {
      if (process.platform !== "linux") { status.state = "blocked"; status.blockedReason = "unsupported-boundary"; return; }
      if (!root) await openRoot();
      const began = performance.now();
      for (let work = 0; work < maxEntries && !lifetime.signal.aborted; work++) {
        if (!await rootUnchanged()) throw Object.assign(new Error("root changed"), { code: "unsafe-path" });
        if (current) {
          const entry = await current.entries.read();
          if (!entry) await closeCurrent();
          else {
            status.inspected++;
            if (entry.isDirectory() && !entry.isSymbolicLink()) {
              try { await prune(entry.name); }
              catch (error) {
                if (!["ENOENT", "ENOTDIR", "ELOOP"].includes(String((error as { code?: unknown }).code))) throw error;
              }
            }
          }
        } else {
          const entry = await root!.entries.read();
          if (!entry) { await closeRoot(); break; }
          status.inspected++;
          // Only an admitted retirement renames into this namespace; finish one a crash interrupted.
          if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(RETIRED_PREFIX)) {
            await rm(join(fdPath(root!.file), entry.name), { recursive: true, force: true });
          } else if (entry.isDirectory() && !entry.isSymbolicLink()) await openCurrent(entry.name);
        }
        if (performance.now() - began >= 40) break;
      }
      if (status.state === "running") status.state = "idle";
    } catch (error) {
      status.state = "blocked";
      const code = String((error as { code?: unknown }).code);
      status.error = ["ENOSPC", "EACCES", "EROFS", "ENOENT", "unsafe-path"].includes(code) ? code : "storage-error";
      await closeRoot();
    }
  };
  const step = (): Promise<void> => {
    if (lifetime.signal.aborted) return Promise.resolve();
    return flight ??= run().finally(() => { flight = undefined; });
  };
  const schedule = () => {
    if (lifetime.signal.aborted) return;
    timer = setTimeout(() => { timer = undefined; void step().finally(schedule); }, Math.max(1_000, options.intervalMs ?? 60_000));
    timer.unref?.();
  };
  return {
    step,
    snapshot: () => ({ ...status, running: flight !== undefined, scheduled: timer !== undefined, pendingScan: root !== undefined }),
    start() { if (!started) { started = true; schedule(); } },
    async dispose() {
      lifetime.abort();
      if (timer) clearTimeout(timer);
      timer = undefined;
      await flight;
      await closeRoot();
      status.state = "stopped";
    },
  };
}
