import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { dirname, join } from "node:path";
import type { ExecutionReleaseProof, MutationOutcome, RuntimeSessionBinding } from "@polyth/contracts";
import { createProcessAuthority, releaseProcessExecution } from "./authority.ts";
export { createProcessContainmentBoundary, releaseProcessContainmentRecord, type ProcessContainmentBoundary } from "./authority.ts";

export interface HarnessProcessAuthority {
  readonly authorityId: string;
  readonly generation: number;
  readonly receipts: Record<string, string>;
  readonly releasedAuthorities: { authorityId: string; generation: number }[];
  /** True only when Polyth can recover and prove release after its own restart. */
  readonly durable: boolean;
  spawn(command: string, args: string[], options?: SpawnOptions): ChildProcess;
  receipt(operationId: string, nativeId: string): Promise<void>;
  close(): Promise<void>;
}

type PortableProof = { authorityId: string; generation: number };
type PortableState = PortableProof & {
  kind: "portable";
  receipts: Record<string, string>;
  releasedAuthorities: PortableProof[];
  released: boolean;
  /** OS uptime when this authority was created. A lower uptime on a later
   * observation is monotonic proof that the host rebooted and the old process
   * tree cannot still exist. */
  hostUptimeSeconds: number;
  /** The Windows Job Object the executor runs in (polyth-job.exe). Once the
   * job is gone, the kernel has ended every process launched in it, which is
   * the release proof a crash otherwise leaves missing. */
  containment?: WindowsJobContainment | ProcessGroupContainment;
};

type WindowsJobContainment = { kind: "windows-job"; job: string };
/** macOS (any POSIX host without the Linux supervisor): the executor leads its
 * own process group and every process it starts inherits a tag naming this
 * authority, so a later Polyth can find what a crash left behind, end it and
 * see that nothing remains. `pgid` is recorded once the executor has started. */
type ProcessGroupContainment = { kind: "process-group"; pgid?: number };

const AUTHORITY_TAG = "POLYTH_RUNTIME_AUTHORITY";
const authorityTag = (proof: PortableProof): string => `${AUTHORITY_TAG}=${proof.authorityId}.${proof.generation}`;

/** Ends and verifies the Job Object an executor runs in. */
export interface WindowsJobController {
  launch(job: string, line: string): { command: string; args: string[]; env: Record<string, string> };
  /** True only once no process of the job remains: absent, or ended and empty. */
  release(job: string): Promise<boolean>;
}

const JOB_NAME_RE = /^Local\\polyth-runtime-[0-9a-f]{24}-[1-9][0-9]{0,15}$/;
const windowsJobName = (proof: PortableProof): string =>
  `Local\\polyth-runtime-${createHash("sha256").update(proof.authorityId).digest("hex").slice(0, 24)}-${proof.generation}`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const windowsCommandShim = (command: string): boolean =>
  process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);

const outcomeUnknown = (message: string) => Object.assign(new Error(message), { code: "outcome-unknown" });

const persistPortableState = (file: string | undefined, state: PortableState): void => {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  renameSync(temp, file);
};

