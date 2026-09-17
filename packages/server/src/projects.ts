// JSON-file backed project registry. M1-simple; swap for sqlite projection later.
// Writes are atomic (tmp + rename). A corrupt on-disk file is never overwritten
// with defaults on load — boot with an empty in-memory registry and leave the
// file untouched until a deliberate user write succeeds.
import { readFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { atomicWriteSync } from "@polyth/plugins";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import type {
  Project,
  ProjectPatch,
  ProjectRemote,
  ProjectService,
  SpaceContext,
} from "@polyth/contracts";

interface PackageWorkspaceMarker {
  kind: "package-workspace";
  packageId: string;
}

type StoredProject = Project & { internal?: PackageWorkspaceMarker };

export interface ProjectProvisionInput {
  id: string;
  spaceId: string;
  path: string;
  name?: string;
  createDirectory?: boolean;
  remote?: ProjectRemote;
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
  /** Boot migration: stamp ownerless projects with the default Space. */
  adoptIntoSpace(spaceId: string): number;
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
const IMAGE_ICON = /^data:(image\/(?:png|svg\+xml|x-icon|vnd\.microsoft\.icon))(?:;charset=utf-8)?;base64,([A-Za-z0-9+/]+={0,2})$/i;
const PROJECT_ICON_PATH = /^\/assets\/project-icons\/[a-z0-9]+(?:-[a-z0-9]+)*\.svg$/;
const HARNESS_ID = /^[a-z][a-z0-9-]*$/;
const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CANONICAL_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

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
  const { internal: _internal, ...visible } = project;
  return { ...visible };
};

export function createProjectService(
  dataDir: string,
  opts: { onRemoved?: (project: Project) => void | Promise<void> } = {},
): ProjectRegistry {
  const file = `${dataDir}/projects.json`;
  let items: StoredProject[] = [];
  // An unreadable registry means the in-memory list is empty because we could
  // not read it, not because there are no projects. The first write would
  // otherwise replace the user's entire project registry with `[]`.
  let unreadable = false;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as StoredProject[];
    items = parsed;
  } catch (err) {
    // Missing file = first run. Anything else (corrupt JSON, unreadable) keeps
    // empty in-memory state and does NOT rewrite the file with defaults.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" && existsSync(file)) {
      unreadable = true;
      console.warn("[polyth] projects.json is unreadable; starting with an empty registry (file left untouched)");
    }
  }

  const persist = () => {
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
    atomicWriteSync(file, JSON.stringify(items, null, 2));
  };

  const add = async (
    path: string,
    name?: string,
    spaceId?: string,
    id = randomUUID(),
  ): Promise<Project> => {
    const abs = resolve(path);
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
      createdAt: Date.now(),
      ...(spaceId ? { spaceId } : {}),
    };
    items.push(project);
    try { persist(); }
    catch (cause) {
      items = items.filter((candidate) => candidate !== project);
      throw cause;
    }
    return publicProject(project);
  };

  const addRemote = async (
    path: string,
    remote: ProjectRemote,
    name?: string,
    spaceId?: string,
    id = randomUUID(),
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
    items.push(project);
    try { persist(); }
    catch (cause) {
      items = items.filter((candidate) => candidate !== project);
      throw cause;
    }
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
      add: (path, name) => add(path, name, spaceId),
      async create(path, name) {
        const abs = resolve(path);
        mkdirSync(abs, { recursive: true });
        return add(abs, name, spaceId);
      },
      async remove(id) {
        const stored = requireUserProject(id);
        const project = publicProject(stored);
        const previous = items;
        items = items.filter((p) => p.id !== id);
        try { persist(); }
        catch (cause) {
          items = previous;
          throw cause;
        }
        try {
          await opts.onRemoved?.(project);
        } catch (cause) {
          console.warn(`[polyth] project cleanup skipped for ${project.id}`, cause);
        }
      },
      addRemote: (path, remote, name) => addRemote(path, remote, name, spaceId),

      async update(id, patch: ProjectPatch): Promise<Project> {
        const project = requireUserProject(id);
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
          const defaults = { ...patch.defaults };
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
        persist();
        return publicProject(project);
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
        if (input.createDirectory) throw Object.assign(new Error("remote provisioning cannot create a local directory"), { code: "invalid-input" });
        return addRemote(input.path, input.remote, input.name, input.spaceId, input.id);
      }
      const path = resolve(input.path);
      if (input.createDirectory) mkdirSync(path, { recursive: true });
      return add(path, input.name, input.spaceId, input.id);
    },
    spaceOfProject: (id) => items.find((p) => p.id === id)?.spaceId,
    adoptIntoSpace(spaceId) {
      const orphans = items.filter((p) => !p.spaceId && !isPackageWorkspace(p));
      if (orphans.length === 0) return 0;
      for (const project of orphans) project.spaceId = spaceId;
      persist();
      return orphans.length;
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
          existing.path = path;
          persist();
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
      items.push(project);
      persist();
      return publicProject(project);
    },
  };
}
