// Keep-awake decides when the app-suspension blocker is held. "working" holds
// it only while the renderer reports a working agent, the way a coffee cup
// keeps a machine up through a long run and lets it sleep afterwards;
// "always" holds it for as long as Polyth runs (the behaviour before modes).
import type { DesktopKeepAwakeMode, DesktopSettings } from "./types.ts";

/** A settings file written before modes has no `keepAwakeMode`: an enabled
 *  keep-awake there meant "always", so it keeps meaning that. */
export function normalizeKeepAwakeMode(raw: Record<string, unknown>, fallback: DesktopKeepAwakeMode): DesktopKeepAwakeMode {
  if (raw.keepAwakeMode === "working" || raw.keepAwakeMode === "always") return raw.keepAwakeMode;
  return raw.keepAwake === true ? "always" : fallback;
}

export function keepAwakeWanted(settings: Pick<DesktopSettings, "keepAwake" | "keepAwakeMode">, working: boolean): boolean {
  return settings.keepAwake && (settings.keepAwakeMode === "always" || working);
}
