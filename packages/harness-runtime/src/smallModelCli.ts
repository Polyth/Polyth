// Shared stateless utility completion over a harness CLI's print/exec mode.
//
// Utility callers (commit messages, auditors, recaps) must not open a backend
// session or run a tool-capable turn: they need one prompt in, one answer out,
// on the same authentication the harness already owns. Each adapter supplies
// only its argv and any output decoding; this module owns the process, the
// stdin prompt, bounded output, timeout, abort and cleanup.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRef, SmallModelCompletionRequest, SmallModelCompletionResult } from "@polyth/contracts";

/** Utility output is short by design; anything larger is a provider failure. */
const MAX_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface SmallModelCliInvocation {
  args: string[];
  /**
   * `message` (default) streams the prompt on stdin. `none` writes nothing;
   * use it only for CLIs that require the prompt in argv and never read stdin.
   */
  stdin?: "message" | "none";
  /** Produce the final text. Defaults to trimmed stdout with code fences removed. */
  parse?(input: { stdout: string; stderr: string; readFile(path: string): string }): string;
}

export interface SmallModelCliInvocationContext {
  /** Per-call directory, removed after parsing, for CLIs that write output to a file. */
  tempDir: string;
  /** The composed system + user prompt. */
  message: string;
}

export interface SmallModelCliOptions {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Build the argv for one request. */
  invocation(
    request: SmallModelCompletionRequest & { model: ModelRef },
    context: SmallModelCliInvocationContext,
  ): SmallModelCliInvocation;
  timeoutMs?: number;
  /** Test seam; defaults to node:child_process spawn. */
  spawnProcess?: typeof spawn;
}

export interface SmallModelCliRunner {
  complete(request: SmallModelCompletionRequest): Promise<SmallModelCompletionResult>;
}

const windowsShim = (command: string): boolean =>
  process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);

const withoutFences = (text: string): string =>
  text.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();

/** Distinct from a provider error: this adapter cannot serve the request and
 * the caller should use the session-backed compatibility path instead. */
const unsupported = (message: string): Error =>
  Object.assign(new Error(message), { code: "unsupported" });

export function createSmallModelCliRunner(options: SmallModelCliOptions): SmallModelCliRunner {
  const spawnProcess = options.spawnProcess ?? spawn;
  return {
    complete(request) {
      const model = request.model;
      if (!model) {
        return Promise.reject(unsupported(`${options.command} utility completion requires an explicit model`));
      }
      const started = performance.now();
      const timeoutMs = request.timeoutMs && request.timeoutMs > 0
        ? request.timeoutMs
        : options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      // Instructions and the untrusted prompt travel on stdin, never argv, so
      // the prompt cannot leak through the process list or break Windows shims.
      const message = request.systemPrompt
        ? `${request.systemPrompt}\n\n${request.prompt}`
        : request.prompt;
      let tempDir: string;
      let invocation: SmallModelCliInvocation;
      try {
        tempDir = mkdtempSync(join(tmpdir(), "polyth-small-model-"));
        invocation = options.invocation({ ...request, model }, { tempDir, message });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      const cleanup = () => {
        try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
      };

      return new Promise<SmallModelCompletionResult>((resolve, reject) => {
        let child: ChildProcess | undefined;
        let settled = false;
        let stdout = "";
        let stderr = "";
        let timer: NodeJS.Timeout | undefined;
        const finish = (error: Error | null, text?: string) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
          cleanup();
          if (error) reject(error);
          else resolve({
            text: text ?? "",
            providerID: model.providerID,
            modelID: model.modelID,
            inputTruncated: false,
            transport: "direct",
            latencyMs: Math.round(performance.now() - started),
          });
        };
        const kill = () => {
          if (!child || child.exitCode !== null || child.signalCode !== null) return;
          try { child.kill("SIGTERM"); } catch { /* already gone */ }
          setTimeout(() => {
            try { child?.kill("SIGKILL"); } catch { /* already gone */ }
          }, 2_000).unref?.();
        };
        const failure = (fallback: string): Error =>
          Object.assign(new Error(stderr.trim() || fallback), { code: "unavailable" });
        // A prompt that cannot fit in argv (Windows or MAX_ARG_STRLEN) is not a
        // provider failure: fall back to the session compatibility path.
        const launchFailure = (error: unknown): Error =>
          (error as { code?: unknown })?.code === "E2BIG"
            ? unsupported(`${options.command} utility prompt exceeds the process argument limit`)
            : error instanceof Error ? error : new Error(String(error));
        const onAbort = () => { kill(); finish(Object.assign(new Error("utility completion was aborted"), { code: "aborted" })); };

        // `cmd.exe` joins the argv unquoted: a path with spaces would split and
        // an empty argument (`--tools ""`) would vanish. An argv prompt
        // (`stdin: "none"`) with shell syntax never reaches `cmd.exe`.
        const shell = windowsShim(options.command);
        const quote = (value: string) => shell && (!value || /\s/.test(value)) ? `"${value}"` : value;
        if (shell && invocation.args.some((arg) => /["%^&|<>!\r\n]/.test(arg))) {
          finish(unsupported(`${options.command} is a Windows command shim; this prompt cannot pass through cmd.exe`));
          return;
        }
        try {
          child = spawnProcess(shell ? `"${options.command}"` : options.command, invocation.args.map(quote), {
            cwd: options.cwd,
            env: options.env ?? process.env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            shell,
          });
        } catch (error) {
          finish(launchFailure(error));
          return;
        }
        if (request.signal?.aborted) { kill(); onAbort(); return; }
        request.signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
          kill();
          finish(Object.assign(
            new Error(`${options.command} utility completion timed out after ${timeoutMs}ms`),
            { code: "unavailable" },
          ));
        }, timeoutMs);
        timer.unref?.();

        child.once("error", (error) => finish(launchFailure(error)));
        child.once("close", (code) => {
          if (code !== 0) {
            finish(failure(`${options.command} exited with code ${code}`));
            return;
          }
          let text: string;
          try {
            text = (invocation.parse ?? ((input: { stdout: string }) => withoutFences(input.stdout)))({
              stdout,
              stderr,
              readFile: (path) => readFileSync(path, "utf8"),
            }).trim();
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          if (!text) {
            finish(Object.assign(new Error(`${options.command} returned an empty utility completion`), { code: "invalid-response" }));
            return;
          }
          finish(null, text);
        });
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (stdout.length > MAX_OUTPUT_BYTES) {
            kill();
            finish(Object.assign(new Error(`${options.command} utility completion exceeded its output bound`), { code: "invalid-response" }));
          }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-MAX_OUTPUT_BYTES);
        });
        child.stdin?.once("error", () => finish(failure(`${options.command} utility process could not receive the prompt`)));
        if (invocation.stdin === "none") child.stdin?.end();
        else child.stdin?.end(message);
      });
    },
  };
}
