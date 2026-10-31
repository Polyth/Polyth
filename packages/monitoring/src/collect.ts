import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, open, readdir, realpath, readFile, type FileHandle } from "node:fs/promises";
import { cpus, freemem, hostname, loadavg, platform, totalmem, uptime } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HostMetrics, LogCandidate, LogTail, ServiceHealth } from "./contracts.ts";
import { failure, validHostLogPath, validJournalSource, validLogPath, validUnit } from "./policy.ts";

export const LOG_BYTES = 64 * 1024;
export const LOG_LINES = 200;
export function boundedTail(content: string, source: string, byteTruncated = false): LogTail {
  const bytes = Buffer.from(content);
  let retained = bytes.subarray(Math.max(0, bytes.length - LOG_BYTES));
  while (retained.length && (retained[0]! & 0xc0) === 0x80) retained = retained.subarray(1);
  const text = retained.toString("utf8");
  const lines = text.split("\n");
  const trailing = lines.at(-1) === "" ? 1 : 0;
  const start = Math.max(0, lines.length - LOG_LINES - trailing);
  return { source, sampledAt: Date.now(), content: lines.slice(start).join("\n"), truncated: byteTruncated || bytes.length > LOG_BYTES || start > 0 };
}
export async function localMetrics(): Promise<HostMetrics> {
  let available = freemem();
  if (platform() === "linux") {
    const meminfo = await readFile("/proc/meminfo", "utf8");
    const kb = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo)?.[1];
    if (kb) available = Number(kb) * 1024;
  }
  const load = loadavg();
  return { hostname: hostname(), platform: platform(), cpuCount: Math.max(1, cpus().length),
    load: [load[0]!, load[1]!, load[2]!], memoryTotal: totalmem(), memoryAvailable: available, uptimeSeconds: uptime() };
}
const inside = (root: string, file: string): boolean => {
  const rel = relative(root, file);
  return !!rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};
export async function localLogTail(root: string, source: string): Promise<LogTail> {
  if (!validLogPath(source)) throw failure("invalid-input", "Choose an approved project-relative .log file");
  if (platform() !== "linux") throw failure("unsupported", "Safe file tails currently require Linux");
  const rootReal = await realpath(root);
  const fileReal = await realpath(resolve(rootReal, source));
  if (!inside(rootReal, fileReal)) throw failure("forbidden", "Log path escapes the project");
  return readTail(fileReal, source, async (real) => { if (!inside(rootReal, real)) throw failure("forbidden", "Log path escapes the project"); });
}
/**
 * Bounded tail of an already-resolved file. `check` validates the opened
 * kernel object (via `/proc/self/fd`) before and after reading, which also
 * covers parent-directory swap races.
 */
async function readTail(fileReal: string, source: string, check: (real: string) => Promise<void>): Promise<LogTail> {
  const handle: FileHandle = await open(fileReal, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const descriptor = `/proc/self/fd/${handle.fd}`;
    await check(await realpath(descriptor));
    const stat = await handle.stat();
    if (!stat.isFile()) throw failure("invalid-input", "Log source must be a regular file");
    const start = Math.max(0, stat.size - LOG_BYTES);
    const buffer = Buffer.alloc(Math.min(stat.size, LOG_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    await check(await realpath(descriptor));
    let retained = buffer.subarray(0, bytesRead);
    if (start > 0) while (retained.length && (retained[0]! & 0xc0) === 0x80) retained = retained.subarray(1);
    const text = retained.toString("utf8");
    // Drop the partial first line when the byte window started mid-file.
    return boundedTail(start > 0 && text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : text, source, start > 0);
  } finally { await handle.close(); }
}
/** An approved absolute host log file; its resolved target must be approvable too. */
export async function localHostLogTail(source: string): Promise<LogTail> {
  if (!validHostLogPath(source)) throw failure("invalid-input", "Choose an approved host log file");
  if (platform() !== "linux") throw failure("unsupported", "Safe file tails currently require Linux");
  let fileReal: string;
  try { fileReal = await realpath(source); } catch { throw failure("not-found", "Log file not found or not readable"); }
  const check = async (real: string) => { if (!validHostLogPath(real)) throw failure("forbidden", "Log file resolves outside approvable host logs"); };
  await check(fileReal);
  try { return await readTail(fileReal, source, check); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EACCES") throw failure("forbidden", "The Polyth server user cannot read this log file");
    throw error;
  }
}

/**
 * Fixed read-only binaries (`journalctl`, `systemctl`) with an argument vector,
 * never a shell. Bounded by time and output; killed on timeout. Raw stderr is
 * never surfaced.
 */
export function runLocal(file: "journalctl" | "systemctl", args: string[], timeoutMs = 10_000): Promise<string> {
  if (platform() !== "linux") return Promise.reject(failure("unsupported", "Host journals and services require Linux with systemd"));
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: "C", SYSTEMD_PAGER: "", SYSTEMD_COLORS: "0" }, windowsHide: true },
      (error, stdout) => error && !(file === "systemctl" && stdout) ? reject(failure("unavailable", `Host ${file} probe failed; check systemd and the server user's journal access`)) : resolve(stdout));
  });
}
/** journalctl argument vector for an approved journal source. */
export function journalArgs(source: string): string[] {
  if (!validJournalSource(source)) throw failure("invalid-input", "Invalid journal source");
  const base = ["--no-pager", "--quiet", "--output=short-iso", "-n", String(LOG_LINES)];
  if (source === "journal") return base;
  if (source === "kernel") return [...base, "--dmesg"];
  return [...base, "--unit", source.slice("journal:".length)];
}
export async function localServices(units: string[]): Promise<ServiceHealth[]> {
  if (units.length > 12 || !units.every(validUnit)) throw failure("invalid-input", "Invalid service units");
  const states = await Promise.all(units.map((unit) => runLocal("systemctl", ["show", "--property=ActiveState", "--value", "--", unit]).catch(() => "unknown")));
  return parseServices(units, states.map((state) => state.trim() || "unknown").join("\n"));
}

