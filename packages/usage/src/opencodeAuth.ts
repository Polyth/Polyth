import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir as systemHomedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";

export type OpenCodeAuthEntry = string | Record<string, unknown>;
export type OpenCodeAuth = Record<string, OpenCodeAuthEntry>;

export interface QuotaDiscoveryPaths {
  authFile?: string;
  claudeCredentialsFile?: string;
  managedDataDir?: string;
  antigravityAccountsFiles?: string[];
  antigravityTokenFiles?: string[];
}

export interface QuotaDiscoveryOptions {
  fetchImpl?: typeof fetch;
  readAuth?: () => OpenCodeAuth;
  writeAuth?: (auth: OpenCodeAuth) => void;
  env?: Record<string, string | undefined>;
  now?: () => number;
  homedir?: string | (() => string);
  platform?: NodeJS.Platform;
  readFile?: (path: string) => string;
  writeManagedCredential?: (providerId: "cursor", value: Record<string, string>) => void;
  unlink?: (path: string) => void;
  readKeychain?: () => string | null;
  paths?: QuotaDiscoveryPaths;
}

export interface QuotaRuntime {
  fetchImpl: typeof fetch;
  readAuth: () => OpenCodeAuth;
  writeAuth: (auth: OpenCodeAuth) => void;
  env: Record<string, string | undefined>;
  now: () => number;
  home: string;
  platform: NodeJS.Platform;
  readFile: (path: string) => string;
  writeManagedCredential: (providerId: "cursor", value: Record<string, string>) => void;
  unlink: (path: string) => void;
  readKeychain?: () => string | null;
  paths: Required<QuotaDiscoveryPaths>;
}

const parseAuth = (text: string): OpenCodeAuth => {
  const parsed: unknown = JSON.parse(text);
  return objectValue(parsed) as OpenCodeAuth ?? {};
};

const atomicWriteJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteSync(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
};

export const resolveQuotaRuntime = (opts: QuotaDiscoveryOptions = {}): QuotaRuntime => {
  const home = typeof opts.homedir === "function"
    ? opts.homedir()
    : opts.homedir ?? systemHomedir();
  const env = opts.env ?? process.env;
  const managedRoot = opts.paths?.managedDataDir
    ?? (env.POLYTH_DATA_DIR
      ? resolve(env.POLYTH_DATA_DIR)
      : join(home, ".config", "polyth"));
  const authFile = opts.paths?.authFile ?? join(home, ".local", "share", "opencode", "auth.json");
  const claudeRoot = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(home, ".claude");
  const antigravityCliHome = env.GEMINI_CLI_HOME
    ? resolve(env.GEMINI_CLI_HOME)
    : (env.ANTIGRAVITY_CLI_HOME ? resolve(env.ANTIGRAVITY_CLI_HOME) : join(home, ".gemini", "antigravity-cli"));
  const paths: Required<QuotaDiscoveryPaths> = {
    authFile,
    claudeCredentialsFile: opts.paths?.claudeCredentialsFile ?? join(claudeRoot, ".credentials.json"),
    managedDataDir: managedRoot,
    antigravityAccountsFiles: opts.paths?.antigravityAccountsFiles ?? [
      join(home, ".config", "opencode", "antigravity-accounts.json"),
      join(home, ".local", "share", "opencode", "antigravity-accounts.json"),
    ],
    antigravityTokenFiles: opts.paths?.antigravityTokenFiles ?? [
      join(antigravityCliHome, "antigravity-oauth-token"),
      join(home, ".config", "antigravity", "antigravity-oauth-token"),
    ],
  };
  const readFile = opts.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const readAuth = opts.readAuth ?? (() => {
    try {
      if (!existsSync(authFile)) return {};
      const text = readFile(authFile).trim();
      return text ? parseAuth(text) : {};
    } catch {
      throw new Error("Failed to read OpenCode auth configuration");
    }
  });
  const writeAuth = opts.writeAuth ?? ((auth: OpenCodeAuth) => atomicWriteJson(authFile, auth));
  const writeManagedCredential = opts.writeManagedCredential
    ?? ((providerId: "cursor", value: Record<string, string>) =>
      atomicWriteJson(join(managedRoot, "quota", `${providerId}.json`), value));
  return {
    fetchImpl: opts.fetchImpl ?? fetch,
    readAuth,
    writeAuth,
    env,
    now: opts.now ?? Date.now,
    home,
    platform: opts.platform ?? process.platform,
    readFile,
    writeManagedCredential,
    unlink: opts.unlink ?? unlinkSync,
    ...(opts.readKeychain ? { readKeychain: opts.readKeychain } : {}),
    paths,
  };
};

export const objectValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

export const stringValue = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && !/[\r\n]/.test(trimmed) ? trimmed : null;
};

export const numberValue = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const timestampValue = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const normalizeAuthEntry = (entry: unknown): Record<string, unknown> | null =>
  typeof entry === "string" ? { token: entry } : objectValue(entry);

export const getAuthEntry = (
  auth: OpenCodeAuth,
  aliases: readonly string[],
): Record<string, unknown> | null => {
  for (const alias of aliases) {
    const entry = normalizeAuthEntry(auth[alias]);
    if (entry) return entry;
  }
  return null;
};

export const readJson = (runtime: QuotaRuntime, path: string): Record<string, unknown> | null => {
  try {
    const text = runtime.readFile(path).trim();
    return text ? objectValue(JSON.parse(text)) : null;
  } catch {
    return null;
  }
};

export const readManagedCredential = (
  runtime: QuotaRuntime,
  providerId: "cursor" | "ollama-cloud",
): Record<string, unknown> | null =>
  readJson(runtime, join(runtime.paths.managedDataDir, "quota", `${providerId}.json`));

export const removeLegacyOpenCodeGoCredential = (runtime: QuotaRuntime): void => {
  try {
    runtime.unlink(join(runtime.paths.managedDataDir, "quota", "opencode-go.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};
