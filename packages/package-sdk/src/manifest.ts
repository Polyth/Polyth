import { satisfies as semverSatisfies, valid as validSemver } from "semver";
import {
  isPackageCapabilityName,
  type CapabilityConstraints,
  type DeclaredCapability,
  type PackageCapabilityName,
} from "./capabilities.ts";
import { assertSafePackagePath, isHttpsOrigin, isHttpsUrl, isSafePackagePath } from "./paths.ts";

export const PACKAGE_MANIFEST_VERSION = 2 as const;
export const SUPPORTED_PACKAGE_MANIFEST_VERSIONS = [1, 2] as const;
export type PackageManifestVersion = (typeof SUPPORTED_PACKAGE_MANIFEST_VERSIONS)[number];

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
  ui?: { entry: string };
  server?: string;
}

export interface PackageContributionBase {
  id: string;
  label?: string;
  description?: string;
  icon?: string;
  order?: number;
}

export interface PackageSurfaceContribution extends PackageContributionBase {
  title: string;
}

export interface PackageComposerAction extends PackageContributionBase {
  label: string;
}

export interface PackageMessageAction extends PackageContributionBase {
  label: string;
  roles?: Array<"user" | "assistant" | "tool">;
}

export interface PackageSessionAction extends PackageContributionBase {
  label: string;
}

export interface PackageCommandContribution extends PackageContributionBase {
  name: string;
  description: string;
}

export interface PackageAttachmentProvider extends PackageContributionBase {
  label: string;
}

export interface PackageContextProvider extends PackageContributionBase {
  label: string;
}

export type PackageToolOutputKind = "auto" | "text" | "json" | "markdown" | "code" | "table";

export interface PackageToolRenderer extends PackageContributionBase {
  matcher: { tools?: string[]; prefix?: string };
  presentation?: {
    title?: string;
    subtitle?: string;
    output?: PackageToolOutputKind;
  };
  /** When true the renderer may return bounded RemoteUI for a single invocation. */
  dynamic?: boolean;
}

export interface PackageStatusBadge extends PackageContributionBase {
  label: string;
}

export interface PackageSettingsSection extends PackageContributionBase {
  title: string;
}

export interface PackageWidgetContribution extends PackageContributionBase {
  title: string;
  description: string;
  defaultSlot?: "workspace.main" | "workspace.right" | "workspace.bottom" | "workspace.header";
}

export interface PackageContributesV1 {
  surfaces?: PackageSurfaceContribution[];
  composerActions?: PackageComposerAction[];
}

export interface PackageContributesV2 extends PackageContributesV1 {
  attachmentProviders?: PackageAttachmentProvider[];
  messageActions?: PackageMessageAction[];
  sessionActions?: PackageSessionAction[];
  commands?: PackageCommandContribution[];
  toolRenderers?: PackageToolRenderer[];
  statusBadges?: PackageStatusBadge[];
  settingsSections?: PackageSettingsSection[];
  contextProviders?: PackageContextProvider[];
  widgets?: PackageWidgetContribution[];
}

export interface PackageConnectionContribution {
  id: string;
  label: string;
  kind: "oauth" | "token";
  origins: string[];
  oauth?: {
    authorizeUrl: string;
    tokenUrl: string;
    clientId: string;
    scopes?: string[];
  };
}

interface PackageManifestCommon {
  id: string;
  version: string;
  engines?: { polyth?: string };
  display: PackageDisplay;
  runtime?: PackageRuntime;
  capabilities?: DeclaredCapability[];
  connections?: PackageConnectionContribution[];
}

export interface PackageManifestV1 extends PackageManifestCommon {
  manifestVersion: 1;
  contributes?: PackageContributesV1;
}

export interface PackageManifestV2 extends PackageManifestCommon {
  manifestVersion: 2;
  contributes?: PackageContributesV2;
}

export type PackageManifest = PackageManifestV1 | PackageManifestV2;
export type ParseManifestFailure = { ok: false; code: string; message: string };
export type ParseManifestSuccess = { ok: true; manifest: PackageManifest };
export type ParseManifestResult = ParseManifestSuccess | ParseManifestFailure;

