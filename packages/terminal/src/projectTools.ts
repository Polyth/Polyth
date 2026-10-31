// Shared server-only boundary for trusted project CLI inspection. Mutating
// commands are previews handed to the canonical Terminal, not executed here.
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import type { SpaceContext } from "@polyth/contracts";
import { resolveWorkspaceContext, workspaceExecutionPath, workspaceRepository } from "@polyth/contracts/workspace";
import { agentBetaEnabled } from "@polyth/harness-runtime";
import { createHarnessProcessAuthority, type HarnessProcessAuthority } from "@polyth/harness-runtime/process-authority";
import type { ServerPackageHost } from "@polyth/plugins";
import type { ProjectToolInput, ProjectToolScope, ToolCommandPreview } from "./projectToolTypes.ts";

export const toolError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

export async function resolveProjectToolScope(host: ServerPackageHost, space: SpaceContext, input: ProjectToolInput): Promise<ProjectToolScope> {
  if (typeof input.projectId !== "string" || !input.projectId) throw toolError("invalid-input", "Choose a project first.");
  const scoped = host.forSpace(space);
  const project = await scoped.projects.get(input.projectId);
  if (!project) throw toolError("not-found", "Workspace not found.");
  const session = input.sessionId ? await scoped.sessions.snapshot(input.sessionId) : undefined;
  if (session && session.projectId !== project.id) throw toolError("not-found", "Workspace not found.");
  if (project.remote) throw toolError("unsupported", "This tool currently supports local projects. Use the remote project's terminal.");
  if (host.deployment !== "local-trusted") throw toolError("unsupported", "Host CLI tools require a local trusted installation.");
  const context = resolveWorkspaceContext(project, session);
  const selected = input.repositoryId
    ? workspaceRepository(context, input.repositoryId)
    : context.repositories.find((row) => row.path === workspaceExecutionPath(project, session));
  if (!selected || selected.state !== "ready") throw toolError("not-found", "Repository checkout is unavailable.");
  const root = await realpath(selected.path);
  return {
    projectId: project.id, sessionId: session?.id ?? null, repositoryId: selected.repositoryId,
    root, alias: selected.alias,
    repositories: context.repositories.map((row) => ({ id: row.repositoryId, alias: row.alias, available: row.state === "ready" })),
  };
}

/** Both lexical traversal and symlink escapes are refused, including Windows syntax. */
export async function checkedToolPath(root: string, path: string, kind: "file" | "directory" = "file"): Promise<string> {
  if (typeof path !== "string" || !path || path.includes("\0") || path.includes("\\")
    || isAbsolute(path) || win32.isAbsolute(path) || path.split("/").includes("..")) {
    throw toolError("invalid-input", "Choose a path inside the selected repository.");
  }
  const canonicalRoot = await realpath(root);
  const target = await realpath(resolve(canonicalRoot, path));
  const rel = relative(canonicalRoot, target);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) throw toolError("invalid-input", "Path escapes the selected repository.");
  const info = await lstat(target);
  if (kind === "file" ? !info.isFile() : !info.isDirectory()) throw toolError("invalid-input", `Choose a ${kind}.`);
  return target;
}

/** Pin and validate the actual regular file, including parent-directory races. */
export async function openProjectToolFile(root: string, path: string, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) {
    throw toolError("invalid-input", "Unsupported file read limit.");
  }
  const canonicalRoot = await realpath(root);
  const target = await checkedToolPath(canonicalRoot, path);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw toolError("invalid-input", "Choose a regular file.");
    const verify = async () => {
      if (await realpath(root) !== canonicalRoot) throw toolError("invalid-input", "Repository path changed during the read.");
      const current = await checkedToolPath(canonicalRoot, path);
      const info = await lstat(current);
      if (current !== target || info.dev !== opened.dev || info.ino !== opened.ino
        || (process.platform === "linux" && await realpath(`/proc/self/fd/${handle.fd}`) !== current)) {
        throw toolError("invalid-input", "File changed outside the selected repository.");
      }
    };
    await verify();
    if (opened.size > maxBytes) throw toolError("invalid-input", "This file is too large to inspect.");
    return { handle, verify, close: () => handle.close() };
  } catch (error) { await handle.close(); throw error; }
}

/** Return bounded bytes only after rechecking the opened file's authority. */
export async function readProjectToolFile(root: string, path: string, maxBytes: number): Promise<Buffer> {
  const file = await openProjectToolFile(root, path, maxBytes);
  try {
    const bytes = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await file.handle.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > maxBytes) throw toolError("invalid-input", "This file is too large to inspect.");
    await file.verify();
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}

const SKIP = new Set([".git", ".scratch", ".terraform", "node_modules", "vendor", ".venv", "dist", "build", "target"]);
export async function discoverToolFiles(root: string, matches: (name: string) => boolean): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const queue = [{ path: ".", depth: 0 }];
  let visited = 0;
  let truncated = false;
  for (let i = 0; i < queue.length; i++) {
    if (++visited > 800 || files.length >= 200) { truncated = true; break; }
    const current = queue[i]!;
    const dir = await checkedToolPath(root, current.path, "directory");
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = current.path === "." ? entry.name : `${current.path}/${entry.name}`;
      if (entry.isFile() && matches(entry.name)) {
        await checkedToolPath(root, path);
        files.push(path);
        if (files.length >= 200) { truncated = true; break; }
      } else if (entry.isDirectory() && !SKIP.has(entry.name) && !entry.name.startsWith(".")) {
        if (current.depth < 5) queue.push({ path, depth: current.depth + 1 });
        else truncated = true;
      }
    }
  }
  return { files, truncated };
}

