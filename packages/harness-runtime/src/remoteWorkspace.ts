// Shell and file tools of a project that lives on an SSH host, for a harness
// that runs on THIS machine ("harness here, tools on the host"). The host
// needs no harness, no Node and no sign-in: every call is one bounded POSIX
// command over the connection's multiplexed master, with raw pipes.
//
// This module is the transport only. Whether a call may run is decided before
// it gets here (`@polyth/permissions/workspace-policy` and the session's
// permission flow); nothing in this file asks or remembers.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { posix } from "node:path";
import type { RemoteProcessHost } from "./remoteHost.ts";

export const REMOTE_WORKSPACE_TOOLS = ["bash", "read", "write", "edit", "grep", "glob"] as const;
export type RemoteWorkspaceToolName = (typeof REMOTE_WORKSPACE_TOOLS)[number];

export interface RemoteWorkspaceToolResult {
  text: string;
  isError?: boolean;
}

export interface RemoteWorkspaceExecResult {
  /** Remote exit status; 255 is the ssh client's own failure. */
  code: number;
  stdout: Buffer;
  stderr: string;
  /** Output passed `maxBytes` and was cut there. */
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
}

export interface RemoteWorkspaceExecOptions {
  /** Positional parameters of the script (`$1`…); never interpolated. */
  args?: readonly string[];
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Stop the script and everything it started when the local side goes
   *  away (cancel, timeout, closed session). Takes no `stdin`. */
  guard?: boolean;
}

