import { spawn } from "node:child_process";
import type { RuntimeCommandDescriptor } from "@polyth/contracts";

/**
 * Antigravity invokes skills as slash commands (`/<skill> <text>`), and print
 * mode expands a leading one. The CLI answers `agy -p /skills --output-format
 * json` locally, without a model call, with
 * `{"command":{"name":"skills","data":{"skills":[{name, description, ...}]}}}`
 * (checked against CLI 1.2.9). That report is the native catalog; nothing
 * here is invented or hardcoded.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_COMMANDS = 256;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function parseAgySkillsReport(output: string, harnessId = "antigravity"): RuntimeCommandDescriptor[] {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { return []; }
  const command = record(record(parsed)?.command);
  if (command?.name !== "skills") return [];
  const skills = record(command.data)?.skills;
  if (!Array.isArray(skills)) return [];
  const seen = new Set<string>();
  const commands: RuntimeCommandDescriptor[] = [];
  for (const value of skills) {
    const skill = record(value);
    const name = typeof skill?.name === "string" ? skill.name.trim() : "";
    if (!SAFE_NAME.test(name) || seen.has(name) || commands.length >= MAX_COMMANDS) continue;
    seen.add(name);
    const description = typeof skill?.description === "string" ? skill.description.replace(/\s+/g, " ").trim().slice(0, 500) : "";
    commands.push({
      id: `native:${harnessId}:${name}`,
      name,
      ...(description ? { description } : {}),
      owner: "native",
      harnessId,
      acceptsArguments: true,
      availability: "session",
      invocation: "raw-native-input",
    });
  }
  return commands;
}

const discoveryError = (message: string) => Object.assign(new Error(message), { code: "discovery-unavailable" });

/** Run the local report. Stdin is closed so print mode never waits for piped
 * input, and a report that outlives its budget or output limit is killed with
 * its process group (print mode starts a language server). */
export function readAgySkills(options: {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  harnessId?: string;
  /** Test seam: extra leading arguments, for example a script path. */
  prefixArgs?: string[];
}): Promise<RuntimeCommandDescriptor[]> {
  return new Promise((resolveReport, rejectReport) => {
    const child = spawn(options.command, [...(options.prefixArgs ?? []), "-p", "/skills", "--output-format", "json"], {
      cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
      detached: process.platform !== "win32",
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(options.command),
    });
    let output = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) rejectReport(error); else resolveReport(parseAgySkillsReport(output, options.harnessId));
    };
    // Only a still-running leader is signalled, so its group ID cannot have
    // been reused by an unrelated process.
    const stop = (message: string) => {
      try {
        if (process.platform !== "win32" && child.pid && child.exitCode === null) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* already gone */ }
      finish(discoveryError(message));
    };
    timer = setTimeout(() => stop("Antigravity did not answer its skills report in time"), options.timeoutMs ?? 90_000);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 1024 * 1024) stop("Antigravity skills report exceeded its size limit");
    });
    child.once("error", () => finish(discoveryError("Antigravity skills report could not start")));
    child.once("close", (code) => finish(code === 0 ? undefined : discoveryError("Antigravity skills report failed")));
  });
}
