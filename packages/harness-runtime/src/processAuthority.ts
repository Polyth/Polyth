import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  throw Object.assign(new Error("Harness process group did not terminate"), { code: "outcome-unknown" });
};

const runTaskkill = (pid: number): Promise<void> => new Promise((resolve, reject) => {
  const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
  const timer = setTimeout(() => {
    killer.kill();
    reject(Object.assign(new Error("Windows harness process-tree shutdown timed out"), { code: "outcome-unknown" }));
  }, 5_000);
  timer.unref?.();
  killer.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  killer.once("exit", (code) => {
    clearTimeout(timer);
    // taskkill returns 128 when the named PID already disappeared. That is fine
    // for ordinary disposal, but it is intentionally not treated as durable
    // release evidence: portable authorities never participate in crash-safe
    // harness switching.
    if (code === 0 || code === 128) resolve();
    else reject(Object.assign(new Error(`taskkill exited with ${code ?? "unknown"}`), { code: "outcome-unknown" }));
  });
});

const createPortableAuthority = (): HarnessProcessAuthority => {
  const authorityId = randomUUID();
  const receipts: Record<string, string> = {};
  let child: ChildProcess | undefined;
  let pid: number | undefined;
  return {
    authorityId,
    generation: 1,
    receipts,
    releasedAuthorities: [],
    durable: false,
    spawn(command, args, options = {}) {
      if (child) throw Object.assign(new Error("Authority already owns a process"), { code: "conflict" });
      const { shell: _shell, detached: _detached, stdio: _stdio, ...spawnOptions } = options;
      child = spawn(command, args, {
        ...spawnOptions,
        shell: false,
        // A dedicated POSIX process group lets explicit disposal terminate the
        // normal descendant tree. Windows uses taskkill /T instead.
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      pid = child.pid;
      return child;
    },
    async receipt(operationId, nativeId) {
      receipts[operationId] = nativeId;
    },
    async close() {
      if (!pid) return;
      if (process.platform === "win32") await runTaskkill(pid);
      else await terminatePosixGroup(pid);
    },
  };
};

/**
 * Linux keeps the existing crash-recoverable supervisor and durable release
 * receipts. macOS/Windows get an owned in-process lifecycle so native harnesses
 * can run, while `durable:false` prevents the switching layer from pretending
 * it can prove cleanup after a Polyth crash.
 */
export async function createHarnessProcessAuthority(
  file?: string,
  stable = false,
): Promise<HarnessProcessAuthority> {
  if (process.platform !== "linux") return createPortableAuthority();
  const authority = await createProcessAuthority(file, stable);
  return Object.assign(authority, { durable: true as const });
}