export interface RemoteWorkspace {
  /** Absolute project path on the host. */
  readonly root: string;
  /** The host, for messages. */
  readonly label: string;
  /** Run a POSIX `sh` script in the project root. Never throws. */
  exec(script: string, options?: RemoteWorkspaceExecOptions): Promise<RemoteWorkspaceExecResult>;
  /** Absolute, normalized form of a tool path; relative ones start at the root. */
  resolvePath(path?: string): string;
  call(tool: RemoteWorkspaceToolName, input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<RemoteWorkspaceToolResult>;
  /** Stops every command still running through this workspace. */
  close(): void;
}

const MAX_OUTPUT_CHARS = 30_000;
const MAX_READ_LINES = 2_000;
const MAX_LINE_CHARS = 2_000;
const MAX_EDIT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const BASH_DEFAULT_MS = 120_000;
const BASH_MAX_MS = 600_000;
/** ssh reports its own failures (no route, auth, dead master) with this status. */
const SSH_FAILURE = 255;

const ok = (text: string): RemoteWorkspaceToolResult => ({ text });
const fail = (text: string): RemoteWorkspaceToolResult => ({ text, isError: true });

const clip = (text: string): string => text.length > MAX_OUTPUT_CHARS
  ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [output truncated, ${text.length - MAX_OUTPUT_CHARS} more characters]`
  : text;

const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Absolute, normalized POSIX path; `..` cannot rise above `/`. */
export function resolveRemoteWorkspacePath(root: string, path?: string): string {
  const value = (path ?? "").trim();
  return posix.normalize(value.startsWith("/") ? value : posix.join(root, value || "."));
}

/**
 * One exact replacement, as the harness's own edit tool does it. A model sees
 * and writes `\n`; a CRLF file keeps its own line endings.
 */
export function applyRemoteWorkspaceEdit(
  current: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { ok: true; next: string; replacements: number } | { ok: false; reason: "identical" | "not-found" | "ambiguous"; matches: number } {
  if (oldString === newString) return { ok: false, reason: "identical", matches: 0 };
  let needle = oldString;
  let replacement = newString;
  if (!current.includes(needle) && current.includes("\r\n")) {
    const crlf = needle.replace(/\r?\n/g, "\r\n");
    if (current.includes(crlf)) {
      needle = crlf;
      replacement = newString.replace(/\r?\n/g, "\r\n");
    }
  }
  const matches = needle ? current.split(needle).length - 1 : 0;
  if (matches === 0) return { ok: false, reason: "not-found", matches };
  if (matches > 1 && !replaceAll) return { ok: false, reason: "ambiguous", matches };
  return {
    ok: true,
    next: replaceAll ? current.split(needle).join(replacement) : current.replace(needle, () => replacement),
    replacements: replaceAll ? matches : 1,
  };
}

// The scripts take every value as a positional parameter, so no path, pattern
// or command is ever spliced into shell text.
const READ_SCRIPT = [
  'if [ -d "$1" ]; then exit 4; fi',
  '[ -f "$1" ] || exit 3',
  'printf "%s\\n" "$(wc -l < "$1")"',
  'tail -n "+$2" -- "$1" | head -n "$3"',
].join("; ");
const CAT_SCRIPT = 'if [ -d "$1" ]; then exit 4; fi; [ -f "$1" ] || exit 3; exec cat -- "$1"';
// `$2` is the SHA-256 the edit was computed from: a compare-and-swap, so a file
// that changed on the host in between is never overwritten.
const WRITE_SCRIPT = [
  'if [ -n "$2" ]; then [ "$(sha256sum < "$1" | cut -d" " -f1)" = "$2" ] || exit 9; fi',
  'd=$(dirname -- "$1")',
  'mkdir -p -- "$d" || exit 1',
  't=$(mktemp "$d/.polyth-edit-XXXXXX") || exit 1',
  'cat > "$t" || { rm -f -- "$t"; exit 1; }',
  'if [ -e "$1" ]; then chmod --reference="$1" "$t" 2>/dev/null || true; else chmod 644 "$t"; fi',
  'mv -f -- "$t" "$1" || { rm -f -- "$t"; exit 1; }',
].join("; ");
// The command runs in a shell of its own; `timeout` is used where the host has
// it, and the local deadline covers a host without it.
const BASH_SCRIPT = [
  'if command -v bash >/dev/null 2>&1; then S=bash; else S=sh; fi',
  'if command -v timeout >/dev/null 2>&1; then exec timeout -k 2 "$1" "$S" -c "$2" </dev/null 2>&1; fi',
  'exec "$S" -c "$2" </dev/null 2>&1',
].join("; ");
// `$1` mode flag, `$2` case flag or "", `$3` glob or "", `$4` limit, `$5` pattern, `$6` target.
const GREP_SCRIPT = [
  'm=$1; c=$2; g=$3; n=$4; p=$5; t=$6',
  'if command -v rg >/dev/null 2>&1; then',
  '  set -- rg --no-heading --color=never "$m"',
  '  if [ -n "$c" ]; then set -- "$@" "$c"; fi',
  '  if [ -n "$g" ]; then set -- "$@" -g "$g"; fi',
  '  "$@" -e "$p" -- "$t" 2>&1 | head -n "$n"',
  'else',
  '  set -- grep -rIE --color=never --exclude-dir=.git "$m"',
  '  if [ -n "$c" ]; then set -- "$@" "$c"; fi',
  '  if [ -n "$g" ]; then set -- "$@" --include="${g##*/}"; fi',
  // `grep -c` lists every file, matching or not.
  '  if [ "$m" = "-c" ]; then "$@" -e "$p" -- "$t" 2>&1 | grep -v ":0$" | head -n "$n"',
  '  else "$@" -e "$p" -- "$t" 2>&1 | head -n "$n"; fi',
  'fi',
].join("\n");
// Killing the local ssh client does not stop what it started: without a TTY the
// far side keeps running. The guard keeps the script's stdin open as a lifeline
// and runs the work in a session of its own; when the lifeline closes, it ends
// that whole process group. `$1` is the script, the rest its parameters.
const GUARD_SCRIPT = [
  's=$1; shift',
  'exec 3<&0',
  'if command -v setsid >/dev/null 2>&1; then g=1; setsid sh -c "$s" sh "$@" </dev/null & else g=; sh -c "$s" sh "$@" </dev/null & fi',
  'c=$!',
  '( cat <&3 >/dev/null 2>&1',
  // No `--`: dash's kill rejects it, and a signal name already ends the options.
  '  if [ -n "$g" ]; then kill -TERM "-$c" 2>/dev/null; sleep 2; kill -KILL "-$c" 2>/dev/null',
  '  else kill -TERM "$c" 2>/dev/null; fi ) >/dev/null 2>&1 &',
  'w=$!',
  'exec 3<&-',
  'wait "$c"; code=$?',
  'kill "$w" 2>/dev/null',
  'exit "$code"',
].join("\n");
const GLOB_SCRIPT = [
  'cd -- "$1" 2>/dev/null || exit 3',
  'command -v bash >/dev/null 2>&1 || exit 5',
  'exec bash -O globstar -O nullglob -O dotglob -c \'IFS=; for f in $1; do case "$f" in .git/*|*/.git/*) continue;; esac; [ -f "$f" ] && printf "%s\\n" "$f"; done\' _ "$2" | head -n 500',
].join("; ");

export function createRemoteWorkspace(remote: RemoteProcessHost, root: string): RemoteWorkspace {
  /** Running local clients and how to stop each one now. */
  const active = new Map<ChildProcess, () => void>();
  let closed = false;

  const exec: RemoteWorkspace["exec"] = (script, options = {}) => new Promise((resolve) => {
    const none = (stderr: string, aborted = false): RemoteWorkspaceExecResult =>
      ({ code: SSH_FAILURE, stdout: Buffer.alloc(0), stderr, truncated: false, timedOut: false, aborted });
    if (closed) return resolve(none("the session is closed", true));
    if (options.signal?.aborted) return resolve(none("cancelled", true));
    const argv = options.guard
      ? ["sh", "-c", GUARD_SCRIPT, "sh", script, ...(options.args ?? [])]
      : ["sh", "-c", script, "sh", ...(options.args ?? [])];
    const { command, args } = remote.processCommand(argv, { cwd: root });
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd: homedir(), stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      return resolve(none(error instanceof Error ? error.message : String(error)));
    }
    const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      active.delete(child);
      resolve({ code, stdout: Buffer.concat(chunks), stderr, truncated, timedOut, aborted });
    };
    // The local client is gone at once; a guarded script on the host follows
    // when its lifeline closes. Neither is waited for.
    const stop = () => {
      child.stdin!.destroy();
      child.kill("SIGKILL");
      settle(137);
    };
    const onAbort = () => { aborted = true; stop(); };
    active.set(child, onAbort);
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => {
      if (size >= maxBytes) { truncated = true; return; }
      const room = maxBytes - size;
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      if (chunk.length > room) truncated = true;
      size += Math.min(chunk.length, room);
    });
    child.stderr!.on("data", (chunk: Buffer) => { if (stderr.length < 8_192) stderr += chunk.toString(); });
    child.on("error", (error) => { stderr ||= error.message; settle(SSH_FAILURE); });
    child.on("close", (code, signal) => settle(code ?? (signal ? 137 : 1)));
    child.stdin!.on("error", () => {});
    if (options.guard) child.on("exit", () => child.stdin!.end());
    else child.stdin!.end(options.stdin ?? "");
  });

  const resolvePath = (path?: string): string => resolveRemoteWorkspacePath(root, path);

  /** A failure of the connection itself, in words a person can act on. */
  const unreachable = (result: RemoteWorkspaceExecResult): RemoteWorkspaceToolResult | undefined => {
    if (result.aborted) return fail("Cancelled.");
    if (result.timedOut) return fail(`${remote.label} did not answer in time.`);
    if (result.code === SSH_FAILURE) return fail(`Could not reach ${remote.label}: ${result.stderr.trim().slice(0, 300) || "no answer"}`);
    return undefined;
  };
  const detail = (result: RemoteWorkspaceExecResult): string => result.stderr.trim().slice(0, 300) || `exit ${result.code}`;

  const tools: Record<RemoteWorkspaceToolName, (input: Record<string, unknown>, signal?: AbortSignal) => Promise<RemoteWorkspaceToolResult>> = {
    async bash(input, signal) {
      const command = text(input.command);
      if (!command?.trim()) return fail("command is required.");
      const ms = Math.min(Math.max(number(input.timeout) ?? BASH_DEFAULT_MS, 1_000), BASH_MAX_MS);
      const seconds = Math.ceil(ms / 1000);
      const result = await exec(BASH_SCRIPT, {
        args: [String(seconds), command],
        timeoutMs: seconds * 1000 + 10_000,
        maxBytes: 2 * 1024 * 1024,
        guard: true,
        ...(signal ? { signal } : {}),
      });
      if (result.aborted) return fail("Cancelled.");
      const body = clip(result.stdout.toString("utf8"));
      if (result.timedOut || result.code === 124) return fail(`${body}${body && !body.endsWith("\n") ? "\n" : ""}[command timed out after ${seconds}s]`);
      // The command's own stderr is merged into stdout, so text here is ssh's.
      if (result.code === SSH_FAILURE && !body && result.stderr.trim()) return unreachable(result)!;
      if (result.code !== 0) return fail(`${body}${body && !body.endsWith("\n") ? "\n" : ""}[exit code ${result.code}]`);
      return ok(body || "(no output)");
    },

    async read(input, signal) {
      const path = resolvePath(text(input.file_path));
      const first = Math.max(1, Math.floor(number(input.offset) ?? 1));
      const count = Math.min(Math.max(1, Math.floor(number(input.limit) ?? MAX_READ_LINES)), MAX_READ_LINES);
      const result = await exec(READ_SCRIPT, { args: [path, String(first), String(count)], ...(signal ? { signal } : {}) });
      if (result.code === 3) return fail(`File does not exist: ${path}`);
      if (result.code === 4) return fail(`${path} is a directory. List it with the bash tool.`);
      const broken = unreachable(result);
      if (broken) return broken;
      if (result.code !== 0) return fail(`Could not read ${path}: ${detail(result)}`);
      const output = result.stdout.toString("utf8");
      const cut = output.indexOf("\n");
      const total = Number(output.slice(0, cut)) || 0;
      const body = output.slice(cut + 1);
      if (!body) return ok(total === 0 ? "(file is empty)" : `(no lines at offset ${first}; the file has ${total} lines)`);
      const lines = body.endsWith("\n") ? body.slice(0, -1).split("\n") : body.split("\n");
      const shown = lines.map((line, index) =>
        `${String(first + index).padStart(6)}\t${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]` : line}`);
      const last = first + lines.length - 1;
      const more = last < total ? `\n… [showing lines ${first}-${last} of ${total}; pass offset and limit for the rest]` : "";
      return ok(shown.join("\n") + more);
    },

    async write(input, signal) {
      const path = resolvePath(text(input.file_path));
      const content = text(input.content);
      if (content === undefined) return fail("content is required.");
      const result = await exec(WRITE_SCRIPT, { args: [path, ""], stdin: content, ...(signal ? { signal } : {}) });
      const broken = unreachable(result);
      if (broken) return broken;
      if (result.code !== 0) return fail(`Could not write ${path}: ${detail(result)}`);
      return ok(`File written: ${path} (${Buffer.byteLength(content)} bytes)`);
    },

    async edit(input, signal) {
      const path = resolvePath(text(input.file_path));
      const oldString = text(input.old_string);
      const newString = text(input.new_string);
      if (oldString === undefined || newString === undefined) return fail("old_string and new_string are required.");
      const current = await exec(CAT_SCRIPT, { args: [path], maxBytes: MAX_EDIT_BYTES, ...(signal ? { signal } : {}) });
      if (current.code === 3) return fail(`File does not exist: ${path}`);
      if (current.code === 4) return fail(`${path} is a directory.`);
      const broken = unreachable(current);
      if (broken) return broken;
      if (current.code !== 0) return fail(`Could not read ${path}: ${detail(current)}`);
      if (current.truncated) return fail(`${path} is too large to edit this way; change it with the bash tool.`);
      const bytes = current.stdout;
      const before = bytes.toString("utf8");
      if (!Buffer.from(before, "utf8").equals(bytes)) return fail(`${path} is not valid UTF-8 text; change it with the bash tool.`);
      const edited = applyRemoteWorkspaceEdit(before, oldString, newString, input.replace_all === true);
      if (!edited.ok) {
        if (edited.reason === "identical") return fail("old_string and new_string are identical.");
        if (edited.reason === "not-found") return fail(`String to replace not found in ${path}. Read the file again and copy the exact text, including indentation.`);
        return fail(`Found ${edited.matches} matches of the string to replace in ${path}, but replace_all is false. Add surrounding lines to make it unique, or set replace_all.`);
      }
      const sha = createHash("sha256").update(bytes).digest("hex");
      const written = await exec(WRITE_SCRIPT, { args: [path, sha], stdin: edited.next, ...(signal ? { signal } : {}) });
      if (written.code === 9) return fail(`${path} changed on the host since it was read. Read it again and retry.`);
      const failed = unreachable(written);
      if (failed) return failed;
      if (written.code !== 0) return fail(`Could not write ${path}: ${detail(written)}`);
      return ok(`Edited ${path}: ${edited.replacements === 1 ? "1 replacement" : `${edited.replacements} replacements`}.`);
    },

    async grep(input, signal) {
      const pattern = text(input.pattern);
      if (!pattern) return fail("pattern is required.");
      const target = resolvePath(text(input.path));
      const mode = input.output_mode === "content" ? "-n" : input.output_mode === "count" ? "-c" : "-l";
      const limit = Math.min(Math.max(1, Math.floor(number(input.head_limit) ?? 250)), 1_000);
      const result = await exec(GREP_SCRIPT, {
        args: [mode, input.case_insensitive === true ? "-i" : "", text(input.glob) ?? "", String(limit), pattern, target],
        guard: true,
        ...(signal ? { signal } : {}),
      });
      const broken = unreachable(result);
      if (broken) return broken;
      const body = result.stdout.toString("utf8").split(`${root}/`).join("").trimEnd();
      return ok(clip(body) || "No matches found.");
    },

    async glob(input, signal) {
      const pattern = text(input.pattern);
      if (!pattern) return fail("pattern is required.");
      const target = resolvePath(text(input.path));
      const result = await exec(GLOB_SCRIPT, { args: [target, pattern], guard: true, ...(signal ? { signal } : {}) });
      if (result.code === 3) return fail(`Directory does not exist: ${target}`);
      if (result.code === 5) return fail(`${remote.label} has no bash; list files with the bash tool and \`find\`.`);
      const broken = unreachable(result);
      if (broken) return broken;
      return ok(result.stdout.toString("utf8").trimEnd() || "No files found.");
    },
  };

  return {
    root,
    label: remote.label,
    exec,
    resolvePath,
    async call(tool, input, options) {
      const handler = tools[tool];
      if (!handler) return fail(`Unknown tool: ${tool}`);
      try {
        return await handler(input, options?.signal);
      } catch (error) {
        return fail(`Tool failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    close() {
      closed = true;
      for (const stop of [...active.values()]) stop();
      active.clear();
    },
  };
}
