// Person-owned data for packages (Spaces §14.4, stage 3 foundation).
//
//   <dataDir>/people/<userId>/packages/<packageId>/   package storage (host.people.storage)
//   <dataDir>/people/<userId>/vault/<packageId>/      opaque secrets (host.people.vault)
//   <dataDir>/people/<userId>/connections.json        per-Space enablement
//   <spaceRoot>/connected-accounts.json               per-Space service-account policy
//
// Nothing a person owns lives under a Space, so leaving a Space deletes
// nothing: enablement for that Space is ignored because membership fails.
// Deleting the account removes the whole `people/<userId>` tree.
import { mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { SecureSafeService } from "@polyth/contracts";
import { createSecureSafeService, releaseSecureSafeService } from "@polyth/credential-vault";
import type { PackageServicePolicy, PeopleHost, PersonPackageStorage } from "@polyth/plugins";
import { atomicWriteSync } from "@polyth/plugins/atomic-write";
import { resolveInside } from "@polyth/tenancy";

const error = (code: string, message: string): Error => Object.assign(new Error(message), { code });

// Leading alphanumeric and no dots: `.`/`..` and separators can never form a
// path component, and `system:*` principals are not people.
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// Same rule as SpaceStorage.packageDir.
const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SPACE_ID = /^spc_[A-Za-z0-9_-]{1,200}$/;
const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const MAX_ENABLED = 64;

const valid = (pattern: RegExp, value: unknown, field: string): string => {
  if (typeof value !== "string" || !pattern.test(value)) throw error("invalid-input", `${field} is invalid`);
  return value;
};

interface EnablementFile {
  version: 1;
  /** spaceId → packageId → connection ids. */
  spaces: Record<string, Record<string, string[]>>;
}

interface PolicyFile {
  version: 1;
  packages: Record<string, PackageServicePolicy>;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export interface PeopleStoreOptions {
  dataDir: string;
  /** Storage root of an existing Space; undefined (or a throw) for an unknown one. */
  spaceRoot(spaceId: string): string | undefined;
  /** Active membership of a person in a Space. */
  isMember(userId: string, spaceId: string): boolean;
}

export interface PeopleStore {
  /** The facade one package receives: every packageId argument must be `packageId`. */
  forPackage(packageId: string): PeopleHost;
  /** Delete everything the person owns: storage, secrets and enablement. */
  removePerson(userId: string): void;
}

/** `<dataDir>/people`: every person's own tree. */
export const peopleRootDir = (dataDir: string): string => join(resolve(dataDir), "people");

export function createPeopleStore(opts: PeopleStoreOptions): PeopleStore {
  const peopleRoot = peopleRootDir(opts.dataDir);
  // One physical store per directory: two instances over the same file would
  // overwrite each other's in-memory secrets.
  const vaults = new Map<string, SecureSafeService>();

  const personDir = (userId: string): string => {
    mkdirSync(peopleRoot, { recursive: true });
    return resolveInside(peopleRoot, valid(USER_ID, userId, "userId"));
  };

  const ensureDir = (base: string, relative: string): string => {
    const dir = resolveInside(base, relative);
    mkdirSync(dir, { recursive: true });
    // Re-check after creation: a symlink planted between check and mkdir
    // must not move the root outside the person's tree.
    resolveInside(base, relative);
    return realpathSync.native(dir);
  };

  const storage = (userId: string, packageId: string): PersonPackageStorage => {
    const person = personDir(userId);
    mkdirSync(person, { recursive: true });
    const root = ensureDir(person, join("packages", valid(PACKAGE_ID, packageId, "packageId")));
    return { root, path: (relative) => resolveInside(root, relative) };
  };

  const vault = (userId: string, packageId: string): SecureSafeService => {
    const person = personDir(userId);
    mkdirSync(person, { recursive: true });
    const dir = ensureDir(person, join("vault", valid(PACKAGE_ID, packageId, "packageId")));
    let safe = vaults.get(dir);
    if (!safe) {
      safe = createSecureSafeService({ dataDir: dir, localOnly: true });
      vaults.set(dir, safe);
    }
    return safe;
  };

  const enablementFile = (userId: string): string => join(personDir(userId), "connections.json");
  const readEnablement = (userId: string): EnablementFile => {
    const stored = readJson<Partial<EnablementFile>>(enablementFile(userId), {});
    return { version: 1, spaces: stored.spaces && typeof stored.spaces === "object" ? stored.spaces : {} };
  };

  const enabled = (userId: string, spaceId: string, packageId: string): string[] => {
    valid(SPACE_ID, spaceId, "spaceId");
    valid(PACKAGE_ID, packageId, "packageId");
    const ids = readEnablement(userId).spaces[spaceId]?.[packageId];
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && CONNECTION_ID.test(id)) : [];
  };

  const setEnabled = (userId: string, spaceId: string, packageId: string, connectionId: string, on: boolean): void => {
    valid(SPACE_ID, spaceId, "spaceId");
    valid(PACKAGE_ID, packageId, "packageId");
    valid(CONNECTION_ID, connectionId, "connectionId");
    if (typeof on !== "boolean") throw error("invalid-input", "on must be a boolean");
    // Turning off is always allowed (cleanup after leaving a Space).
    if (on && !isMember(userId, spaceId)) throw error("forbidden", "not a member of this Space");
    const file = readEnablement(userId);
    const current = enabled(userId, spaceId, packageId).filter((id) => id !== connectionId);
    if (on) {
      if (current.length >= MAX_ENABLED) throw error("invalid-input", "too many enabled connections");
      current.push(connectionId);
    }
    const space = { ...file.spaces[spaceId] };
    if (current.length > 0) space[packageId] = current;
    else delete space[packageId];
    if (Object.keys(space).length > 0) file.spaces[spaceId] = space;
    else delete file.spaces[spaceId];
    mkdirSync(personDir(userId), { recursive: true });
    atomicWriteSync(enablementFile(userId), JSON.stringify(file, null, 2), 0o600);
  };

  const policyFile = (spaceId: string): string | undefined => {
    valid(SPACE_ID, spaceId, "spaceId");
    let root: string | undefined;
    try {
      root = opts.spaceRoot(spaceId);
    } catch {
      root = undefined;
    }
    return root ? resolveInside(root, "connected-accounts.json") : undefined;
  };

  const servicePolicy = (spaceId: string, packageId: string): PackageServicePolicy => {
    valid(PACKAGE_ID, packageId, "packageId");
    const file = policyFile(spaceId);
    const stored = file ? readJson<Partial<PolicyFile>>(file, {}).packages?.[packageId] : undefined;
    return { agentsMayUseService: stored?.agentsMayUseService === true };
  };

  const setServicePolicy = (spaceId: string, packageId: string, policy: PackageServicePolicy): void => {
    valid(PACKAGE_ID, packageId, "packageId");
    if (typeof policy?.agentsMayUseService !== "boolean") {
      throw error("invalid-input", "agentsMayUseService must be a boolean");
    }
    const file = policyFile(spaceId);
    if (!file) throw error("not-found", "Space not found");
    const stored = readJson<Partial<PolicyFile>>(file, {});
    const packages = stored.packages && typeof stored.packages === "object" ? { ...stored.packages } : {};
    packages[packageId] = { agentsMayUseService: policy.agentsMayUseService };
    atomicWriteSync(file, JSON.stringify({ version: 1, packages } satisfies PolicyFile, null, 2));
  };

  const isMember = (userId: string, spaceId: string): boolean => {
    if (typeof userId !== "string" || !USER_ID.test(userId)) return false;
    if (typeof spaceId !== "string" || !SPACE_ID.test(spaceId)) return false;
    try {
      return opts.isMember(userId, spaceId);
    } catch {
      return false;
    }
  };

  return {
    forPackage(packageId) {
      const owner = valid(PACKAGE_ID, packageId, "packageId");
      const own = (requested: string): string => {
        if (requested !== owner) throw error("forbidden", "a package may only use its own person data");
        return requested;
      };
      return {
        storage: (userId, id) => storage(userId, own(id)),
        vault: (userId, id) => {
          const safe = vault(userId, own(id));
          return {
            putOpaque: (key, value) => safe.putOpaque(key, value),
            getOpaque: (key) => safe.getOpaque(key),
            deleteOpaque: (key) => safe.deleteOpaque(key),
            deleteOpaqueByPrefix: (prefix) => safe.deleteOpaqueByPrefix(prefix),
          };
        },
        credentialVault: (userId, id) => vault(userId, own(id)),
        enabled: (userId, spaceId, id) => enabled(userId, spaceId, own(id)),
        setEnabled: (userId, spaceId, id, connectionId, on) =>
          setEnabled(userId, spaceId, own(id), connectionId, on),
        servicePolicy: (spaceId, id) => servicePolicy(spaceId, own(id)),
        setServicePolicy: (spaceId, id, policy) => setServicePolicy(spaceId, own(id), policy),
        isMember,
      };
    },
    removePerson(userId) {
      // Lexical path: rm removes a planted symlink itself, never its target.
      const dir = join(peopleRoot, valid(USER_ID, userId, "userId"));
      for (const [vaultDir, safe] of vaults) {
        if (vaultDir.startsWith(dir + sep) || vaultDir.startsWith(realPathOr(dir) + sep)) {
          releaseSecureSafeService(safe);
          vaults.delete(vaultDir);
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function realPathOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}
