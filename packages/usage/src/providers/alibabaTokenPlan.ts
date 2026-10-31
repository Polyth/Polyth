import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, delimiter, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { QuotaSnapshot } from "@polyth/contracts";
import type { QuotaProvider } from "../index.ts";
import { numberValue, objectValue, timestampValue, type QuotaRuntime } from "../opencodeAuth.ts";
import { mapProviderUsage, usageWindow, type ProviderUsageWindow } from "../ocWindows.ts";

/**
 * Alibaba Personal Token Plan is reported only by the official `bl` CLI:
 *
 *   bl usage token-plan --output json
 *
 * The CLI owns console authentication. This adapter never installs it, never
 * runs login, never reads console cookies and never uses a shell. Only a
 * trusted absolute PATH entry is considered, from a non-project working
 * directory, so a repository cannot shadow the binary.
 */
const COMMAND = "bl";
const ARGS = ["usage", "token-plan", "--output", "json"] as const;
const COMMAND_TIMEOUT_MS = 10_000;
const OUTPUT_LIMIT_BYTES = 256 * 1024;
const FIVE_HOUR_SECONDS = 5 * 3600;
const WEEKLY_SECONDS = 7 * 86400;

export interface AlibabaTokenPlanWindow {
  usedPercent: number;
  resetAt: number | null;
}

export interface AlibabaTokenPlanUsage {
  fiveHour?: AlibabaTokenPlanWindow;
  weekly?: AlibabaTokenPlanWindow;
}

const parseWindow = (
  payload: Record<string, unknown>,
  prefix: "per5Hour" | "per1Week",
): AlibabaTokenPlanWindow | undefined | "invalid" => {
  const percentageKey = `${prefix}Percentage`;
  const resetKey = `${prefix}ResetTime`;
  const percentagePresent = Object.hasOwn(payload, percentageKey);
  const resetPresent = Object.hasOwn(payload, resetKey);
  if (!percentagePresent && !resetPresent) return undefined;
  if (!percentagePresent) return "invalid";
  const used = numberValue(payload[percentageKey]);
  if (used === null || used < 0 || used > 1) return "invalid";
  const resetAt = resetPresent ? timestampValue(payload[resetKey]) : null;
  if (resetPresent && resetAt === null) return "invalid";
  return { usedPercent: used * 100, resetAt };
};

/** Pure parser so the CLI payload can be tested without running `bl`. */
export const parseAlibabaTokenPlanUsage = (text: string): AlibabaTokenPlanUsage => {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Alibaba Cloud CLI did not return valid JSON");
  }
  const record = objectValue(payload);
  if (!record) throw new Error("Alibaba Cloud CLI returned an invalid Personal Token Plan payload");
  const fiveHour = parseWindow(record, "per5Hour");
  if (fiveHour === "invalid") throw new Error("Alibaba Cloud CLI returned an invalid Personal Token Plan payload");
  const weekly = parseWindow(record, "per1Week");
  if (weekly === "invalid") throw new Error("Alibaba Cloud CLI returned an invalid Personal Token Plan payload");
  if (!fiveHour && !weekly) throw new Error("Alibaba Personal Token Plan usage returned no quota windows");
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
  };
};

const isInside = (parent: string, candidate: string): boolean => {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const SHELL_LAUNCHER_NAMES = new Set([
  "bash", "cmd", "cmd.exe", "command.com", "csh", "dash", "fish", "ksh",
  "powershell", "powershell.exe", "pwsh", "pwsh.exe", "sh", "sh.exe",
  "tcsh", "wscript.exe", "zsh",
]);
const SHELL_LAUNCHER_EXTENSIONS = new Set([
  ".bash", ".bat", ".cmd", ".com", ".fish", ".ps1", ".sh", ".zsh",
]);
const isShellLauncher = (file: string): boolean =>
  SHELL_LAUNCHER_NAMES.has(basename(file).toLowerCase())
  || SHELL_LAUNCHER_EXTENSIONS.has(extname(file).toLowerCase());

/** Resolve `bl` from absolute, non-project PATH entries only. */
export const resolveAlibabaTokenPlanBinary = (
  runtime: QuotaRuntime,
  cwd: string = process.cwd(),
): string | null => {
  if (runtime.platform !== "darwin" && runtime.platform !== "linux") return null;
  const pathValue = runtime.env.PATH;
  if (!pathValue) return null;
  const project = resolve(cwd);
  for (const raw of pathValue.split(delimiter)) {
    const entry = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
    if (!entry || !isAbsolute(entry)) continue;
    const directory = resolve(entry);
    if (isInside(project, directory)) continue;
    const candidate = join(directory, COMMAND);
    try {
      // Follow the real target: a trusted PATH directory can hold a symlink
      // into the project, which would otherwise bypass the directory check.
      const resolved = realpathSync(candidate);
      if (isInside(project, resolved) || isShellLauncher(resolved)) continue;
      if (!statSync(resolved).isFile()) continue;
      accessSync(resolved, constants.X_OK);
      return resolved;
    } catch {
      // Not this directory, a dangling link, or not executable.
    }
  }
  return null;
};

const runTokenPlanUsage = (runtime: QuotaRuntime, file: string): string => {
  try {
    return execFileSync(file, [...ARGS], {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: OUTPUT_LIMIT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: runtime.home,
      env: { ...process.env, ...runtime.env },
      shell: false,
      windowsHide: true,
    });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { status?: number | null; signal?: string | null };
    if (failure.code === "ENOENT") {
      throw new Error("Alibaba Cloud CLI (bl) was not found on the trusted PATH.");
    }
    if (failure.status === 3) {
      throw new Error("Alibaba Cloud console session is missing or expired. Run `bl auth login --console`.");
    }
    if (failure.code === "ETIMEDOUT" || failure.signal === "SIGTERM") {
      throw new Error("Timed out while running the Alibaba Cloud CLI.");
    }
    throw new Error("Could not read Alibaba Personal Token Plan quota.");
  }
};

export const createAlibabaTokenPlanProvider = (
  runtime: QuotaRuntime,
): QuotaProvider & { isConfigured(): boolean } => {
  const binary = () => resolveAlibabaTokenPlanBinary(runtime);
  return {
    id: "alibaba-token-plan",
    isConfigured: () => Boolean(binary()),
    async fetch(signal): Promise<QuotaSnapshot> {
      if (signal.aborted) throw new Error("Alibaba Personal Token Plan request aborted");
      const file = binary();
      if (!file) {
        throw new Error("Alibaba Cloud CLI (bl) was not found on the trusted PATH.");
      }
      const usage = parseAlibabaTokenPlanUsage(runTokenPlanUsage(runtime, file));
      const windows: Record<string, ProviderUsageWindow> = {};
      if (usage.fiveHour) {
        windows["5h"] = usageWindow({
          usedPercent: usage.fiveHour.usedPercent,
          windowSeconds: FIVE_HOUR_SECONDS,
          resetAt: usage.fiveHour.resetAt,
        });
      }
      if (usage.weekly) {
        windows.weekly = usageWindow({
          usedPercent: usage.weekly.usedPercent,
          windowSeconds: WEEKLY_SECONDS,
          resetAt: usage.weekly.resetAt,
        });
      }
      const mapped = mapProviderUsage({ windows });
      if (mapped.length === 0) throw new Error("Alibaba Personal Token Plan usage returned no quota windows");
      return {
        providerId: "alibaba-token-plan",
        accountLabel: "Alibaba Personal Token Plan",
        windows: mapped,
        fetchedAt: runtime.now(),
        stale: false,
      };
    },
  };
};
