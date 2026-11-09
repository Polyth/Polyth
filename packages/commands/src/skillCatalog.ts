// The skills catalog: what repositories offer, read into a per-Space snapshot.
//
// One source is one archive on disk plus an index built from it. Review and
// install both read that same archive, so what a person reviewed is byte for
// byte what gets installed, with no network involved at install. Repository
// content is data throughout: nothing from an archive runs, and instructions are
// shown to a person before they can reach an agent.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import {
  atomicWriteSync,
  describeInstallSource,
  downloadPublicHttps,
  fetchPublicHttps,
  openZipArchive,
  type ZipArchive,
} from "@polyth/plugins";
import { roleAtLeast, type SpaceContext, type SpaceStorage } from "@polyth/contracts";
import type {
  CapabilityInstallationScope,
  SkillCatalogDetailDto,
  SkillCatalogDto,
  SkillCatalogInstallInput,
  SkillCatalogInstalledDto,
  SkillCatalogSkillDto,
  SkillCatalogSourceDto,
  SkillFileDto,
  SkillFilePreviewDto,
  SkillInstallationDto,
} from "@polyth/contracts/capability-installations";
import { parseSkillFile, skillListField, skillTextField } from "@polyth/harness-runtime/native-skills";
import type { SkillService, StoredSkill } from "./skills.ts";
import {
  BUNDLE_LIMITS,
  bundleContentHash,
  hasHiddenText,
  previewFile,
  skillFileKind,
  type SkillBundleFile,
} from "./skillBundles.ts";

interface SourceConfig {
  id: string;
  label: string;
  /** The URL the person gave, or the curated repository's. */
  url: string;
  builtin: boolean;
  /** Repository folders that are not skills to offer, by path prefix. */
  skip?: readonly string[];
}

/** Curated sources. `skip` drops what would only confuse a catalog: Anthropic's
 * blank template, the skills OpenAI bundles into Codex itself, and the copy of
 * one Cursor plugin it mirrors for another harness. */
export const BUILTIN_SKILL_SOURCES: readonly SourceConfig[] = [
  { id: "anthropic", label: "Anthropic", url: "https://github.com/anthropics/skills", builtin: true, skip: ["template"] },
  { id: "openai", label: "OpenAI", url: "https://github.com/openai/skills", builtin: true, skip: ["skills/.system"] },
  { id: "cursor", label: "Cursor", url: "https://github.com/cursor/plugins", builtin: true, skip: ["harness"] },
  { id: "mattpocock", label: "Matt Pocock", url: "https://github.com/mattpocock/skills", builtin: true },
];

/** The "Start here" shelf: useful on the first day whatever the project is. A
 * skill that leaves its repository simply drops off the shelf. */
const FEATURED = new Set([
  "anthropic:frontend-design",
  "mattpocock:diagnosing-bugs",
  "openai:security-best-practices",
  "cursor:loop-on-ci",
  "anthropic:pdf",
  "mattpocock:tdd",
]);

const MAX_ARCHIVE_BYTES = 48 * 1024 * 1024;
const MAX_CUSTOM_SOURCES = 24;
const MAX_SKILLS_PER_SOURCE = 1000;
const MAX_LISTED_FILES = 2000;
const MAX_DESCRIPTION = 1024;
const MAX_AVATAR_BYTES = 256 * 1024;
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 15 * 60 * 1000;
const MAX_PARALLEL_SYNCS = 2;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Folders that hold fixtures or vendored copies, not skills to offer. */
const NOT_SKILLS = new Set(["node_modules", ".git", "vendor", "test", "tests", "__tests__", "fixtures", "__fixtures__", "template", "templates"]);
const ACRONYMS: Record<string, string> = {
  api: "API", apis: "APIs", ai: "AI", aspnet: "ASP.NET", ci: "CI", cd: "CD", cli: "CLI", css: "CSS", docx: "DOCX", gh: "GitHub", git: "Git",
  github: "GitHub", html: "HTML", http: "HTTP", json: "JSON", llm: "LLM", mcp: "MCP", openai: "OpenAI", pdf: "PDF",
  pptx: "PPTX", pr: "PR", prs: "PRs", qa: "QA", sdk: "SDK", tdd: "TDD", ts: "TS", ui: "UI", ux: "UX", xlsx: "XLSX",
};

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

/** `frontend-design` → `Frontend design`; `mcp-builder` → `MCP builder`. */
export function humanizeSkillName(name: string): string {
  const words = name.split(/[-_\s]+/).filter(Boolean).map((word) => ACRONYMS[word.toLowerCase()] ?? word.toLowerCase());
  const first = words[0] ?? name;
  words[0] = first === first.toLowerCase() ? first.charAt(0).toUpperCase() + first.slice(1) : first;
  return words.join(" ");
}

