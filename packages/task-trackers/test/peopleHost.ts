// In-memory `host.people` for task-tracker tests. Mirrors the rules of the
// server's people store that the package relies on: person ids and `spc_`
// Space ids are validated, turning an account on needs active membership,
// turning it off always works, and the service policy defaults to off.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PackageServicePolicy, PeopleHost } from "@polyth/plugins";

const USER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SPACE_ID = /^spc_[A-Za-z0-9_-]{1,200}$/;

const invalid = (field: string): never => {
  throw Object.assign(new Error(`${field} is invalid`), { code: "invalid-input" });
};

export interface FakePeople extends PeopleHost {
  /** spaceId → member user ids. */
  members: Map<string, Set<string>>;
  /** `${userId}` → opaque secrets of this package. */
  secrets: Map<string, Map<string, string>>;
  policies: Map<string, PackageServicePolicy>;
}

export function fakePeople(root: string, members: Record<string, string[]>): FakePeople {
  const memberMap = new Map(Object.entries(members).map(([spaceId, ids]) => [spaceId, new Set(ids)]));
  const secrets = new Map<string, Map<string, string>>();
  const enablement = new Map<string, string[]>();
  const policies = new Map<string, PackageServicePolicy>();
  const user = (userId: string) => USER_ID.test(userId) ? userId : invalid("userId");
  const space = (spaceId: string) => SPACE_ID.test(spaceId) ? spaceId : invalid("spaceId");
  const own = (packageId: string) => {
    if (packageId !== "task-trackers") throw Object.assign(new Error("not this package"), { code: "forbidden" });
  };
  const isMember = (userId: string, spaceId: string) => memberMap.get(spaceId)?.has(userId) === true;
  const people: FakePeople = {
    members: memberMap,
    secrets,
    policies,
    storage(userId, packageId) {
      own(packageId);
      const dir = join(root, "people", user(userId), "packages", packageId);
      mkdirSync(dir, { recursive: true });
      return { root: dir, path: (relative) => join(dir, relative) };
    },
    vault(userId, packageId) {
      own(packageId);
      const id = user(userId);
      let store = secrets.get(id);
      if (!store) secrets.set(id, store = new Map());
      return {
        putOpaque: (key, value) => { store.set(key, value); },
        getOpaque: (key) => store.get(key) ?? null,
        deleteOpaque: (key) => { store.delete(key); },
        deleteOpaqueByPrefix: (prefix) => { for (const key of [...store.keys()]) if (key.startsWith(prefix)) store.delete(key); },
      } as ReturnType<PeopleHost["vault"]>;
    },
    enabled(userId, spaceId, packageId) {
      own(packageId);
      return [...enablement.get(`${user(userId)}|${space(spaceId)}`) ?? []];
    },
    setEnabled(userId, spaceId, packageId, connectionId, on) {
      own(packageId);
      const key = `${user(userId)}|${space(spaceId)}`;
      if (on && !isMember(userId, spaceId)) {
        throw Object.assign(new Error("not a member of this Space"), { code: "forbidden" });
      }
      const current = (enablement.get(key) ?? []).filter((id) => id !== connectionId);
      if (on) current.push(connectionId);
      enablement.set(key, current);
    },
    servicePolicy(spaceId, packageId) {
      own(packageId);
      return { agentsMayUseService: policies.get(space(spaceId))?.agentsMayUseService === true };
    },
    setServicePolicy(spaceId, packageId, policy) {
      own(packageId);
      policies.set(space(spaceId), { agentsMayUseService: policy.agentsMayUseService });
    },
    isMember,
  };
  return people;
}
