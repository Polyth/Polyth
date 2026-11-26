// Second windows' own chrome (secondWindowPreload.ts ↔ main.ts). No runtime
// imports: the sandboxed preload bundles this module, so it must not pull Node
// built-ins.
import type { DesktopSecondWindowSettings, DesktopSettings } from "./types.ts";

/** The only channels a second window may use. Main answers each one for the
 *  window that asks, and never for the main window's channels. */
export const SECOND_WINDOW_CHANNELS = Object.freeze({
  get: "desktop:second-window:get",
  action: "desktop:second-window:action",
  caption: "desktop:second-window:caption",
  titlebar: "desktop:second-window:titlebar",
  /** Main → window. */
  settings: "desktop:second-window:settings",
  /** Main → window. */
  state: "desktop:second-window:state",
});

/** The settings a second window reads: the caption buttons' side, set and
 *  theme, and the performance switches the chrome follows. Built field by
 *  field, so a new desktop setting never reaches a second window by default. */
export function secondWindowSettings(settings: DesktopSettings): DesktopSecondWindowSettings {
  return {
    controlsPosition: settings.controlsPosition,
    controlsFollowSystem: settings.controlsFollowSystem,
    controlsTheme: settings.controlsTheme,
    lowResourceMode: settings.lowResourceMode,
    reduceAnimations: settings.reduceAnimations,
  };
}
