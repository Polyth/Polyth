// In-memory-backed PeopleHost for package tests: storage under a temp dir,
// vault and enablement in maps, membership from a fixed table.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PackageServicePolicy, PeopleHost } from "@polyth/plugins/people";

export function fakePeople(root: string, members: Record<string, readonly string[]>): PeopleHost & {
  vaults: Map<string, Map<string, string>>;
} {
  const vaults = new Map<string, Map<string, string>>();
  const enabled = new Map<string, Set<string>>();
  const policies = new Map<string, PackageServicePolicy>();
  const isMember = (userId: string, spaceId: string) => members[spaceId]?.includes(userId) ?? false;
  return {
    vaults,
    storage(userId, packageId) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(userId)) throw Object.assign(new Error("userId is invalid"), { code: "invalid-input" });
      const dir = join(root, "people", userId, "packages", packageId);
      mkdirSync(dir, { recursive: true });
      return { root: dir, path: (relative) => join(dir, relative) };
    },
    vault(userId, packageId) {
      const key = `${userId}/${packageId}`;
      const store = vaults.get(key) ?? new Map<string, string>();
      vaults.set(key, store);
      return {
        putOpaque: (k: string, v: string) => { store.set(k, v); },
        getOpaque: (k: string) => store.get(k) ?? null,
        deleteOpaque: (k: string) => { store.delete(k); },
        deleteOpaqueByPrefix: (prefix: string) => { for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k); },
      } as ReturnType<PeopleHost["vault"]>;
    },
    enabled: (userId, spaceId, packageId) => [...(enabled.get(`${userId}/${spaceId}/${packageId}`) ?? [])],
    setEnabled(userId, spaceId, packageId, connectionId, on) {
      if (on && !isMember(userId, spaceId)) throw Object.assign(new Error("not a member"), { code: "forbidden" });
      const key = `${userId}/${spaceId}/${packageId}`;
      const set = enabled.get(key) ?? new Set<string>();
      if (on) set.add(connectionId); else set.delete(connectionId);
      enabled.set(key, set);
    },
    servicePolicy: (spaceId, packageId) => policies.get(`${spaceId}/${packageId}`) ?? { agentsMayUseService: false },
    setServicePolicy: (spaceId, packageId, policy) => { policies.set(`${spaceId}/${packageId}`, policy); },
    isMember,
  };
}
