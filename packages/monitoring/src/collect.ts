import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, open, readdir, realpath, readFile, statfs, type FileHandle } from "node:fs/promises";
import { cpus, freemem, hostname, loadavg, platform, totalmem, uptime } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { diskPercent, type DiskUsage, type HostMetrics, type HostPressure, type LogCandidate, type LogTail, type ProcessGroup, type ServiceHealth } from "./contracts.ts";
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
/** Filesystems worth a row: real block devices, not snaps, boot or container layers. */
const REAL_DISK_LIMIT = 6;
const isRealDisk = (device: string, mount: string): boolean =>
  device.startsWith("/dev/") && !device.startsWith("/dev/loop")
  && !/^\/(boot|snap|run|sys|proc|dev|var\/lib\/(docker|containers|kubelet))(\/|$)/.test(mount);
const fullestFirst = (disks: DiskUsage[]): DiskUsage[] =>
  disks.filter((disk) => disk.size > 0).sort((a, b) => diskPercent(b) - diskPercent(a) || a.mount.localeCompare(b.mount)).slice(0, REAL_DISK_LIMIT);
const diskAt = async (mount: string): Promise<DiskUsage> => {
  const info = await statfs(mount);
  return { mount, size: info.blocks * info.bsize, used: (info.blocks - info.bfree) * info.bsize, available: info.bavail * info.bsize };
};
/** `/proc/mounts` escapes spaces as octal; one device mounted twice counts once. */
export function realMounts(mounts: string): string[] {
  const seen = new Map<string, string>();
  for (const line of mounts.split("\n")) {
    const [device, raw] = line.split(" ");
    if (!device || !raw) continue;
    const mount = raw.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));
    const known = seen.get(device);
    if (isRealDisk(device, mount) && (!known || mount.length < known.length)) seen.set(device, mount);
  }
  return [...seen.values()];
}
async function localDisks(): Promise<DiskUsage[] | undefined> {
  const linux = platform() === "linux";
  const mounts = linux ? realMounts(await readFile("/proc/mounts", "utf8").catch(() => "")) : [];
  // A container's root is an overlay and a non-Linux host has no mount table.
  if (!mounts.length) mounts.push(linux ? "/" : parse(process.cwd()).root);
  const settled = await Promise.allSettled(mounts.map(diskAt));
  const disks = settled.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
  return disks.length ? fullestFirst(disks) : undefined;
}
export function parsePressureLine(text: string): number | undefined {
  const value = /^(?:\S+ )?some\b.*\bavg60=(\d+(?:\.\d+)?)/m.exec(text)?.[1];
  return value === undefined ? undefined : Math.min(100, Number(value));
}
async function localPressure(): Promise<HostPressure | undefined> {
  if (platform() !== "linux") return undefined;
  const read = (name: string) => readFile(`/proc/pressure/${name}`, "utf8").then(parsePressureLine, () => undefined);
  const [cpu, io, memory] = await Promise.all([read("cpu"), read("io"), read("memory")]);
  return cpu === undefined || io === undefined || memory === undefined ? undefined : { cpu, io, memory };
}
export async function localMetrics(): Promise<HostMetrics> {
  let available = freemem();
  if (platform() === "linux") {
    const meminfo = await readFile("/proc/meminfo", "utf8");
    const kb = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo)?.[1];
    if (kb) available = Number(kb) * 1024;
  }
  const load = loadavg();
  const [disks, pressure] = await Promise.all([localDisks(), localPressure()]);
  return { hostname: hostname(), platform: platform(), cpuCount: Math.max(1, cpus().length),
    load: [load[0]!, load[1]!, load[2]!], memoryTotal: totalmem(), memoryAvailable: available, uptimeSeconds: uptime(),
    ...(disks ? { disks } : {}), ...(pressure ? { pressure } : {}) };
}

