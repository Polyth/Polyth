// JSON-file backed project registry. M1-simple; swap for sqlite projection later.
// Writes are atomic (tmp + rename). A corrupt on-disk file is never overwritten
// with defaults on load — boot with an empty in-memory registry and leave the
// file untouched until a deliberate user write succeeds.
import { execFile } from "node:child_process";
import { readFileSync, mkdirSync, existsSync, renameSync, realpathSync, statSync } from "node:fs";
import { atomicWriteSync } from "@polyth/plugins/atomic-write";
import { GIT_BINARY_ENV, resolveExecutable } from "@polyth/kernel/executable";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { PROJECT_PRESENTATION_SETTING_KEYS } from "@polyth/contracts";
import { parseProjectComposition } from "@polyth/contracts/project-composition";
import type { ProjectRepository } from "@polyth/contracts/workspace";
import type {
  JsonValue,
  Project,
  ProjectPatch,
  ProjectComposition,
  ProjectPresentationSettingsDto,
  ProjectRemote,
  ProjectService,
  SpaceContext,
} from "@polyth/contracts";

interface PackageWorkspaceMarker {
  kind: "package-workspace";
  packageId: string;
}

type StoredProject = Project & {
  internal?: PackageWorkspaceMarker;
  /** Principal whose personal project this is (`Project.personal`). */
  personalOwner?: string;
  presentation?: StoredProjectPresentationSettings;
  repositoryIdentities?: Record<string, string[]>;
};

interface StoredProjectPresentationSettings {
  revision: number;
  updatedAt: number;
  settings: Record<string, JsonValue>;
}

export interface ProjectProvisionInput {
  id: string;
  spaceId: string;
  path: string;
  name?: string;
  createDirectory?: boolean;
  remote?: ProjectRemote;
  /** Provision `ownerId`'s personal project (local, directory created). */
  personalOwner?: string;
}

/** Project registry with tenancy. `ProjectService` methods on this object are
 *  the UNSCOPED, server-internal view: the runtime pool and session service
 *  resolve a project by id after tenancy was already checked upstream.
 *
 *  Everything that serves a request must go through `forSpace(ctx)`, which
 *  returns a ProjectService that cannot see or touch another Space's rows. */
export interface ProjectRegistry extends ProjectService {
  forSpace(ctx: Pick<SpaceContext, "spaceId">): ProjectService;
  /** Canonical provisioning seam. The control plane reserves `id` before this
   * domain write; request-facing code must never accept the id from a client. */
  provision(input: ProjectProvisionInput): Promise<Project>;
  /** Owning Space of a project id, or undefined for unknown / pre-tenancy. */
  spaceOfProject(id: string): string | undefined;
  /** A person's personal project in one Space, if it was provisioned. */
  personalProject(spaceId: string, ownerId: string): Project | undefined;
  /** Whether a local path lies in personal-project storage, which only
   *  `provision({ personalOwner })` may register. Existence never matters. */
  reservedForPersonal(path: string): boolean;
  /** Boot migration: stamp ownerless projects with the default Space. */
  adoptIntoSpace(spaceId: string): number;
  /** Boot migration for renamed packages (`polyth.formerIds`): a project's
   *  include/exclude choice saved under a former id moves to the current id,
   *  unless the project already has a choice for it. Returns the projects
   *  changed. Package workspaces keep their recorded package id. */
  renamePackageChoices(renames: ReadonlyArray<{ id: string; formerIds: readonly string[] }>): number;
  /**
   * Server/package-system seam. Package workspaces are persisted runtime
   * anchors: `get()` can resolve them for sessions/runtimes, while `list()`
   * deliberately never exposes them as user projects.
   */
  ensurePackageWorkspace(input: {
    spaceId: string;
    packageId: string;
    path: string;
  }): Promise<Project>;
}

const MAX_PROJECT_ICON_BYTES = 512 * 1024;
/** Tells the personal project apart once real projects sit beside it. */
const PERSONAL_PROJECT_ICON = "/assets/project-icons/user.svg";
const IMAGE_ICON = /^data:(image\/(?:png|svg\+xml|x-icon|vnd\.microsoft\.icon))(?:;charset=utf-8)?;base64,([A-Za-z0-9+/]+={0,2})$/i;
const PROJECT_ICON_PATH = /^\/assets\/project-icons\/[a-z0-9]+(?:-[a-z0-9]+)*\.svg$/;
const HARNESS_ID = /^[a-z][a-z0-9-]*$/;
const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CANONICAL_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const MAX_PROJECT_PRESENTATION_BYTES = 256 * 1024;
const PROJECT_PRESENTATION_KEYS = new Set<string>(PROJECT_PRESENTATION_SETTING_KEYS);
const MAX_PROJECT_REPOSITORIES = 32;
const MAX_PROJECT_GREETING = 160;
const MAX_REPOSITORY_ALIAS_LENGTH = 80;

