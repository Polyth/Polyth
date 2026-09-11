import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { dirname } from "node:path";
import { createProcessAuthority } from "./authority.ts";

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
};

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

const createPortableAuthority = (
  file?: string,
  stable = false,
): HarnessProcessAuthority => {
  const observedUptime = uptime();
  const prior = readPortableState(file);
  let priorReleased = prior?.released === true;

  // Uptime is monotonic within one boot. It can only be lower than the value
  // persisted by an earlier process after a host reboot, which proves that the
  // previous local executor and all of its descendants are gone.
  if (prior && !priorReleased && observedUptime < prior.hostUptimeSeconds) {
    priorReleased = true;
  }
  if (prior && !priorReleased) {
    throw outcomeUnknown(
      "Previous macOS/Windows harness execution has no crash-safe release proof. Polyth will not start a duplicate executor until the prior execution is explicitly released or the host is rebooted.",
    );
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
  persistPortableState(file, state);

  let child: ChildProcess | undefined;
  let pid: number | undefined;
  return {
    authorityId: state.authorityId,
    generation: state.generation,
    receipts: state.receipts,
    releasedAuthorities: state.releasedAuthorities,
    durable: false,
    spawn(command, args, options = {}) {
      if (child) throw Object.assign(new Error("Authority already owns a process"), { code: "conflict" });
      const { detached: _detached, stdio: _stdio, ...spawnOptions } = options;
      try {
        child = spawn(command, args, {
          ...spawnOptions,
          // Windows npm shims are .cmd/.bat files and require cmd.exe. The
          // executable itself was already resolved by Polyth; prompts and
          // project text never become part of this command line.
          shell: windowsCommandShim(command) || options.shell || false,
          // A dedicated POSIX process group lets explicit disposal terminate
          // the normal descendant tree. Windows uses taskkill /T instead.
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        pid = child.pid;
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
        if (process.platform === "win32") await runTaskkill(pid);
        else await terminatePosixGroup(pid);
      }
      state.released = true;
      persistPortableState(file, state);
    },
  };
};

/**
 * Linux keeps the existing crash-recoverable supervisor and durable release
 * receipts. macOS/Windows get an owned process lifecycle with durable mutation
 * receipts and a fail-closed crash fence. Clean disposal can start another
 * generation; an unclean crash cannot silently duplicate execution. Because
 * there is still no kernel-backed post-crash descendant proof, `durable:false`
 * keeps cross-harness switching blocked outside Linux.
 */
export async function createHarnessProcessAuthority(
  file?: string,
  stable = false,
): Promise<HarnessProcessAuthority> {
  if (process.platform !== "linux") return createPortableAuthority(file, stable);
  const authority = await createProcessAuthority(file, stable);
  return Object.assign(authority, { durable: true as const });
}
