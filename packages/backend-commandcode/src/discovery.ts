import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import type { AgentDescriptor, ModelDescriptor, ModelRef } from "@polyth/contracts";
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

const commandCodeBinary = async (command?: string): Promise<string> =>
  command ?? await resolveCommandCodeBinary();

export const commandCodeVersion = async (command?: string): Promise<string | undefined> => {
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
  command?: string,
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
  command?: string,
): Promise<CommandCodeStatus> {
  const text = await run(await commandCodeBinary(command), ["status", "--json"], undefined, 7_500);
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
  command?: string,
  cwd?: string,
): Promise<ModelDescriptor[]> {
  const text = await run(await commandCodeBinary(command), ["--list-models"], cwd, 15_000);
  const models = parseCommandCodeModelList(text);
  if (!models.length) {
    throw Object.assign(new Error("Command Code returned no parseable models"), { code: "catalog-unavailable" });
  }
  return models;
}

const BUILTIN_AGENTS: readonly AgentDescriptor[] = [
  {
    name: "general",
    description: "General research and multi-step work with the full native Command Code tool set.",
    mode: "subagent",
  },
  {
    name: "explore",
    description: "Read-only codebase search and understanding across many files.",
    mode: "subagent",
  },
  {
    name: "plan",
    description: "Implementation planning and trade-off analysis with read-only tools.",
    mode: "subagent",
  },
] as const;

const RESERVED_AGENT_NAMES = new Set(["general", "explore", "plan", "review"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

const scalar = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "|" || trimmed === ">") return undefined;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim() || undefined;
  }
  return trimmed;
};

const frontmatter = (text: string): Record<string, string> => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line || /^\s/.test(line) || line.trimStart().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = scalar(line.slice(colon + 1));
    if (key && value !== undefined) out[key] = value;
  }
  return out;
};

const configuredModel = (id: string | undefined, effort: string | undefined): ModelRef | undefined => {
  if (!id || id.toLowerCase() === "inherit") return undefined;
  const slash = id.indexOf("/");
  const variant = effort && EFFORTS.has(effort.toLowerCase()) ? effort.toLowerCase() : undefined;
  return {
    providerID: slash > 0 ? id.slice(0, slash).toLowerCase() : "command-code",
    modelID: id,
    ...(variant ? { variant } : {}),
  };
};

export function parseCommandCodeAgentFile(filename: string, text: string): AgentDescriptor | undefined {
  if (extname(filename).toLowerCase() !== ".md") return undefined;
  const meta = frontmatter(text);
  const fallback = basename(filename, extname(filename));
  const name = (meta.name ?? fallback).trim();
  if (!name || name.length > 128 || /[\r\n/\\]/.test(name)) return undefined;
  if (RESERVED_AGENT_NAMES.has(name.toLowerCase())) return undefined;
  const description = meta.description?.trim();
  const model = configuredModel(meta.model?.trim(), meta.reasoningEffort?.trim());
  return {
    name,
    ...(description ? { description } : {}),
    mode: "subagent",
    ...(model ? { model } : {}),
  };
}

const discoverAgentDir = async (dir: string): Promise<AgentDescriptor[]> => {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
  const out: AgentDescriptor[] = [];
  for (const entry of entries.filter((item) => item.isFile() && extname(item.name).toLowerCase() === ".md")
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const text = await readFile(join(dir, entry.name), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const agent = parseCommandCodeAgentFile(entry.name, text);
    if (agent) out.push(agent);
  }
  return out;
};

/** Discover the documented Command Code agent registry without reading prompt
 * bodies into Polyth state. Built-ins win, then personal agents, then project
 * agents — matching Command Code's first-definition-wins load order. */
export async function discoverCommandCodeAgents(
  cwd: string,
  home = homedir(),
): Promise<AgentDescriptor[]> {
  const result = BUILTIN_AGENTS.map((agent) => ({ ...agent }));
  const seen = new Set([...RESERVED_AGENT_NAMES]);
  for (const dir of [join(home, ".commandcode", "agents"), join(cwd, ".commandcode", "agents")]) {
    for (const agent of await discoverAgentDir(dir)) {
      const key = agent.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(agent);
    }
  }
  return result;
}