function invalidRepository(message: string, code: string = "invalid-input"): Error {
  return Object.assign(new Error(message), { code });
}

function repositoryAlias(value: unknown, fallback: string): string {
  if (value === undefined) return fallback.slice(0, MAX_REPOSITORY_ALIAS_LENGTH);
  if (typeof value !== "string") throw invalidRepository("repository alias must be text");
  const alias = value.trim();
  if (!alias || alias.length > MAX_REPOSITORY_ALIAS_LENGTH) {
    throw invalidRepository(`repository alias required (≤${MAX_REPOSITORY_ALIAS_LENGTH} chars)`);
  }
  return alias;
}

function existingRepositoryRows(project: Project): ProjectRepository[] {
  if (project.repositories === undefined) {
    return [{ id: "primary", alias: project.name, path: project.path }];
  }
  if (!Array.isArray(project.repositories) || project.repositories.length === 0) {
    throw invalidRepository("project repositories must be a non-empty list");
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  return project.repositories.map((repository, index) => {
    if (!repository || typeof repository !== "object"
      || typeof repository.id !== "string" || !repository.id
      || typeof repository.alias !== "string" || !repository.alias
      || typeof repository.path !== "string" || !repository.path) {
      throw invalidRepository(`project repository ${index} is invalid`);
    }
    if (ids.has(repository.id)) throw invalidRepository(`duplicate project repository id: ${repository.id}`);
    if (paths.has(repository.path)) throw invalidRepository(`duplicate project repository path: ${repository.path}`);
    ids.add(repository.id);
    paths.add(repository.path);
    return { id: repository.id, alias: repository.alias, path: repository.path };
  });
}

function canonicalExistingPath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function primaryRepositoryId(project: Project, rows: readonly ProjectRepository[]): string {
  if (project.primaryRepositoryId !== undefined) {
    if (!rows.some((repository) => repository.id === project.primaryRepositoryId)) {
      throw invalidRepository("primary repository is not part of the project");
    }
    return project.primaryRepositoryId;
  }
  const matchingRoot = rows.filter((repository) => canonicalExistingPath(repository.path) === canonicalExistingPath(project.path));
  if (matchingRoot.length === 1) return matchingRoot[0]!.id;
  if (rows.length === 1) return rows[0]!.id;
  throw invalidRepository("project has no unambiguous primary repository");
}

function canonicalDirectory(path: unknown): string {
  if (typeof path !== "string" || !path.trim()) throw invalidRepository("repository path must be a non-empty path");
  let canonical: string;
  try { canonical = realpathSync(path); } catch { throw invalidRepository(`repository path does not exist: ${path}`, "invalid-path"); }
  try {
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
  } catch {
    throw invalidRepository(`repository path must be a local directory: ${path}`, "invalid-path");
  }
  return canonical;
}

function gitRepositoryRoot(path: string): Promise<string> {
  return new Promise((resolveRoot, reject) => {
    execFile(resolveExecutable("git", { overrideEnv: GIT_BINARY_ENV }), ["-C", path, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    }, (error, stdout) => {
      if (error || !String(stdout).trim()) {
        reject(invalidRepository("repository path must be a local Git repository"));
        return;
      }
      try {
        resolveRoot(realpathSync(String(stdout).trim()));
      } catch {
        reject(invalidRepository("Git repository root could not be resolved", "invalid-path"));
      }
    });
  });
}

/** Only opaque fingerprints are persisted. Remote URLs (including embedded
 * credentials) never enter a projected Project, error, or diagnostic. */
async function repositoryIdentity(root: string): Promise<string[]> {
  const run = (args: string[]) => new Promise<string>((done) => {
    execFile(resolveExecutable("git", { overrideEnv: GIT_BINARY_ENV }), ["-C", root, ...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } },
    (error, stdout) => done(error ? "" : String(stdout)));
  });
  const [roots, remotes] = await Promise.all([
    run(["rev-list", "--max-parents=0", "--all"]), run(["config", "--get-regexp", "^remote\\..*\\.url$"]),
  ]);
  const values = roots.split(/\s+/).filter((value) => /^[a-f0-9]{40,64}$/.test(value)).map((value) => `commit:${value}`);
  for (const line of remotes.split("\n")) {
    const raw = line.replace(/^\S+\s+/, "").trim();
    if (!raw) continue;
    let safe: string;
    try {
      const url = new URL(raw); url.username = ""; url.password = ""; url.search = ""; url.hash = "";
      safe = url.toString();
    } catch { safe = raw.replace(/^[^@/]+@/, ""); }
    values.push(`remote:${safe}`);
  }
  return [...new Set(values)].slice(0, 64).map((value) => createHash("sha256").update(value).digest("hex"));
}