const err = (code: string, message: string): ParseManifestFailure => ({ ok: false, code, message });
const fail: (code: string, message: string) => never = (code, message) => {
  throw Object.assign(new Error(message), { code });
};

const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONTRIB_ID = /^[a-z][a-z0-9._-]{0,63}$/;
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const OAUTH_CLIENT_ID = /^[\x21-\x7E]{1,256}$/;
const MAX_CONTRIBUTIONS_PER_KIND = 32;
const MAX_LABEL = 120;
const MAX_DESCRIPTION = 500;
const MAX_MATCHERS = 32;

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-input", message);
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, message: string, max = MAX_DESCRIPTION): string {
  if (typeof value !== "string" || !value.trim()) fail("invalid-input", message);
  const text = value.trim();
  if (text.length > max) fail("invalid-input", `${message}; maximum length is ${max}`);
  return text;
}

function optionalString(value: unknown, message: string, max = MAX_DESCRIPTION): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, message, max);
}

function requireArray(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) fail("invalid-input", message);
  return value as unknown[];
}

function requireMatchingString(value: unknown, pattern: RegExp, message: string): string {
  if (typeof value !== "string" || !pattern.test(value)) fail("invalid-input", message);
  return value as string;
}

function parseIcon(value: unknown, message = "icon is invalid"): string | undefined {
  if (value === undefined) return undefined;
  const icon = requireNonEmptyString(value, message, 64);
  if (/:\/\//.test(icon) || /javascript:/i.test(icon) || /<[^>]+>/.test(icon)) {
    fail("invalid-input", `${message}; URLs and HTML are not allowed`);
  }
  return icon;
}

function parseOrder(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < -10_000 || value > 10_000) {
    fail("invalid-input", "contribution order must be a finite number between -10000 and 10000");
  }
  return value;
}

function parseStringList(value: unknown, message: string, max: number): string[] | undefined {
  if (value === undefined) return undefined;
  const values = requireArray(value, message);
  if (values.length > max || values.some((item) => typeof item !== "string" || !item.trim())) fail("invalid-input", message);
  return [...new Set((values as string[]).map((item) => item.trim()))];
}

function parseCapabilityConstraints(name: PackageCapabilityName, raw: Record<string, unknown>): CapabilityConstraints | undefined {
  const origins = parseStringList(raw.origins, `${name} origins must be https origins`, 64);
  if (origins?.some((origin) => !isHttpsOrigin(origin))) fail("invalid-input", `${name} origins must be https origins`);
  const methods = parseStringList(raw.methods, `${name} methods are invalid`, 6) as CapabilityConstraints["methods"];
  if (methods?.some((method) => !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method))) {
    fail("invalid-input", `${name} methods are invalid`);
  }
  const modelClasses = parseStringList(raw.modelClasses, `${name} modelClasses are invalid`, 1) as CapabilityConstraints["modelClasses"];
  if (modelClasses?.some((value) => value !== "utility")) fail("invalid-input", `${name} modelClasses are invalid`);
  let maxOutputTokens: number | undefined;
  if (raw.maxOutputTokens !== undefined) {
    if (!Number.isInteger(raw.maxOutputTokens) || Number(raw.maxOutputTokens) < 1 || Number(raw.maxOutputTokens) > 4_096) {
      fail("invalid-input", `${name} maxOutputTokens must be between 1 and 4096`);
    }
    maxOutputTokens = Number(raw.maxOutputTokens);
  }
  if (name === "network.fetch" && !origins?.length) fail("invalid-input", "network.fetch requires a non-empty origins allowlist");
  if (name === "model.generate" && !modelClasses?.length) fail("invalid-input", "model.generate requires modelClasses");
  if (!origins?.length && !methods?.length && !modelClasses?.length && maxOutputTokens === undefined) return undefined;
  return {
    ...(origins?.length ? { origins } : {}),
    ...(methods?.length ? { methods } : {}),
    ...(modelClasses?.length ? { modelClasses } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}

function parseCapabilities(value: unknown): DeclaredCapability[] {
  if (value === undefined) return [];
  const items = requireArray(value, "capabilities must be an array");
  const out: DeclaredCapability[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item === "string") {
      if (!isPackageCapabilityName(item)) fail("invalid-input", `unknown capability "${item}"`);
      if (seen.has(item)) fail("invalid-input", `duplicate capability "${item}"`);
      if (["network.fetch", "model.generate"].includes(item)) {
        fail("invalid-input", `${item} requires explicit constraints`);
      }
      seen.add(item);
      out.push({ name: item });
      continue;
    }
    const raw = requireRecord(item, "each capability must be a string or object");
    if (typeof raw.name !== "string" || !isPackageCapabilityName(raw.name)) fail("invalid-input", `unknown capability "${String(raw.name)}"`);
    const name = raw.name;
    if (seen.has(name)) fail("invalid-input", `duplicate capability "${name}"`);
    seen.add(name);
    const constraints = parseCapabilityConstraints(name, raw);
    out.push({
      name,
      ...(raw.required === false ? { required: false } : {}),
      ...(constraints ? { constraints } : {}),
    });
  }
  return out;
}

