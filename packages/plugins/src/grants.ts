import { existsSync } from "node:fs";
import type { PackageCapabilityGrantDto, SpaceStorage } from "@polyth/contracts";
import {
  expandedCapabilities,
  isPackageCapabilityName,
  type CapabilityConstraints,
  type DeclaredCapability,
  type PackageConnectionContribution,
} from "@polyth/package-sdk/manifest";
import { connectionFingerprint, fingerprintsStale } from "./connectionFingerprint.ts";
import { readJsonFile, spacePackageFile, writeJsonFile } from "./spaceJson.ts";

export interface ScopedPackageCapabilityGrant extends Omit<PackageCapabilityGrantDto, "constraints"> {
  constraints?: CapabilityConstraints;
}

interface GrantsFile {
  grants?: ScopedPackageCapabilityGrant[];
  connectionFingerprints?: Record<string, string>;
}

interface StoredConnectionState {
  status: "disconnected" | "connecting" | "connected" | "error";
  account?: string;
  error?: string;
  expiresAt?: number;
}

const fileOf = (storage: SpaceStorage, packageId: string): string =>
  spacePackageFile(storage, packageId, "grants.json");
const connectionsFileOf = (storage: SpaceStorage, packageId: string): string =>
  spacePackageFile(storage, packageId, "connections.json");

function loadGrantState(storage: SpaceStorage, packageId: string): GrantsFile {
  return readJsonFile<GrantsFile>(fileOf(storage, packageId), {});
}

function saveGrantState(storage: SpaceStorage, packageId: string, state: GrantsFile): void {
  writeJsonFile(fileOf(storage, packageId), {
    grants: state.grants ?? [],
    connectionFingerprints: state.connectionFingerprints ?? {},
  });
}

function disconnectStoredConnection(storage: SpaceStorage, packageId: string, connectionId: string): void {
  const file = connectionsFileOf(storage, packageId);
  const stored = readJsonFile<Record<string, StoredConnectionState>>(file, {});
  if (!stored[connectionId]) return;
  stored[connectionId] = { status: "disconnected" };
  writeJsonFile(file, stored);
}

export function readGrants(storage: SpaceStorage, packageId: string): ScopedPackageCapabilityGrant[] {
  const parsed = loadGrantState(storage, packageId);
  return Array.isArray(parsed.grants) ? parsed.grants : [];
}

export function readConnectionFingerprints(
  storage: SpaceStorage,
  packageId: string,
): Record<string, string> {
  return loadGrantState(storage, packageId).connectionFingerprints ?? {};
}

export function writeGrants(
  storage: SpaceStorage,
  packageId: string,
  grants: ScopedPackageCapabilityGrant[],
  connectionFingerprints?: Record<string, string>,
): void {
  const previous = loadGrantState(storage, packageId);
  saveGrantState(storage, packageId, {
    grants,
    connectionFingerprints: connectionFingerprints ?? previous.connectionFingerprints ?? {},
  });
}

export function approveConnectionDefinitions(
  storage: SpaceStorage,
  packageId: string,
  specs: readonly PackageConnectionContribution[],
  requestedIds: readonly string[],
): Record<string, string> {
  const wanted = new Set(requestedIds);
  for (const id of wanted) {
    if (!specs.some((spec) => spec.id === id)) {
      throw Object.assign(new Error(`connection "${id}" is not declared`), { code: "invalid-input" });
    }
  }
  const state = loadGrantState(storage, packageId);
  const fingerprints = { ...(state.connectionFingerprints ?? {}) };
  for (const spec of specs) {
    if (!wanted.has(spec.id)) continue;
    const nextFingerprint = connectionFingerprint(spec);
    if (fingerprints[spec.id] !== nextFingerprint) {
      // Approval of a changed security target must never carry an already
      // connected credential across origins/endpoints/client ids. Disconnect
      // first, then publish the new fingerprint. If the process dies between
      // those writes the connection is merely unavailable; old authority is
      // never made valid for the new target.
      disconnectStoredConnection(storage, packageId, spec.id);
    }
    fingerprints[spec.id] = nextFingerprint;
  }
  saveGrantState(storage, packageId, { grants: state.grants ?? [], connectionFingerprints: fingerprints });
  return fingerprints;
}

/** Forget approvals for declarations removed by an activated package version.
 * This is deliberately destructive: if a later version reuses an id, the
 * connection is treated as new and must be reviewed again. */
