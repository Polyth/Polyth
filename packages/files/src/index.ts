// Project-scoped filesystem. Every path is relative to a project root;
// escapes (`..`, absolute, symlink-out) are rejected.
import { mkdir, open, readFile, readdir, lstat, realpath, rename as move, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_READ = 512 * 1024;
const BINARY_SCAN = 8 * 1024;

export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
  size?: number;
}

export interface FileReadResult {
  path: string;
  content: string;
  truncated: boolean;
  tooLarge?: boolean;
}

export interface FileService {
  tree(root: string, opts?: { path?: string; hidden?: boolean }): Promise<FileEntry[]>;
  read(root: string, rel: string): Promise<FileReadResult>;
  write(root: string, rel: string, content: string): Promise<void>;
  mkdir(root: string, rel: string): Promise<void>;
  remove(root: string, rel: string): Promise<void>;
  rename(root: string, from: string, to: string): Promise<void>;
  search(root: string, q: string, limit: number): Promise<string[]>;
}

const posix = (p: string): string => p.split(path.sep).join("/");

export function createFileService(): FileService {
  return {
    async tree(root, opts = {}) {
      const rel = opts.path ?? "";
      const abs = await resolveInside(root, rel);
      const st = await lstat(abs);
      if (!st.isDirectory()) throw new Error(`Not a directory: ${rel || "."}`);
      const hidden = opts.hidden === true;
      const entries = await readdir(abs, { withFileTypes: true });
      const out: FileEntry[] = [];
      for (const ent of entries) {
        if (ent.name === ".git") continue;
        if (!hidden && ent.name.startsWith(".")) continue;
        const childRel = posix(rel ? path.join(rel, ent.name) : ent.name);
        const isDir = ent.isDirectory();
        const item: FileEntry = { name: ent.name, path: childRel, dir: isDir };
        if (!isDir) {
          try {
            const s = await lstat(path.join(abs, ent.name));
            if (s.isFile()) item.size = s.size;
          } catch { /* ignore */ }
        }
        out.push(item);
      }
      out.sort((a, b) => {
        if (a.dir !== b.dir) return a.dir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return out;
    },

    async read(root, rel) {
      const abs = await resolveInside(root, rel);
      const fh = await open(abs, "r");
      try {
        const st = await fh.stat();
        const scanLen = Math.min(BINARY_SCAN, st.size);
        if (scanLen > 0) {
          const head = Buffer.alloc(scanLen);
          await fh.read(head, 0, scanLen, 0);
          if (head.includes(0)) {
            return { path: posix(rel), content: "", truncated: false, tooLarge: true };
          }
        }
        if (st.size > MAX_READ) {
          const buf = Buffer.alloc(MAX_READ);
          await fh.read(buf, 0, MAX_READ, 0);
          return { path: posix(rel), content: buf.toString("utf8"), truncated: true };
        }
      } finally {
        await fh.close();
      }
      const content = await readFile(abs, "utf8");
      return { path: posix(rel), content, truncated: false };
    },

    async write(root, rel, content) {
      const abs = await resolveInside(root, rel, { forWrite: true });
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      // Refuse if the written file (or a parent symlink) landed outside root.
      await resolveInside(root, rel);
    },

    async mkdir(root, rel) {
      const abs = await resolveInside(root, rel, { forWrite: true });
      await mkdir(abs, { recursive: true });
      await resolveInside(root, rel);
    },

    async remove(root, rel) {
      const abs = await resolveInside(root, rel);
      await rm(abs, { recursive: true });
    },

    async rename(root, from, to) {
      const source = await resolveInside(root, from);
      const target = await resolveInside(root, to, { forWrite: true });
      await lstat(target).then(() => { throw new Error(`Path already exists: ${to}`); }).catch((err: unknown) => {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") return;
        throw err;
      });
      await move(source, target);
      await resolveInside(root, to);
    },

    async search(root, q, limit) {
      const rootAbs = path.resolve(root);
      const found: string[] = [];
      const query = q.toLowerCase();
      const walk = async (dirAbs: string, rel: string): Promise<void> => {
        if (found.length >= limit) return;
        let entries;
        try {
          entries = await readdir(dirAbs, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of entries) {
          if (found.length >= limit) return;
          if (ent.name === ".git" || ent.name === "node_modules") continue;
          const childRel = rel ? `${rel}/${ent.name}` : ent.name;
          const childAbs = path.join(dirAbs, ent.name);
          if (ent.isDirectory()) {
            await walk(childAbs, childRel);
            continue;
          }
          if (fuzzyName(ent.name, query)) found.push(posix(childRel));
        }
      };
      await walk(rootAbs, "");
      return found.slice(0, limit);
    },
  };
}

function fuzzyName(name: string, query: string): boolean {
  if (!query) return true;
  const n = name.toLowerCase();
  if (n.includes(query)) return true;
  let i = 0;
  for (const ch of n) {
    if (ch === query[i]) i++;
    if (i >= query.length) return true;
  }
  return false;
}

function assertRelative(rel: string): void {
  if (!rel || rel === ".") return;
  if (path.isAbsolute(rel) || rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel)) {
    throw new Error(`Path escapes project root: ${rel}`);
  }
  const parts = rel.split(/[/\\]/);
  if (parts.includes("..")) throw new Error(`Path escapes project root: ${rel}`);
}

async function resolveInside(
  root: string,
  rel: string,
  opts: { forWrite?: boolean } = {},
): Promise<string> {
  assertRelative(rel);
  const rootAbs = path.resolve(root);
  let rootReal: string;
  try {
    rootReal = await realpath(rootAbs);
  } catch {
    rootReal = rootAbs;
  }
  const joined = path.resolve(rootAbs, rel || ".");
  const relToRoot = path.relative(rootAbs, joined);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
    throw new Error(`Path escapes project root: ${rel}`);
  }
  try {
    const real = await realpath(joined);
    const relReal = path.relative(rootReal, real);
    if (relReal.startsWith("..") || path.isAbsolute(relReal)) {
      throw new Error(`Path escapes project root: ${rel}`);
    }
    return real;
  } catch (err) {
    if (!opts.forWrite) throw err instanceof Error ? err : new Error(String(err));
    // File may not exist yet — walk up to an existing ancestor and realpath it.
    let dir = path.dirname(joined);
    for (;;) {
      try {
        const realDir = await realpath(dir);
        const relDir = path.relative(rootReal, realDir);
        if (relDir.startsWith("..") || path.isAbsolute(relDir)) {
          throw new Error(`Path escapes project root: ${rel}`);
        }
        return joined;
      } catch (inner) {
        if (inner instanceof Error && inner.message.startsWith("Path escapes")) throw inner;
        const parent = path.dirname(dir);
        if (parent === dir) return joined;
        dir = parent;
      }
    }
  }
}