function parseConnections(value: unknown): PackageConnectionContribution[] {
  if (value === undefined) return [];
  const items = requireArray(value, "connections must be an array");
  if (items.length > 16) fail("invalid-input", "too many connections");
  const out: PackageConnectionContribution[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const raw = requireRecord(item, "each connection must be an object");
    const id = requireMatchingString(raw.id, CONTRIB_ID, "connection id is invalid");
    if (seen.has(id)) fail("invalid-input", `duplicate connection id "${id}"`);
    seen.add(id);
    const label = requireNonEmptyString(raw.label, "connection label is required", MAX_LABEL);
    if (raw.kind !== "oauth" && raw.kind !== "token") fail("invalid-input", 'connection kind must be "oauth" or "token"');
    const kind = raw.kind as "oauth" | "token";
    const originList = requireArray(raw.origins, "connection origins must be https origins");
    if (originList.length === 0 || originList.length > 32 || originList.some((origin) => typeof origin !== "string" || !isHttpsOrigin(origin))) {
      fail("invalid-input", "connection origins must be https origins");
    }
    const origins = [...new Set(originList as string[])];
    let oauth: PackageConnectionContribution["oauth"];
    if (kind === "oauth") {
      const spec = requireRecord(raw.oauth, "oauth connection needs oauth authorize/token URLs");
      if (spec.clientIdEnv !== undefined || spec.clientSecretEnv !== undefined || spec.env !== undefined) fail("invalid-input", "oauth must not reference host environment variables");
      if (typeof spec.authorizeUrl !== "string" || !isHttpsUrl(spec.authorizeUrl)) fail("invalid-input", "oauth.authorizeUrl must be https");
      if (typeof spec.tokenUrl !== "string" || !isHttpsUrl(spec.tokenUrl)) fail("invalid-input", "oauth.tokenUrl must be https");
      if (typeof spec.clientId !== "string" || !OAUTH_CLIENT_ID.test(spec.clientId)) fail("invalid-input", "oauth.clientId must be a public client id");
      const scopes = parseStringList(spec.scopes, "oauth.scopes must be strings", 64);
      oauth = {
        authorizeUrl: spec.authorizeUrl,
        tokenUrl: spec.tokenUrl,
        clientId: spec.clientId,
        ...(scopes?.length ? { scopes } : {}),
      };
    }
    out.push({ id, label, kind, origins, ...(oauth ? { oauth } : {}) });
  }
  return out;
}

