// JSON-file backed project registry. M1-simple; swap for sqlite projection later.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Project,
  ProjectPatch,
  ProjectRemote,
  ProjectService,
  SpaceContext,
} from "@polyth/contracts";

/** Project registry with tenancy. `ProjectService` methods on this object are
 *  the UNSCOPED, server-internal view: the runtime pool and session service
 *  resolve a project by id after tenancy was already checked upstream.
 *
 *  Everything that serves a request must go through `forSpace(ctx)`, which
 *  returns a ProjectService that cannot see or touch another Space's rows. */
export interface ProjectRegistry extends ProjectService {
  forSpace(ctx: Pick<SpaceContext, "spaceId">): ProjectService;
  /** Owning Space of a project id, or undefined for unknown / pre-tenancy. */
  spaceOfProject(id: string): string | undefined;
  /** Boot migration: stamp ownerless projects with the default Space. */
  adoptIntoSpace(spaceId: string): number;
}

const MAX_PROJECT_ICON_BYTES = 512 * 1024;
const IMAGE_ICON = /^data:(image\/(?:png|svg\+xml|x-icon|vnd\.microsoft\.icon));base64,([A-Za-z0-9+/]+={0,2})$/;
const PROJECT_ICON_PATH = /^\/assets\/project-icons\/[a-z0-9]+(?:-[a-z0-9]+)*\.svg$/;

function validProjectIcon(icon: string): boolean {
  if (PROJECT_ICON_PATH.test(icon)) return true;
  if (!icon.startsWith("data:")) return icon.length <= 16;
  const match = icon.match(IMAGE_ICON);
  if (!match) return false;
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length === 0 || bytes.length > MAX_PROJECT_ICON_BYTES) return false;
  const mime = match[1]!;
  if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/x-icon" || mime === "image/vnd.microsoft.icon") {
    return bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0;
  }
  const svg = bytes.toString("utf8");
  // SVG namespace declarations commonly contain the W3C URL; they are not
  // resource fetches and remain safe to accept. All other remote/data URLs
  // are refused so an uploaded icon cannot pull in active external content.
  const svgWithoutNamespaces = svg.replace(/\sxmlns(?::[\w-]+)?\s*=\s*["']https?:\/\/www\.w3\.org\/[^"']*["']/gi, "");
  return /<svg[\s>]/i.test(svg)
    && !/<\/?(?:script|foreignObject)\b/i.test(svg)
    && !/\son\w+\s*=/i.test(svg)
    && !/(?:javascript:|https?:|\bdata:)/i.test(svgWithoutNamespaces);
}

export function createProjectService(dataDir: string): ProjectRegistry {
  const file = `${dataDir}/projects.json`;
  let items: Project[] = [];
  try {
    items = JSON.parse(readFileSync(file, "utf8"));
  } catch { /* first run */ }

  const persist = () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(items, null, 2));
  };
  // `spaceId` is threaded through the private helpers rather than read from a
  // caller-supplied field: a scoped view binds it, the unscoped view leaves it
  // undefined, and no request path can choose it.
  const add = async (path: string, name?: string, spaceId?: string): Promise<Project> => {
    const abs = resolve(path);
    if (!existsSync(abs)) throw Object.assign(new Error(`path does not exist: ${abs}`), { code: "invalid-path" });
    // Two Spaces may legitimately register the same directory; only a
    // same-Space duplicate is deduplicated.
    const existing = items.find((p) => p.path === abs && p.spaceId === spaceId);
    if (existing) return existing;
    const project: Project = {
      id: randomUUID(),
      path: abs,
      name: name || basename(abs),
      createdAt: Date.now(),
      ...(spaceId ? { spaceId } : {}),
    };
    items.push(project);
    persist();
    return project;
  };

  // One code path serves both views. `spaceId === undefined` is the unscoped
  // server-internal view; a bound spaceId is the request-facing view, and a
  // row belonging to another Space is indistinguishable from a row that does
  // not exist (`not-found`, never `forbidden`) so ids cannot be probed.
  const view = (spaceId?: string): ProjectService => {
    const visible = (p: Project): boolean => spaceId === undefined || p.spaceId === spaceId;
    const find = (id: string): Project | undefined => {
      const project = items.find((p) => p.id === id);
      return project && visible(project) ? project : undefined;
    };
    const require_ = (id: string): Project => {
      const project = find(id);
      if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
      return project;
    };

    return {
      list: async () => items.filter(visible).map((p) => ({ ...p })),
      get: async (id) => find(id),
      add: (path, name) => add(path, name, spaceId),
      async create(path, name) {
        const abs = resolve(path);
        mkdirSync(abs, { recursive: true });
        return add(abs, name, spaceId);
      },
      async remove(id) {
        // A delete that names another tenant's project must not silently
        // succeed either — it removes nothing and says not-found.
        require_(id);
        items = items.filter((p) => p.id !== id);
        persist();
      },

      // Remote-bound project: `path` lives on the machine behind `remote`, so
      // the local existence check does not apply. Callers (the SSH routes)
      // validate the path on the remote host before registering.
      async addRemote(path, remote: ProjectRemote, name?: string): Promise<Project> {
        if (!path.startsWith("/")) {
          throw Object.assign(new Error("remote path must be absolute"), { code: "invalid-input" });
        }
        const existing = items.find((p) =>
          p.path === path && p.remote?.connectionId === remote.connectionId && p.spaceId === spaceId);
        if (existing) return existing;
        const project: Project = {
          id: randomUUID(),
          path,
          name: name || basename(path) || path,
          createdAt: Date.now(),
          ...(spaceId ? { spaceId } : {}),
          remote: { kind: remote.kind, connectionId: remote.connectionId },
        };
        items.push(project);
        persist();
        return project;
      },

      async update(id, patch: ProjectPatch): Promise<Project> {
        const project = require_(id);
        if (patch.name !== undefined) {
          if (typeof patch.name !== "string") throw Object.assign(new Error("name must be text"), { code: "invalid-input" });
          const name = patch.name.trim();
          if (!name || name.length > 120) throw Object.assign(new Error("name required (\u2264120 chars)"), { code: "invalid-input" });
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
          if (!validProjectIcon(patch.icon)) {
            throw Object.assign(new Error("icon must be a short glyph or a safe SVG, ICO, or PNG under 512 KiB"), { code: "invalid-input" });
          }
          if (patch.icon === "") delete project.icon;
          else project.icon = patch.icon;
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
          // shallow-merge defaults so a partial patch never wipes other defaults
          project.defaults = { ...project.defaults, ...patch.defaults };
        }
        persist();
        return project;
      },
    };
  };

  return {
    ...view(undefined),
    forSpace: (ctx) => view(ctx.spaceId),
    spaceOfProject: (id) => items.find((p) => p.id === id)?.spaceId,
    adoptIntoSpace(spaceId) {
      const orphans = items.filter((p) => !p.spaceId);
      if (orphans.length === 0) return 0;
      for (const project of orphans) project.spaceId = spaceId;
      persist();
      return orphans.length;
    },
  };
}
