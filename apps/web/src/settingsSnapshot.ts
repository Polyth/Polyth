// What the person's look was when the last launch ended — theme, accent,
// density, text sizes, shell style, wallpaper preset — kept per connection and
// account in the app-owned store, so a native launch paints it before the first
// render while the same settings are on their way from the server. The native
// shell's origin storage starts empty on every launch (random loopback port),
// which is why the server copy alone arrives after the first frame.
//
// Only what the look needs is kept: the product settings that style the shell,
// the UI settings that style it, the wallpaper *preset* id and the one custom
// theme the palette names, and three first-screen preferences (hero widgets,
// hero board, phone composer buttons). Nothing else from the settings blob (model picks,
// notification templates, MCP servers, sidebar state, tokens) is written. A
// custom wallpaper image stays out: it is a device asset with its own record
// (customWallpaperMemory.ts). Applying this never leaves the device; the
// server's own answer replaces it (settingsSync.ts).
import { hasClientPersistenceBackend, hydrateClientRecord, writeClientPreference, type PersistenceScope } from "./clientPersistence.ts";
import { clientAccountPersistenceScope } from "./reliabilityContext.ts";
import { normalizeSettings, type PolythSettings } from "./settings.ts";
import { parseUiSettings, type UiSettings } from "./uiPrefs.ts";
import { backgroundPresetArt } from "./backgrounds.ts";
import { parseCustomThemes, type ThemeSpec } from "./theme.ts";

const KIND = "settings-look-v1";
/** Well under the Link store's 256 KB per record. */
export const SETTINGS_LOOK_MAX_BYTES = 64 * 1024;

export const LOOK_PRODUCT_KEYS = [
  "theme", "appearanceMode", "themeStyle", "accentColor", "density", "fontSize", "chatFontSize", "fontFamily",
  // Shape the first screen's list and times.
  "relativeTime", "defaultVisibleSessionCount",
] as const satisfies readonly (keyof PolythSettings)[];
export const LOOK_UI_KEYS = [
  "density", "headerFontSize", "subheaderFontSize", "terminalFontSize", "editorFontSize", "rounding",
  "glassEffect", "hideBorders", "shellLook", "mirrorLayout", "chatWidth",
  // What the first screen is made of: phone header and composer buttons,
  // message chrome, the rails and the shell layout.
  "mobileSessionTitle", "mobileShortcuts", "showTechnicalButtons", "showDictate", "showAutoApprove", "showGoals",
  "showQuickActions", "activityBlockStyle", "composerStatusStyle", "thinkingDisplayMode", "actionGrouping",
  "statusBar", "showMessageActions", "showAnswerQuickActions", "pinLatestPrompt", "promptBookmarkDesktop",
  "promptNavigator", "promptNavigatorSide", "topRailAlignment", "topRailSurface", "shellLayout",
  "shellBarStyle", "floatingColumns", "shellToolsDock", "shellActionsDock", "shellTitle", "topRailSize",
  "rightRailSize", "leftRailSize", "railSpacing",
] as const satisfies readonly (keyof UiSettings)[];

/** Account preferences that shape the first screen (hero widgets and board,
 *  the phone composer's buttons). Their own stores validate the values when
 *  they are written; this record only carries the JSON. Others (rails, the
 *  project interface choice) hold navigation or per-project state and stay out. */
export const LOOK_PREFERENCE_IDS = ["core.hero-widgets", "core.hero-board", "core.mobile-composer-rail"] as const;

export type LookProduct = Pick<PolythSettings, (typeof LOOK_PRODUCT_KEYS)[number]>;
export type LookUi = Pick<UiSettings, (typeof LOOK_UI_KEYS)[number]>;

/** The look as the stores hold it. `background` is a preset id; a custom image
 *  is never part of it. `customTheme` is the one custom palette in use. */
export interface SettingsLook {
  product: LookProduct;
  ui: LookUi;
  background: string;
  customTheme: ThemeSpec | null;
  /** JSON values by preference id, only the ids in LOOK_PREFERENCE_IDS. */
  preferences: Record<string, unknown>;
}

export interface SettingsLookRecord extends SettingsLook {
  v: 1;
  savedAt: number;
}

function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) out[key] = source[key];
  return out;
}

export const pickLookProduct = (settings: PolythSettings): LookProduct => pick(settings, LOOK_PRODUCT_KEYS);
export const pickLookUi = (settings: UiSettings): LookUi => pick(settings, LOOK_UI_KEYS);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Serialized look under the byte cap. Over it, the preferences go first, then
 *  the custom theme; null when even the bare look is too large (it is then
 *  simply not remembered). */
export function encodeSettingsLook(look: SettingsLook, savedAt: number): string | null {
  const attempts: Array<Pick<SettingsLook, "customTheme" | "preferences">> = [
    { customTheme: look.customTheme, preferences: look.preferences },
    { customTheme: look.customTheme, preferences: {} },
    { customTheme: null, preferences: {} },
  ];
  for (const attempt of attempts) {
    const encoded = JSON.stringify({ v: 1, savedAt, ...look, ...attempt } satisfies SettingsLookRecord);
    if (encoded.length <= SETTINGS_LOOK_MAX_BYTES) return encoded;
  }
  return null;
}

/** A record that is missing, corrupt, oversized, of another version or without
 *  a usable product section decodes to null: the launch is then as it was
 *  before the look was remembered. Every value goes through its own store's
 *  parser, so an edited record cannot inject anything those stores refuse. */
export function decodeSettingsLook(raw: string | null): SettingsLookRecord | null {
  if (!raw || raw.length > SETTINGS_LOOK_MAX_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!isRecord(value) || value.v !== 1 || typeof value.savedAt !== "number") return null;
  if (!isRecord(value.product) || !isRecord(value.ui)) return null;
  const background = typeof value.background === "string" && backgroundPresetArt(value.background, "dark") !== null
    ? value.background
    : "";
  const customTheme = parseCustomThemes(JSON.stringify([value.customTheme]))[0] ?? null;
  const preferences: Record<string, unknown> = {};
  if (isRecord(value.preferences)) {
    for (const id of LOOK_PREFERENCE_IDS) {
      const item = value.preferences[id];
      if (item !== null && typeof item === "object") preferences[id] = item;
    }
  }
  return {
    v: 1,
    savedAt: value.savedAt,
    product: pickLookProduct(normalizeSettings(value.product)),
    ui: pickLookUi(parseUiSettings(JSON.stringify(value.ui))),
    background,
    customTheme,
    preferences,
  };
}

/** Whose look this is: the connection and the signed-in account. Settings are
 *  account-owned, so the Space is not part of it. */
const scope = (): PersistenceScope => clientAccountPersistenceScope();

/** The remembered look, or null in a browser (origin storage already works
 *  there) and whenever the record cannot be used. */
export async function readSettingsLook(): Promise<SettingsLookRecord | null> {
  if (!hasClientPersistenceBackend()) return null;
  try {
    return decodeSettingsLook(await hydrateClientRecord(KIND, scope()));
  } catch {
    return null; // a slow or failed store read only means no head start
  }
}

/** Presentation only: a lost write costs the next launch its head start. */
export function writeSettingsLook(encoded: string): void {
  if (!hasClientPersistenceBackend()) return;
  writeClientPreference(KIND, scope(), encoded);
}
