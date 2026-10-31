// Package-owned opaque secrets in a Space Credential Vault (Spaces §4).
//
// Every server package reaches the Space vault through `host.services`, which
// the host binds to the receiving package (`bindPackageServices`). That facade
// stores each opaque key under the caller's own namespace, so one package can
// never read, overwrite or delete another package's opaque secrets — even if
// it guesses the key. Host code holding the unbound service keeps raw access.
//
// Pure and browser-safe: the Credential Vault store imports the same table to
// migrate keys written before the namespace existed.
import type { SecureSafeService } from "@polyth/contracts";

const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `pkg.<packageId>:<key>`: `.` never occurs in a package id or a legacy prefix. */
export function packageOpaqueKey(packageId: string, key: string): string {
  if (!PACKAGE_ID.test(packageId)) {
    throw Object.assign(new Error("package id is invalid"), { code: "invalid-input" });
  }
  return `pkg.${packageId}:${key}`;
}

export const isPackageOpaqueKey = (key: string): boolean => key.startsWith("pkg.");

/**
 * `pkg.<id>:pkg.<id>:<key>` → `pkg.<id>:<key>`. Hosts that bound package
 * services twice (2026-10-15 until the fix) stored keys with the namespace
 * repeated; anything else is returned unchanged.
 */
export function collapseRepeatedPackageNamespace(key: string): string {
  const match = /^(pkg\.[a-z0-9][a-z0-9-]{0,63}:)(?:\1)+/.exec(key);
  return match ? match[1]! + key.slice(match[0].length) : key;
}

/**
 * Prefixes that packages wrote before the namespace, and the package that
 * owns each. `pkgconn:` is the plugin manager's per-connection secret for a
 * managed package; it is exclusive to `plugins` whatever a package is named.
 */
export const LEGACY_OPAQUE_OWNERS: Readonly<Record<string, string>> = Object.freeze({
  "google:": "google",
  "gitlab:": "gitlab",
  "task-trackers:": "task-trackers",
  "pkgconn:": "plugins",
});

/** The package that owns a pre-namespace opaque key, or undefined when no
 *  package claims it (it then stays readable only through the host). */
export function legacyOpaqueOwner(key: string): string | undefined {
  for (const [prefix, owner] of Object.entries(LEGACY_OPAQUE_OWNERS)) {
    if (key.startsWith(prefix)) return owner;
  }
  return undefined;
}

const OPAQUE_METHODS = new Set<PropertyKey>(["putOpaque", "getOpaque", "deleteOpaque", "deleteOpaqueByPrefix"]);

/**
 * The Credential Vault a package sees: opaque keys live under its namespace;
 * credential entries, resolution and listing are unchanged. Person partitions
 * are not reachable from a package (they have `host.people`).
 */
export function packageScopedSecureSafe(safe: SecureSafeService, packageId: string): SecureSafeService {
  const ns = (key: string): string => packageOpaqueKey(packageId, key);
  return new Proxy(safe, {
    get(target, property, receiver) {
      if (property === "forPerson") return undefined;
      if (!OPAQUE_METHODS.has(property)) {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      if (property === "putOpaque") return (key: string, value: string) => target.putOpaque(ns(key), value);
      if (property === "getOpaque") return (key: string) => target.getOpaque(ns(key));
      if (property === "deleteOpaque") return (key: string) => target.deleteOpaque(ns(key));
      return (prefix: string) => target.deleteOpaqueByPrefix(ns(prefix));
    },
  });
}
