import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ModelDescriptor } from "@polyth/contracts";
import {
  discoverHarnessExecutable,
  harnessExecutableChildEnv,
} from "@polyth/harness-runtime/executable-discovery";

const exec = promisify(execFile);
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]/g;

export interface CommandCodeStatus {
  authenticated: boolean | "unknown";
  accountLabel?: string;
  raw?: Record<string, unknown>;
}

export const COMMANDCODE_REQUIRED_FLAGS = [
  "-p",
  "--output-format",
  "--skip-onboarding",
  "--no-auto-update",
  "--tools-enable",
  "--mod",
  "--resume",
  "--model",
  "--effort",
  "--permission-mode",
  "--list-models",
] as const;

export interface CommandCodeCompatibility {
  compatible: boolean;
  missing: string[];
}

export async function resolveCommandCodeBinary(): Promise<string> {
  const requested = process.env.POLYTH_COMMANDCODE_BIN?.trim() || "command-code";
  const report = await discoverHarnessExecutable(requested);
  if (!report.hit) {
    throw Object.assign(
      new Error(`Command Code CLI was not found (${report.searched.slice(0, 8).join(", ") || "no searchable locations"})`),
      { code: "not-installed" },
    );
  }
  return report.hit.executablePath;
}

const run = async (command: string, args: string[], cwd?: string, timeout = 10_000): Promise<string> => {
  const env = await harnessExecutableChildEnv(command);
  const { stdout, stderr } = await exec(command, args, {
    cwd,
    env,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
  });
  return String(stdout || stderr || "").trim();
};

export const commandCodeVersion = async (command = await resolveCommandCodeBinary()): Promise<string | undefined> => {
  const value = await run(command, ["--version"], undefined, 5_000).catch(() => "");
  return value.trim() || undefined;
};

const flagPattern = (flag: string): RegExp => {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s,])${escaped}(?=$|[\\s,=<])`, "m");
};

/** Inspect the real installed CLI surface instead of guessing from a version.
 * This keeps compatibility tied to documented features Polyth actually uses. */
export function inspectCommandCodeHelp(output: string): CommandCodeCompatibility {
  const help = output.replace(ANSI, "");
  const missing = COMMANDCODE_REQUIRED_FLAGS.filter((flag) => !flagPattern(flag).test(help));
  return { compatible: missing.length === 0, missing };
}

export async function commandCodeCompatibility(
  command = await resolveCommandCodeBinary(),
): Promise<CommandCodeCompatibility> {
  const help = await run(command, ["--help"], undefined, 5_000);
  return inspectCommandCodeHelp(help);
}

export const commandCodeCompatibilityMessage = (compatibility: CommandCodeCompatibility): string =>
  compatibility.compatible
    ? "Command Code CLI is compatible"
    : `Upgrade Command Code; required CLI flags are missing: ${compatibility.missing.join(", ")}`;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
};

const authState = (value: Record<string, unknown>): boolean | "unknown" => {
  const auth = record(value.auth) ?? record(value.authentication) ?? record(value.account);
  for (const candidate of [value.authenticated, auth?.authenticated, auth?.loggedIn, value.loggedIn]) {
    if (typeof candidate === "boolean") return candidate;
  }
  const state = firstString(value.status, auth?.status, value.state)?.toLowerCase();
  if (state && ["authenticated", "ready", "logged-in", "logged_in", "signed-in", "signed_in"].includes(state)) return true;
  if (state && ["unauthenticated", "logged-out", "logged_out", "signed-out", "signed_out", "auth-required"].includes(state)) return false;
  return "unknown";
};

export async function commandCodeStatus(
  command = await resolveCommandCodeBinary(),
): Promise<CommandCodeStatus> {
  const text = await run(command, ["status", "--json"], undefined, 7_500);
  let parsed: Record<string, unknown>;
  try {
    parsed = record(JSON.parse(text)) ?? {};
  } catch {
    throw Object.assign(new Error("Command Code status returned invalid JSON"), { code: "protocol-error" });
  }
  const account = record(parsed.account) ?? record(parsed.user) ?? record(parsed.auth);
  return {
    authenticated: authState(parsed),
    accountLabel: firstString(account?.email, account?.name, parsed.email, parsed.name),
    raw: parsed,
  };
}

const humanizeModel = (id: string): string => {
  const leaf = id.split("/").at(-1) ?? id;
  return leaf
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "gpt") return "GPT";
      if (lower === "glm") return "GLM";
      if (lower === "qwen") return "Qwen";
      if (lower === "kimi") return "Kimi";
      if (lower === "ai") return "AI";
      return /^[0-9.]+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
};

const modelToken = (line: string): string | undefined => {
  const cleaned = line.replace(ANSI, "").trim().replace(/^[•*+\-]\s*/, "").replace(/^`|`$/g, "");
  if (!cleaned || /\s/.test(cleaned)) return undefined;
  if (cleaned.length > 160 || !/[0-9/_.-]/.test(cleaned)) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(cleaned)) return undefined;
  return cleaned;
};

/** Parse the official `command-code --list-models` copy-pasteable id list.
 * Headings and decoration are ignored; no static catalog is substituted. */
export function parseCommandCodeModelList(output: string): ModelDescriptor[] {
  const seen = new Set<string>();
  const models: ModelDescriptor[] = [];
  for (const line of output.split(/\r?\n/)) {
    const id = modelToken(line);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const slash = id.indexOf("/");
    const providerID = slash > 0 ? id.slice(0, slash).toLowerCase() : "command-code";
    models.push({
      providerID,
      modelID: id,
      name: humanizeModel(id),
      connected: true,
    });
  }
  return models;
}

export async function discoverCommandCodeModels(
  command = await resolveCommandCodeBinary(),
  cwd?: string,
): Promise<ModelDescriptor[]> {
  const text = await run(command, ["--list-models"], cwd, 15_000);
  const models = parseCommandCodeModelList(text);
  if (!models.length) {
    throw Object.assign(new Error("Command Code returned no parseable models"), { code: "catalog-unavailable" });
  }
  return models;
}
