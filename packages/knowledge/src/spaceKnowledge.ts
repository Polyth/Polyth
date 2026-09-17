import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import type { SpaceContext } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import {
  createKnowledgeStore,
  type KnowledgeStore,
} from "./index.ts";

const notFound = (message = "knowledge project not found"): Error =>
  Object.assign(new Error(message), { code: "not-found" });

export interface SpaceKnowledgeRouter {
  /** Internal routing facade used by track orchestration. */
  routed: KnowledgeStore;
  forSpace(space: SpaceContext): KnowledgeStore;
  prepareProject(space: SpaceContext, projectId: string): Promise<KnowledgeStore>;
  run<T>(space: SpaceContext, action: () => T): T;
  close(): void;
}

/**
 * Knowledge bytes live only under `<space>/packages/knowledge`. The routing
 * facade never accepts a Space id from request data: project bindings are made
 * only after the host's already-scoped ProjectService confirms ownership.
 */
export function createSpaceKnowledgeRouter(host: Pick<ServerPackageHost, "spaceStorage" | "forSpace">): SpaceKnowledgeRouter {
  const context = new AsyncLocalStorage<SpaceContext>();
  const stores = new Map<string, KnowledgeStore>();
  const projectStores = new Map<string, KnowledgeStore>();
  const itemStores = new Map<string, KnowledgeStore>();

  const forSpace = (space: SpaceContext): KnowledgeStore => {
    const root = host.spaceStorage(space).packageDir("knowledge");
    let store = stores.get(root);
    if (!store) {
      store = createKnowledgeStore(join(root, "knowledge.db"));
      stores.set(root, store);
    }
    return store;
  };

  const prepareProject = async (space: SpaceContext, projectId: string): Promise<KnowledgeStore> => {
    if (!projectId) throw notFound();
    const project = await host.forSpace(space).projects.get(projectId);
    if (!project) throw notFound();
    const store = forSpace(space);
    projectStores.set(projectId, store);
    return store;
  };

  const selected = (projectId: string): KnowledgeStore => {
    const active = context.getStore();
    if (active) return forSpace(active);
    const bound = projectStores.get(projectId);
    if (!bound) throw notFound();
    return bound;
  };

  const locate = async (id: string): Promise<KnowledgeStore | undefined> => {
    const active = context.getStore();
    if (active) {
      const store = forSpace(active);
      return await store.get(id) ? store : undefined;
    }
    const cached = itemStores.get(id);
    if (cached) return cached;
    // Background track plan rendering may run outside the originating request.
    // It may search only stores already admitted by a trusted Space context in
    // this process. It never opens/enumerates another Space on its own.
    for (const store of stores.values()) {
      if (await store.get(id)) {
        itemStores.set(id, store);
        return store;
      }
    }
    return undefined;
  };

  const routed: KnowledgeStore = {
    list: (query) => selected(query.projectId).list(query),
    async get(id) {
      const store = await locate(id);
      return store?.get(id);
    },
    async create(input) {
      const store = selected(input.projectId);
      const item = await store.create(input);
      itemStores.set(item.id, store);
      return item;
    },
    async update(id, patch, expectedRevision) {
      const store = await locate(id);
      if (!store) throw notFound("knowledge item not found");
      const item = await store.update(id, patch, expectedRevision);
      itemStores.set(id, store);
      return item;
    },
    async remove(id) {
      const store = await locate(id);
      if (!store) return false;
      const removed = await store.remove(id);
      if (removed) itemStores.delete(id);
      return removed;
    },
    close() {
      for (const store of new Set(stores.values())) store.close();
      stores.clear();
      projectStores.clear();
      itemStores.clear();
    },
  };

  return {
    routed,
    forSpace,
    prepareProject,
    run: (space, action) => context.run(space, action),
    close: () => routed.close(),
  };
}