export function retireConnectionApprovals(
  storage: SpaceStorage,
  packageId: string,
  connectionIds: readonly string[],
): void {
  if (connectionIds.length === 0) return;
  const state = loadGrantState(storage, packageId);
  const fingerprints = { ...(state.connectionFingerprints ?? {}) };
  let changed = false;
  for (const id of connectionIds) {
    if (!(id in fingerprints)) continue;
    delete fingerprints[id];
    changed = true;
  }
  if (!changed) return;
  saveGrantState(storage, packageId, {
    grants: state.grants ?? [],
    connectionFingerprints: fingerprints,
  });
}

export function connectionReviewRequired(
  storage: SpaceStorage,
  packageId: string,
  specs: readonly PackageConnectionContribution[],
): boolean {
  if (specs.length === 0) return false;
  return fingerprintsStale(readConnectionFingerprints(storage, packageId), specs);
}

const cloneStrings = <T extends string>(value: readonly T[] | undefined): T[] | undefined =>
  value?.length ? [...new Set(value)] : undefined;

function exactConstraints(
  value: CapabilityConstraints | undefined,
): CapabilityConstraints | undefined {
  if (!value) return undefined;
  const origins = cloneStrings(value.origins);
  const methods = cloneStrings(value.methods);
  const modelClasses = cloneStrings(value.modelClasses);
  return {
    ...(origins ? { origins } : {}),
    ...(methods ? { methods } : {}),
    ...(modelClasses ? { modelClasses } : {}),
    ...(typeof value.maxOutputTokens === "number" ? { maxOutputTokens: value.maxOutputTokens } : {}),
  };
}

/** Persist the exact authority the user just approved for each named
 * capability. Callers resolve capability names back to the full current
 * manifest declaration before reaching this function, so this is not a
 * delta-merge operation. Exact replacement is required to represent an
 * approved transition from constrained -> unconstrained (or removal of one
 * constraint dimension). */
export function grantCapabilities(
  storage: SpaceStorage,
  packageId: string,
  requested: DeclaredCapability[],
  grantedBy?: string,
): ScopedPackageCapabilityGrant[] {
  const file = loadGrantState(storage, packageId);
  const existing = Array.isArray(file.grants) ? file.grants : [];
  const now = Date.now();
  const byName = new Map(existing.map((item) => [item.name, item]));
  for (const item of requested) {
    const prev = byName.get(item.name);
    const constraints = exactConstraints(item.constraints);
    byName.set(item.name, {
      name: item.name,
      ...(constraints ? { constraints } : {}),
      grantedAt: now,
      ...(grantedBy ? { grantedBy } : prev?.grantedBy ? { grantedBy: prev.grantedBy } : {}),
    });
  }
  const next = [...byName.values()];
  saveGrantState(storage, packageId, {
    grants: next,
    connectionFingerprints: file.connectionFingerprints ?? {},
  });
  return next;
}

export function grantsAsDeclared(grants: readonly ScopedPackageCapabilityGrant[]): DeclaredCapability[] {
  const out: DeclaredCapability[] = [];
  for (const grant of grants) {
    if (!isPackageCapabilityName(grant.name)) continue;
    out.push({
      name: grant.name,
      ...(grant.constraints ? { constraints: grant.constraints } : {}),
    });
  }
  return out;
}

export function missingGrants(
  grants: readonly ScopedPackageCapabilityGrant[],
  requested: readonly DeclaredCapability[],
): DeclaredCapability[] {
  return expandedCapabilities(grantsAsDeclared(grants), requested);
}

export function missingRequiredGrants(
  grants: readonly ScopedPackageCapabilityGrant[],
  requested: readonly DeclaredCapability[],
): DeclaredCapability[] {
  return missingGrants(grants, requested.filter((capability) => capability.required !== false));
}

export function deleteGrants(storage: SpaceStorage, packageId: string): void {
  const file = fileOf(storage, packageId);
  if (!existsSync(file)) return;
  saveGrantState(storage, packageId, { grants: [], connectionFingerprints: {} });
}

export function assertAuthConnectionGranted(
  storage: SpaceStorage,
  packageId: string,
  declared: readonly DeclaredCapability[],
): void {
  if (!declared.some((item) => item.name === "auth.connection")) {
    throw Object.assign(new Error('capability "auth.connection" is not declared'), {
      code: "CAPABILITY_UNDECLARED",
    });
  }
  if (!readGrants(storage, packageId).some((item) => item.name === "auth.connection")) {
    throw Object.assign(new Error('capability "auth.connection" is not granted'), {
      code: "CAPABILITY_DENIED",
    });
  }
}
