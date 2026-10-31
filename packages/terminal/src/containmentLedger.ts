import { createProcessContainmentBoundary, releaseProcessContainmentRecord, type ProcessContainmentBoundary } from "@polyth/harness-runtime/process-authority";
import type { SpaceStorage } from "@polyth/contracts";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, writeFile, lstat, opendir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const PACKAGE = "terminal";
const MAX_RECORDS = 4096;
const MAX_FILE_BYTES = 64 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unknown = (message: string) => Object.assign(new Error(message), { code: "outcome-unknown" });

export interface TerminalContainmentRecord {
  version: 1;
  id: string;
  terminalId: string;
  projectId: string;
  cwd: string;
  workspaceRoots: string[];
  authorityFile: string;
}

type BoundaryFactory = (controller?: undefined, options?: { file?: string }) => ProcessContainmentBoundary | undefined;
type ReleaseRecord = (file: string) => Promise<void>;

const isInside = (root: string, value: string): boolean => {
  const rel = relative(resolve(root), resolve(value));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${"/"}`) && !rel.startsWith(`..${"\\"}`) && !/^[A-Za-z]:/.test(rel));
};
const validAbsolutePath = (value: string): boolean => value.length > 0 && !value.includes("\0") && resolve(value) === value;

const recordDir = (storage: SpaceStorage): string => storage.packageDir(PACKAGE);
const executionDir = (storage: SpaceStorage): string => storage.path("packages/terminal/executions");
const recordPath = (executionDir: string, id: string): string => join(executionDir, `${id}.json`);
const authorityPath = (executionDir: string, id: string): string => join(executionDir, `${id}.authority`);

async function readRecord(file: string, dir: string): Promise<TerminalContainmentRecord> {
  const base = dirname(file);
  if (base !== resolve(dir) || !/^[0-9a-f-]{36}\.json$/.test(file.slice(base.length + 1))) throw unknown("terminal ledger filename is invalid");
  const handle = await open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw unknown("terminal ledger record is invalid");
    const buffer = Buffer.alloc(stat.size + 1);
    const read = await handle.read(buffer, 0, buffer.length, 0);
    if (read.bytesRead > MAX_FILE_BYTES) throw unknown("terminal ledger record is oversized");
    const parsed = JSON.parse(buffer.subarray(0, read.bytesRead).toString("utf8"));
    if (!parsed || parsed.version !== 1 || typeof parsed.id !== "string" || !ID.test(parsed.id)
      || file !== recordPath(dir, parsed.id)
      || typeof parsed.terminalId !== "string" || !parsed.terminalId || typeof parsed.projectId !== "string" || !parsed.projectId || typeof parsed.cwd !== "string" || !validAbsolutePath(parsed.cwd)
      || !Array.isArray(parsed.workspaceRoots) || parsed.workspaceRoots.length > 128
      || !parsed.workspaceRoots.every((value: unknown) => typeof value === "string" && validAbsolutePath(value))
      || typeof parsed.authorityFile !== "string" || resolve(parsed.authorityFile) !== resolve(authorityPath(dir, parsed.id))) {
      throw unknown("terminal ledger record is malformed");
    }
    return parsed as TerminalContainmentRecord;
  } finally { await handle.close(); }
}

async function listRecords(storage: SpaceStorage): Promise<Array<{ record: TerminalContainmentRecord; file: string; dir: string }>> {
  const dir = executionDir(storage);
  let entries: string[] = [];
  try {
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unknown("terminal ledger directory is not owned");
    const directory = await opendir(dir);
    for await (const entry of directory) {
      if (entries.length >= MAX_RECORDS) throw unknown("terminal ledger contains too many records");
      entries.push(entry.name);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files = entries.filter((name) => name.endsWith(".json"));
  const result = [] as Array<{ record: TerminalContainmentRecord; file: string; dir: string }>;
  for (const name of files) {
    if (!/^[0-9a-f-]{36}\.json$/i.test(name)) throw unknown("terminal ledger contains an unexpected record");
    const file = join(dir, name);
    result.push({ record: await readRecord(file, dir), file, dir });
  }
  return result;
}

export function createTerminalContainmentLedger(options: {
  storageForProject(projectId: string): Promise<SpaceStorage>;
  storages(): Promise<readonly SpaceStorage[]>;
  boundaryFactory?: BoundaryFactory;
  releaseRecord?: ReleaseRecord;
}) {
  const live = new Map<string, { storage: SpaceStorage; record: TerminalContainmentRecord; boundary?: ProcessContainmentBoundary }>();
  const boundaryFactory = options.boundaryFactory ?? createProcessContainmentBoundary;
  const releaseRecord = options.releaseRecord ?? releaseProcessContainmentRecord;

  const uniqueStorages = async (): Promise<SpaceStorage[]> => {
    const seen = new Set<string>();
    const result: SpaceStorage[] = [];
    for (const storage of await options.storages()) {
      const key = resolve(recordDir(storage));
      if (!seen.has(key)) { seen.add(key); result.push(storage); }
    }
    return result;
  };

  const removeFiles = async (entry: { record: TerminalContainmentRecord; file: string }): Promise<void> => {
    await unlink(entry.file).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    await unlink(entry.record.authorityFile).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    live.delete(entry.record.id);
  };
  const release = async (entry: { record: TerminalContainmentRecord; file: string; dir: string }): Promise<void> => {
    const current = live.get(entry.record.id);
    if (current?.boundary) {
      await current.boundary.close();
      return;
    }
    const authority = await lstat(entry.record.authorityFile).catch(() => undefined);
    if (!authority || authority.isSymbolicLink() || !authority.isFile()) throw unknown("terminal authority record is unavailable");
    await releaseRecord(entry.record.authorityFile);
    await removeFiles(entry);
  };

  return {
    async create(input: { id: string; projectId: string; cwd: string; workspaceRoots?: readonly string[] }): Promise<ProcessContainmentBoundary | undefined> {
      if (!input.id || !input.projectId || !validAbsolutePath(input.cwd)) throw new Error("terminal ledger input is invalid");
      const storage = await options.storageForProject(input.projectId);
      const dir = executionDir(storage);
      const id = randomUUID();
      const file = recordPath(dir, id);
      const authorityFile = authorityPath(dir, id);
      const record: TerminalContainmentRecord = {
        version: 1, id, terminalId: input.id, projectId: input.projectId, cwd: resolve(input.cwd),
        workspaceRoots: [...(input.workspaceRoots ?? [])].map((value) => {
          if (!validAbsolutePath(value)) throw new Error("terminal workspace root is invalid");
          return resolve(value);
        }), authorityFile,
      };
      if (record.workspaceRoots.length > 128) throw Object.assign(new Error("too many terminal workspace roots"), { code: "resource-limit" });
      await mkdir(dirname(file), { recursive: true });
      const directoryStat = await lstat(dir);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw unknown("terminal ledger directory is not owned");
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
      await rename(temp, file);
      let boundary: ProcessContainmentBoundary | undefined;
      try { boundary = boundaryFactory(undefined, { file: authorityFile }); }
      catch (error) { throw error; }
      let released = false;
      let closed = false;
      let closing: Promise<void> | undefined;
      const wrapped: ProcessContainmentBoundary | undefined = boundary ? {
        launch(command, args) {
          if (released) throw unknown("Terminal containment is already released");
          return boundary!.launch(command, args);
        },
        launcherStarted(pid) { if (!released) boundary!.launcherStarted?.(pid); },
        launcherExited() { if (!released) boundary!.launcherExited(); },
        close() {
          if (closed) return Promise.resolve();
          if (!closing) closing = (async () => {
            if (!released) { await boundary!.close(); released = true; }
            await removeFiles({ record, file });
            closed = true;
          })().finally(() => { closing = undefined; });
          return closing;
        },
      } : undefined;
      live.set(id, { storage, record, boundary: wrapped });
      return wrapped;
    },
    async releaseByCwd(cwd: string): Promise<void> {
      const target = resolve(cwd);
      for (const storage of await uniqueStorages()) {
        const records = await listRecords(storage);
        for (const entry of records) {
          if (entry.record.cwd === target || isInside(target, entry.record.cwd)
            || entry.record.workspaceRoots.some((root) => root === target || isInside(target, root))) {
            await release(entry);
          }
        }
      }
    },
    async releaseAll(): Promise<void> {
      for (const storage of await uniqueStorages()) {
        for (const entry of await listRecords(storage)) await release(entry);
      }
    },
  };
}
