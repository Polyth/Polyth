// Durable studio files inside a session checkout. Every write of studio.json
// goes through `update`, which serializes per studio (in-process mutex) and
// writes atomically (temp file + rename), so tools from parallel delegated
// sessions and the studio UI never interleave a read-modify-write.
import { mkdir, readFile, realpath, rename, stat, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import {
  createStudioState,
  normalizeStudioId,
  parseStudioState,
  studioPaths,
  type StudioInit,
  type StudioState,
} from "../index.ts";
import type { AudioAnalysis } from "../audio/analysis.ts";

export const MAX_SCENE_BYTES = 200_000;

const invalid = (message: string, code = "invalid-input") => Object.assign(new Error(message), { code });

/** Resolve a checkout-relative path and refuse traversal or symlink escape. */
export async function resolveInside(cwd: string, relative: string): Promise<string> {
  if (!cwd || !path.isAbsolute(cwd)) throw invalid("session checkout is unavailable");
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw invalid(`path escapes the checkout: ${relative}`);
  const root = await realpath(cwd);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) throw invalid(`path escapes the checkout: ${relative}`);
  // Walk existing ancestors: none may be a symlink that leaves the root.
  let probe = target;
  while (probe.startsWith(root + path.sep)) {
    try {
      const info = await lstat(probe);
      if (info.isSymbolicLink()) {
        const real = await realpath(probe);
        if (real !== root && !real.startsWith(root + path.sep)) throw invalid(`path escapes the checkout through a link: ${relative}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    probe = path.dirname(probe);
  }
  return target;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(temp, data);
  await rename(temp, file);
}

export interface StudioRef { cwd: string; studioId: string }

export class StudioStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  key(ref: StudioRef): string {
    return `${ref.cwd}\u0000${normalizeStudioId(ref.studioId)}`;
  }

  private async serialize<T>(ref: StudioRef, work: () => Promise<T>): Promise<T> {
    const key = this.key(ref);
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  async file(ref: StudioRef, relative: string): Promise<string> {
    return resolveInside(ref.cwd, relative);
  }

  async read(ref: StudioRef): Promise<StudioState | null> {
    const file = await this.file(ref, studioPaths(ref.studioId).state);
    const text = await readText(file);
    return text === null ? null : parseStudioState(text, ref.studioId);
  }

  async require(ref: StudioRef): Promise<StudioState> {
    const state = await this.read(ref);
    if (!state) {
      throw invalid(`studio ${ref.studioId} does not exist in this checkout; call creative_studio_init first`, "not-found");
    }
    return state;
  }

  /** Revision token for cheap change polling (mtime + size). */
  async revision(ref: StudioRef): Promise<string | null> {
    try {
      const info = await stat(await this.file(ref, studioPaths(ref.studioId).state));
      return `${info.mtimeMs.toFixed(0)}-${info.size}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async init(ref: StudioRef, init: StudioInit, options: { reset?: boolean } = {}): Promise<{ state: StudioState; created: boolean }> {
    return this.serialize(ref, async () => {
      const existing = await this.read(ref);
      if (existing && !options.reset) return { state: existing, created: false };
      const state = createStudioState(ref.studioId, init);
      await this.write(ref, state);
      return { state, created: true };
    });
  }

  async update(ref: StudioRef, mutate: (state: StudioState) => StudioState | Promise<StudioState>): Promise<StudioState> {
    return this.serialize(ref, async () => {
      const current = await this.require(ref);
      const next = await mutate(current);
      next.updatedAt = Math.max(Date.now(), current.updatedAt + 1);
      await this.write(ref, next);
      return next;
    });
  }

  private async write(ref: StudioRef, state: StudioState): Promise<void> {
    await atomicWrite(await this.file(ref, studioPaths(ref.studioId).state), JSON.stringify(state, null, 2));
  }

  async readAnalysis(ref: StudioRef): Promise<AudioAnalysis | null> {
    const text = await readText(await this.file(ref, studioPaths(ref.studioId).analysis));
    return text ? JSON.parse(text) as AudioAnalysis : null;
  }

  async writeAnalysis(ref: StudioRef, analysis: AudioAnalysis): Promise<void> {
    await atomicWrite(await this.file(ref, studioPaths(ref.studioId).analysis), JSON.stringify(analysis));
  }

  async readScene(ref: StudioRef, sceneId: string): Promise<string | null> {
    return readText(await this.file(ref, studioPaths(ref.studioId).scene(sceneId)));
  }

  async readScenes(ref: StudioRef, sceneIds: readonly string[]): Promise<Record<string, string | undefined>> {
    const entries = await Promise.all(sceneIds.map(async (id) => [id, (await this.readScene(ref, id)) ?? undefined] as const));
    return Object.fromEntries(entries);
  }

  async writeScene(ref: StudioRef, sceneId: string, code: string): Promise<void> {
    if (Buffer.byteLength(code, "utf8") > MAX_SCENE_BYTES) throw invalid(`scene code is larger than ${MAX_SCENE_BYTES} bytes`);
    if (!/\bexport\s+default\b/.test(code)) throw invalid("scene code must be an ES module with `export default { draw … }`");
    if (/\bimport\s*[\s{*(]|\bimport\s*\(/.test(code.replace(/\/\/.*$/gm, ""))) {
      throw invalid("scene code must not import modules; Three.js arrives as the THREE argument");
    }
    await atomicWrite(await this.file(ref, studioPaths(ref.studioId).scene(sceneId)), code);
  }

  async writeBinary(ref: StudioRef, relative: string, data: Uint8Array): Promise<void> {
    await atomicWrite(await this.file(ref, relative), data);
  }
}