function parseRuntime(value: unknown): PackageRuntime | undefined {
  if (value === undefined) return undefined;
  const raw = requireRecord(value, "runtime must be an object");
  const kindRaw = raw.kind === undefined ? "sandboxed" : raw.kind;
  if (kindRaw !== "sandboxed" && kindRaw !== "trusted-local") fail("invalid-input", 'runtime.kind must be "sandboxed" or "trusted-local"');
  const kind: PackageRuntimeKind = kindRaw;
  let ui: PackageRuntime["ui"];
  if (raw.ui !== undefined) {
    const uiRaw = requireRecord(raw.ui, "runtime.ui must be an object");
    if (uiRaw.mode !== undefined) fail("invalid-input", "runtime.ui.mode is not supported; use entry only");
    if (typeof uiRaw.entry !== "string" || !isSafePackagePath(uiRaw.entry)) fail("invalid-input", "runtime.ui.entry must be a relative path inside the package");
    ui = { entry: assertSafePackagePath(uiRaw.entry, "runtime.ui.entry") };
  }
  let server: string | undefined;
  if (raw.server !== undefined) {
    if (kind !== "trusted-local") fail("invalid-input", "runtime.server is only valid for trusted-local packages");
    if (typeof raw.server !== "string" || !isSafePackagePath(raw.server)) fail("invalid-input", "runtime.server must be a relative path inside the package");
    server = assertSafePackagePath(raw.server, "runtime.server");
  }
  return { kind, ...(ui ? { ui } : {}), ...(server ? { server } : {}) };
}

function baseContribution(raw: Record<string, unknown>, kind: string): PackageContributionBase {
  const label = optionalString(raw.label, `${kind} label is invalid`, MAX_LABEL);
  const description = optionalString(raw.description, `${kind} description is invalid`);
  const icon = parseIcon(raw.icon, `${kind} icon is invalid`);
  const order = parseOrder(raw.order);
  return {
    id: requireMatchingString(raw.id, CONTRIB_ID, `${kind} id is invalid`),
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
    ...(icon ? { icon } : {}),
    ...(order !== undefined ? { order } : {}),
  };
}

function parseContributionArray<T>(
  value: unknown,
  kind: string,
  seen: Set<string>,
  parse: (raw: Record<string, unknown>) => T & { id: string },
): T[] {
  if (value === undefined) return [];
  const items = requireArray(value, `contributes.${kind} must be an array`);
  if (items.length > MAX_CONTRIBUTIONS_PER_KIND) fail("invalid-input", `contributes.${kind} exceeds ${MAX_CONTRIBUTIONS_PER_KIND} items`);
  return items.map((item) => {
    const parsed = parse(requireRecord(item, `each ${kind} contribution must be an object`));
    if (seen.has(parsed.id)) fail("invalid-input", `duplicate contribution id "${parsed.id}"`);
    seen.add(parsed.id);
    return parsed;
  });
}

