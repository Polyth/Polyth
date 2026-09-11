/**
 * Canonical English messages owned by the permissions package. Every other locale
 * in this directory is checked against these keys.
 */
export const en = {
  "permissionbanner.agentWantsToUseBrowser": "Agent wants to use Browser",
  "permissionbanner.allowOnce": "Allow once",
  "permissionbanner.always": "Always",
  "permissionbanner.alwaysScope": "Always scope",
  "permissionbanner.browserActionCapabilities": "Open pages, read visible content, and interact with page controls.",
  "permissionbanner.deny": "Deny",
  "permissionbanner.permissionRequested": "Permission requested",
  "permissionbanner.risk": "risk",
  "permissionbanner.thisSession": "this session",
  "permissionbanner.viaValue": "via {tool}",
} as const;

export type PermissionsMessageKey = keyof typeof en;
export type PermissionsMessages = Record<PermissionsMessageKey, string>;
