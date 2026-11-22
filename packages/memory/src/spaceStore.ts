import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SpaceContext } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { importLegacyMemory, LEGACY_MEMORY_DATABASE } from "./legacyImport.ts";
import { createMemoryStore, type MemoryStore } from "./store.ts";

export interface SpaceMemoryStores {
  /** The Space's store. The context must come from the gateway or the host. */
  forSpace(space: SpaceContext): MemoryStore;
  close(): void;
}

/**
 * One memory database per Space, in this package's own directory:
 * `<space>/packages/memory/memory.db`. Opening a Space's store for the first
 * time moves in the memory it kept in the old store (see `legacyImport.ts`).
 */
export function createSpaceMemoryStores(host: Pick<ServerPackageHost, "spaceStorage" | "pluginId">): SpaceMemoryStores {
  const open = new Map<string, { db: DatabaseSync; store: MemoryStore }>();
  return {
    forSpace(space) {
      const storage = host.spaceStorage(space);
      const file = join(storage.packageDir(host.pluginId), "memory.db");
      let entry = open.get(file);
      if (!entry) {
        const fresh = !existsSync(file);
        const db = new DatabaseSync(file);
        try {
          const store = createMemoryStore(db, space.spaceId);
          // Before the first read: a default policy row created by one would
          // otherwise stand in for the Space's real settings.
          const moved = importLegacyMemory(db, storage.path(LEGACY_MEMORY_DATABASE), { spaceId: space.spaceId, fresh });
          if (moved?.records || moved?.reclaimedBytes) {
            console.info(`[memory] moved ${moved.records} notes of Space ${space.spaceId} into the memory store; the old database gave back ${Math.round(moved.reclaimedBytes / 1024)} KiB`);
          }
          entry = { db, store };
        } catch (cause) {
          db.close();
          throw cause;
        }
        open.set(file, entry);
      }
      return entry.store;
    },
    close() {
      for (const { db, store } of open.values()) { store.close(); db.close(); }
      open.clear();
    },
  };
}