function parseContributes(value: unknown, version: PackageManifestVersion): PackageContributesV1 | PackageContributesV2 | undefined {
  if (value === undefined) return undefined;
  const raw = requireRecord(value, "contributes must be an object");
  const seen = new Set<string>();
  const surfaces = parseContributionArray(raw.surfaces, "surfaces", seen, (item): PackageSurfaceContribution => ({
    ...baseContribution(item, "surface"),
    title: requireNonEmptyString(item.title, "surface title is required", MAX_LABEL),
  }));
  const composerActions = parseContributionArray(raw.composerActions, "composerActions", seen, (item): PackageComposerAction => ({
    ...baseContribution(item, "composer action"),
    label: requireNonEmptyString(item.label, "composer action label is required", MAX_LABEL),
  }));
  if (version === 1) {
    for (const key of ["attachmentProviders", "messageActions", "sessionActions", "commands", "toolRenderers", "statusBadges", "settingsSections", "contextProviders", "widgets", "settings"]) {
      if (raw[key] !== undefined) fail("invalid-input", `contributes.${key} is not supported in v1`);
    }
    return { ...(surfaces.length ? { surfaces } : {}), ...(composerActions.length ? { composerActions } : {}) };
  }

  const attachmentProviders = parseContributionArray(raw.attachmentProviders, "attachmentProviders", seen, (item): PackageAttachmentProvider => ({
    ...baseContribution(item, "attachment provider"),
    label: requireNonEmptyString(item.label, "attachment provider label is required", MAX_LABEL),
  }));
  const messageActions = parseContributionArray(raw.messageActions, "messageActions", seen, (item): PackageMessageAction => {
    const roles = parseStringList(item.roles, "message action roles are invalid", 3) as PackageMessageAction["roles"];
    if (roles?.some((role) => role !== "user" && role !== "assistant" && role !== "tool")) fail("invalid-input", "message action roles are invalid");
    return { ...baseContribution(item, "message action"), label: requireNonEmptyString(item.label, "message action label is required", MAX_LABEL), ...(roles?.length ? { roles } : {}) };
  });
  const sessionActions = parseContributionArray(raw.sessionActions, "sessionActions", seen, (item): PackageSessionAction => ({
    ...baseContribution(item, "session action"),
    label: requireNonEmptyString(item.label, "session action label is required", MAX_LABEL),
  }));
  const commands = parseContributionArray(raw.commands, "commands", seen, (item): PackageCommandContribution => ({
    ...baseContribution(item, "command"),
    name: requireMatchingString(item.name, COMMAND_NAME, "command name is invalid"),
    description: requireNonEmptyString(item.description, "command description is required"),
  }));
  const toolRenderers = parseContributionArray(raw.toolRenderers, "toolRenderers", seen, (item): PackageToolRenderer => {
    const matcher = requireRecord(item.matcher, "tool renderer matcher is required");
    const tools = parseStringList(matcher.tools, "tool renderer tools are invalid", MAX_MATCHERS);
    const prefix = optionalString(matcher.prefix, "tool renderer prefix is invalid", 120);
    if (!tools?.length && !prefix) fail("invalid-input", "tool renderer matcher needs tools or prefix");
    let presentation: PackageToolRenderer["presentation"];
    if (item.presentation !== undefined) {
      const p = requireRecord(item.presentation, "tool renderer presentation is invalid");
      const output = p.output;
      if (output !== undefined && !["auto", "text", "json", "markdown", "code", "table"].includes(String(output))) fail("invalid-input", "tool renderer output is invalid");
      const title = optionalString(p.title, "tool renderer title is invalid", MAX_LABEL);
      const subtitle = optionalString(p.subtitle, "tool renderer subtitle is invalid", MAX_LABEL);
      presentation = {
        ...(title ? { title } : {}),
        ...(subtitle ? { subtitle } : {}),
        ...(output ? { output: output as PackageToolOutputKind } : {}),
      };
    }
    return {
      ...baseContribution(item, "tool renderer"),
      matcher: { ...(tools?.length ? { tools } : {}), ...(prefix ? { prefix } : {}) },
      ...(presentation ? { presentation } : {}),
      ...(item.dynamic === true ? { dynamic: true } : {}),
    };
  });
  const statusBadges = parseContributionArray(raw.statusBadges, "statusBadges", seen, (item): PackageStatusBadge => ({
    ...baseContribution(item, "status badge"), label: requireNonEmptyString(item.label, "status badge label is required", MAX_LABEL),
  }));
  const settingsSections = parseContributionArray(raw.settingsSections, "settingsSections", seen, (item): PackageSettingsSection => ({
    ...baseContribution(item, "settings section"), title: requireNonEmptyString(item.title, "settings section title is required", MAX_LABEL),
  }));
  const contextProviders = parseContributionArray(raw.contextProviders, "contextProviders", seen, (item): PackageContextProvider => ({
    ...baseContribution(item, "context provider"), label: requireNonEmptyString(item.label, "context provider label is required", MAX_LABEL),
  }));
  const widgets = parseContributionArray(raw.widgets, "widgets", seen, (item): PackageWidgetContribution => {
    const slot = item.defaultSlot;
    if (slot !== undefined && !["workspace.main", "workspace.right", "workspace.bottom", "workspace.header"].includes(String(slot))) fail("invalid-input", "widget defaultSlot is invalid");
    return {
      ...baseContribution(item, "widget"),
      title: requireNonEmptyString(item.title, "widget title is required", MAX_LABEL),
      description: requireNonEmptyString(item.description, "widget description is required"),
      ...(slot ? { defaultSlot: slot as PackageWidgetContribution["defaultSlot"] } : {}),
    };
  });
  return {
    ...(surfaces.length ? { surfaces } : {}),
    ...(composerActions.length ? { composerActions } : {}),
    ...(attachmentProviders.length ? { attachmentProviders } : {}),
    ...(messageActions.length ? { messageActions } : {}),
    ...(sessionActions.length ? { sessionActions } : {}),
    ...(commands.length ? { commands } : {}),
    ...(toolRenderers.length ? { toolRenderers } : {}),
    ...(statusBadges.length ? { statusBadges } : {}),
    ...(settingsSections.length ? { settingsSections } : {}),
    ...(contextProviders.length ? { contextProviders } : {}),
    ...(widgets.length ? { widgets } : {}),
  };
}

