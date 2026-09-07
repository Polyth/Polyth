import { satisfies as semverSatisfies, valid as validSemver } from "semver";
import { isPackageCapabilityName, type DeclaredCapability } from "./capabilities.ts";
import { assertSafePackagePath, isHttpsOrigin, isHttpsUrl, isSafePackagePath } from "./paths.ts";

export const PACKAGE_MANIFEST_VERSION = 1 as const;

export function engineRangeSatisfied(range: string, hostVersion: string): boolean {
  return semverSatisfies(hostVersion, range.trim(), { includePrerelease: true });
}

export type PackageRuntimeKind = "trusted-local" | "sandboxed";

export interface PackageDisplay {
  name: string;
  description: string;
  icon?: string;
}

export interface PackageRuntime {
  kind: PackageRuntimeKind;
  ui?: {
    entry: string;
  };
  server?: string;
}

export interface PackageSurfaceContribution {
  id: string;
  title: string;
  description?: string;
  order?: number;
}

export interface PackageComposerAction {
  id: string;
  label: string;
  description?: string;
}

export interface PackageConnectionContribution {
  id: string;
  label: string;
  kind: "oauth" | "token";
  /** HTTPS origins that may receive this connection's credentials. */
  origins: string[];
  oauth?: {
    authorizeUrl: string;
    tokenUrl: string;
    /** Public OAuth client id. Host never reads env names from the package. */
    clientId: string;
    scopes?: string[];
  };
}

export interface PackageContributes {
  surfaces?: PackageSurfaceContribution[];
  composerActions?: PackageComposerAction[];
}

export interface PackageManifestV1 {
  manifestVersion: typeof PACKAGE_MANIFEST_VERSION;
  id: string;
  version: string;
  engines?: { polyth?: string };
  display: PackageDisplay;
  runtime?: PackageRuntime;
  contributes?: PackageContributes;
  capabilities?: DeclaredCapability[];
  connections?: PackageConnectionContribution[];
}

export type ParseManifestFailure = { ok: false; code: string; message: string };
export type ParseManifestSuccess = { ok: true; manifest: PackageManifestV1 };
export type ParseManifestResult = ParseManifestSuccess | ParseManifestFailure;

const err = (code: string, message: string): ParseManifestFailure => ({ ok: false, code, message });
const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONTRIB_ID = /^[a-z][a-z0-9._-]*$/;
const OAUTH_CLIENT_ID = /^[\x21-\x7E]{1,256}$/;

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-input", message);
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) fail("invalid-input", message);
  return (value as string).trim();
}

function requireArray(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) fail("invalid-input", message);
  return value as unknown[];
}

function requireMatchingString(value: unknown, pattern: RegExp, message: string): string {
  if (typeof value !== "string" || !pattern.test(value)) fail("invalid-input", message);
  return value as string;
}

function parseCapabilities(value: unknown): DeclaredCapability[] {
  if (value === undefined) return [];
  const items = requireArray(value, "capabilities must be an array");
  const out: DeclaredCapability[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item === "string") {
      if (!isPackageCapabilityName(item)) return fail("invalid-input", `unknown capability "${item}"`);
      if (seen.has(item)) return fail("invalid-input", `duplicate capability "${item}"`);
      seen.add(item);
      out.push({ name: item });
      continue;
    }
    const raw = requireRecord(item, "each capability must be a string or object");
    if (typeof raw.name !== "string" || !isPackageCapabilityName(raw.name)) {
      return fail("invalid-input", `unknown capability "${String(raw.name)}"`);
    }
    const name = raw.name;
    if (seen.has(name)) fail("invalid-input", `duplicate capability "${name}"`);
    seen.add(name);
    let origins: string[] | undefined;
    if (raw.origins !== undefined) {
      const originList = requireArray(raw.origins, `${name} origins must be https origins`);
      if (originList.some((origin) => typeof origin !== "string" || !isHttpsOrigin(origin))) {
        fail("invalid-input", `${name} origins must be https origins`);
      }
      origins = [...new Set(originList as string[])];
    }
    if (name === "network.fetch" && (!origins || origins.length === 0)) {
      fail("invalid-input", "network.fetch requires a non-empty origins allowlist");
    }
    out.push({
      name,
      ...(origins ? { constraints: { origins } } : {}),
    });
  }
  return out;
}

