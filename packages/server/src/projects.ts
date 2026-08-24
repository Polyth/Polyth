// JSON-file backed project registry. M1-simple; swap for sqlite projection later.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Project, ProjectPatch, ProjectRemote, ProjectService } from "@polyth/contracts";

export function createProjectService(dataDir: string): ProjectService {
  const file = `${dataDir}/projects.json`;
  let items: Project[] = [];
  try {
    items = JSON.parse(readFileSync(file, "utf8"));
  } catch { /* first run */ }

  const persist = () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(items, null, 2));
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
        const name = patch.name.trim();
        if (!name || name.length > 120) throw Object.assign(new Error("name required (≤120 chars)"), { code: "invalid-input" });
        project.name = name;
      }
      if (patch.color !== undefined) {
        if (patch.color !== "" && !/^#[0-9a-fA-F]{3,8}$/.test(patch.color)) {
          throw Object.assign(new Error("color must be a hex value"), { code: "invalid-input" });
        }
        if (patch.color === "") delete project.color;
        else project.color = patch.color;
      }
      if (patch.icon !== undefined) {
        if (patch.icon.length > 8) throw Object.assign(new Error("icon must be a short glyph"), { code: "invalid-input" });
        if (patch.icon === "") delete project.icon;
        else project.icon = patch.icon;
      }
      if (patch.defaults !== undefined) {
        // shallow-merge defaults so a partial patch never wipes other defaults
        project.defaults = { ...project.defaults, ...patch.defaults };
      }
      persist();
      return project;
    },
  };
}