export const LOG_CANDIDATE_LIMIT = 24;
const CANDIDATE_DEPTH = 4;
const CANDIDATE_SCAN_BUDGET = 4000;
/**
 * Suggest project `.log` files an administrator may approve. Only names are
 * returned; nothing is read. Symlinks, dot entries and node_modules are never
 * followed, so a suggestion always satisfies `validLogPath` and stays inside
 * the project; the bounded walk keeps huge trees cheap.
 */
export async function discoverLocalLogs(root: string): Promise<LogCandidate[]> {
  if (platform() !== "linux") return [];
  const rootReal = await realpath(root);
  const found: LogCandidate[] = [];
  const queue: Array<{ dir: string; rel: string; depth: number }> = [{ dir: rootReal, rel: "", depth: 0 }];
  let budget = CANDIDATE_SCAN_BUDGET;
  while (queue.length && budget > 0) {
    const { dir, rel, depth } = queue.shift()!;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (--budget < 0) break;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (depth + 1 < CANDIDATE_DEPTH) queue.push({ dir: join(dir, entry.name), rel: path, depth: depth + 1 }); }
      else if (entry.isFile() && validLogPath(path)) {
        try { const stat = await lstat(join(dir, entry.name)); found.push({ path, kind: "project", size: stat.size, modifiedAt: stat.mtimeMs }); } catch { /* vanished */ }
      }
    }
  }
  return found.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path)).slice(0, LOG_CANDIDATE_LIMIT);
}

export const HOST_LOG_ROOT = "/var/log";
export const HOST_CANDIDATE_LIMIT = 40;
/** Rotated, compressed and binary accounting files are not useful tails. */
export const skippedHostLog = (name: string): boolean =>
  /\.(gz|xz|bz2|zst|zip|old|journal|journal~)$|\.\d+$|-\d{8}$/.test(name) || /^sa\d+$/.test(name)
  || ["lastlog", "wtmp", "btmp", "faillog", "utmp"].includes(name);
/** Readable host log files under `/var/log` (depth 2), newest first. Names only. */
export async function discoverHostLogs(root = HOST_LOG_ROOT): Promise<LogCandidate[]> {
  if (platform() !== "linux") return [];
  const found: LogCandidate[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let budget = CANDIDATE_SCAN_BUDGET;
  while (queue.length && budget > 0) {
    const { dir, depth } = queue.shift()!;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (--budget < 0) break;
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { if (depth < 1 && entry.name !== "journal") queue.push({ dir: path, depth: depth + 1 }); continue; }
      if (!entry.isFile() || skippedHostLog(entry.name) || !validHostLogPath(path)) continue;
      try {
        await access(path, constants.R_OK);
        const stat = await lstat(path);
        found.push({ path, kind: "host", size: stat.size, modifiedAt: stat.mtimeMs });
      } catch { /* unreadable or vanished */ }
    }
  }
  return found.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path)).slice(0, HOST_CANDIDATE_LIMIT);
}
/** Journal sources every systemd host offers; availability is checked on read. */
export const journalCandidates = (): LogCandidate[] => [
  { path: "journal", kind: "journal", size: 0, modifiedAt: 0 },
  { path: "kernel", kind: "journal", size: 0, modifiedAt: 0 },
];

