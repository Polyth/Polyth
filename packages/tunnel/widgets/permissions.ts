import { GRANT_PROFILE_PRESETS, REMOTE_CAPABILITY as C, type GrantProfileId } from "@polyth/contracts";
import type { TunnelMessageKey } from "../src/i18n/en.ts";
import { translateEnglish, type Translate } from "./i18n.ts";

/** Every grantable capability except the full-access switch, in owner words.
 *  A test pins that this covers REMOTE_CAPABILITY_VALUES exactly. */
export const CAPABILITY_GROUPS: ReadonlyArray<{ title: TunnelMessageKey; items: ReadonlyArray<readonly [string, TunnelMessageKey]> }> = [
  { title: "tunnel.permissions.group.sessions", items: [
    [C.coreSessionsRead, "tunnel.permissions.item.sessionsRead"],
    [C.coreSessionsCreate, "tunnel.permissions.item.sessionsCreate"],
    [C.coreSessionsMessage, "tunnel.permissions.item.sessionsMessage"],
    [C.coreSessionsControl, "tunnel.permissions.item.sessionsControl"],
    [C.coreRequestsRespond, "tunnel.permissions.item.requestsRespond"],
    [C.coreNotificationsRead, "tunnel.permissions.item.notificationsRead"],
    [C.coreSessionsDelete, "tunnel.permissions.item.sessionsDelete"],
  ] },
  { title: "tunnel.permissions.group.projects", items: [
    [C.coreProjectsRead, "tunnel.permissions.item.projectsRead"],
    [C.coreProjectsWrite, "tunnel.permissions.item.projectsWrite"],
  ] },
  { title: "tunnel.permissions.group.files", items: [
    [C.filesRead, "tunnel.permissions.item.filesRead"],
    [C.filesWrite, "tunnel.permissions.item.filesWrite"],
  ] },
  { title: "tunnel.permissions.group.terminal", items: [
    [C.terminalOpen, "tunnel.permissions.item.terminalOpen"],
    [C.terminalInput, "tunnel.permissions.item.terminalInput"],
    [C.terminalResize, "tunnel.permissions.item.terminalResize"],
  ] },
  { title: "tunnel.permissions.group.git", items: [
    [C.gitRead, "tunnel.permissions.item.gitRead"],
    [C.gitWrite, "tunnel.permissions.item.gitWrite"],
  ] },
  { title: "tunnel.permissions.group.browser", items: [[C.browserUse, "tunnel.permissions.item.browserUse"]] },
  { title: "tunnel.permissions.group.voice", items: [[C.dictationUse, "tunnel.permissions.item.dictationUse"]] },
  { title: "tunnel.permissions.group.linkAdmin", items: [
    [C.tunnelStatusRead, "tunnel.permissions.item.tunnelStatusRead"],
    [C.tunnelDevicesManage, "tunnel.permissions.item.tunnelDevicesManage"],
    [C.tunnelPairingManage, "tunnel.permissions.item.tunnelPairingManage"],
    [C.tunnelGrantsManage, "tunnel.permissions.item.tunnelGrantsManage"],
  ] },
  { title: "tunnel.permissions.group.accounts", items: [
    [C.authPasswordManage, "tunnel.permissions.item.authPasswordManage"],
    [C.authSessionsManage, "tunnel.permissions.item.authSessionsManage"],
  ] },
  { title: "tunnel.permissions.group.packages", items: [
    [C.packagesInstall, "tunnel.permissions.item.packagesInstall"],
    [C.packagesEnable, "tunnel.permissions.item.packagesEnable"],
    [C.packagesDisable, "tunnel.permissions.item.packagesDisable"],
  ] },
  { title: "tunnel.permissions.group.credentials", items: [
    [C.secureSafeSecretsRead, "tunnel.permissions.item.secretsRead"],
    [C.secureSafeSecretsExport, "tunnel.permissions.item.secretsExport"],
  ] },
  { title: "tunnel.permissions.group.server", items: [
    [C.coreHealthRead, "tunnel.permissions.item.healthRead"],
    [C.serverShutdown, "tunnel.permissions.item.serverShutdown"],
    [C.serverIdentityRotate, "tunnel.permissions.item.serverIdentityRotate"],
  ] },
];

export const PRESETS: ReadonlyArray<readonly [Exclude<GrantProfileId, "full-remote">, TunnelMessageKey]> = [
  ["observe", "tunnel.permissions.preset.observe"],
  ["interact", "tunnel.permissions.preset.interact"],
  ["developer", "tunnel.permissions.preset.developer"],
];

export const hasFullAccess = (grants: readonly string[]): boolean => grants.includes(C.deviceFullAccess);

/** The preset a grant list equals exactly, if any. */
export function matchingPreset(grants: readonly string[]): GrantProfileId | null {
  const own = [...new Set(grants)].sort().join("\n");
  for (const [id] of PRESETS) {
    if ([...GRANT_PROFILE_PRESETS[id]].sort().join("\n") === own) return id;
  }
  return null;
}

export function accessLabel(grants: readonly string[], t: Translate = translateEnglish): string {
  if (hasFullAccess(grants)) return t("tunnel.permissions.fullAccess");
  const preset = matchingPreset(grants);
  const match = PRESETS.find(([id]) => id === preset);
  return match ? t(match[1]) : t("tunnel.permissions.custom");
}

/** Turning full access off keeps every individual capability the device had,
 *  so nothing silently disappears; the owner narrows from there. */
export function withFullAccess(grants: readonly string[], on: boolean): string[] {
  const rest = grants.filter((grant) => grant !== C.deviceFullAccess);
  return on ? [...rest, C.deviceFullAccess] : rest;
}
