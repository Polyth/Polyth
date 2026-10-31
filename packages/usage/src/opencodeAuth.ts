import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir as systemHomedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";
import {
  findInstalledGoogleClient,
  refreshAntigravityCliLogin,
  type GoogleClientKind,
  type GoogleOAuthClient,
} from "./providers/googleCliClients.ts";

export type OpenCodeAuthEntry = string | Record<string, unknown>;
export type OpenCodeAuth = Record<string, OpenCodeAuthEntry>;

export interface QuotaDiscoveryPaths {
  authFile?: string;
  /** Other logins of the same provider, tried after `authFile` when it fails
   *  authentication. A harness can hold a working credential for a provider
   *  whose own client store still has an expired one. */
  authFiles?: string[];
  claudeCredentialsFile?: string;
  codexAuthFile?: string;
  codexAuthFiles?: string[];
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
  arch?: string;
  readFile?: (path: string) => string;
  writeManagedCredential?: (providerId: "cursor", value: Record<string, string>) => void;
  unlink?: (path: string) => void;
  /** Test seam for the macOS keychain; receives the generic-password service name. */
  readKeychain?: (service: string) => string | null;
  /** Test seam: the OAuth client of the user's installed Google CLI. */
  findGoogleClient?: (kind: GoogleClientKind) => GoogleOAuthClient | null;
  /** Test seam: lets the installed `agy` refresh the login under `loginHome`. */
  refreshAntigravityLogin?: (loginHome: string) => Promise<boolean>;
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
  arch: string;
  readFile: (path: string) => string;
  writeManagedCredential: (providerId: "cursor", value: Record<string, string>) => void;
  unlink: (path: string) => void;
  /** Test seam for the macOS keychain; receives the generic-password service name. */
  readKeychain?: (service: string) => string | null;
  findGoogleClient: (kind: GoogleClientKind) => GoogleOAuthClient | null;
  refreshAntigravityLogin: (loginHome: string) => Promise<boolean>;
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
  // OpenCode resolves its own data directory from XDG_DATA_HOME; reading the
  // hardcoded path missed every relocated install.
  const openCodeDataDir = env.XDG_DATA_HOME
    ? resolve(env.XDG_DATA_HOME)
    : join(home, ".local", "share");
  const authFile = opts.paths?.authFile ?? join(openCodeDataDir, "opencode", "auth.json");
  const piAgentDir = (() => {
    const configured = env.PI_CODING_AGENT_DIR?.trim();
    if (!configured) return join(home, ".pi", "agent");
    if (configured === "~") return home;
    return resolve(configured.replace(/^~(?=\/)/, home));
  })();
  // Pi keeps its own provider logins in its agent directory. A Polyth session
  // can run on a Pi login while OpenCode's store holds an expired key, so the
  // same provider source reads both.
  const authFiles = opts.paths?.authFiles ?? [
    authFile,
    join(piAgentDir, "auth.json"),
  ].filter((path, index, all) => all.indexOf(path) === index);
  const claudeRoot = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(home, ".claude");
  const codexHome = env.CODEX_HOME
    ? resolve(env.CODEX_HOME)
    : (env.CODEX_CONFIG_DIR ? resolve(env.CODEX_CONFIG_DIR) : join(home, ".codex"));
  const defaultCodexAuthFile = join(codexHome, "auth.json");
  const codexAuthFile = opts.paths?.codexAuthFile ?? defaultCodexAuthFile;
  const codexAuthFiles = opts.paths?.codexAuthFiles ?? (
    opts.paths?.codexAuthFile
      ? [opts.paths.codexAuthFile]
      : [
          defaultCodexAuthFile,
          join(home, ".config", "codex", "auth.json"),
        ]
  );
  const antigravityCliHome = env.GEMINI_CLI_HOME
    ? resolve(env.GEMINI_CLI_HOME)
    : (env.ANTIGRAVITY_CLI_HOME ? resolve(env.ANTIGRAVITY_CLI_HOME) : join(home, ".gemini", "antigravity-cli"));
  const paths: Required<QuotaDiscoveryPaths> = {
    authFile,
    authFiles,
    claudeCredentialsFile: opts.paths?.claudeCredentialsFile ?? join(claudeRoot, ".credentials.json"),
    codexAuthFile,
    codexAuthFiles,
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
  const platform = opts.platform ?? process.platform;
  const search = { env, home, platform };
  return {
    fetchImpl: opts.fetchImpl ?? fetch,
    readAuth,
    writeAuth,
    env,
    now: opts.now ?? Date.now,
    home,
    platform,
    arch: opts.arch ?? process.arch,
    readFile,
    writeManagedCredential,
    unlink: opts.unlink ?? unlinkSync,
    ...(opts.readKeychain ? { readKeychain: opts.readKeychain } : {}),
    findGoogleClient: opts.findGoogleClient ?? ((kind) => findInstalledGoogleClient(kind, search)),
    refreshAntigravityLogin: opts.refreshAntigravityLogin ?? ((loginHome) => refreshAntigravityCliLogin(search, loginHome)),
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
  providerId: "cursor" | "ollama-cloud" | "mimo",
): Record<string, unknown> | null =>
  readJson(runtime, join(runtime.paths.managedDataDir, "quota", `${providerId}.json`));

export const removeLegacyOpenCodeGoCredential = (runtime: QuotaRuntime): void => {
  try {
    runtime.unlink(join(runtime.paths.managedDataDir, "quota", "opencode-go.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

/**
 * Every login a provider has across the harness credential stores this host
 * knows about, in the order a request should try them: the provider's own
 * client store first, then Pi's agent directory. Duplicates by value are
 * dropped, so one shared login is one candidate.
 *
 * A store that cannot be read is skipped: one unreadable file must not hide
 * a working login in another. Nothing here starts a process.
 */
export const providerLogins = (
  runtime: QuotaRuntime,
  providerId: string,
  fields: readonly string[] = ["key", "token", "access"],
): string[] => {
  const seen = new Set<string>();
  for (const path of runtime.paths.authFiles) {
    let store: OpenCodeAuth;
    try {
      const text = runtime.readFile(path).trim();
      if (!text) continue;
      const parsed: unknown = JSON.parse(text);
      store = objectValue(parsed) as OpenCodeAuth ?? {};
    } catch {
      continue;
    }
    const entry = normalizeAuthEntry(store[providerId]);
    for (const field of fields) {
      const value = stringValue(entry?.[field]);
      if (value) seen.add(value);
    }
  }
  return [...seen];
};
