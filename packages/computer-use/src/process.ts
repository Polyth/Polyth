import { spawn } from "node:child_process";
import { ComputerUseError } from "./errors.ts";

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Largest stdout kept; a screenshot from `xwd` of a 4K root is ~33 MB. */
  maxStdoutBytes?: number;
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

/** Runs one helper program the driver owns from start to exit. The child is
 * killed on abort or timeout and its output is bounded, so a hung helper can
 * neither block the tool nor fill memory. No shell is involved. */
export type CommandRunner = (command: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>;

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_STDOUT = 4 * 1024 * 1024;
const MAX_STDERR = 16 * 1024;

export const runCommand: CommandRunner = (command, args, options = {}) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) {
    reject(new ComputerUseError("aborted", "The action was cancelled"));
    return;
  }
  const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  const child = spawn(command, [...args], {
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const chunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderr = "";
  let settled = false;
  const finish = (error: Error | undefined, result?: RunResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (error) reject(error);
    else resolve(result!);
  };
  const stop = (error: Error) => {
    child.kill("SIGKILL");
    finish(error);
  };
  const onAbort = () => stop(new ComputerUseError("aborted", "The action was cancelled"));
  const timer = setTimeout(
    () => stop(new ComputerUseError("timeout", `${command} did not finish in time`)),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  options.signal?.addEventListener("abort", onAbort, { once: true });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxStdout) {
      stop(new ComputerUseError("driver-failed", `${command} returned more output than expected`));
      return;
    }
    chunks.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < MAX_STDERR) stderr += chunk.toString("utf8").slice(0, MAX_STDERR - stderr.length);
  });
  child.on("error", (error: NodeJS.ErrnoException) => {
    finish(error.code === "ENOENT"
      ? new ComputerUseError("missing-helper", `${command} is not installed`)
      : new ComputerUseError("driver-failed", `${command} could not start: ${error.message}`));
  });
  child.on("close", (code, signal) => {
    if (code === 0) {
      finish(undefined, { stdout: Buffer.concat(chunks), stderr });
      return;
    }
    const detail = stderr.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 400);
    finish(new ComputerUseError(
      "driver-failed",
      `${command} failed (${signal ?? `exit ${code}`})${detail ? `: ${detail}` : ""}`,
    ));
  });
  child.stdin.on("error", () => { /* the child may exit before reading its input */ });
  child.stdin.end(options.input ?? "");
});
