import { REMOTE_CAPABILITY } from "@polyth/contracts";
import { requireInstanceOwnerAuthority } from "@polyth/contracts/instance-authority";
import type { RouteHandler } from "../http.ts";
import type { PackageResidue } from "../packageResidue.ts";
import type { PackageRegistry } from "../packages.ts";

export function packageRoutes(registry: PackageRegistry, residue?: PackageResidue): RouteHandler {
  return async (rc) => {
    if (rc.path === "/api/packages" && rc.method === "GET") {
      rc.json(200, { packages: registry.list() });
      return true;
    }

    // Data of removed packages is deployment-wide: only the instance owner
    // may see or delete it, like package installation itself.
    if (residue && rc.path === "/api/packages/residue" && rc.method === "GET") {
      requireInstanceOwnerAuthority(rc, "package data maintenance requires the instance owner");
      rc.json(200, { residue: residue.list() });
      return true;
    }
    const residueMatch = rc.path.match(/^\/api\/packages\/residue\/([^/]+)$/);
    if (residue && residueMatch && rc.method === "DELETE") {
      requireInstanceOwnerAuthority(rc, "package data maintenance requires the instance owner");
      rc.requireCapability(REMOTE_CAPABILITY.packagesInstall);
      let id: string;
      try {
        id = decodeURIComponent(residueMatch[1]!);
      } catch {
        throw Object.assign(new Error("package id is not a valid URL path segment"), { code: "invalid-input" });
      }
      const removed = residue.purge(id);
      if (!removed) throw Object.assign(new Error("no leftover data for this package"), { code: "not-found" });
      rc.json(200, { removed });
      return true;
    }

    const match = rc.path.match(/^\/api\/packages\/([^/]+)$/);
    if (match && rc.method === "PATCH") {
      requireInstanceOwnerAuthority(rc, "package enablement changes require the instance owner");
      const body = await rc.body();
      if (typeof body.enabled !== "boolean") {
        throw Object.assign(new Error("enabled must be a boolean"), {
          code: "invalid-input",
          field: "enabled",
        });
      }
      rc.json(200, await registry.setEnabled(match[1]!, body.enabled));
      return true;
    }

    return false;
  };
}
