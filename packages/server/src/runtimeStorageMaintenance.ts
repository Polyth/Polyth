import { join, resolve } from "node:path";
import { createOpenCodeStorageMaintenance } from "@polyth/backend-opencode";
import { hasDurableProcessRelease } from "@polyth/harness-runtime";
import type { KeyedRuntimeOwner } from "./runtimeOccupancy.ts";

/** Canonical reference checks and allocation ownership stay with the server;
 * cache traversal/deletion stays with the backend that owns the storage. */
export function createRuntimeStorageMaintenance(options: {
  root: string;
  pool: Pick<KeyedRuntimeOwner<unknown>, "withVacant">;
  storageKey(projectId: string, cwd: string): string;
  poolKey(projectId: string, cwd: string): string;
  withReferencesLease(projectId: string, cwd: string, work: () => Promise<void>): Promise<boolean>;
  shuttingDown(): boolean;
  maxEntries?: number;
}) {
  return createOpenCodeStorageMaintenance({
    root: options.root,
    maxEntries: options.maxEntries,
    async withRemovalLease(runtimeDir, metadata, remove) {
      const { projectId, cwd } = metadata.runtimeLocation;
      if (!metadata.runtimeGeneration || resolve(runtimeDir) !== resolve(options.root, options.storageKey(projectId, cwd))) return "identity-mismatch";
      let blocked: "stopping" | "canonical-reference" | "release-unproven" | undefined;
      const vacant = await options.pool.withVacant(options.poolKey(projectId, resolve(cwd)), async () => {
        if (options.shuttingDown()) { blocked = "stopping"; return; }
        const unreferenced = await options.withReferencesLease(projectId, cwd, async () => {
          if (!hasDurableProcessRelease(join(runtimeDir, "opencode.pid.json.supervisor.json"), {
            authorityId: metadata.runtimeAuthority, generation: metadata.runtimeGeneration!,
          })) { blocked = "release-unproven"; return; }
          await remove();
        });
        if (!unreferenced) blocked = "canonical-reference";
      });
      return vacant ? blocked : "runtime-occupied";
    },
  });
}