// Per-process CPU and memory, by name only: a command line can hold secrets and
// is never read. Two samples of /proc/<pid>/stat give the CPU used in between.
export const PROCESS_WINDOW_MS = 2_000;
const PROCESS_GROUP_LIMIT = 8;
const FALLBACK_CLOCK_TICK = 100;
const FALLBACK_PAGE_SIZE = 4096;
export interface ProcessSample { pid: number; ticks: number; pages: number; name: string }
/** The name sits in parentheses and may itself hold spaces and parentheses. */
export function parseProcStat(line: string): ProcessSample | undefined {
  const open = line.indexOf("("); const close = line.lastIndexOf(")");
  if (open < 1 || close < open) return undefined;
  const pid = Number(line.slice(0, open));
  // Fields after the name start at the third, the state.
  const rest = line.slice(close + 2).split(" ");
  const ticks = Number(rest[11]) + Number(rest[12]); const pages = Number(rest[21]);
  if (!Number.isSafeInteger(pid) || !Number.isFinite(ticks) || !Number.isFinite(pages)) return undefined;
  return { pid, ticks, pages, name: line.slice(open + 1, close) };
}
const KNOWN_PROCESSES: ReadonlyArray<readonly [RegExp, string]> = [
  // The native Claude Code binary is named after its version.
  [/^\d+\.\d+\.\d+$/, "Claude Code"],
  [/^(chrome|chromium|chromium-browse|chrome_crashpad)/, "Chromium"],
  [/^(dockerd|docker-proxy|containerd|containerd-shim)/, "Docker"],
  [/^polyth/, "Polyth"],
  [/^node$/, "Node"],
  [/^\.?opencode/, "OpenCode"],
  [/^python3?(\.\d+)?$/, "Python"],
];
export function processLabel(name: string): string {
  const clean = name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 40);
  return KNOWN_PROCESSES.find(([pattern]) => pattern.test(clean))?.[1] ?? (clean || "Unknown");
}
export function groupProcesses(before: ProcessSample[], after: ProcessSample[], seconds: number, clockTick = FALLBACK_CLOCK_TICK, pageSize = FALLBACK_PAGE_SIZE): ProcessGroup[] {
  const earlier = new Map(before.map((item) => [item.pid, item.ticks]));
  const groups = new Map<string, ProcessGroup>();
  for (const item of after) {
    // A kernel thread owns no user memory, whatever it is called.
    const name = item.pages === 0 ? "Kernel" : processLabel(item.name);
    const group = groups.get(name) ?? { name, count: 0, cpus: 0, memory: 0 };
    group.count += 1;
    group.cpus += Math.max(0, item.ticks - (earlier.get(item.pid) ?? item.ticks)) / clockTick / seconds;
    group.memory += item.pages * pageSize;
    groups.set(name, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, cpus: Math.round(group.cpus * 100) / 100 }))
    .filter((group) => group.name !== "Kernel" || group.cpus >= 0.05)
    .sort((a, b) => b.cpus - a.cpus || b.memory - a.memory)
    .slice(0, PROCESS_GROUP_LIMIT);
}
async function readProcessTable(): Promise<ProcessSample[]> {
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  const samples: ProcessSample[] = [];
  // A small pool: this runs next to the work it is measuring.
  for (let start = 0; start < pids.length; start += 64) {
    const lines = await Promise.all(pids.slice(start, start + 64).map((pid) => readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")));
    for (const line of lines) { const sample = line ? parseProcStat(line) : undefined; if (sample) samples.push(sample); }
  }
  return samples;
}
let localConstants: Promise<{ clockTick: number; pageSize: number }> | undefined;
const procConstants = () => localConstants ??= (async () => {
  const value = (name: string, fallback: number) => runLocal("getconf", [name], 3_000).then((text) => Number(text.trim()) || fallback, () => fallback);
  return { clockTick: await value("CLK_TCK", FALLBACK_CLOCK_TICK), pageSize: await value("PAGESIZE", FALLBACK_PAGE_SIZE) };
})();
export async function localProcesses(windowMs = PROCESS_WINDOW_MS): Promise<ProcessGroup[]> {
  if (platform() !== "linux") throw failure("unsupported", "Process names require Linux");
  const { clockTick, pageSize } = await procConstants();
  const before = await readProcessTable();
  await new Promise((done) => setTimeout(done, windowMs));
  return groupProcesses(before, await readProcessTable(), windowMs / 1000, clockTick, pageSize);
}
// A fixed probe with no input. `cat` survives a process vanishing mid-read; awk
// keeps pid, CPU ticks, resident pages and the name, in that order.
const REMOTE_PROCESS_TABLE = `cat /proc/[0-9]*/stat 2>/dev/null | awk '{ c=$0; sub(/^[0-9]+ \\(/,"",c); sub(/\\) [A-Za-z] .*$/,"",c); n=split($0,a,") "); split(a[n],b," "); print $1, b[12]+b[13], b[22], c }'`;
export const REMOTE_PROCESSES_COMMAND = `LC_ALL=C; getconf CLK_TCK; getconf PAGESIZE; ${REMOTE_PROCESS_TABLE}; echo '#second'; sleep ${PROCESS_WINDOW_MS / 1000}; ${REMOTE_PROCESS_TABLE}; true`;
export function parseRemoteProcesses(output: string): ProcessGroup[] {
  const lines = output.split(/\r?\n/);
  const split = lines.indexOf("#second");
  const clockTick = Number(lines[0]); const pageSize = Number(lines[1]);
  if (split < 2 || !(clockTick > 0) || !(pageSize > 0)) throw failure("unsupported", "The SSH host did not provide process data");
  const samples = (rows: string[]) => rows.flatMap((row): ProcessSample[] => {
    const match = /^(\d+) (\d+) (\d+) (.*)$/.exec(row);
    return match ? [{ pid: Number(match[1]), ticks: Number(match[2]), pages: Number(match[3]), name: match[4]! }] : [];
  });
  return groupProcesses(samples(lines.slice(2, split)), samples(lines.slice(split + 1)), PROCESS_WINDOW_MS / 1000, clockTick, pageSize);
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
 * Fixed read-only binaries (`journalctl`, `systemctl`, `getconf`) with an argument vector,
 * never a shell. Bounded by time and output; killed on timeout. Raw stderr is
 * never surfaced.
 */
export function runLocal(file: "journalctl" | "systemctl" | "getconf", args: string[], timeoutMs = 10_000): Promise<string> {
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
// Pressure and disks follow as optional sections: a host without them still reports the rest.
export const REMOTE_METRICS_COMMAND = "LC_ALL=C; uname -s; hostname; getconf _NPROCESSORS_ONLN; cat /proc/loadavg; awk '/^MemTotal:|^MemAvailable:/ { print $2 }' /proc/meminfo; cut -d' ' -f1 /proc/uptime; echo '#pressure'; for r in cpu io memory; do printf '%s ' \"$r\"; grep '^some' \"/proc/pressure/$r\" 2>/dev/null || echo; done; echo '#disks'; timeout 3 df -Pkl 2>/dev/null || timeout 3 df -Pk 2>/dev/null; true";
function parseRemotePressure(lines: string[]): HostPressure | undefined {
  const value = (name: string) => parsePressureLine(lines.find((line) => line.startsWith(`${name} `)) ?? "");
  const cpu = value("cpu"); const io = value("io"); const memory = value("memory");
  return cpu === undefined || io === undefined || memory === undefined ? undefined : { cpu, io, memory };
}
function parseRemoteDisks(lines: string[]): DiskUsage[] | undefined {
  const rows = lines.flatMap((line) => {
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(\/.*)$/.exec(line);
    return match ? [{ device: match[1]!, mount: match[5]!.slice(0, 240), size: Number(match[2]) * 1024, used: Number(match[3]) * 1024, available: Number(match[4]) * 1024 }] : [];
  });
  const real = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    const known = real.get(row.device);
    if (isRealDisk(row.device, row.mount) && (!known || row.mount.length < known.mount.length)) real.set(row.device, row);
  }
  const chosen = real.size ? [...real.values()] : rows.filter((row) => row.mount === "/");
  return chosen.length ? fullestFirst(chosen.map(({ device: _device, ...disk }) => disk)) : undefined;
}
export function parseRemoteMetrics(output: string): HostMetrics {
  const all = output.trim().split(/\r?\n/);
  const sections = all.indexOf("#pressure");
  const disksAt = all.indexOf("#disks");
  const lines = all.slice(0, [sections, disksAt].filter((at) => at >= 0).reduce((first, at) => Math.min(first, at), all.length));
  const load = (lines[3] ?? "").split(/\s+/).slice(0, 3).map(Number);
  const numbers = [Number(lines[2]), ...load, Number(lines[4]), Number(lines[5]), Number(lines[6])];
  if (lines.length !== 7 || lines[0] !== "Linux" || numbers.some((n) => !Number.isFinite(n) || n < 0)
    || numbers[0]! < 1 || load.length !== 3 || numbers[4]! <= 0 || numbers[5]! > numbers[4]!) {
    throw failure("unsupported", "The SSH host did not provide valid Linux metrics");
  }
  return { platform: "linux", hostname: lines[1]!.slice(0, 255), cpuCount: Number(lines[2]),
    load: load as [number, number, number], memoryTotal: Number(lines[4]) * 1024,
    memoryAvailable: Number(lines[5]) * 1024, uptimeSeconds: Number(lines[6]),
    ...optionalSections(sections < 0 ? [] : all.slice(sections + 1, disksAt < 0 ? undefined : disksAt), disksAt < 0 ? [] : all.slice(disksAt + 1)) };
}
function optionalSections(pressureLines: string[], diskLines: string[]): Pick<HostMetrics, "disks" | "pressure"> {
  const disks = parseRemoteDisks(diskLines); const pressure = parseRemotePressure(pressureLines);
  return { ...(disks ? { disks } : {}), ...(pressure ? { pressure } : {}) };
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
