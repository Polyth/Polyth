// JSON-file backed project registry. M1-simple; swap for sqlite projection later.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Project, ProjectService } from "@polyth/contracts";

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
  };
}
