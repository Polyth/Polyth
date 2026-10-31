// Google quota sources refresh tokens that a CLI issued, and a refresh must use
// the OAuth client that issued them. Those clients belong to the CLIs (Gemini
// CLI, Antigravity, the OpenCode auth plugins), so Polyth never ships one: it
// reads the client from the user's own install, or lets `agy` refresh its own
// login.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export interface GoogleOAuthClient {
  id: string;
  secret: string;
}

export type GoogleClientKind = "gemini" | "antigravity";

export interface InstalledClientSearch {
  env: Record<string, string | undefined>;
  home: string;
  platform: NodeJS.Platform;
}

/** Constant names the installs assign their client to: Gemini CLI (bundled
 *  chunks and `@google/gemini-cli-core`) uses `OAUTH_`, `opencode-gemini-auth`
 *  `GEMINI_`, `opencode-antigravity-auth` `ANTIGRAVITY_`. */
const CONSTANT_PREFIXES: Readonly<Record<GoogleClientKind, readonly string[]>> = {
  gemini: ["OAUTH", "GEMINI"],
  antigravity: ["ANTIGRAVITY"],
};

const literal = (text: string, name: string): string | null =>
  new RegExp(`\\b${name}\\s*=\\s*["'\`]([^"'\`\\s]+)["'\`]`).exec(text)?.[1] ?? null;

/** The client a source file assigns to its named constants, or null. */
export const clientFromSource = (text: string, kind: GoogleClientKind): GoogleOAuthClient | null => {
  for (const prefix of CONSTANT_PREFIXES[kind]) {
    const id = literal(text, `${prefix}_CLIENT_ID`);
    const secret = literal(text, `${prefix}_CLIENT_SECRET`);
    if (id && secret && id.endsWith(".apps.googleusercontent.com")) return { id, secret };
  }
  return null;
};

const realpath = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const listJs = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".js")).map((name) => join(dir, name));
  } catch {
    return [];
  }
};

const onPath = (name: string, search: InstalledClientSearch): string | null => {
  const path = search.env.PATH ?? (search.platform === "win32" ? search.env.Path : undefined) ?? "";
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const hit = realpath(join(dir, name));
    if (hit) return hit;
  }
  return null;
};

const globalModuleDirs = (search: InstalledClientSearch): string[] => [
  ...(search.env.NPM_CONFIG_PREFIX ? [join(search.env.NPM_CONFIG_PREFIX, "lib", "node_modules")] : []),
  join(search.home, ".npm-global", "lib", "node_modules"),
  ...(search.platform === "win32"
    ? (search.env.APPDATA ? [join(search.env.APPDATA, "npm", "node_modules")] : [])
    : ["/usr/local/lib/node_modules", "/usr/lib/node_modules", "/opt/homebrew/lib/node_modules"]),
];

const geminiCliFiles = (search: InstalledClientSearch): string[] => {
  const roots = new Set<string>();
  // `gemini` links to `<package>/bundle/gemini.js`.
  const bin = onPath("gemini", search);
  if (bin) roots.add(dirname(dirname(bin)));
  for (const dir of globalModuleDirs(search)) roots.add(join(dir, "@google", "gemini-cli"));
  const files: string[] = [];
  for (const root of roots) {
    files.push(...listJs(join(root, "bundle")));
    for (const core of [join(root, "node_modules", "@google", "gemini-cli-core"), join(dirname(root), "gemini-cli-core")]) {
      files.push(join(core, "dist", "src", "code_assist", "oauth2.js"));
    }
  }
  return files;
};

/** OpenCode installs plugins into its cache (and, for local configs, its
 *  config directory). */
const openCodePluginDirs = (search: InstalledClientSearch, name: string): string[] => {
  const cache = search.env.XDG_CACHE_HOME || join(search.home, ".cache");
  const config = search.env.XDG_CONFIG_HOME || join(search.home, ".config");
  return [join(cache, "opencode", "node_modules", name), join(config, "opencode", "node_modules", name)];
};

const candidateFiles = (kind: GoogleClientKind, search: InstalledClientSearch): string[] => kind === "gemini"
  ? [
      ...geminiCliFiles(search),
      ...openCodePluginDirs(search, "opencode-gemini-auth").map((dir) => join(dir, "dist", "index.js")),
    ]
  : openCodePluginDirs(search, "opencode-antigravity-auth").map((dir) => join(dir, "dist", "src", "constants.js"));

const MARKERS: Readonly<Record<GoogleClientKind, readonly string[]>> = {
  gemini: ["OAUTH_CLIENT_SECRET", "GEMINI_CLIENT_SECRET"],
  antigravity: ["ANTIGRAVITY_CLIENT_SECRET"],
};

const parsed = new Map<string, { mtimeMs: number; client: GoogleOAuthClient | null }>();

const clientInFile = (path: string, kind: GoogleClientKind): GoogleOAuthClient | null => {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  const key = `${kind}\0${path}`;
  const cached = parsed.get(key);
  if (cached?.mtimeMs === mtimeMs) return cached.client;
  let client: GoogleOAuthClient | null = null;
  try {
    const text = readFileSync(path, "utf8");
    if (MARKERS[kind].some((marker) => text.includes(marker))) client = clientFromSource(text, kind);
  } catch { /* unreadable install file */ }
  parsed.set(key, { mtimeMs, client });
  return client;
};

/** The OAuth client of the user's installed Gemini CLI / OpenCode auth plugin. */
export const findInstalledGoogleClient = (
  kind: GoogleClientKind,
  search: InstalledClientSearch,
): GoogleOAuthClient | null => {
  for (const file of candidateFiles(kind, search)) {
    const client = clientInFile(file, kind);
    if (client) return client;
  }
  return null;
};

const AGY_REFRESH_TIMEOUT_MS = 30_000;

/** Lets the installed `agy` refresh the login stored under `loginHome`: any
 *  command that reaches Google refreshes and rewrites `antigravity-oauth-token`,
 *  and `agy models` is the cheapest one (no model turn). Resolves whether the
 *  command succeeded. */
export const refreshAntigravityCliLogin = (
  search: InstalledClientSearch,
  loginHome: string,
): Promise<boolean> => {
  const configured = search.env.POLYTH_ANTIGRAVITY_BIN?.trim();
  const binary = configured
    || onPath(search.platform === "win32" ? "agy.exe" : "agy", search)
    || realpath(join(search.home, ".local", "bin", "agy"));
  if (!binary) return Promise.resolve(false);
  const env = {
    ...search.env,
    HOME: loginHome,
    ...(search.platform === "win32" ? { USERPROFILE: loginHome } : {}),
  };
  return new Promise((resolve) => {
    execFile(binary, ["models"], { env, timeout: AGY_REFRESH_TIMEOUT_MS, windowsHide: true }, (error) => resolve(!error));
  });
};
