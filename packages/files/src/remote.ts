// Remote (SSH) project filesystem: the same FileService surface as the local
// implementation, but every operation is one or two bounded `RemoteHost.exec`
// calls on the remote POSIX shell. Only Linux-compatible remotes are
// supported (the owned-runtime probe already requires /proc), so GNU
// coreutils (stat -c, ls, base64) are assumed. Round trips are cheap: the SSH
// transport multiplexes all channels over one ControlMaster connection.
import { posix } from "node:path";
import type { RemoteHost } from "@polyth/contracts";
import {
  assertRelative,
  BINARY_SCAN_BYTES,
  fold,
  MAX_READ_BYTES,
  MAX_RAW_BYTES,
  rawMimeOf,
  scorePath,
  type FileEntry,
  type FileRawResult,
  type FileReadResult,
  type FileSearchHit,
  type FileService,
  type FileStatResult,
  type SearchOptions,
  type WriteOptions,
} from "./index.ts";

const shq = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/** GNU stat, with a BSD fallback; prints `kind|size|mtimeSeconds`. */
const STAT_EXPR = `if stat -c '%F|%s|%Y' -- $1 2>/dev/null; then :; else stat -f '%HT|%z|%m' -- $1; fi`;
const STAT_LINE_RE = /^([^|]+)\|(\d+)\|(\d+)/;
const isDirKind = (kind: string): boolean => /directory/i.test(kind);
const revisionOf = (size: string, mtimeSeconds: string): string =>
  `${Number(mtimeSeconds).toString(36)}-${Number(size).toString(36)}`;

/** Chunked base64 writes stay well under the ~128 KiB single-argv limit. */
const WRITE_CHUNK_BYTES = 60 * 1024;

const fail = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

/** Stream a remote command's stdout to completion (reads larger than the
 *  exec cap: file contents up to 20 MiB are base64'd this way). */
const collect = (host: RemoteHost, command: string): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    let out = "";
    let settled = false;
    let handle: Awaited<ReturnType<RemoteHost["start"]>> | null = null;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        void handle?.kill().catch(() => {});
        reject(err);
      } else {
        resolve(out);
      }
    };
    const timer = setTimeout(
      () => finish(fail("unavailable", "remote read timed out")),
      60_000,
    );
    host.start(command).then(
      (h) => {
        handle = h;
        h.onOutput((chunk) => { out += chunk; });
        h.onExit((code) => finish(
          code === 0 ? undefined : fail("unavailable", `remote command exited (${code})`),
        ));
      },
      (err: unknown) => finish(err instanceof Error ? err : new Error(String(err))),
    );
  });