const emptyPresentationSettings = (): ProjectPresentationSettingsDto => ({
  revision: 0,
  updatedAt: 0,
  settings: {},
});

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function presentationDto(value: unknown): ProjectPresentationSettingsDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyPresentationSettings();
  const stored = value as Partial<StoredProjectPresentationSettings>;
  const revision = stored.revision;
  const updatedAt = stored.updatedAt;
  if (typeof revision !== "number" || !Number.isFinite(revision)
    || typeof updatedAt !== "number" || !Number.isFinite(updatedAt)
    || !stored.settings || typeof stored.settings !== "object" || Array.isArray(stored.settings)) {
    return emptyPresentationSettings();
  }
  const settings: Partial<Record<typeof PROJECT_PRESENTATION_SETTING_KEYS[number], JsonValue>> = {};
  for (const [key, item] of Object.entries(stored.settings)) {
    if (PROJECT_PRESENTATION_KEYS.has(key) && isJsonValue(item)) {
      settings[key as typeof PROJECT_PRESENTATION_SETTING_KEYS[number]] = item;
    }
  }
  return {
    revision: Math.max(0, Math.trunc(revision)),
    updatedAt: Math.max(0, updatedAt),
    settings,
  };
}

function normalizeIncomingPresentationSettings(value: unknown): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("presentation settings must be an object"), { code: "invalid-input" });
  }
  const settings: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!PROJECT_PRESENTATION_KEYS.has(key)) {
      throw Object.assign(new Error(`unknown presentation setting: ${key}`), { code: "invalid-input" });
    }
    if (!isJsonValue(item)) {
      throw Object.assign(new Error(`presentation setting ${key} is not JSON`), { code: "invalid-input" });
    }
    settings[key] = item;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(settings);
  } catch {
    throw Object.assign(new Error("presentation settings must be JSON"), { code: "invalid-input" });
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_PROJECT_PRESENTATION_BYTES) {
    throw Object.assign(new Error("presentation settings exceed 256 KiB"), { code: "invalid-input" });
  }
  return settings;
}

