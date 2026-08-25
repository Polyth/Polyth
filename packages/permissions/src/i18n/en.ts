/**
 * Canonical English messages owned by the permissions package. Every other locale
 * in this directory is checked against these keys.
 */
export const en = {
  "permissionbanner.allowOnce": "Allow once",
  "permissionbanner.always": "Always",
  "permissionbanner.alwaysScope": "Always scope",
  "permissionbanner.deny": "Deny",
  "permissionbanner.permissionRequested": "Permission requested",
  "permissionbanner.risk": "risk",
  "permissionbanner.thisSession": "this session",
  "permissionbanner.viaValue": "via {tool}",
} as const;

export type PermissionsMessageKey = keyof typeof en;
export type PermissionsMessages = Record<PermissionsMessageKey, string>;