function parseConnections(value: unknown): PackageConnectionContribution[] {
  if (value === undefined) return [];
  const items = requireArray(value, "connections must be an array");
  const out: PackageConnectionContribution[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const raw = requireRecord(item, "each connection must be an object");
    const id = requireMatchingString(raw.id, CONTRIB_ID, "connection id is invalid");
    if (seen.has(id)) fail("invalid-input", `duplicate connection id "${id}"`);
    seen.add(id);
    const label = requireNonEmptyString(raw.label, "connection label is required");
    if (raw.kind !== "oauth" && raw.kind !== "token") fail("invalid-input", 'connection kind must be "oauth" or "token"');
    const kind = raw.kind as "oauth" | "token";
    const originList = requireArray(raw.origins, "connection origins must be https origins");
    if (originList.length === 0 || originList.some((origin) => typeof origin !== "string" || !isHttpsOrigin(origin))) {
      fail("invalid-input", "connection origins must be https origins");
    }
    const origins = [...new Set(originList as string[])];
    let oauth: PackageConnectionContribution["oauth"];
    if (kind === "oauth") {
      const spec = requireRecord(raw.oauth, "oauth connection needs oauth authorize/token URLs");
      if (spec.clientIdEnv !== undefined || spec.clientSecretEnv !== undefined || spec.env !== undefined) {
        fail("invalid-input", "oauth must not reference host environment variables");
      }
      if (typeof spec.authorizeUrl !== "string" || !isHttpsUrl(spec.authorizeUrl)) {
        fail("invalid-input", "oauth.authorizeUrl must be https");
      }
      if (typeof spec.tokenUrl !== "string" || !isHttpsUrl(spec.tokenUrl)) {
        fail("invalid-input", "oauth.tokenUrl must be https");
      }
      if (typeof spec.clientId !== "string" || !OAUTH_CLIENT_ID.test(spec.clientId)) {
        fail("invalid-input", "oauth.clientId must be a public client id");
      }
      const authorizeUrl = spec.authorizeUrl as string;
      const tokenUrl = spec.tokenUrl as string;
      const clientId = spec.clientId as string;
      if (spec.scopes !== undefined && (!Array.isArray(spec.scopes) || spec.scopes.some((scope) => typeof scope !== "string"))) {
        fail("invalid-input", "oauth.scopes must be strings");
      }
      const scopes = Array.isArray(spec.scopes)
        ? (spec.scopes as unknown[]).filter((scope): scope is string => typeof scope === "string" && !!scope.trim()).map((scope) => scope.trim())
        : undefined;
      oauth = {
        authorizeUrl,
        tokenUrl,
        clientId,
        ...(scopes ? { scopes } : {}),
      };
    }
    out.push({
      id,
      label,
      kind,
      origins,
      ...(oauth ? { oauth } : {}),
    });
  }
  return out;
}

function parseRuntime(value: unknown): PackageRuntime | undefined {
  if (value === undefined) return undefined;
  const raw = requireRecord(value, "runtime must be an object");
  const kindRaw = raw.kind === undefined ? "sandboxed" : raw.kind;
  if (kindRaw !== "sandboxed" && kindRaw !== "trusted-local") {
    fail("invalid-input", 'runtime.kind must be "sandboxed" or "trusted-local"');
  }
  const kind: PackageRuntimeKind = kindRaw === "trusted-local" ? "trusted-local" : "sandboxed";
  let ui: PackageRuntime["ui"];
  if (raw.ui !== undefined) {
    const uiRaw = requireRecord(raw.ui, "runtime.ui must be an object");
    if (uiRaw.mode !== undefined) {
      fail("invalid-input", "runtime.ui.mode is not supported; use entry only");
    }
    if (typeof uiRaw.entry !== "string" || !isSafePackagePath(uiRaw.entry)) {
      fail("invalid-input", "runtime.ui.entry must be a relative path inside the package");
    }
    ui = { entry: assertSafePackagePath(uiRaw.entry as string, "runtime.ui.entry") };
  }
  let server: string | undefined;
  if (raw.server !== undefined) {
    if (kind !== "trusted-local") fail("invalid-input", "runtime.server is only valid for trusted-local packages");
    if (typeof raw.server !== "string" || !isSafePackagePath(raw.server)) {
      fail("invalid-input", "runtime.server must be a relative path inside the package");
    }
    server = assertSafePackagePath(raw.server as string, "runtime.server");
  }
  return { kind, ...(ui ? { ui } : {}), ...(server ? { server } : {}) };
}

