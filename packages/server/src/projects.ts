// JSON-file backed project registry. M1-simple; swap for sqlite projection later.
// Writes are atomic (tmp + rename). A corrupt on-disk file is never overwritten
// with defaults on load — boot with an empty in-memory registry and leave the
// file untouched until a deliberate user write succeeds.
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Project, ProjectPatch, ProjectRemote, ProjectService } from "@polyth/contracts";

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

function atomicWriteSync(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, "utf8");
  try {
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

export function createProjectService(dataDir: string): ProjectService {
  const file = `${dataDir}/projects.json`;
  let items: Project[] = [];
  try {
    items = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    // Missing file = first run. Anything else (corrupt JSON, unreadable) keeps
    // empty in-memory state and does NOT rewrite the file with defaults.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" && existsSync(file)) {
      console.warn("[polyth] projects.json is unreadable; starting with an empty registry (file left untouched)");
    }
  }

  const persist = () => {
    mkdirSync(dirname(file), { recursive: true });
    atomicWriteSync(file, JSON.stringify(items, null, 2));
  };
  const add = async (path: string, name?: string): Promise<Project> => {
    const abs = resolve(path);
    if (!existsSync(abs)) throw Object.assign(new Error(`path does not exist: ${abs}`), { code: "invalid-path" });
    const existing = items.find((p) => p.path === abs);
    if (existing) return existing;
    const project: Project = { id: randomUUID(), path: abs, name: name || basename(abs), createdAt: Date.now() };
    items.push(project);
    persist();
    return project;
  };

  return {
    list: async () => [...items],
    get: async (id) => items.find((p) => p.id === id),
    add,
    async create(path, name) {
      const abs = resolve(path);
      mkdirSync(abs, { recursive: true });
      return add(abs, name);
    },
    async remove(id) {
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
        p.path === path && p.remote?.connectionId === remote.connectionId);
      if (existing) return existing;
      const project: Project = {
        id: randomUUID(),
        path,
        name: name || basename(path) || path,
        createdAt: Date.now(),
        remote: { kind: remote.kind, connectionId: remote.connectionId },
      };
      items.push(project);
      persist();
      return project;
    },

    async update(id, patch: ProjectPatch): Promise<Project> {
      const project = items.find((p) => p.id === id);
      if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
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
}
