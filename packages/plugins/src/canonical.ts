import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TrustClass } from "@polyth/contracts";
import {
  parsePackageManifestDocument,
  isPackageCapabilityName,
  type PackageManifestV1,
} from "@polyth/package-sdk/manifest";
import { parseManifest, type ManagedPluginManifest } from "./managedManifest.ts";

export function isV1Document(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (value as { manifestVersion?: unknown }).manifestVersion === 1;
}

export function loadCanonicalManifest(dir: string): {
  canonical: PackageManifestV1;
  legacy: ManagedPluginManifest;
} {
  const v1Path = join(dir, "polyth-package.json");
  if (existsSync(v1Path) && statSync(v1Path).isFile()) {
    const canonical = parsePackageManifestDocument(JSON.parse(readFileSync(v1Path, "utf8")));
    return { canonical, legacy: legacyFromCanonical(canonical) };
  }
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
      description?: unknown;
      polyth?: Record<string, unknown>;
    };
    if (isV1Document(pkg.polyth)) {
      const polyth = pkg.polyth;
      const document = {
        ...polyth,
        id: polyth.id ?? (typeof pkg.name === "string" ? pkg.name.replace(/^@/, "").replace("/", ".") : undefined),
        version: polyth.version ?? pkg.version,
        display: polyth.display ?? {
          name: typeof pkg.name === "string" ? pkg.name : "Package",
          description: typeof pkg.description === "string" ? pkg.description : "Package",
        },
      };
      const canonical = parsePackageManifestDocument(document);
      return { canonical, legacy: legacyFromCanonical(canonical) };
    }
  }
  const legacyPath = join(dir, "polyth-plugin.json");
  if (!existsSync(legacyPath)) {
    throw Object.assign(new Error("package has no polyth-package.json or polyth-plugin.json manifest"), {
      code: "invalid-input",
    });
  }
  const legacy = parseManifest(readFileSync(legacyPath, "utf8"));
  return { canonical: canonicalFromLegacy(legacy), legacy };
}

export function canonicalFromLegacy(legacy: ManagedPluginManifest): PackageManifestV1 {
  return {
    manifestVersion: 1,
    id: legacy.id,
    version: legacy.version,
    display: { name: legacy.name, description: legacy.name },
    runtime: {
      kind: "trusted-local",
      ...(legacy.entries?.server ? { server: legacy.entries.server } : {}),
    },
    capabilities: (legacy.capabilities ?? []).filter(isPackageCapabilityName).map((name) => ({ name })),
  };
}

export function legacyFromCanonical(canonical: PackageManifestV1): ManagedPluginManifest {
  const trust: TrustClass = canonical.runtime?.kind === "trusted-local"
    ? (canonical.runtime.server ? "privileged" : "workspace")
    : canonical.capabilities?.some((cap) => cap.name === "network.fetch" || cap.name === "auth.connection")
      ? "network"
      : "ui-only";
  return {
    id: canonical.id,
    name: canonical.display.name,
    version: canonical.version,
    trust,
    capabilities: (canonical.capabilities ?? []).map((cap) => cap.name),
    contributions: [],
    widgets: [],
    ...(canonical.runtime?.ui || canonical.runtime?.server
      ? {
        entries: {
          ...(canonical.runtime.ui ? { ui: canonical.runtime.ui.entry } : {}),
          ...(canonical.runtime.server ? { server: canonical.runtime.server } : {}),
        },
      }
      : {}),
  };
}