function parseContributes(value: unknown): PackageContributes | undefined {
  if (value === undefined) return undefined;
  const raw = requireRecord(value, "contributes must be an object");
  const surfaces: PackageSurfaceContribution[] = [];
  if (raw.surfaces !== undefined) {
    const items = requireArray(raw.surfaces, "contributes.surfaces must be an array");
    const seen = new Set<string>();
    for (const item of items) {
      const surface = requireRecord(item, "each surface must be an object");
      const id = requireMatchingString(surface.id, CONTRIB_ID, "surface id is invalid");
      if (seen.has(id)) fail("invalid-input", `duplicate surface id "${id}"`);
      seen.add(id);
      const title = requireNonEmptyString(surface.title, "surface title is required");
      surfaces.push({
        id,
        title,
        ...(typeof surface.description === "string" ? { description: surface.description } : {}),
        ...(typeof surface.order === "number" && Number.isFinite(surface.order) ? { order: surface.order } : {}),
      });
    }
  }
  if (raw.widgets !== undefined) fail("invalid-input", "contributes.widgets is not supported in v1");
  if (raw.settings !== undefined) fail("invalid-input", "contributes.settings is not supported in v1");
  const composerActions: PackageComposerAction[] = [];
  if (raw.composerActions !== undefined) {
    const items = requireArray(raw.composerActions, "contributes.composerActions must be an array");
    const seen = new Set<string>();
    for (const item of items) {
      const action = requireRecord(item, "composer action id is invalid");
      const id = requireMatchingString(action.id, CONTRIB_ID, "composer action id is invalid");
      if (seen.has(id)) fail("invalid-input", `duplicate composer action "${id}"`);
      seen.add(id);
      const label = requireNonEmptyString(action.label, "composer action label is required");
      composerActions.push({
        id,
        label,
        ...(typeof action.description === "string" ? { description: action.description } : {}),
      });
    }
  }
  return {
    ...(surfaces.length ? { surfaces } : {}),
    ...(composerActions.length ? { composerActions } : {}),
  };
}

export function parsePackageManifestDocument(data: unknown): PackageManifestV1 {
  const raw = requireRecord(data, "manifest must be an object");
  if (raw.manifestVersion !== PACKAGE_MANIFEST_VERSION) {
    fail("unsupported-manifest-version", `unsupported manifestVersion; this host accepts ${PACKAGE_MANIFEST_VERSION}`);
  }
  const id = requireMatchingString(raw.id, PACKAGE_ID, "manifest id must be a short lowercase identifier");
  if (typeof raw.version !== "string" || !validSemver(raw.version)) {
    fail("invalid-input", "manifest version must be semver");
  }
  const version = raw.version as string;
  const displayRaw = requireRecord(raw.display, "display is required");
  const displayName = requireNonEmptyString(displayRaw.name, "display.name is required");
  const displayDescription = requireNonEmptyString(displayRaw.description, "display.description is required");
  let icon: string | undefined;
  if (displayRaw.icon !== undefined) {
    icon = requireNonEmptyString(displayRaw.icon, "display.icon must be a non-empty string");
    if (/:\/\//.test(icon) || /javascript:/i.test(icon) || /<[^>]+>/.test(icon)) {
      fail("invalid-input", "display.icon must not contain URLs or HTML");
    }
  }
  let engines: PackageManifestV1["engines"];
  if (raw.engines !== undefined) {
    if (!raw.engines || typeof raw.engines !== "object" || Array.isArray(raw.engines)) {
      fail("invalid-engines", "engines must be an object");
    }
    const spec = raw.engines as Record<string, unknown>;
    if (spec.polyth !== undefined && (typeof spec.polyth !== "string" || !spec.polyth.trim())) {
      fail("invalid-engines", "engines.polyth must be a semver range");
    }
    engines = typeof spec.polyth === "string" ? { polyth: spec.polyth.trim() } : {};
  }
  const runtime = parseRuntime(raw.runtime);
  if (runtime?.kind === "trusted-local" && !runtime.server && !runtime.ui) {
    fail("invalid-input", "trusted-local runtime needs ui or server");
  }
  const contributes = parseContributes(raw.contributes);
  return {
    manifestVersion: PACKAGE_MANIFEST_VERSION,
    id,
    version,
    display: {
      name: displayName,
      description: displayDescription,
      ...(icon ? { icon } : {}),
    },
    ...(engines ? { engines } : {}),
    ...(runtime ? { runtime } : {}),
    ...(contributes ? { contributes } : {}),
    capabilities: parseCapabilities(raw.capabilities),
    connections: parseConnections(raw.connections),
  };
}

export function parsePackageManifestJson(json: string): ParseManifestResult {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return err("invalid-input", "manifest is not valid JSON");
  }
  try {
    return { ok: true, manifest: parsePackageManifestDocument(data) };
  } catch (cause) {
    const error = cause as Error & { code?: string };
    return err(error.code ?? "invalid-input", error.message);
  }
}

export function assertEngineCompatible(manifest: PackageManifestV1, hostVersion: string): void {
  const range = manifest.engines?.polyth;
  if (!range) return;
  if (!engineRangeSatisfied(range, hostVersion)) {
    fail("incompatible-engine", `package requires Polyth ${range}; this host is ${hostVersion}`);
  }
}

export function requiredAssets(manifest: PackageManifestV1): string[] {
  const assets: string[] = [];
  if (manifest.runtime?.ui?.entry) assets.push(manifest.runtime.ui.entry);
  if (manifest.runtime?.server) assets.push(manifest.runtime.server);
  return assets;
}

export { expandedCapabilities, type DeclaredCapability, PACKAGE_CAPABILITY_NAMES, isPackageCapabilityName } from "./capabilities.ts";
export { assertSafePackagePath, isHttpsOrigin, isHttpsUrl, isSafePackagePath } from "./paths.ts";
export { packDirectory } from "./pack.ts";