const readPortableState = (file: string | undefined): PortableState | undefined => {
  if (!file) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<PortableState>;
    if (value.kind !== "portable") return undefined;
    if (
      typeof value.authorityId !== "string"
      || !Number.isSafeInteger(value.generation)
      || (value.generation ?? 0) <= 0
      || !value.receipts
      || typeof value.receipts !== "object"
      || Array.isArray(value.receipts)
      || !Array.isArray(value.releasedAuthorities)
      || !value.releasedAuthorities.every((proof) => proof
        && typeof proof.authorityId === "string"
        && Number.isSafeInteger(proof.generation)
        && proof.generation > 0)
      || typeof value.released !== "boolean"
      || typeof value.hostUptimeSeconds !== "number"
      || !Number.isFinite(value.hostUptimeSeconds)
      || value.hostUptimeSeconds < 0
      // A job is only ever this authority's own: never probe or end another.
      || (value.containment !== undefined && !(
        (value.containment?.kind === "windows-job"
          && value.containment.job === windowsJobName(value as PortableProof))
        || (value.containment?.kind === "process-group"
          && (value.containment.pgid === undefined
            || (Number.isSafeInteger(value.containment.pgid) && value.containment.pgid > 1)))
      ))
    ) {
      throw outcomeUnknown("Portable harness authority state is malformed");
    }
    return value as PortableState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const posixGroupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const terminatePosixGroup = async (pid: number): Promise<void> => {
  if (!posixGroupAlive(pid)) return;
  try { process.kill(-pid, "SIGTERM"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const gentleDeadline = Date.now() + 1_500;
  while (Date.now() < gentleDeadline) {
    if (!posixGroupAlive(pid)) return;
    await sleep(25);
  }
  try { process.kill(-pid, "SIGKILL"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const hardDeadline = Date.now() + 3_500;
  while (Date.now() < hardDeadline) {
    if (!posixGroupAlive(pid)) return;
    await sleep(25);
  }
  throw outcomeUnknown("Harness process group did not terminate");
};

const runTaskkill = (pid: number): Promise<void> => new Promise((resolve, reject) => {
  const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
  const timer = setTimeout(() => {
    killer.kill();
    reject(outcomeUnknown("Windows harness process-tree shutdown timed out"));
  }, 5_000);
  timer.unref?.();
  killer.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  killer.once("exit", (code) => {
    clearTimeout(timer);
    // taskkill returns 128 when the named PID already disappeared. This is
    // enough for an explicit clean disposal in this process, but never becomes
    // crash-recoverable release proof (`durable` remains false).
    if (code === 0 || code === 128) resolve();
    else reject(outcomeUnknown(`taskkill exited with ${code ?? "unknown"}`));
  });
});

type ProcessRow = { pid: number; pgid: number; words: string[] };

const psExecutable = (): string | undefined => ["/bin/ps", "/usr/bin/ps"].find((candidate) => existsSync(candidate));

/** Every process with its group and its environment (`ps e`), or undefined
 * when the table could not be read. */
const listProcesses = (): Promise<ProcessRow[] | undefined> => new Promise((resolve) => {
  const ps = psExecutable();
  if (!ps) return resolve(undefined);
  // BSD `-E` and procps `e` both append the environment to the command.
  const flags = process.platform === "darwin" ? ["-axEww"] : ["axeww"];
  const child = spawn(ps, [...flags, "-o", "pid=,pgid=,command="], { stdio: ["ignore", "pipe", "ignore"], shell: false });
  const chunks: Buffer[] = [];
  const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(undefined); }, 10_000);
  timer.unref?.();
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.once("error", () => { clearTimeout(timer); resolve(undefined); });
  child.once("close", (code) => {
    clearTimeout(timer);
    if (code !== 0) return resolve(undefined);
    const rows: ProcessRow[] = [];
    for (const line of Buffer.concat(chunks).toString("utf8").split("\n")) {
      const [pid, pgid, ...words] = line.trim().split(/\s+/);
      if (/^\d+$/.test(pid ?? "") && /^\d+$/.test(pgid ?? "")) rows.push({ pid: Number(pid), pgid: Number(pgid), words });
    }
    resolve(rows);
  });
});

/** The process table, returned only when it demonstrably shows a child's
 * environment: a probe child carries a one-off tag and must be listed with it.
 * A host whose `ps` hides environments would otherwise report "nothing left"
 * for an executor that is still running. */
const listProcessesWithEnvironment = async (): Promise<ProcessRow[] | undefined> => {
  const tag = `${AUTHORITY_TAG}_PROBE=${randomUUID()}`;
  const [name, value] = tag.split("=") as [string, string];
  let probe: ChildProcess;
  try {
    probe = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], nodeModeSpawnOptions(process.execPath, {
      env: { ...process.env, [name]: value },
      stdio: "ignore",
      shell: false,
    }));
  } catch {
    return undefined;
  }
  probe.once("error", () => {});
  try {
    // The tag appears once the probe has replaced its image, moments after spawn.
    for (let attempt = 0; attempt < 20 && probe.pid; attempt += 1) {
      const rows = await listProcesses();
      if (!rows) return undefined;
      if (rows.some((row) => row.pid === probe.pid && row.words.includes(tag))) {
        return rows.filter((row) => row.pid !== probe.pid);
      }
      await sleep(100);
    }
    return undefined;
  } finally {
    probe.kill("SIGKILL");
  }
};

const signalProcess = (target: number, signal: NodeJS.Signals): void => {
  try { process.kill(target, signal); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};

/** Ends what a crashed authority left running and returns true only once the
 * process table shows none of it. A process is this authority's when it
 * carries the authority's tag; its recorded group is ended as a whole only
 * while a tagged process is still in it, because a group id that outlived the
 * executor may by now belong to something unrelated. */
const releaseProcessGroupExecution = async (prior: PortableState): Promise<boolean> => {
  const tag = authorityTag(prior);
  const pgid = prior.containment?.kind === "process-group" ? prior.containment.pgid : undefined;
  const owned = (rows: ProcessRow[]) => rows.filter((row) => row.words.includes(tag));
  let rows = await listProcessesWithEnvironment();
  if (!rows) return false;
  if (!owned(rows).length) return true;
  const ownsGroup = pgid !== undefined && owned(rows).some((row) => row.pgid === pgid);
  for (const [signal, waitMs] of [["SIGTERM", 1_500], ["SIGKILL", 3_500]] as const) {
    if (ownsGroup) signalProcess(-pgid, signal);
    for (const row of owned(rows)) if (!ownsGroup || row.pgid !== pgid) signalProcess(row.pid, signal);
    const deadline = Date.now() + waitMs;
    do {
      await sleep(50);
      rows = await listProcesses();
      if (!rows) return false;
      if (!owned(rows).length && !(ownsGroup && posixGroupAlive(pgid))) return true;
    } while (Date.now() < deadline);
  }
  return false;
};

/** Quote one argument the way libuv (Node's `spawn`) and the MSVC runtime
 * agree on, so the command line polyth-job.exe starts parses back exactly. */
export const quoteWindowsArgument = (argument: string): string => {
  if (argument === "") return '""';
  if (!/[ \t"]/.test(argument)) return argument;
  if (!/["\\]/.test(argument)) return `"${argument}"`;
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    quoted += "\\".repeat(character === '"' ? backslashes * 2 + 1 : backslashes) + character;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
};

/** A `.cmd`/`.bat` shim (npm installs every CLI as one) starts only through
 * cmd.exe, and Node joins a `shell` command line unquoted, so a path with a
 * space (a project folder, the user's profile, Program Files) split into
 * several arguments. Quote each word for the program the shim runs; cmd.exe
 * keeps quoted words whole and the shim's `%*` hands them on unchanged. */
export const windowsShimInvocation = (command: string, args: readonly string[]): { command: string; args: string[] } =>
  ({ command: quoteWindowsArgument(command), args: args.map(quoteWindowsArgument) });

/** The command line Node itself would run for `spawn(command, args, { shell })`. */
const windowsCommandLine = (command: string, args: readonly string[], shell: SpawnOptions["shell"]): string => {
  if (!windowsCommandShim(command) && !shell) return [command, ...args].map(quoteWindowsArgument).join(" ");
  // Node joins a shell command unquoted and hands it to cmd.exe /d /s /c.
  const interpreter = typeof shell === "string" ? shell : process.env.ComSpec ?? "cmd.exe";
  const words = shell ? [command, ...args] : [command, ...args].map(quoteWindowsArgument);
  return `${quoteWindowsArgument(interpreter)} /d /s /c "${words.join(" ")}"`;
};

/** The packaged helper, else the one `npm run build:supervisor` built. Both are
 * checked because a packaged app's POLYTH_RESOURCES_DIR is inherited by every
 * process it starts, source checkouts run from its terminals included. */
const jobHelperExecutable = (): string | undefined => {
  const resources = process.env.POLYTH_RESOURCES_DIR;
  return [
    ...(resources ? [join(resources, "runtime-supervisor", "win32", "polyth-job.exe")] : []),
    join(import.meta.dirname, "..", "native", "bin", "win32", "polyth-job.exe"),
  ].find((candidate) => existsSync(candidate));
};

const runJobHelper = (helper: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(helper, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, shell: false });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(outcomeUnknown("polyth-job.exe did not answer"));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => { if (stdout.length < 1_024) stdout += String(chunk); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    // `close`, not `exit`: the output can still be in the pipe when the process
    // has exited, and a read without it would call an ended job unverified.
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.trim() }); });
  });

let detectedJobs: Promise<WindowsJobController | undefined> | undefined;
/** Job Object containment, when polyth-job.exe is present and the host lets it
 * enter a job (a self test, run once per process). Never synchronous: the server
 * shares its thread with the desktop window, and a first launch of an unsigned
 * helper can sit in the virus scanner for seconds. */
export const windowsJobContainment = (): Promise<WindowsJobController | undefined> => {
  if (process.platform !== "win32") return Promise.resolve(undefined);
  detectedJobs ??= (async () => {
    const helper = jobHelperExecutable();
    if (!helper) return undefined;
    const selftest = await runJobHelper(helper, ["selftest"], 10_000).catch(() => undefined);
    if (selftest?.code !== 0 || selftest.stdout !== "ok") return undefined;
    return {
      launch: (job, line) => ({ command: helper, args: ["run", job], env: { POLYTH_JOB_COMMAND_LINE: line } }),
      async release(job) {
        if (!JOB_NAME_RE.test(job)) return false;
        const ended = await runJobHelper(helper, ["terminate", job], 15_000).catch(() => undefined);
        return ended?.code === 0 && (ended.stdout === "absent" || ended.stdout === "empty");
      },
    };
  })();
  return detectedJobs;
};

/** The executor of a prior authority is provably gone: a reboot since, its job
 * is gone, or nothing tagged as its own is left (ending either first if it
 * somehow still runs). */
const priorExecutionReleased = async (
  prior: PortableState,
  observedUptime: number,
  jobs: WindowsJobController | null,
): Promise<boolean> => {
  if (prior.released) return true;
  // Uptime is monotonic within one boot. It can only be lower than the value
  // persisted by an earlier process after a host reboot, which proves that the
  // previous local executor and all of its descendants are gone.
  if (observedUptime < prior.hostUptimeSeconds) return true;
  if (prior.containment?.kind === "windows-job") return Boolean(jobs && await jobs.release(prior.containment.job));
  if (prior.containment?.kind === "process-group") {
    return process.platform !== "win32" && await releaseProcessGroupExecution(prior);
  }
  return false;
};

const unreleasedMessage = (prior: PortableState): string => {
  if (prior.containment?.kind === "windows-job") {
    return "The previous harness execution's Windows job could not be verified as ended. Polyth will not start a duplicate executor until it is.";
  }
  if (prior.containment?.kind === "process-group") {
    return "The previous harness run could not be confirmed as stopped, so Polyth will not start a second one beside it. Quit the leftover harness processes or restart the computer.";
  }
  return "Previous macOS/Windows harness execution has no crash-safe release proof. Polyth will not start a duplicate executor until the prior execution is explicitly released or the host is rebooted.";
};

/** Test seam: the macOS/Windows authority with an explicit job controller. */
export async function createPortableHarnessAuthority(
  file?: string,
  stable = false,
  jobController?: WindowsJobController | null,
): Promise<HarnessProcessAuthority> {
  const jobs = jobController === undefined ? await windowsJobContainment() ?? null : jobController;
  const observedUptime = uptime();
  const prior = readPortableState(file);
  if (prior && !await priorExecutionReleased(prior, observedUptime, jobs)) {
    throw outcomeUnknown(unreleasedMessage(prior));
  }

  const releasedAuthorities = [
    ...(prior?.releasedAuthorities ?? []),
    ...(prior ? [{ authorityId: prior.authorityId, generation: prior.generation }] : []),
  ];
  const state: PortableState = {
    kind: "portable",
    authorityId: stable && prior ? prior.authorityId : randomUUID(),
    generation: (prior?.generation ?? 0) + 1,
    receipts: { ...(prior?.receipts ?? {}) },
    releasedAuthorities,
    released: false,
    hostUptimeSeconds: observedUptime,
  };
  const containment: WindowsJobContainment | undefined = jobs ? { kind: "windows-job", job: windowsJobName(state) } : undefined;
  const group: ProcessGroupContainment | undefined = !containment && process.platform !== "win32"
    ? { kind: "process-group" }
    : undefined;
  state.containment = containment ?? group;
  if (!state.containment) delete state.containment;
  persistPortableState(file, state);

  let child: ChildProcess | undefined;
  let pid: number | undefined;
  return {
    authorityId: state.authorityId,
    generation: state.generation,
    receipts: state.receipts,
    releasedAuthorities: state.releasedAuthorities,
    // A process group ends a crashed run, but a member can leave it: it is not
    // the sealed boundary cross-harness switching relies on.
    durable: containment !== undefined,
    spawn(command, args, options = {}) {
      if (child) throw Object.assign(new Error("Authority already owns a process"), { code: "conflict" });
      const { detached: _detached, stdio: _stdio, ...spawnOptions } = options;
      try {
        if (containment && jobs) {
          // polyth-job.exe enters the job first and starts the command in it,
          // with the same standard pipes, so every descendant is contained.
          const launch = jobs.launch(containment.job, windowsCommandLine(command, args, options.shell));
          child = spawn(launch.command, launch.args, {
            ...spawnOptions,
            env: { ...(options.env ?? process.env), ...launch.env },
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });
        } else {
          // Windows npm shims are .cmd/.bat files and require cmd.exe. The
          // executable itself was already resolved by Polyth; prompts and
          // project text never become part of this command line.
          const shim = windowsCommandShim(command) && !options.shell;
          const invocation = shim ? windowsShimInvocation(command, args) : { command, args };
          child = spawn(invocation.command, invocation.args, {
            ...spawnOptions,
            // The tag every descendant inherits: what a later Polyth looks for
            // after a crash. It names the authority and is not a secret.
            ...(group ? { env: { ...(options.env ?? process.env), [AUTHORITY_TAG]: `${state.authorityId}.${state.generation}` } } : {}),
            shell: shim || options.shell || false,
            // A dedicated POSIX process group lets explicit disposal terminate
            // the normal descendant tree. Windows uses taskkill /T instead.
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });
        }
        pid = child.pid;
        if (group && pid) {
          group.pgid = pid;
          persistPortableState(file, state);
        }
        return child;
      } catch (error) {
        state.released = true;
        persistPortableState(file, state);
        throw error;
      }
    },
    async receipt(operationId, nativeId) {
      state.receipts[operationId] = nativeId;
      persistPortableState(file, state);
    },
    async close() {
      if (state.released) return;
      if (pid) {
        if (containment && jobs) {
          if (!await jobs.release(containment.job)) throw outcomeUnknown("Windows harness job did not end");
        } else if (process.platform === "win32") await runTaskkill(pid);
        else await terminatePosixGroup(pid);
      }
      state.released = true;
      persistPortableState(file, state);
    },
  };
}

/**
 * Linux keeps the existing crash-recoverable supervisor and durable release
 * receipts. Windows runs the executor inside a Job Object (polyth-job.exe), so
 * a job that is gone after a crash proves its whole tree is gone and the next
 * generation starts without waiting for a reboot. macOS has neither: the
 * executor leads a process group and its descendants carry the authority's
 * tag, so after a crash the next generation ends what is left and starts once
 * the process table shows none of it. That is recovery evidence, not a sealed
 * boundary, so `durable:false` keeps cross-harness switching blocked there.
 * Windows without the helper keeps the fail-closed fence until a reboot.
 */
/** The Desktop app hosts the Polyth server in Electron's main process, so
 * `process.execPath` there is the app binary, which runs a script as Node only
 * with ELECTRON_RUN_AS_NODE. Without it a worker launched as
 * `process.execPath <worker.mjs>` starts a second app instance that the
 * single-instance lock closes at once, and the runtime never initializes (a new
 * chat then ends as "not confirmed"). Descendants inherit the flag, which is
 * what a worker's own `process.execPath` children (hooks, bootstraps) need. */
export const nodeModeSpawnOptions = (
  command: string,
  options: SpawnOptions,
  runtime: { electron?: string; execPath: string } = { electron: process.versions.electron, execPath: process.execPath },
): SpawnOptions => {
  if (!runtime.electron || command !== runtime.execPath) return options;
  return { ...options, env: { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: "1" } };
};

const withNodeMode = <T extends HarnessProcessAuthority>(authority: T): T => {
  const spawnProcess = authority.spawn.bind(authority);
  authority.spawn = (command, args, options = {}) => spawnProcess(command, args, nodeModeSpawnOptions(command, options));
  return authority;
};

export async function createHarnessProcessAuthority(
  file?: string,
  stable = false,
): Promise<HarnessProcessAuthority> {
  if (process.platform !== "linux") return withNodeMode(await createPortableHarnessAuthority(file, stable));
  const authority = await createProcessAuthority(file, stable);
  return withNodeMode(Object.assign(authority, { durable: true as const }));
}

/** Fence the exact authority a binding names, without constructing a runtime.
 * Linux proves release through its supervisor receipts; Windows through the
 * authority's Job Object. Anything else cannot prove it and is rejected. */
export async function releaseHarnessProcessExecution(
  file: string,
  binding: RuntimeSessionBinding,
  operationId: string,
  jobController?: WindowsJobController | null,
): Promise<MutationOutcome<ExecutionReleaseProof>> {
  if (process.platform === "linux") return releaseProcessExecution(file, binding, operationId);
  const jobs = jobController === undefined ? await windowsJobContainment() ?? null : jobController;
  const backendSessionId = binding.backendSessionId;
  if (!backendSessionId) {
    return { kind: "rejected", code: "binding-mismatch", message: "backend execution identity is missing" };
  }
  let state: PortableState | undefined;
  try {
    state = readPortableState(file);
  } catch {
    return { kind: "rejected", code: "invalid-state", message: "durable process authority is malformed" };
  }
  if (!state) return { kind: "rejected", code: "not-found", message: "durable process authority is unavailable" };
  const exactCurrent = state.authorityId === binding.authorityId && state.generation === binding.generation;
  const alreadyReleased = state.releasedAuthorities.some((proof) =>
    proof.authorityId === binding.authorityId && proof.generation === binding.generation);
  if (!exactCurrent && !alreadyReleased) {
    return { kind: "rejected", code: "stale-evidence", message: "durable process authority does not match" };
  }
  if (!state.released) {
    if (state.containment?.kind !== "windows-job" && uptime() >= state.hostUptimeSeconds) {
      return {
        kind: "rejected",
        code: "unsupported",
        message: process.platform === "win32"
          ? "Crash-safe cross-harness switching needs the Windows job boundary (polyth-job.exe), which this runtime was started without; it can still be used normally"
          : "Crash-safe cross-harness switching requires Linux or Windows; this runtime can still be used normally",
      };
    }
    // As on Linux, a successor that already reattached is fenced as well.
    if (!await priorExecutionReleased(state, uptime(), jobs)) {
      return { kind: "unknown", operationId, message: "the harness execution's Windows job could not be verified as ended" };
    }
    state.released = true;
    persistPortableState(file, state);
  }
  return {
    kind: "confirmed",
    value: { authorityId: binding.authorityId, generation: binding.generation, backendSessionId },
  };
}
