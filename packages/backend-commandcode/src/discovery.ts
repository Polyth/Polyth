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
  model?: string;
  contextWindow?: number;
  raw?: Record<string, unknown>;
}

export const COMMANDCODE_REQUIRED_FLAGS = [
  "-p",
  "--output-format",
  "--skip-onboarding",
  "--no-auto-update",
  "--tools-enable",
  "--mod",
  "--skill",
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

let launcher: string | undefined;
/** The last resolved launcher (before symlinks), for commands shown to a user. */
export const commandCodeLauncher = (): string | undefined => launcher;

export async function resolveCommandCodeBinary(): Promise<string> {
  const requested = process.env.POLYTH_COMMANDCODE_BIN?.trim() || "command-code";
  const report = await discoverHarnessExecutable(requested);
  if (!report.hit) {
    throw Object.assign(
      new Error(`Command Code CLI was not found (${report.searched.slice(0, 8).join(", ") || "no searchable locations"})`),
      { code: "not-installed" },
    );
  }
  launcher = report.hit.launcherPath ?? report.hit.executablePath;
  return report.hit.executablePath;
}

/** A Command Code CLI reached some other way than a local executable path,
 * e.g. on a remote host. `run` resolves stdout (or stderr when stdout is
 * empty) on exit 0 and rejects with `{ stdout }` otherwise, like execFile. */
export interface CommandCodeCli {
  run(args: string[], cwd: string | undefined, timeoutMs: number): Promise<string>;
}

/** `accountEnv` points the CLI at one account's private home. */
const run = async (command: string | CommandCodeCli, args: string[], cwd?: string, timeout = 10_000, accountEnv?: Readonly<Record<string, string>>): Promise<string> => {
  if (typeof command !== "string") return command.run(args, cwd, timeout);
  const env = { ...await harnessExecutableChildEnv(command), ...accountEnv };
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

const commandCodeBinary = async (command?: string | CommandCodeCli): Promise<string | CommandCodeCli> =>
  command ?? await resolveCommandCodeBinary();

export const commandCodeVersion = async (command?: string | CommandCodeCli): Promise<string | undefined> => {
  const resolved = await commandCodeBinary(command);
  const value = await run(resolved, ["--version"], undefined, 5_000).catch(() => "");
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
  command?: string | CommandCodeCli,
): Promise<CommandCodeCompatibility> {
  const help = await run(await commandCodeBinary(command), ["--help"], undefined, 5_000);
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

const positiveNumber = (value: unknown): number | undefined => {
  let numeric = Number.NaN;
  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string") {
    const match = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(value);
    if (match) {
      const multiplier = match[2]?.toLowerCase() === "k"
        ? 1_000
        : match[2]?.toLowerCase() === "m"
          ? 1_000_000
          : 1;
      numeric = Number(match[1]) * multiplier;
    }
  }
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  const rounded = Math.round(numeric);
  return rounded > 0 ? rounded : undefined;
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
  command?: string | CommandCodeCli,
  cwd?: string,
  accountEnv?: Readonly<Record<string, string>>,
): Promise<CommandCodeStatus> {
  // A signed-out CLI prints its JSON report and exits 1; keep that answer.
  const text = await run(await commandCodeBinary(command), ["status", "--json"], cwd, 7_500, accountEnv)
    .catch((error: { stdout?: unknown }) => {
      const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
      if (stdout.startsWith("{")) return stdout;
      throw error;
    });
  let parsed: Record<string, unknown>;
  try {
    parsed = record(JSON.parse(text)) ?? {};
  } catch {
    throw Object.assign(new Error("Command Code status returned invalid JSON"), { code: "protocol-error" });
  }
  const account = record(parsed.account) ?? record(parsed.user) ?? record(parsed.auth);
  const modelRecord = record(parsed.model);
  const model = firstString(parsed.model, modelRecord?.id, parsed.current_model, parsed.currentModel);
  const contextWindow = positiveNumber(
    parsed.context_window ?? parsed.contextWindow ?? modelRecord?.context_window ?? modelRecord?.contextWindow,
  );
  return {
    authenticated: authState(parsed),
    accountLabel: firstString(account?.email, account?.name, parsed.email, parsed.name),
    ...(model ? { model } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
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
  const cleaned = line.replace(ANSI, "").trim().replace(/^[•*+\-]\s*/, "");
  const candidate = /^`?([A-Za-z0-9][A-Za-z0-9._/-]*)`?(?=\s|$)/.exec(cleaned)?.[1];
  if (!candidate) return undefined;
  if (candidate.length > 160 || !/[0-9/_-]/.test(candidate)) return undefined;
  return candidate;
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
  command?: string | CommandCodeCli,
  cwd?: string,
  status?: CommandCodeStatus,
  accountEnv?: Readonly<Record<string, string>>,
): Promise<ModelDescriptor[]> {
  const text = await run(await commandCodeBinary(command), ["--list-models"], cwd, 15_000, accountEnv);
  const models = parseCommandCodeModelList(text);
  if (!models.length) {
    throw Object.assign(new Error("Command Code returned no parseable models"), { code: "catalog-unavailable" });
  }
  if (!status?.model || !status.contextWindow) return models;
  return models.map((model) => model.modelID === status.model
    ? { ...model, context: status.contextWindow }
    : model);
}