export function createRemoteFileService(host: RemoteHost): FileService {
  /** Run `cd <root> && <body>`; rel paths are validated before interpolation. */
  const run = async (
    root: string,
    rel: string,
    body: string,
    opts?: { timeoutMs?: number; maxOutputBytes?: number },
  ) => {
    assertRelative(rel);
    return host.exec(`cd -- ${shq(root)} && ${body}`, opts);
  };

  const stat = async (root: string, rel: string): Promise<FileStatResult> => {
    const result = await run(root, rel, `stat_one() { ${STAT_EXPR}; }; stat_one ${shq(rel)}`);
    if (result.code !== 0) {
      throw new Error(`cannot stat ${rel || "."}: ${result.stderr.trim() || `exit ${result.code}`}`);
    }
    const match = result.stdout.trim().split(/\r?\n/).at(-1)?.match(STAT_LINE_RE);
    if (!match) throw new Error(`cannot stat ${rel || "."}: unexpected output`);
    const kind = isDirKind(match[1]!) ? "dir" as const : "file" as const;
    const out: FileStatResult = { path: posix.normalize(rel), kind, size: Number(match[2]) };
    if (kind === "file") {
      out.mime = rawMimeOf(rel);
      out.revision = revisionOf(match[2]!, match[3]!);
    }
    return out;
  };

  return {
    async tree(root, opts = {}) {
      const rel = opts.path ?? "";
      const result = await run(root, rel, `ls -1Ap -- ${shq(rel || ".")}`);
      if (result.code !== 0) throw new Error(`Not a directory: ${rel || "."}`);
      const hidden = opts.hidden === true;
      const out: FileEntry[] = [];
      for (const line of result.stdout.split("\n")) {
        const name = line.trim();
        if (!name || name === "." || name === "..") continue;
        if (name === ".git") continue;
        if (!hidden && name.startsWith(".")) continue;
        const isDir = name.endsWith("/");
        const entryName = isDir ? name.slice(0, -1) : name;
        out.push({
          name: entryName,
          path: posix.join(rel, entryName),
          dir: isDir,
        });
      }
      out.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
      return out;
    },

    async read(root, rel): Promise<FileReadResult> {
      const st = await this.stat(root, rel);
      if (st.kind !== "file") throw new Error(`Not a file: ${rel}`);
      const truncated = st.size > MAX_READ_BYTES;
      const body = truncated
        ? `head -c ${MAX_READ_BYTES} -- ${shq(rel)} | base64`
        : `base64 < ${shq(rel)}`;
      const encoded = await collect(host, `cd -- ${shq(root)} && ${body}`);
      const buf = Buffer.from(encoded.replace(/\s+/g, ""), "base64");
      if (buf.subarray(0, BINARY_SCAN_BYTES).includes(0)) {
        return { path: posix.normalize(rel), content: "", truncated: false, tooLarge: true, revision: st.revision };
      }
      return { path: posix.normalize(rel), content: buf.toString("utf8"), truncated, revision: st.revision };
    },

    stat,

    async readRaw(root, rel): Promise<FileRawResult> {
      const st = await this.stat(root, rel);
      if (st.kind !== "file") throw new Error(`Not a file: ${rel}`);
      if (st.size > MAX_RAW_BYTES) throw new Error(`File too large to serve raw: ${rel}`);
      const encoded = await collect(host, `cd -- ${shq(root)} && base64 < ${shq(rel)}`);
      return { data: Buffer.from(encoded.replace(/\s+/g, ""), "base64"), mime: rawMimeOf(rel), size: st.size };
    },

    async write(root, rel, content, opts: WriteOptions = {}) {
      // Existing-file guards: revision conflict + refuse text over binary.
      const check = await run(root, rel, [
        `F=${shq(rel)}`,
        'if [ -f "$F" ]; then',
        `  BIN=$(od -An -N ${BINARY_SCAN_BYTES} -t x1 "$F" 2>/dev/null | grep -c ' 00' || true)`,
        `  STAT=$(stat -c '%s %Y' -- "$F" 2>/dev/null || stat -f '%z %m' -- "$F")`,
        "  echo POLYTH_EXISTS=1",
        '  echo "POLYTH_BIN=$BIN"',
        '  echo "POLYTH_STAT=$STAT"',
        "else",
        "  echo POLYTH_EXISTS=0",
        "fi",
      ].join("\n"));
      if (check.code !== 0) throw new Error(`cannot stat ${rel}: ${check.stderr.trim() || `exit ${check.code}`}`);
      const exists = /POLYTH_EXISTS=1/.test(check.stdout);
      if (exists) {
        const statLine = check.stdout.match(/POLYTH_STAT=(\d+ \d+)/)?.[1];
        if (statLine) {
          const [size, mtime] = statLine.split(" ");
          const currentRev = revisionOf(size!, mtime!);
          if (opts.baseRevision !== undefined && opts.baseRevision !== currentRev) {
            throw fail("conflict", `File changed on disk: ${rel}`);
          }
        }
        const bin = /POLYTH_BIN=([0-9]+)/.exec(check.stdout)?.[1];
        if (Number(bin ?? 0) > 0) {
          throw fail("invalid-input", `Refusing to overwrite binary file with text: ${rel}`);
        }
      }
      await this.writeBytes(root, rel, Buffer.from(content, "utf8"));
      const st = await this.stat(root, rel);
      return { revision: st.revision! };
    },

    async writeBytes(root, rel, data) {
      const dir = posix.dirname(rel);
      const b64 = Buffer.from(data).toString("base64");
      const step = Math.ceil(WRITE_CHUNK_BYTES / 3) * 4;
      const chunks: string[] = [];
      for (let i = 0; i < b64.length; i += step) chunks.push(b64.slice(i, i + step));
      // `$$` stays outside shq so every remote shell mints its own tmp path.
      const tmpExpr = `${shq(rel)}.polyth-tmp.$$`;
      let cmd = [
        `mkdir -p -- ${shq(dir)}`,
        `TMP=${tmpExpr}`,
        `printf '%s' ${shq(chunks.shift() ?? "")} | base64 -d > "$TMP"`,
      ].join(" && ");
      for (const chunk of chunks) {
        cmd += ` && printf '%s' ${shq(chunk)} | base64 -d >> "$TMP"`;
      }
      cmd += ` && mv -- "$TMP" ${shq(rel)}`;
      const result = await run(root, rel, cmd, { timeoutMs: 60_000 });
      if (result.code !== 0) {
        throw new Error(`cannot write ${rel}: ${result.stderr.trim() || `exit ${result.code}`}`);
      }
    },

    async mkdir(root, rel) {
      const result = await run(root, rel, `mkdir -p -- ${shq(rel)}`);
      if (result.code !== 0) {
        throw new Error(`cannot create ${rel}: ${result.stderr.trim() || `exit ${result.code}`}`);
      }
    },

    async remove(root, rel) {
      const result = await run(root, rel, `rm -rf -- ${shq(rel)}`);
      if (result.code !== 0) {
        throw new Error(`cannot delete ${rel}: ${result.stderr.trim() || `exit ${result.code}`}`);
      }
    },

    async rename(root, from, to) {
      const result = await run(root, from, [
        `if [ -e ${shq(to)} ]; then echo POLYTH_TARGET_EXISTS >&2; exit 2; fi`,
        `mv -- ${shq(from)} ${shq(to)}`,
      ].join("\n"));
      if (result.code !== 0) {
        if (result.code === 2) throw new Error(`Path already exists: ${to}`);
        throw new Error(`cannot rename ${from}: ${result.stderr.trim() || `exit ${result.code}`}`);
      }
    },

    async search(root, q, limit) {
      const hits = await this.searchScored(root, q, { limit });
      return hits.map((h) => h.path);
    },

    async searchScored(root, q, opts: SearchOptions = {}) {
      const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
      const includeDirs = opts.includeDirs === true;
      const query = fold(q.trim());
      // Prune the same heavy dirs the local walk skips; `find` never follows
      // symlinks and -xdev stays on one filesystem. Output is capped both
      // remotely (head) and locally (transport cap).
      const result = await host.exec(
        `find ${shq(posix.normalize(root))} -xdev `
          + `\\( -name .git -o -name node_modules -o -name dist -o -name build -o -name out `
          + `-o -name coverage -o -name .next -o -name .cache -o -name target `
          + `-o -name __pycache__ -o -name .venv \\) -prune `
          + `-o -type f -printf 'f|%p\\n' -o -type d -printf 'd|%p\\n' | head -n 20000`,
        { timeoutMs: 15_000, maxOutputBytes: 4 * 1024 * 1024 },
      );
      if (result.code !== 0) {
        throw new Error(`search failed: ${result.stderr.trim() || `exit ${result.code}`}`);
      }
      const rootPrefix = `${posix.normalize(root)}/`;
      const hits: FileSearchHit[] = [];
      for (const line of result.stdout.split("\n")) {
        const sep = line.indexOf("|");
        if (sep < 0) continue;
        const kind = line.slice(0, sep);
        const abs = line.slice(sep + 1);
        if (!abs.startsWith(rootPrefix)) continue;
        const childRel = abs.slice(rootPrefix.length);
        if (!childRel) continue;
        if (kind === "d") {
          if (includeDirs) {
            const scored = scorePath(childRel, query);
            if (scored) hits.push({ path: childRel, kind: "dir", ...scored });
          }
          continue;
        }
        const scored = scorePath(childRel, query);
        if (scored) hits.push({ path: childRel, kind: "file", ...scored });
      }
      hits.sort((a, b) => (b.score - a.score) || (a.path.length - b.path.length) || a.path.localeCompare(b.path));
      return hits.slice(0, limit);
    },
  };
}