export function parsePackageManifestDocument(data: unknown): PackageManifest {
  const raw = requireRecord(data, "manifest must be an object");
  if (raw.manifestVersion !== 1 && raw.manifestVersion !== 2) {
    fail("unsupported-manifest-version", `unsupported manifestVersion; this host accepts ${SUPPORTED_PACKAGE_MANIFEST_VERSIONS.join(", ")}`);
  }
  const manifestVersion = raw.manifestVersion as PackageManifestVersion;
  const id = requireMatchingString(raw.id, PACKAGE_ID, "manifest id must be a short lowercase identifier");
  if (typeof raw.version !== "string" || !validSemver(raw.version)) fail("invalid-input", "manifest version must be semver");
  const version = raw.version;
  const displayRaw = requireRecord(raw.display, "display is required");
  const displayIcon = parseIcon(displayRaw.icon, "display.icon is invalid");
  const display: PackageDisplay = {
    name: requireNonEmptyString(displayRaw.name, "display.name is required", MAX_LABEL),
    description: requireNonEmptyString(displayRaw.description, "display.description is required"),
    ...(displayIcon ? { icon: displayIcon } : {}),
  };
  let engines: PackageManifest["engines"];
  if (raw.engines !== undefined) {
    const spec = requireRecord(raw.engines, "engines must be an object");
    if (spec.polyth !== undefined && (typeof spec.polyth !== "string" || !spec.polyth.trim())) fail("invalid-engines", "engines.polyth must be a semver range");
    engines = typeof spec.polyth === "string" ? { polyth: spec.polyth.trim() } : {};
  }
  const runtime = parseRuntime(raw.runtime);
  if (runtime?.kind === "trusted-local" && !runtime.server && !runtime.ui) fail("invalid-input", "trusted-local runtime needs ui or server");
  const common = {
    id,
    version,
    display,
    ...(engines ? { engines } : {}),
    ...(runtime ? { runtime } : {}),
    capabilities: parseCapabilities(raw.capabilities),
    connections: parseConnections(raw.connections),
  };
  const contributes = parseContributes(raw.contributes, manifestVersion);
  return manifestVersion === 1
    ? { manifestVersion: 1, ...common, ...(contributes ? { contributes: contributes as PackageContributesV1 } : {}) }
    : { manifestVersion: 2, ...common, ...(contributes ? { contributes: contributes as PackageContributesV2 } : {}) };
}

export function parsePackageManifestJson(json: string): ParseManifestResult {
  let data: unknown;
  try { data = JSON.parse(json); } catch { return err("invalid-input", "manifest is not valid JSON"); }
  try { return { ok: true, manifest: parsePackageManifestDocument(data) }; }
  catch (cause) {
    const error = cause as Error & { code?: string };
    return err(error.code ?? "invalid-input", error.message);
  }
}

export function assertEngineCompatible(manifest: PackageManifest, hostVersion: string): void {
  const range = manifest.engines?.polyth;
  if (range && !engineRangeSatisfied(range, hostVersion)) fail("incompatible-engine", `package requires Polyth ${range}; this host is ${hostVersion}`);
}

export function requiredAssets(manifest: PackageManifest): string[] {
  const assets: string[] = [];
  if (manifest.runtime?.ui?.entry) assets.push(manifest.runtime.ui.entry);
  if (manifest.runtime?.server) assets.push(manifest.runtime.server);
  return assets;
}

export { expandedCapabilities, type CapabilityConstraints, type DeclaredCapability, PACKAGE_CAPABILITY_NAMES, isPackageCapabilityName } from "./capabilities.ts";
export { assertSafePackagePath, isHttpsOrigin, isHttpsUrl, isSafePackagePath } from "./paths.ts";
export { packDirectory } from "./pack.ts";
