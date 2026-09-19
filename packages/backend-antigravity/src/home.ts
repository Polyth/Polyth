import { link as hardlink, lstat, mkdir, readdir, readFile, readlink, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { JsonObject } from "@polyth/contracts";

/**
 * Antigravity only reads MCP servers from its *global* Gemini config directory
 * (`$HOME/.gemini/config`), not from workspace `.agents/plugins` (verified
 * against CLI 1.2.7: plugin `hooks.json` loads there but `mcp_config.json` is
 * never read). A per-runtime `HOME` therefore has to exist so one canonical
 * session's MCP bridge never lands in a shared, user-visible config file.
 *
 * The private HOME links back to the real one so HOME-dependent tooling the
 * agent runs (git, ssh, package managers, caches) keeps working. The Gemini
 * `config` directory is the only subtree that is materialized per runtime.
 */
export interface AntigravityHomeInput {
  /** Private per-runtime HOME owned by the Space runtime directory. */
  homeRoot: string;
  /** The real OS user home whose `.gemini` the CLI is authenticated against. */
  realHome: string;
  /** Rendered MCP servers; `undefined` reuses the last staged projection. */
  mcpServers?: Record<string, JsonObject>;
}

const PRIVATE = 0o700;
const contains = (root: string, candidate: string): boolean => {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
};

const ensurePrivateDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: PRIVATE });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Antigravity private home path is not a directory: ${path}`);
  }
};

/** Link one real home entry into the private home without copying it. */
const linkEntry = async (target: string, link: string): Promise<void> => {
  const existing = await lstat(link).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    const current = await readlink(link).catch(() => undefined);
    if (current !== undefined && resolve(dirname(link), current) === resolve(target)) return;
    await unlink(link);
  } else if (existing) {
    // Never clobber a real file or directory inside the private home.
    return;
  }
  const info = await stat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return;
  if (info.isDirectory()) {
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    return;
  }
  try {
    await symlink(target, link, "file");
  } catch (error) {
    if (process.platform !== "win32") throw error;
    // Windows file symlinks need privileges; a hard link keeps the entry usable
    // when the volumes match, otherwise the entry is left absent.
    await hardlink(target, link).catch(() => undefined);
  }
};

const jsonObject = (value: unknown): Record<string, JsonObject> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonObject>
    : undefined;

const readUserMcpServers = async (file: string): Promise<Record<string, JsonObject>> => {
  const body = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!body) return {};
  try {
    return jsonObject(jsonObject(JSON.parse(body))?.mcpServers) ?? {};
  } catch {
    // A malformed user MCP config must not take down the Polyth projection.
    return {};
  }
};

const writePrivate = async (file: string, content: string): Promise<void> => {
  const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error(`Antigravity MCP config path is not a private file: ${file}`);
  }
  const current = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (current === content) return;
  const temp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, file);
};

const linkEntries = async (from: string, to: string, skip: ReadonlySet<string>): Promise<void> => {
  const names = await readdir(from).catch(() => [] as string[]);
  for (const name of names) {
    if (skip.has(name)) continue;
    await linkEntry(join(from, name), join(to, name));
  }
};

/**
 * Materialize the private Gemini home. Idempotent: repeated calls only refresh
 * the staged MCP projection and leave existing links in place.
 */
export async function materializeAntigravityHome(input: AntigravityHomeInput): Promise<void> {
  const { homeRoot, realHome } = input;
  await ensurePrivateDirectory(homeRoot);
  const gemini = join(homeRoot, ".gemini");
  await ensurePrivateDirectory(gemini);
  const config = join(gemini, "config");
  await ensurePrivateDirectory(config);
  const realGemini = join(realHome, ".gemini");
  const realConfig = join(realGemini, "config");

  const topLevel = await readdir(realHome).catch(() => [] as string[]);
  for (const name of topLevel) {
    if (name === ".gemini") continue;
    const target = join(realHome, name);
    // Never link an ancestor of the private home into itself (walk loop).
    if (contains(target, homeRoot)) continue;
    await linkEntry(target, join(homeRoot, name));
  }
  await linkEntries(realGemini, gemini, new Set(["config"]));
  await linkEntries(realConfig, config, new Set(["mcp_config.json"]));

  const servers = {
    ...await readUserMcpServers(join(realConfig, "mcp_config.json")),
    ...(input.mcpServers ?? {}),
  };
  await writePrivate(join(config, "mcp_config.json"), JSON.stringify({ mcpServers: servers }, null, 2) + "\n");
}