export interface ToolRunResult { stdout: string; exitCode: number | null }
/** Ownership transfers on call, including rejected admission. Release only
 * after the CLI authority is proven closed (or no process was launched). */
export interface ToolOwnedResource { close(): Promise<void> }
export type ToolRun = (command: "docker" | "terraform", args: string[], cwd: string, ownedResource?: ToolOwnedResource) => Promise<ToolRunResult>;

/** Own every process tree; timeouts and disable release its exact authority. */
export function createProjectToolRunner(options: { authority?: () => Promise<HarnessProcessAuthority>; timeoutMs?: number } = {}) {
  const active = new Set<HarnessProcessAuthority>();
  const resources = new Map<HarnessProcessAuthority, () => Promise<void>>();
  let enabled = false;
  let reservations = 0;
  let epoch = 0;
  const run: ToolRun = async (command, args, cwd, ownedResource) => {
    let authority: HarnessProcessAuthority | undefined;
    let resourceClosed = false;
    let resourceFlight: Promise<void> | undefined;
    const releaseResource = async () => {
      if (resourceClosed || !ownedResource) return;
      if (!resourceFlight) resourceFlight = ownedResource.close().then(() => { resourceClosed = true; }).finally(() => { resourceFlight = undefined; });
      await resourceFlight;
    };
    try {
      if (agentBetaEnabled()) throw Object.assign(toolError("unavailable", "CLI inspection is disabled in this read-only preview."), { reason: "read-only-preview" });
      if (!enabled) throw toolError("unavailable", "The tool package is disabled.");
      if (active.size + reservations >= 4) throw toolError("unavailable", "Another tool check is running. Try again shortly.");
      const generation = epoch;
      reservations++;
      try { authority = await (options.authority ?? createHarnessProcessAuthority)(); } finally { reservations--; }
      active.add(authority);
      resources.set(authority, releaseResource);
      if (!enabled || generation !== epoch) throw toolError("unavailable", "The tool package was disabled.");
      const env: NodeJS.ProcessEnv = { ...process.env, TF_IN_AUTOMATION: "1", TF_INPUT: "0" };
      // User-global extra flags/logging must not change a bounded inspection.
      for (const key of Object.keys(env)) if (key === "TF_LOG" || key === "TF_LOG_PATH" || key.startsWith("TF_CLI_ARGS")) delete env[key];
      return await new Promise<ToolRunResult>((resolveRun, rejectRun) => {
        let bytes = 0;
        const output: Buffer[] = [];
        const child = authority!.spawn(command, args, { cwd, env, shell: false });
        let settled = false;
        const finish = (error?: Error, code: number | null = null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) rejectRun(error);
          else resolveRun({ stdout: Buffer.concat(output).toString("utf8"), exitCode: code });
        };
        const timer = setTimeout(() => finish(toolError("unavailable", `${command} inspection timed out.`)), options.timeoutMs ?? 20_000);
        const count = (chunk: Buffer, stdout: boolean) => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) finish(toolError("unavailable", `${command} output is too large to inspect.`));
          else if (stdout) output.push(chunk);
        };
        child.stdout?.on("data", (chunk: Buffer) => count(chunk, true));
        // Stderr may contain configuration values. Never return or log it.
        child.stderr?.on("data", (chunk: Buffer) => count(chunk, false));
        child.once("error", () => finish(toolError("unavailable", `${command} could not start. Check that its CLI is installed.`)));
        child.once("close", (code) => finish(undefined, code));
        child.stdin?.end();
      });
    } finally {
      // Remove only after release proof. A failed close remains owned for stop().
      if (authority) {
        await authority.close();
        await releaseResource();
        resources.delete(authority);
        active.delete(authority);
      } else await releaseResource();
    }
  };
  return {
    run,
    enable() { enabled = true; epoch++; },
    async stop() {
      enabled = false; epoch++;
      const results = await Promise.allSettled([...active].map(async (authority) => {
        await authority.close(); await resources.get(authority)?.(); resources.delete(authority); active.delete(authority);
      }));
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  };
}

export function quoteToolArgument(value: string, platform: NodeJS.Platform = process.platform): string {
  if (value.includes("\0") || /[\r\n]/.test(value)) throw toolError("invalid-input", "Unsupported command argument.");
  if (platform === "win32") {
    if (/["%!^&|<>]/.test(value)) throw toolError("unsupported", "This path needs manual quoting in a Windows terminal.");
    return `"${value}"`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function projectToolCommand(scope: ProjectToolScope, title: string, explanation: string, command: "docker" | "terraform", args: string[]): ToolCommandPreview {
  return {
    title, explanation, projectId: scope.projectId, sessionId: scope.sessionId,
    repositoryId: scope.repositoryId, cwd: scope.root,
    cmd: [command, ...args].map((arg) => quoteToolArgument(arg)).join(" "),
  };
}
