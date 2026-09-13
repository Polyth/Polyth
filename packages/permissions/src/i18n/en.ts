/**
 * Canonical English messages owned by the permissions package. Every other locale
 * in this directory is checked against these keys.
 */
export const en = {
  "permissionbanner.agentWantsToUseBrowser": "Agent wants to use Browser",
  "permissionbanner.allSession": "All session",
  "permissionbanner.allowAllSession": "Allow every following action in this session",
  "permissionbanner.allowOnce": "Allow once",
  "permissionbanner.always": "Always",
  "permissionbanner.alwaysScope": "Always scope",
  "permissionbanner.browserActionCapabilities": "Open pages, read visible content, and interact with page controls.",
  "permissionbanner.deny": "Deny",
  "permissionbanner.denyShort": "Deny",
  "permissionbanner.once": "Once",
  "permissionbanner.permissionRequested": "Permission requested",
  "permissionbanner.risk": "risk",
  "permissionbanner.session": "Session",
  "permissionbanner.thisSession": "this session",
  "permissionbanner.viaValue": "via {tool}",
} as const;

export type PermissionsMessageKey = keyof typeof en;
export type PermissionsMessages = Record<PermissionsMessageKey, string>;