const slugify = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");

const clampDescription = (text: string): string => {
  if (text.length <= MAX_DESCRIPTION) return text;
  const cut = text.slice(0, MAX_DESCRIPTION - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > MAX_DESCRIPTION * 0.6 ? cut.slice(0, space) : cut}…`;
};

/** Which shelf of its repository a skill sits on, from its folder's parents. */
function collectionOf(path: string): string | undefined {
  const parts = path.split("/").slice(0, -1).map((part) => part.replace(/^\.+/, "")).filter((part) => part && part !== "skills");
  return parts[0] ? humanizeSkillName(parts[0]) : undefined;
}

/** A repository a person named, in any form they are likely to paste. */
export function normalizeSkillSourceUrl(input: string): string {
  const text = input.trim().replace(/\/+$/, "");
  const ssh = text.match(/^git@([a-z0-9.-]+):(.+?)(?:\.git)?$/i);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) return `https://github.com/${text.replace(/\.git$/, "")}`;
  if (/^(?:www\.)?(?:github\.com|gitlab\.com|codeberg\.org)\//i.test(text)) return `https://${text}`;
  // A link to a folder inside a repository names the repository and its branch.
  return text.replace(/^(https:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/tree\/[^/]+)\/.*$/i, "$1");
}

export interface RepositoryLocation {
  archiveUrl: string;
  host: string;
  /** `owner/repo`. */
  repository: string;
  ref: string;
  webUrl: string;
}

export function repositoryLocation(url: string): RepositoryLocation {
  const described = describeInstallSource(url);
  if (described.kind !== "repository" || !described.archiveUrl || !described.repositoryHost || !described.repositoryPath) {
    throw fail("invalid-input", "Enter a repository on GitHub, GitLab or Codeberg, like owner/repo");
  }
  const repository = described.repositoryPath.replace(/\.git$/i, "");
  return {
    archiveUrl: described.archiveUrl,
    host: described.repositoryHost.replace(/^www\./, ""),
    repository,
    ref: described.repositoryRef ?? "HEAD",
    webUrl: `https://${described.repositoryHost.replace(/^www\./, "")}/${repository}`,
  };
}

/** Where to read one folder of a repository at one commit, in the forge's own UI. */
function folderUrl(location: RepositoryLocation, path: string, commit: string | undefined): string {
  const ref = commit ?? location.ref;
  if (location.host === "gitlab.com") return `${location.webUrl}/-/tree/${ref}/${path}`;
  if (location.host === "codeberg.org") return `${location.webUrl}/src/commit/${ref}/${path}`;
  return `${location.webUrl}/tree/${ref}/${path}`;
}

interface IndexedFile {
  /** Inside the skill folder. */
  path: string;
  bytes: number;
  executable: boolean;
}

interface IndexedSkill {
  name: string;
  title: string;
  description: string;
  collection?: string;
  /** Skill folder inside the repository. */
  path: string;
  contentHash: string;
  /** Total file count; `listed` may be shorter for an oversized skill. */
  files: number;
  bytes: number;
  scripts: number;
  license?: string;
  hiddenText?: true;
  tooLarge?: true;
  allowedTools?: string[];
  disallowedTools?: string[];
  listed: IndexedFile[];
}

interface SourceIndex {
  version: 1;
  /** File name of the archive this index was built from. */
  archive: string;
  /** Top folder inside the archive, removed from every path. */
  rootPrefix: string;
  syncedAt: number;
  commit?: string;
  updatedAt?: number;
  description?: string;
  stars?: number;
  license?: string;
  avatar?: string;
  avatarUrl?: string;
  skills: IndexedSkill[];
}

/** The folder name every entry shares (`repo-HEAD/`), or none. */
function archiveRoot(paths: readonly string[]): string {
  const first = paths[0]?.split("/")[0];
  if (!first) return "";
  const prefix = `${first}/`;
  return paths.every((path) => path.startsWith(prefix)) ? prefix : "";
}

/** The commit a forge archive was made from, from its comment or top folder. */
function archiveCommit(comment: string, rootPrefix: string): string | undefined {
  const fromComment = comment.trim().match(/^[0-9a-f]{40}$/);
  if (fromComment) return fromComment[0];
  return rootPrefix.match(/-([0-9a-f]{40})\/$/)?.[1];
}

const looksLikeUnsafeName = (name: string): boolean => !NAME.test(name) || name.length > 64;

/** Finds every skill in an archive. A `SKILL.md` inside another skill's folder is
 * part of that skill. A repository root with one counts only when nothing else
 * does, since many repositories keep a template there. Identical copies of a
 * skill collapse to the shortest path. Pure over the archive, so it can be tested. */
export async function indexSkillArchive(
  archive: ZipArchive,
  skip: readonly string[] = [],
): Promise<{ rootPrefix: string; commit?: string; updatedAt?: number; skills: IndexedSkill[] }> {
  const rootPrefix = archiveRoot(archive.entries.map((entry) => entry.path));
  const files = archive.entries.map((entry) => ({ ...entry, relative: entry.path.slice(rootPrefix.length) }));
  const updatedAt = files.reduce((latest, file) => Math.max(latest, file.modifiedAt), 0) || undefined;
  const skipped = (path: string): boolean =>
    skip.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
    || path.split("/").some((part) => NOT_SKILLS.has(part));

  const roots = files
    .filter((file) => posix.basename(file.relative) === "SKILL.md")
    .map((file) => posix.dirname(file.relative))
    .filter((dir) => !skipped(dir === "." ? "" : dir));
  const nested = roots.filter((dir) => dir !== ".");
  const candidates = nested.length ? nested : roots;
  const unique = new Set(candidates);
  const outermost = candidates.filter((dir) => {
    for (let parent = posix.dirname(dir); parent !== "." && parent !== "/"; parent = posix.dirname(parent)) {
      if (unique.has(parent)) return false;
    }
    return true;
  }).sort();

  const skills: IndexedSkill[] = [];
  for (const dir of outermost.slice(0, MAX_SKILLS_PER_SOURCE)) {
    const prefix = dir === "." ? "" : `${dir}/`;
    const own = files.filter((file) => file.relative.startsWith(prefix));
    const totalBytes = own.reduce((sum, file) => sum + file.bytes, 0);
    const tooMany = own.length > BUNDLE_LIMITS.files
      || totalBytes > BUNDLE_LIMITS.bytes
      || own.some((file) => file.bytes > BUNDLE_LIMITS.fileBytes);
    let raw: string;
    try {
      raw = (await archive.read(`${rootPrefix}${prefix}SKILL.md`, BUNDLE_LIMITS.instructionBytes * 2)).toString("utf8");
    } catch {
      continue;
    }
    const parsed = parseSkillFile(raw);
    const description = skillTextField(parsed, "description");
    // Without a description an agent could never know when to use it.
    if (!description || !parsed.body) continue;
    const declared = skillTextField(parsed, "name") ?? "";
    const name = looksLikeUnsafeName(declared) ? slugify(dir === "." ? rootPrefix.replace(/\/$/, "") : posix.basename(dir)) : declared;
    if (looksLikeUnsafeName(name)) continue;
    let contentHash = "";
    if (!tooMany) {
      const bundle: SkillBundleFile[] = [];
      for (const file of own) {
        bundle.push({
          path: file.relative.slice(prefix.length),
          bytes: await archive.read(file.path, BUNDLE_LIMITS.fileBytes),
          executable: file.executable,
        });
      }
      contentHash = bundleContentHash(bundle);
    } else {
      contentHash = createHash("sha256").update(JSON.stringify(own.map((file) => [file.relative, file.bytes]))).digest("hex");
    }
    const listed = own.slice(0, MAX_LISTED_FILES).map((file) => ({
      path: file.relative.slice(prefix.length),
      bytes: file.bytes,
      executable: file.executable,
    }));
    const license = skillTextField(parsed, "license");
    const allowedTools = skillListField(parsed, "allowed-tools");
    const disallowedTools = skillListField(parsed, "disallowed-tools");
    const collection = dir === "." ? undefined : collectionOf(dir);
    const oversizedText = Buffer.byteLength(parsed.body) > BUNDLE_LIMITS.instructionBytes;
    skills.push({
      name,
      title: humanizeSkillName(name),
      description: clampDescription(description),
      ...(collection ? { collection } : {}),
      path: dir === "." ? "" : dir,
      contentHash,
      files: own.length,
      bytes: totalBytes,
      scripts: own.filter((file) => skillFileKind(file.relative, file.executable) === "script").length,
      ...(license ? { license: license.slice(0, 120) } : {}),
      ...(hasHiddenText(raw) ? { hiddenText: true as const } : {}),
      ...(tooMany || oversizedText ? { tooLarge: true as const } : {}),
      ...(allowedTools.length ? { allowedTools } : {}),
      ...(disallowedTools.length ? { disallowedTools } : {}),
      listed,
    });
  }

  // The same skill published twice in one repository is one row.
  const byIdentity = new Map<string, IndexedSkill>();
  for (const skill of skills.sort((a, b) => a.path.length - b.path.length || (a.path < b.path ? -1 : 1))) {
    const key = `${skill.name}\0${skill.contentHash}`;
    if (!byIdentity.has(key)) byIdentity.set(key, skill);
  }
  const commit = archiveCommit(archive.comment, rootPrefix);
  return {
    rootPrefix,
    ...(commit ? { commit } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    skills: [...byIdentity.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.path < b.path ? -1 : 1)),
  };
}

export interface SkillCatalogDeps {
  storage(space: SpaceContext): SpaceStorage;
  skills: SkillService;
  download?: typeof downloadPublicHttps;
  fetchText?: typeof fetchPublicHttps;
  now?(): number;
}

export interface SkillCatalog {
  list(space: SpaceContext, projectId?: string): Promise<SkillCatalogDto>;
  detail(space: SpaceContext, id: string, projectId?: string): Promise<SkillCatalogDetailDto>;
  file(space: SpaceContext, id: string, path: string): Promise<SkillFilePreviewDto>;
  install(space: SpaceContext, input: SkillCatalogInstallInput): Promise<SkillInstallationDto>;
  /** Installs what the catalog now holds for a skill that came from it. */
  update(space: SpaceContext, scope: CapabilityInstallationScope, name: string, projectId?: string): Promise<SkillInstallationDto>;
  addSource(space: SpaceContext, url: string): Promise<SkillCatalogSourceDto>;
  removeSource(space: SpaceContext, id: string): Promise<boolean>;
  /** Reads repositories again now: one source, or all of them. */
  refresh(space: SpaceContext, id?: string): Promise<void>;
  /** A stored skill's catalog state, for the library's "Update" and "View". */
  originState(space: SpaceContext, skill: StoredSkill): { catalogId?: string; avatar?: string; updateAvailable: boolean };
  /** Waits for the reads now running. For tests and orderly shutdown. */
  idle(): Promise<void>;
}

export function createSkillCatalog(deps: SkillCatalogDeps): SkillCatalog {
  const download = deps.download ?? downloadPublicHttps;
  const fetchText = deps.fetchText ?? fetchPublicHttps;
  const now = deps.now ?? Date.now;

  const rootOf = (space: SpaceContext): string => join(deps.storage(space).packageDir("commands"), "skill-catalog");
  const customFile = (space: SpaceContext): string => join(rootOf(space), "sources.json");
  const sourceDir = (space: SpaceContext, id: string): string => join(rootOf(space), "sources", id);
  const indexFile = (space: SpaceContext, id: string): string => join(sourceDir(space, id), "index.json");

  const readCustom = (space: SpaceContext): SourceConfig[] => {
    try {
      const raw = JSON.parse(readFileSync(customFile(space), "utf8")) as { sources?: unknown };
      if (!Array.isArray(raw.sources)) return [];
      return raw.sources.flatMap((row) => {
        const source = row as Partial<SourceConfig>;
        return typeof source.id === "string" && /^s-[a-f0-9]{12}$/.test(source.id)
          && typeof source.url === "string" && typeof source.label === "string"
          ? [{ id: source.id, url: source.url, label: source.label, builtin: false }]
          : [];
      });
    } catch {
      return [];
    }
  };
  const writeCustom = (space: SpaceContext, sources: readonly SourceConfig[]): void => {
    mkdirSync(rootOf(space), { recursive: true, mode: 0o700 });
    atomicWriteSync(customFile(space), JSON.stringify({
      version: 1,
      sources: sources.map(({ id, label, url }) => ({ id, label, url })),
    }, null, 2), 0o600);
  };
  const allSources = (space: SpaceContext): SourceConfig[] => [...BUILTIN_SKILL_SOURCES, ...readCustom(space)];
  const sourceOf = (space: SpaceContext, id: string): SourceConfig => {
    const source = allSources(space).find((candidate) => candidate.id === id);
    if (!source) throw fail("not-found", "source not found");
    return source;
  };

  /** Parsed indexes, kept while their file is unchanged. Keyed by Space. */
  const indexCache = new Map<string, { mtime: number; index: SourceIndex }>();
  const readIndex = (space: SpaceContext, id: string): SourceIndex | undefined => {
    const file = indexFile(space, id);
    let mtime: number;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      return undefined;
    }
    const key = `${space.spaceId}\0${id}`;
    const cached = indexCache.get(key);
    if (cached?.mtime === mtime) return cached.index;
    try {
      const index = JSON.parse(readFileSync(file, "utf8")) as SourceIndex;
      if (index.version !== 1 || !Array.isArray(index.skills) || !/^archive-[a-f0-9]{16}\.zip$/.test(index.archive)) return undefined;
      indexCache.set(key, { mtime, index });
      return index;
    } catch {
      return undefined;
    }
  };

  // What is running or recently failed, per Space and source. In memory only:
  // a restart simply tries again.
  const running = new Map<string, Promise<void>>();
  const failures = new Map<string, { at: number; message: string }>();
  const waiting: Array<() => void> = [];
  let active = 0;
  const acquire = async (): Promise<void> => {
    if (active >= MAX_PARALLEL_SYNCS) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
  };
  const release = (): void => {
    active -= 1;
    waiting.shift()?.();
  };

  /** Repository facts for a person choosing a source. Optional: a forge without
   * this API, or a rate limit, leaves the catalog fully usable. */
  const readMetadata = async (location: RepositoryLocation, previous: SourceIndex | undefined) => {
    if (location.host !== "github.com") return {};
    const response = await fetchText(`https://api.github.com/repos/${location.repository}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Polyth" },
      maxBytes: 256 * 1024,
      timeoutMs: 10_000,
    });
    if (response.status < 200 || response.status >= 300) return {};
    const raw = JSON.parse(response.body) as {
      description?: unknown;
      stargazers_count?: unknown;
      pushed_at?: unknown;
      license?: { spdx_id?: unknown } | null;
      owner?: { avatar_url?: unknown } | null;
    };
    const pushed = typeof raw.pushed_at === "string" ? Date.parse(raw.pushed_at) : Number.NaN;
    const spdx = raw.license?.spdx_id;
    const avatarUrl = typeof raw.owner?.avatar_url === "string" ? raw.owner.avatar_url : undefined;
    let avatar = avatarUrl && avatarUrl === previous?.avatarUrl ? previous.avatar : undefined;
    if (avatarUrl && !avatar) avatar = await readAvatar(avatarUrl);
    return {
      ...(typeof raw.description === "string" && raw.description ? { description: raw.description.slice(0, 400) } : {}),
      ...(typeof raw.stargazers_count === "number" ? { stars: raw.stargazers_count } : {}),
      ...(Number.isFinite(pushed) ? { updatedAt: pushed } : {}),
      ...(typeof spdx === "string" && spdx && spdx !== "NOASSERTION" ? { license: spdx } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(avatar ? { avatar } : {}),
    };
  };

  /** Only a PNG or JPEG, recognized by its bytes, ever reaches the page. */
  const readAvatar = async (url: string): Promise<string | undefined> => {
    try {
      const sized = `${url}${url.includes("?") ? "&" : "?"}s=96`;
      const bytes = await download(sized, { maxBytes: MAX_AVATAR_BYTES, timeoutMs: 10_000 });
      const png = bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const jpeg = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
      if (!png && !jpeg) return undefined;
      return `data:image/${png ? "png" : "jpeg"};base64,${bytes.toString("base64")}`;
    } catch {
      return undefined;
    }
  };

  const syncSource = async (space: SpaceContext, source: SourceConfig): Promise<number> => {
    const location = repositoryLocation(source.url);
    const buffer = await download(location.archiveUrl, { maxBytes: MAX_ARCHIVE_BYTES, timeoutMs: 90_000 });
    const dir = sourceDir(space, source.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const archiveName = `archive-${createHash("sha256").update(buffer).digest("hex").slice(0, 16)}.zip`;
    const archivePath = join(dir, archiveName);
    if (!existsSync(archivePath)) {
      const staging = `${archivePath}.${process.pid}.tmp`;
      writeFileSync(staging, buffer, { mode: 0o600 });
      renameSync(staging, archivePath);
    }
    const archive = await openZipArchive(archivePath);
    let built: Awaited<ReturnType<typeof indexSkillArchive>>;
    try {
      built = await indexSkillArchive(archive, source.skip ?? []);
    } finally {
      archive.close();
    }
    const previous = readIndex(space, source.id);
    const metadata = await readMetadata(location, previous).catch(() => ({ }));
    const index: SourceIndex = {
      version: 1,
      archive: archiveName,
      syncedAt: now(),
      ...built,
      ...(previous?.description ? { description: previous.description } : {}),
      ...(previous?.stars !== undefined ? { stars: previous.stars } : {}),
      ...(previous?.license ? { license: previous.license } : {}),
      ...(previous?.avatar ? { avatar: previous.avatar, ...(previous.avatarUrl ? { avatarUrl: previous.avatarUrl } : {}) } : {}),
      ...metadata,
    };
    atomicWriteSync(indexFile(space, source.id), JSON.stringify(index), 0o600);
    // Only now is the previous archive unreferenced.
    for (const name of readdirSync(dir)) {
      if (name !== archiveName && name !== "index.json") rmSync(join(dir, name), { force: true, recursive: true });
    }
    return built.skills.length;
  };

  const startSync = (space: SpaceContext, source: SourceConfig): Promise<void> => {
    const key = `${space.spaceId}\0${source.id}`;
    const existing = running.get(key);
    if (existing) return existing;
    const task = (async () => {
      await acquire();
      try {
        await syncSource(space, source);
        failures.delete(key);
      } catch (cause) {
        failures.set(key, { at: now(), message: readableFailure(cause) });
      } finally {
        release();
        running.delete(key);
      }
    })();
    running.set(key, task);
    return task;
  };

  const syncIfStale = (space: SpaceContext, source: SourceConfig): void => {
    const key = `${space.spaceId}\0${source.id}`;
    if (running.has(key)) return;
    const failed = failures.get(key);
    if (failed && now() - failed.at < RETRY_AFTER_MS) return;
    const syncedAt = readIndex(space, source.id)?.syncedAt;
    if (syncedAt === undefined || now() - syncedAt >= STALE_AFTER_MS) void startSync(space, source);
  };

  const sourceDto = (space: SpaceContext, source: SourceConfig, index: SourceIndex | undefined): SkillCatalogSourceDto => {
    const location = repositoryLocation(source.url);
    const key = `${space.spaceId}\0${source.id}`;
    const failed = failures.get(key);
    return {
      id: source.id,
      label: source.label,
      repository: location.repository,
      url: location.webUrl,
      builtin: source.builtin,
      ...(index?.description ? { description: index.description } : {}),
      ...(index?.stars !== undefined ? { stars: index.stars } : {}),
      ...(index?.license ? { license: index.license } : {}),
      ...(index?.avatar ? { avatar: index.avatar } : {}),
      ...(index?.updatedAt ? { updatedAt: index.updatedAt } : {}),
      ...(index?.syncedAt ? { syncedAt: index.syncedAt } : {}),
      ...(index?.commit ? { commit: index.commit } : {}),
      skillCount: index?.skills.length ?? 0,
      sync: running.has(key) ? "syncing" : failed ? "error" : "idle",
      ...(failed ? { error: failed.message } : {}),
    };
  };

  const skillDto = (
    source: SourceConfig,
    skill: IndexedSkill,
    managed: readonly StoredSkill[],
  ): SkillCatalogSkillDto => {
    const installed: SkillCatalogInstalledDto[] = [];
    const nameTakenIn: CapabilityInstallationScope[] = [];
    for (const row of managed) {
      if (row.name !== skill.name) continue;
      const scope = row.scope as CapabilityInstallationScope;
      if (row.origin?.kind === "catalog" && row.origin.sourceId === source.id && row.origin.path === skill.path) {
        installed.push({
          scope,
          state: row.modified ? "modified" : row.origin.contentHash === skill.contentHash ? "current" : "outdated",
        });
      } else {
        nameTakenIn.push(scope);
      }
    }
    return {
      id: `${source.id}:${skill.path}`,
      sourceId: source.id,
      name: skill.name,
      title: skill.title,
      description: skill.description,
      ...(skill.collection ? { collection: skill.collection } : {}),
      path: skill.path,
      contentHash: skill.contentHash,
      files: skill.files,
      bytes: skill.bytes,
      scripts: skill.scripts,
      ...(skill.license ? { license: skill.license } : {}),
      ...(skill.hiddenText ? { hiddenText: true } : {}),
      ...(skill.tooLarge ? { tooLarge: true } : {}),
      ...(FEATURED.has(`${source.id}:${skill.name}`) ? { featured: true } : {}),
      ...(installed.length ? { installed } : {}),
      ...(nameTakenIn.length ? { nameTakenIn } : {}),
    };
  };

  const locate = (space: SpaceContext, id: string) => {
    const split = id.indexOf(":");
    if (split <= 0) throw fail("not-found", "skill not found");
    const source = sourceOf(space, id.slice(0, split));
    const index = readIndex(space, source.id);
    const path = id.slice(split + 1);
    const skill = index?.skills.find((candidate) => candidate.path === path);
    if (!index || !skill) throw fail("not-found", "skill not found");
    return { source, index, skill };
  };

  const withArchive = async <T>(space: SpaceContext, source: SourceConfig, index: SourceIndex, read: (archive: ZipArchive) => Promise<T>): Promise<T> => {
    const archive = await openZipArchive(join(sourceDir(space, source.id), index.archive));
    try {
      return await read(archive);
    } finally {
      archive.close();
    }
  };

  const archivePathOf = (index: SourceIndex, skill: IndexedSkill, file: string): string =>
    `${index.rootPrefix}${skill.path ? `${skill.path}/` : ""}${file}`;

  const installIndexed = async (
    space: SpaceContext,
    located: ReturnType<typeof locate>,
    scope: CapabilityInstallationScope,
    projectId: string | undefined,
    replace: boolean | undefined,
  ): Promise<SkillInstallationDto> => {
    const { source, index, skill } = located;
    if (skill.tooLarge) throw fail("invalid-input", "This skill is too large to install");
    const location = repositoryLocation(source.url);
    const files = await withArchive(space, source, index, async (archive) => {
      const out: SkillBundleFile[] = [];
      for (const file of skill.listed) {
        out.push({
          path: file.path,
          bytes: await archive.read(archivePathOf(index, skill, file.path), BUNDLE_LIMITS.fileBytes),
          executable: file.executable,
        });
      }
      return out;
    });
    // The archive is ours and immutable, but this is the one check that decides
    // whether what was reviewed is what gets stored, so it reads the real bytes.
    if (bundleContentHash(files) !== skill.contentHash) throw fail("conflict", "This skill's files changed; open it again to review them");
    const main = files.find((file) => file.path === "SKILL.md");
    if (!main) throw fail("invalid-input", "This skill has no instructions");
    return deps.skills.installCopy(space, scope, {
      name: skill.name,
      description: skill.description,
      instructions: parseSkillFile(main.bytes.toString("utf8")).body,
      ...(skill.disallowedTools?.length ? { disallowedTools: skill.disallowedTools } : {}),
      origin: {
        kind: "catalog",
        sourceId: source.id,
        sourceLabel: source.label,
        repository: location.repository,
        path: skill.path,
        url: folderUrl(location, skill.path, index.commit),
        ...(index.commit ? { commit: index.commit } : {}),
        contentHash: skill.contentHash,
        installedAt: now(),
      },
      files,
      ...(replace ? { replace: true } : {}),
    }, projectId);
  };

  return {
    async list(space, projectId) {
      const sources = allSources(space);
      for (const source of sources) syncIfStale(space, source);
      const managed = deps.skills.listManaged(space, projectId);
      const access = deps.skills.access(space);
      const skills: SkillCatalogSkillDto[] = [];
      const rows: SkillCatalogSourceDto[] = [];
      for (const source of sources) {
        const index = readIndex(space, source.id);
        rows.push(sourceDto(space, source, index));
        for (const skill of index?.skills ?? []) skills.push(skillDto(source, skill, managed));
      }
      return {
        sources: rows,
        skills,
        access: {
          ...access,
          sources: roleAtLeast(space.role, "admin"),
          nativePolicy: false,
        },
      };
    },

    async detail(space, id, projectId) {
      const located = locate(space, id);
      const { source, index, skill } = located;
      const location = repositoryLocation(source.url);
      const instructions = await withArchive(space, source, index, async (archive) =>
        parseSkillFile((await archive.read(archivePathOf(index, skill, "SKILL.md"), BUNDLE_LIMITS.instructionBytes * 2)).toString("utf8")).body);
      const files: SkillFileDto[] = skill.listed.map((file) => ({
        path: file.path,
        bytes: file.bytes,
        kind: skillFileKind(file.path, file.executable),
      }));
      return {
        skill: skillDto(source, skill, deps.skills.listManaged(space, projectId)),
        source: sourceDto(space, source, index),
        instructions,
        files,
        url: folderUrl(location, skill.path, index.commit),
        ...(skill.allowedTools?.length ? { allowedTools: skill.allowedTools } : {}),
        ...(skill.disallowedTools?.length ? { disallowedTools: skill.disallowedTools } : {}),
      };
    },

    async file(space, id, path) {
      const { source, index, skill } = locate(space, id);
      const listed = skill.listed.find((file) => file.path === path);
      if (!listed) throw fail("not-found", "file not found");
      // Only what a preview can show is read: a font needs no decompressing.
      if (skillFileKind(path, listed.executable) === "binary") return { path, kind: "binary", bytes: listed.bytes };
      const bytes = await withArchive(space, source, index, (archive) =>
        archive.read(archivePathOf(index, skill, path), BUNDLE_LIMITS.fileBytes));
      return previewFile(path, bytes, listed.executable);
    },

    async install(space, input) {
      const located = locate(space, input.id);
      if (located.skill.contentHash !== input.contentHash) {
        throw fail("conflict", "This skill changed since you opened it; review it again");
      }
      return installIndexed(space, located, input.scope, input.projectId, input.replace);
    },

    async update(space, scope, name, projectId) {
      const stored = deps.skills.listManaged(space, projectId).find((skill) =>
        skill.name === name && skill.scope === scope && (scope === "space" || skill.projectId === projectId));
      if (stored?.origin?.kind !== "catalog") throw fail("not-found", "this skill did not come from the catalog");
      const located = locate(space, `${stored.origin.sourceId}:${stored.origin.path}`);
      return installIndexed(space, located, scope, projectId, undefined);
    },

    async addSource(space, url) {
      if (!roleAtLeast(space.role, "admin")) throw fail("forbidden", "only a Space admin can add sources");
      const normalized = normalizeSkillSourceUrl(url);
      const location = repositoryLocation(normalized);
      const identity = `${location.host}/${location.repository}@${location.ref}`.toLowerCase();
      const sources = allSources(space);
      const same = sources.find((source) => {
        const other = repositoryLocation(source.url);
        return `${other.host}/${other.repository}@${other.ref}`.toLowerCase() === identity;
      });
      if (same) throw fail("conflict", `${same.label} is already a source`);
      const custom = readCustom(space);
      if (custom.length >= MAX_CUSTOM_SOURCES) throw fail("invalid-input", `A Space can add at most ${MAX_CUSTOM_SOURCES} sources`);
      const source: SourceConfig = {
        id: `s-${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`,
        label: location.repository,
        url: location.ref === "HEAD" ? location.webUrl : normalized,
        builtin: false,
      };
      // Read it first: a repository with no skills, or one that cannot be
      // reached, is reported here and leaves nothing behind.
      let found: number;
      try {
        await acquire();
        try {
          found = await syncSource(space, source);
        } finally {
          release();
        }
      } catch (cause) {
        rmSync(sourceDir(space, source.id), { recursive: true, force: true });
        throw fail((cause as { httpStatus?: number }).httpStatus === 404 ? "not-found" : "invalid-input", readableFailure(cause));
      }
      if (found === 0) {
        rmSync(sourceDir(space, source.id), { recursive: true, force: true });
        throw fail("invalid-input", `No skills found in ${location.repository}. A skill is a folder with a SKILL.md file.`);
      }
      writeCustom(space, [...custom, source]);
      return sourceDto(space, source, readIndex(space, source.id));
    },

    async removeSource(space, id) {
      if (!roleAtLeast(space.role, "admin")) throw fail("forbidden", "only a Space admin can remove sources");
      if (BUILTIN_SKILL_SOURCES.some((source) => source.id === id)) throw fail("invalid-input", "this source comes with Polyth");
      const custom = readCustom(space);
      const kept = custom.filter((source) => source.id !== id);
      if (kept.length === custom.length) return false;
      writeCustom(space, kept);
      // Installed copies keep their files: removing a source removes the offer.
      rmSync(sourceDir(space, id), { recursive: true, force: true });
      indexCache.delete(`${space.spaceId}\0${id}`);
      failures.delete(`${space.spaceId}\0${id}`);
      return true;
    },

    async refresh(space, id) {
      if (space.role === "viewer") throw fail("forbidden", "insufficient role to refresh sources");
      const sources = id ? [sourceOf(space, id)] : allSources(space);
      for (const source of sources) {
        failures.delete(`${space.spaceId}\0${source.id}`);
        void startSync(space, source);
      }
    },

    originState(space, skill) {
      if (skill.origin?.kind !== "catalog") return { updateAvailable: false };
      const { sourceId, path, contentHash } = skill.origin;
      const index = readIndex(space, sourceId);
      const current = index?.skills.find((candidate) => candidate.path === path);
      return {
        ...(current ? { catalogId: `${sourceId}:${path}` } : {}),
        ...(index?.avatar ? { avatar: index.avatar } : {}),
        updateAvailable: Boolean(current && current.contentHash !== contentHash && !current.tooLarge),
      };
    },

    async idle() {
      while (running.size) await Promise.all(running.values());
    },
  };
}

function readableFailure(cause: unknown): string {
  const status = (cause as { httpStatus?: number } | null)?.httpStatus;
  if (status === 404) return "Repository not found. It may be private or the address may be wrong.";
  if (status === 403 || status === 429) return "The repository host refused this request for now.";
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.length > 200 ? `${message.slice(0, 199)}…` : message;
}
