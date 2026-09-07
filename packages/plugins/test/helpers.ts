import type { SecureSafeService } from "@polyth/contracts";
import { mkdirSync } from "node:fs";
import { createSpaceStorage } from "@polyth/tenancy";
import type { PackageSpaceAdminView } from "../src/serverPackage.ts";

export type PackageOpaqueVault = Pick<
  SecureSafeService,
  "putOpaque" | "getOpaque" | "deleteOpaque" | "deleteOpaqueByPrefix"
>;

export function testSpaceStorage(root: string) {
  mkdirSync(root, { recursive: true });
  return createSpaceStorage(root);
}

export function spaceView(spaceId: string, root: string): PackageSpaceAdminView {
  return { spaceId, storage: testSpaceStorage(root) };
}

export function memoryOpaqueVault(): PackageOpaqueVault {
  const map = new Map<string, string>();
  return {
    putOpaque(key, value) { map.set(key, value); },
    getOpaque(key) { return map.get(key) ?? null; },
    deleteOpaque(key) { map.delete(key); },
    deleteOpaqueByPrefix(prefix) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) map.delete(key);
      }
    },
  };
}