// Fixed probes through SSH's existing bounded process owner; no local shell spawn.
export const REMOTE_METRICS_COMMAND = "LC_ALL=C; uname -s; hostname; getconf _NPROCESSORS_ONLN; cat /proc/loadavg; awk '/^MemTotal:|^MemAvailable:/ { print $2 }' /proc/meminfo; cut -d' ' -f1 /proc/uptime";
export function parseRemoteMetrics(output: string): HostMetrics {
  const lines = output.trim().split(/\r?\n/);
  const load = (lines[3] ?? "").split(/\s+/).slice(0, 3).map(Number);
  const numbers = [Number(lines[2]), ...load, Number(lines[4]), Number(lines[5]), Number(lines[6])];
  if (lines.length !== 7 || lines[0] !== "Linux" || numbers.some((n) => !Number.isFinite(n) || n < 0)
    || numbers[0]! < 1 || load.length !== 3 || numbers[4]! <= 0 || numbers[5]! > numbers[4]!) {
    throw failure("unsupported", "The SSH host did not provide valid Linux metrics");
  }
  return { platform: "linux", hostname: lines[1]!.slice(0, 255), cpuCount: Number(lines[2]),
    load: load as [number, number, number], memoryTotal: Number(lines[4]) * 1024,
    memoryAvailable: Number(lines[5]) * 1024, uptimeSeconds: Number(lines[6]) };
}
export function serviceCommand(units: string[]): string {
  if (units.length > 12 || !units.every(validUnit)) throw failure("invalid-input", "Invalid service units");
  return units.map((unit) => `systemctl show --property=ActiveState --value -- '${unit}' 2>/dev/null || printf 'unknown\\n'`).join("; ");
}
export function parseServices(units: string[], output: string): ServiceHealth[] {
  const states = output.trim().split(/\r?\n/);
  return units.map((unit, i) => ({ unit, state: ["active", "inactive", "failed", "activating", "deactivating"].includes(states[i] ?? "")
    ? states[i] as ServiceHealth["state"] : "unknown" }));
}
export function journalCommand(unit: string): string {
  if (!validUnit(unit)) throw failure("invalid-input", "Invalid service unit");
  return journalSourceCommand(`journal:${unit}`);
}
/** Remote form of `journalArgs`; every argument is validated and single-quoted. */
export function journalSourceCommand(source: string): string {
  return `journalctl ${journalArgs(source).map((arg) => `'${arg}'`).join(" ")}`;
}
/**
 * Remote host-file tail. Prints the resolved path and size first so the caller
 * can reject a symlink that resolves outside approvable host logs.
 */
export function remoteFileCommand(path: string): string {
  if (!validHostLogPath(path)) throw failure("invalid-input", "Invalid host log path");
  return `f=$(readlink -f -- '${path}') && [ -f "$f" ] && [ -r "$f" ] && printf '%s\\n%s\\n' "$f" "$(stat -c %s -- "$f")" && tail -c ${LOG_BYTES} -- "$f"`;
}
export function parseRemoteFile(source: string, output: string): LogTail {
  const first = output.indexOf("\n"); const second = output.indexOf("\n", first + 1);
  const resolved = output.slice(0, first); const size = Number(output.slice(first + 1, second));
  if (first < 0 || second < 0 || !Number.isFinite(size)) throw failure("unavailable", "The SSH host did not return a valid log tail");
  if (!validHostLogPath(resolved)) throw failure("forbidden", "Log file resolves outside approvable host logs");
  const text = output.slice(second + 1);
  const cut = size > LOG_BYTES && text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : text;
  return boundedTail(cut, source, size > LOG_BYTES);
}
export const REMOTE_HOST_LOGS_COMMAND = `find ${HOST_LOG_ROOT} -maxdepth 2 -type f -readable -printf '%s %T@ %p\\n' 2>/dev/null | head -n 1000; true`;
export function parseRemoteHostLogs(output: string): LogCandidate[] {
  const found: LogCandidate[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\d+) (\d+(?:\.\d+)?) (\/.+)$/.exec(line);
    if (!match) continue;
    const path = match[3]!;
    if (skippedHostLog(path.slice(path.lastIndexOf("/") + 1)) || path.startsWith(`${HOST_LOG_ROOT}/journal/`) || !validHostLogPath(path)) continue;
    found.push({ path, kind: "host", size: Number(match[1]), modifiedAt: Math.round(Number(match[2]) * 1000) });
  }
  return found.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path)).slice(0, HOST_CANDIDATE_LIMIT);
}