function sanitizeProjectIconSvg(svg: string): string {
  return svg
    .replace(/^\uFEFF/, "")
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!doctype[\s\S]*?>/gi, "")
    .replace(/<(script|foreignObject)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/\sxmlns:xlink\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
    .replace(/\s(?:xlink:)?href\s*=\s*(?:"(?!#)[^"]*"|'(?!#)[^']*')/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
    .trim();
}

function ensureProjectIconSvgXmlns(svg: string): string {
  if (/\sxmlns\s*=\s*(["'])http:\/\/www\.w3\.org\/2000\/svg\1/i.test(svg)) return svg;
  return svg.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
}

function decodeIncomingSvgDataUrl(icon: string): string | null {
  const base64 = icon.match(/^data:image\/svg\+xml(?:;charset=utf-8)?;base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (base64) {
    const bytes = Buffer.from(base64[1]!, "base64");
    return bytes.length ? bytes.toString("utf8") : null;
  }
  const encoded = icon.match(/^data:image\/svg\+xml(?:;charset=utf-8)?,(.+)$/i);
  if (encoded) {
    try { return decodeURIComponent(encoded[1]!); } catch { return null; }
  }
  return null;
}

function normalizeIncomingProjectIcon(icon: string): string {
  const svg = decodeIncomingSvgDataUrl(icon);
  if (!svg) return icon;
  if (/<\/?(?:script|foreignObject)\b/i.test(svg) || /\son\w+\s*=/i.test(svg) || /javascript:/i.test(svg)) return icon;
  const clean = ensureProjectIconSvgXmlns(sanitizeProjectIconSvg(svg));
  if (!/<svg[\s>]/i.test(clean)) return icon;
  return `data:image/svg+xml;base64,${Buffer.from(clean).toString("base64")}`;
}

function validProjectIcon(icon: string): boolean {
  if (PROJECT_ICON_PATH.test(icon)) return true;
  if (!icon.startsWith("data:")) return icon.length <= 16;
  const match = icon.match(IMAGE_ICON);
  if (!match) return false;
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length === 0 || bytes.length > MAX_PROJECT_ICON_BYTES) return false;
  const mime = match[1]!.toLowerCase();
  if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/x-icon" || mime === "image/vnd.microsoft.icon") {
    return bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0;
  }
  const svg = bytes.toString("utf8");
  const svgWithoutNamespaces = svg.replace(/\sxmlns(?::[\w-]+)?\s*=\s*["']https?:\/\/www\.w3\.org\/[^"']*["']/gi, "");
  return /<svg[\s>]/i.test(svg)
    && !/<\/?(?:script|foreignObject)\b/i.test(svg)
    && !/\son\w+\s*=/i.test(svg)
    && !/(?:javascript:|https?:|\bdata:)/i.test(svgWithoutNamespaces);
}

const packageWorkspaceId = (spaceId: string, packageId: string): string =>
  `__polyth_pkg_${createHash("sha256").update(`${spaceId}\0${packageId}`).digest("hex").slice(0, 32)}`;

const isPackageWorkspace = (project: StoredProject): project is StoredProject & { internal: PackageWorkspaceMarker } =>
  project.internal?.kind === "package-workspace" && typeof project.internal.packageId === "string";

const publicProject = (project: StoredProject): Project => {
  const {
    internal: _internal,
    presentation: _presentation,
    repositoryIdentities: _repositoryIdentities,
    personalOwner: _personalOwner,
    ...visible
  } = project;
  return structuredClone(visible);
};

export function createProjectService(
  dataDir: string,
  opts: { onRemoved?: (project: Project) => void | Promise<void> } = {},
): ProjectRegistry {
  const file = `${dataDir}/projects.json`;
  const spacesRoots = [...new Set([resolve(dataDir, "spaces"), canonicalExistingPath(resolve(dataDir, "spaces"))])];
  /** `<data>/spaces/<space>/personal/…` holds personal projects only. The
   *  path is derived from a person's id, so letting anyone register it as an
   *  ordinary project would let a member squat on or probe another's folder.
   *  Refused before any existence check, so the answer never depends on it. */
  const insidePersonalStorage = (abs: string): boolean =>
    [abs, canonicalExistingPath(abs)].some((candidate) => spacesRoots.some((root) => {
      const rel = relative(root, candidate);
      return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && rel.split(sep)[1] === "personal";
    }));
  let items: StoredProject[] = [];
  // An unreadable registry means the in-memory list is empty because we could
  // not read it, not because there are no projects. The first write would
  // otherwise replace the user's entire project registry with `[]`.
  let unreadable = false;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as StoredProject[];
    if (!Array.isArray(parsed)) throw new Error("project registry must be an array");
    items = parsed;
  } catch (err) {
    // Missing file = first run. Anything else (corrupt JSON, unreadable) keeps
    // empty in-memory state and does NOT rewrite the file with defaults.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" && existsSync(file)) {
      unreadable = true;
      console.warn("[polyth] projects.json is unreadable; starting with an empty registry (file left untouched)");
    }
  }

  const persist = (next: StoredProject[] = items) => {
    mkdirSync(dirname(file), { recursive: true });
    if (unreadable) {
      // Keep whatever we could not parse: it is the only copy of the user's
      // project registry, and a human can still recover paths from it. Move it
      // aside once, then write normally from here on.
      const quarantine = `${file}.unreadable-${Date.now()}`;
      try {
        renameSync(file, quarantine);
        console.warn(`[polyth] preserved the unreadable project registry at ${quarantine}`);
      } catch (error) {
        throw Object.assign(
          new Error("the project registry is unreadable and could not be preserved; refusing to overwrite it"),
          { code: "conflict", cause: error },
        );
      }
      unreadable = false;
    }
    atomicWriteSync(file, JSON.stringify(next, null, 2));
    items = next;
  };
  // `spaceId` is threaded through the private helpers rather than read from a
  // caller-supplied field: a scoped view binds it, the unscoped view leaves it
  // undefined, and no request path can choose it.
  const add = async (
    path: string,
    name?: string,
    spaceId?: string,
    composition?: ProjectComposition,
    id: string = randomUUID(),
    personalOwner?: string,
  ): Promise<Project> => {
    const parsedComposition = composition === undefined ? undefined : parseProjectComposition(composition);
    const abs = resolve(path);
    if (!personalOwner && insidePersonalStorage(abs)) {
      throw Object.assign(new Error("this folder is reserved for a personal project"), { code: "invalid-path" });
    }
    if (!existsSync(abs)) throw Object.assign(new Error(`path does not exist: ${abs}`), { code: "invalid-path" });
    const existing = items.find((p) => !isPackageWorkspace(p) && p.path === abs && p.spaceId === spaceId);
    if (existing) return publicProject(existing);
    if (!CANONICAL_PROJECT_ID.test(id) || items.some((project) => project.id === id)) {
      throw Object.assign(new Error("project id already exists or is invalid"), { code: "conflict" });
    }
    const project: StoredProject = {
      id,
      path: abs,
      name: name || basename(abs),
      ...(parsedComposition ? { composition: parsedComposition } : {}),
      createdAt: Date.now(),
      ...(spaceId ? { spaceId } : {}),
      ...(personalOwner ? { personal: true as const, personalOwner, icon: PERSONAL_PROJECT_ICON } : {}),
    };
    persist([...items, project]);
    return publicProject(project);
  };

  const addRemote = async (
    path: string,
    remote: ProjectRemote,
    name?: string,
    spaceId?: string,
    id: string = randomUUID(),
  ): Promise<Project> => {
    if (!path.startsWith("/")) {
      throw Object.assign(new Error("remote path must be absolute"), { code: "invalid-input" });
    }
    const existing = items.find((p) =>
      !isPackageWorkspace(p)
      && p.path === path && p.remote?.connectionId === remote.connectionId && p.spaceId === spaceId);
    if (existing) return publicProject(existing);
    if (!CANONICAL_PROJECT_ID.test(id) || items.some((project) => project.id === id)) {
      throw Object.assign(new Error("project id already exists or is invalid"), { code: "conflict" });
    }
    const project: StoredProject = {
      id,
      path,
      name: name || basename(path) || path,
      createdAt: Date.now(),
      ...(spaceId ? { spaceId } : {}),
      remote: { kind: remote.kind, connectionId: remote.connectionId },
    };
    persist([...items, project]);
    return publicProject(project);
  };

  // One code path serves both views. `spaceId === undefined` is the unscoped
  // server-internal view; a bound spaceId is the request-facing view, and a
  // row belonging to another Space is indistinguishable from a row that does
  // not exist (`not-found`, never `forbidden`) so ids cannot be probed.
  const view = (spaceId?: string): ProjectService => {
    const visible = (p: StoredProject): boolean => spaceId === undefined || p.spaceId === spaceId;
    const find = (id: string): StoredProject | undefined => {
      const project = items.find((p) => p.id === id);
      return project && visible(project) ? project : undefined;
    };
    const requireUserProject = (id: string): StoredProject => {
      const project = find(id);
      if (!project || isPackageWorkspace(project)) {
        throw Object.assign(new Error("project not found"), { code: "not-found" });
      }
      return project;
    };

    return {
      list: async () => items
        .filter((project) => visible(project) && !isPackageWorkspace(project))
        .map(publicProject),
      get: async (id) => {
        const project = find(id);
        return project ? publicProject(project) : undefined;
      },
      async add(path: string, name?: string, composition?: ProjectComposition) {
        return add(path, name, spaceId, composition);
      },
      async create(path: string, name?: string, composition?: ProjectComposition) {
        if (composition !== undefined) parseProjectComposition(composition);
        const abs = resolve(path);
        mkdirSync(abs, { recursive: true });
        return add(abs, name, spaceId, composition);
      },
      async remove(id) {
        // A delete that names another tenant's project must not silently
        // succeed either — it removes nothing and says not-found. Internal
        // package workspaces cannot be removed through ProjectService.
        const project = publicProject(requireUserProject(id));
        persist(items.filter((p) => p.id !== id));
        // Project deletion is canonical even if best-effort auxiliary cleanup
        // fails. Stores also resolve only existing project IDs, so a failed hook
        // can leave at most unreachable garbage, never a cross-tenant reference.
        try {
          await opts.onRemoved?.(project);
        } catch (cause) {
          console.warn(`[polyth] project cleanup skipped for ${project.id}`, cause);
        }
      },
      // Remote-bound project: `path` lives on the machine behind `remote`, so
      // the local existence check does not apply. Callers (the SSH routes)
      // validate the path on the remote host before registering.
      addRemote: (path, remote, name) => addRemote(path, remote, name, spaceId),

      async update(id, patch: ProjectPatch): Promise<Project> {
        const existing = requireUserProject(id);
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
          throw Object.assign(new Error("project patch must be an object"), { code: "invalid-input" });
        }
        let project = structuredClone(existing);
        if (patch.repository !== undefined) {
          if (!patch.repository || typeof patch.repository !== "object" || Array.isArray(patch.repository)) {
            throw invalidRepository("repository patch must be an object");
          }
          if (project.remote) {
            throw invalidRepository("repository inventory is unsupported for remote projects", "unsupported");
          }
          const repositoryPatch = patch.repository;
          const rows = existingRepositoryRows(project);
          if (repositoryPatch.action === "add") {
            const requestedPath = canonicalDirectory(repositoryPatch.path);
            const root = await gitRepositoryRoot(requestedPath);
            const identity = await repositoryIdentity(root);
            // Git validation is the only awaited part of this mutation. A
            // project can be edited or deleted while it runs, so re-authorize
            // and clone the latest row immediately before synchronous work.
            const latest = requireUserProject(id);
            project = structuredClone(latest);
            const latestRows = existingRepositoryRows(project);
            const knownRoots = new Set([
              canonicalExistingPath(project.path),
              ...latestRows.map((repository) => canonicalExistingPath(repository.path)),
            ]);
            const alias = repositoryAlias(repositoryPatch.alias, basename(root) || root);
            // Repeating an add against the same canonical root is safe and
            // idempotent, including a symlink alias or a path inside the repo.
            if (!knownRoots.has(root)) {
              if (latestRows.length >= MAX_PROJECT_REPOSITORIES) {
                throw invalidRepository(`a project may contain at most ${MAX_PROJECT_REPOSITORIES} repositories`);
              }
              const rows = latestRows;
              const repositoryId = randomUUID();
              rows.push({ id: repositoryId, alias, path: root });
              project.repositoryIdentities = { ...project.repositoryIdentities, [repositoryId]: identity };
              project.repositories = rows;
              if (latest.repositories === undefined) project.primaryRepositoryId = "primary";
            }
          } else if (repositoryPatch.action === "rename") {
            if (typeof repositoryPatch.repositoryId !== "string" || !repositoryPatch.repositoryId) {
              throw invalidRepository("repository id must be a non-empty value");
            }
            const target = rows.find((repository) => repository.id === repositoryPatch.repositoryId);
            if (!target) throw invalidRepository("repository not found", "not-found");
            target.alias = repositoryAlias(repositoryPatch.alias, target.alias);
            project.repositories = rows;
          } else if (repositoryPatch.action === "make-primary") {
            if (!rows.some((row) => row.id === repositoryPatch.repositoryId)) throw invalidRepository("repository not found", "not-found");
            project.repositories = rows;
            // Existing sessions retain their saved execution anchor. The
            // legacy Project.path stays stable for old scalar consumers.
            project.legacyRepositoryId ??= primaryRepositoryId(project, rows);
            project.primaryRepositoryId = repositoryPatch.repositoryId;
          } else if (repositoryPatch.action === "relocate") {
            const target = rows.find((row) => row.id === repositoryPatch.repositoryId);
            if (!target) throw invalidRepository("repository not found", "not-found");
            const root = await gitRepositoryRoot(canonicalDirectory(repositoryPatch.path));
            const [oldIdentity, nextIdentity] = await Promise.all([
              project.repositoryIdentities?.[target.id]?.length ? Promise.resolve(project.repositoryIdentities[target.id]!) : repositoryIdentity(target.path),
              repositoryIdentity(root),
            ]);
            if (target.path !== root && !oldIdentity.some((value) => nextIdentity.includes(value))) {
              throw invalidRepository("Repository identity could not be verified. Choose the same repository or add it separately.");
            }
            const latest = requireUserProject(id);
            const latestRows = existingRepositoryRows(latest);
            const current = latestRows.find((row) => row.id === target.id);
            if (!current || current.path !== target.path) throw invalidRepository("repository changed while locating it; try again", "conflict");
            if (latestRows.some((row) => row.id !== target.id && canonicalExistingPath(row.path) === root)) throw invalidRepository("repository path is already registered");
            project = structuredClone(latest);
            current.path = root;
            project.repositories = latestRows;
            project.repositoryIdentities = { ...project.repositoryIdentities, [target.id]: nextIdentity };
          } else if (repositoryPatch.action === "remove") {
            if (typeof repositoryPatch.repositoryId !== "string" || !repositoryPatch.repositoryId) {
              throw invalidRepository("repository id must be a non-empty value");
            }
            const target = rows.find((repository) => repository.id === repositoryPatch.repositoryId);
            if (!target) throw invalidRepository("repository not found", "not-found");
            const primaryId = primaryRepositoryId(project, rows);
            if (target.id === primaryId) {
              throw invalidRepository("the primary repository cannot be removed");
            }
            project.repositories = rows.filter((repository) => repository.id !== target.id);
            if (project.repositoryIdentities) delete project.repositoryIdentities[target.id];
          } else {
            throw invalidRepository("unknown repository action");
          }
        }
        if (patch.composition !== undefined) {
          if (patch.composition === null) delete project.composition;
          else project.composition = parseProjectComposition(patch.composition);
        }
        if (patch.name !== undefined) {
          if (typeof patch.name !== "string") throw Object.assign(new Error("name must be text"), { code: "invalid-input" });
          const name = patch.name.trim();
          if (!name || name.length > 120) throw Object.assign(new Error("name required (≤120 chars)"), { code: "invalid-input" });
          project.name = name;
        }
        if (patch.color !== undefined) {
          if (typeof patch.color !== "string") throw Object.assign(new Error("color must be text"), { code: "invalid-input" });
          if (patch.color !== "" && !/^#[0-9a-fA-F]{3,8}$/.test(patch.color)) {
            throw Object.assign(new Error("color must be a hex value"), { code: "invalid-input" });
          }
          if (patch.color === "") delete project.color;
          else project.color = patch.color;
        }
        if (patch.icon !== undefined) {
          if (typeof patch.icon !== "string") throw Object.assign(new Error("icon must be text"), { code: "invalid-input" });
          const icon = normalizeIncomingProjectIcon(patch.icon);
          if (!validProjectIcon(icon)) {
            throw Object.assign(new Error("icon must be a short glyph or a safe SVG, ICO, or PNG under 512 KiB"), { code: "invalid-input" });
          }
          if (icon === "") delete project.icon;
          else project.icon = icon;
        }
        if (patch.greeting !== undefined) {
          if (patch.greeting === null) delete project.greeting;
          else {
            if (typeof patch.greeting !== "string") throw Object.assign(new Error("greeting must be text or null"), { code: "invalid-input" });
            const greeting = patch.greeting.replace(/\s+/g, " ").trim();
            if (greeting.length > MAX_PROJECT_GREETING) {
              throw Object.assign(new Error(`greeting must be at most ${MAX_PROJECT_GREETING} chars`), { code: "invalid-input" });
            }
            project.greeting = greeting;
          }
        }
        if (patch.defaults !== undefined) {
          if (!patch.defaults || typeof patch.defaults !== "object" || Array.isArray(patch.defaults)) {
            throw Object.assign(new Error("defaults must be an object"), { code: "invalid-input" });
          }
          if (
            patch.defaults.rememberModelSelection !== undefined
            && typeof patch.defaults.rememberModelSelection !== "boolean"
          ) {
            throw Object.assign(new Error("rememberModelSelection must be boolean"), { code: "invalid-input" });
          }
          if (
            patch.defaults.isolation !== undefined
            && patch.defaults.isolation !== "off" && patch.defaults.isolation !== "workspace"
          ) {
            throw Object.assign(new Error("defaults.isolation must be off or workspace"), { code: "invalid-input" });
          }
          if (patch.defaults.isolateByDefault !== undefined && typeof patch.defaults.isolateByDefault !== "boolean") {
            throw Object.assign(new Error("defaults.isolateByDefault must be boolean"), { code: "invalid-input" });
          }
          const harness = patch.defaults.harness;
          if (harness !== undefined && harness !== null && (
            !harness || typeof harness !== "object"
            || (harness.mode !== "auto" && (harness.mode !== "pinned" || typeof harness.harnessId !== "string" || !HARNESS_ID.test(harness.harnessId)))
          )) {
            throw Object.assign(new Error("defaults.harness must be inherit, Auto, or a registered harness selection"), { code: "invalid-input" });
          }
          if (patch.defaults.agentProfileId !== undefined && patch.defaults.agentProfileId !== null && typeof patch.defaults.agentProfileId !== "string") {
            throw Object.assign(new Error("defaults.agentProfileId must be a profile id or null"), { code: "invalid-input" });
          }
          // Harness-qualified model refs are a client-side catalog identity.
          // ProjectDefaults stores that identity canonically as ModelRef + the
          // separate harness selection, so never persist harnessId inside model.
          const defaults = structuredClone(patch.defaults);
          const model = defaults.model as ({ providerID: string; modelID: string; harnessId?: unknown } | null | undefined);
          if (model?.harnessId !== undefined) {
            const harnessId = model.harnessId;
            if (typeof harnessId !== "string" || !HARNESS_ID.test(harnessId)) {
              throw Object.assign(new Error("defaults.model.harnessId must be a valid harness id"), { code: "invalid-input" });
            }
            defaults.model = { providerID: model.providerID, modelID: model.modelID };
            if (defaults.harness === undefined) defaults.harness = { mode: "pinned", harnessId };
          }
          project.defaults = { ...project.defaults, ...defaults };
        }
        persist(items.map((candidate) => candidate === existing ? project : candidate));
        return publicProject(project);
      },
      async getPresentationSettings(id): Promise<ProjectPresentationSettingsDto> {
        return presentationDto(requireUserProject(id).presentation);
      },
      async putPresentationSettings(id, input, expectedRevision): Promise<ProjectPresentationSettingsDto> {
        const existing = requireUserProject(id);
        const project = structuredClone(existing);
        const settings = normalizeIncomingPresentationSettings(input);
        const current = presentationDto(project.presentation);
        if (expectedRevision !== undefined) {
          if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
            throw Object.assign(new Error("expected revision must be a non-negative integer"), { code: "invalid-input" });
          }
          if (current.revision !== expectedRevision) {
            throw Object.assign(new Error("project presentation changed; refresh and retry"), { code: "conflict" });
          }
        }
        const next: StoredProjectPresentationSettings = {
          revision: current.revision + 1,
          updatedAt: Date.now(),
          settings,
        };
        project.presentation = next;
        persist(items.map((candidate) => candidate === existing ? project : candidate));
        return { ...next, settings: { ...next.settings } };
      },
    };
  };

  return {
    ...view(undefined),
    forSpace: (ctx) => view(ctx.spaceId),
    async provision(input) {
      if (!input.spaceId || !CANONICAL_PROJECT_ID.test(input.id)) {
        throw Object.assign(new Error("canonical project id and Space are required"), { code: "invalid-input" });
      }
      if (input.remote) {
        if (input.personalOwner) throw Object.assign(new Error("a personal project is local"), { code: "invalid-input" });
        if (input.createDirectory) throw Object.assign(new Error("remote provisioning cannot create a local directory"), { code: "invalid-input" });
        return addRemote(input.path, input.remote, input.name, input.spaceId, input.id);
      }
      const path = resolve(input.path);
      if (input.personalOwner) {
        const existing = items.find((p) => p.personalOwner === input.personalOwner && p.spaceId === input.spaceId);
        if (existing) return publicProject(existing);
        if (items.some((p) => p.path === path && p.spaceId === input.spaceId)) {
          throw Object.assign(new Error("personal project path is already registered"), { code: "conflict" });
        }
      }
      if (input.createDirectory || input.personalOwner) mkdirSync(path, { recursive: true });
      return add(path, input.name, input.spaceId, undefined, input.id, input.personalOwner);
    },
    spaceOfProject: (id) => items.find((p) => p.id === id)?.spaceId,
    reservedForPersonal: (path) => insidePersonalStorage(resolve(path)),
    personalProject(spaceId, ownerId) {
      const project = items.find((p) => p.personalOwner === ownerId && p.spaceId === spaceId);
      return project ? publicProject(project) : undefined;
    },
    adoptIntoSpace(spaceId) {
      const orphans = items.filter((p) => !p.spaceId && !isPackageWorkspace(p));
      if (orphans.length === 0) return 0;
      const orphanIds = new Set(orphans.map((project) => project.id));
      persist(items.map((project) => orphanIds.has(project.id) ? { ...project, spaceId } : project));
      return orphans.length;
    },
    renamePackageChoices(renames) {
      let changed = 0;
      const next = items.map((project) => {
        const overrides = project.composition?.packageOverrides;
        if (!overrides) return project;
        let moved: Record<string, "include" | "exclude"> | undefined;
        for (const { id, formerIds } of renames) {
          for (const former of formerIds) {
            if (!Object.hasOwn(moved ?? overrides, former)) continue;
            moved ??= { ...overrides };
            if (!Object.hasOwn(moved, id)) moved[id] = moved[former]!;
            delete moved[former];
          }
        }
        if (!moved) return project;
        changed += 1;
        return { ...project, composition: { ...project.composition!, packageOverrides: moved } };
      });
      if (changed > 0) persist(next);
      return changed;
    },
    async ensurePackageWorkspace(input) {
      if (!input.spaceId) throw Object.assign(new Error("spaceId is required"), { code: "invalid-input" });
      if (!PACKAGE_ID.test(input.packageId)) {
        throw Object.assign(new Error("invalid package id"), { code: "invalid-input" });
      }
      const path = resolve(input.path);
      mkdirSync(path, { recursive: true });
      const existing = items.find((project) =>
        isPackageWorkspace(project)
        && project.spaceId === input.spaceId
        && project.internal.packageId === input.packageId);
      if (existing) {
        if (existing.path !== path) {
          const updated = { ...existing, path };
          persist(items.map((project) => project === existing ? updated : project));
          return publicProject(updated);
        }
        return publicProject(existing);
      }
      const project: StoredProject = {
        id: packageWorkspaceId(input.spaceId, input.packageId),
        path,
        name: `${input.packageId} workspace`,
        spaceId: input.spaceId,
        createdAt: Date.now(),
        internal: { kind: "package-workspace", packageId: input.packageId },
      };
      const collision = items.find((candidate) => candidate.id === project.id);
      if (collision) {
        throw Object.assign(new Error("package workspace id collision"), { code: "conflict" });
      }
      persist([...items, project]);
      return publicProject(project);
    },
  };
}
