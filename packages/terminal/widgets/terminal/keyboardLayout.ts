// The DOM half of the macOS Option rule in keymap.ts: which platform this is,
// and which base character the active layout puts on a physical key.

/** macOS (and its mobile relatives) is where Option composes characters. */
export const macOptionPlatform = (): boolean =>
  typeof navigator !== "undefined" && /mac|iphone|ipad|ipod/i.test(navigator.platform ?? "");

let layoutMapPromise: Promise<ReadonlyMap<string, string> | undefined> | null = null;

/**
 * The active keyboard layout as `KeyboardEvent.code → character`.
 *
 * `navigator.keyboard.getLayoutMap()` is Chromium-only — Polyth's desktop shell
 * has it, other engines fall back to the US Key/Digit characters in keymap.ts.
 * Read it once and cache the promise: the map is a live snapshot of the layout,
 * and asking per keypress would both cost and churn.
 */
export const loadKeyboardLayoutMap = (): Promise<ReadonlyMap<string, string> | undefined> => {
  layoutMapPromise ??= (async () => {
    if (typeof navigator === "undefined") return undefined;
    const keyboard = (navigator as Navigator & {
      keyboard?: { getLayoutMap?: () => Promise<ReadonlyMap<string, string>> };
    }).keyboard;
    if (typeof keyboard?.getLayoutMap !== "function") return undefined;
    try {
      return await keyboard.getLayoutMap();
    } catch {
      // A denied permission or an unsupported engine is not fatal: the US
      // Key/Digit fallback still covers Option+4 and Option+letter.
      return undefined;
    }
  })();
  return layoutMapPromise;
};
