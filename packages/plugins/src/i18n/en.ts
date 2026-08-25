/**
 * Canonical English messages owned by the plugins package. Every other locale
 * in this directory is checked against these keys.
 */
export const en = {
  "packages.plugins.installEnableAndInspectThirdPartyPlugins": "Install, enable, and inspect third-party plugins",
  "packages.plugins.managedPlugins": "Managed plugins",
  "pluginbridge.pluginWidgetValue": "Plugin widget: {title}",
  "pluginmodules.pluginValueUiEntryMustExportA": "plugin \"{pluginId}\" UI entry must export a modules component map",
} as const;

export type PluginsMessageKey = keyof typeof en;
export type PluginsMessages = Record<PluginsMessageKey, string>;
