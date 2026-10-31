// Appearance leads each family of sizes with one control and keeps the exact
// per-part controls one click away: a shared nudge for every text size, and
// three presets for the rails. Pure, so the page and its tests share it.
import { TEXT_SIZE_MAX, TEXT_SIZE_MIN, type PolythSettings } from "../../settings.ts";
import {
  RAIL_SIZE_MAX,
  RAIL_SIZE_MIN,
  RAIL_SIZE_STEP,
  RAIL_SPACING_MAX,
  RAIL_SPACING_MIN,
  RAIL_SPACING_STEP,
  UI_DEFAULTS,
  type UiSettings,
} from "../../uiPrefs.ts";

/** Header size keeps its own wider range; every other text size shares the
 *  store's TEXT_SIZE range. */
export const HEADER_SIZE_MIN = 14;
export const HEADER_SIZE_MAX = 48;

export type TextSizes = Pick<PolythSettings, "fontSize" | "chatFontSize">
  & Pick<UiSettings, "headerFontSize" | "subheaderFontSize" | "terminalFontSize" | "editorFontSize">;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Every text size moved by the same number of pixels, each kept inside its
 *  own range, so one control grows or shrinks all text together. */
export function shiftTextSizes(sizes: TextSizes, delta: number): TextSizes {
  return {
    fontSize: clamp(sizes.fontSize + delta, TEXT_SIZE_MIN, TEXT_SIZE_MAX),
    chatFontSize: clamp(sizes.chatFontSize + delta, TEXT_SIZE_MIN, TEXT_SIZE_MAX),
    headerFontSize: clamp(sizes.headerFontSize + delta, HEADER_SIZE_MIN, HEADER_SIZE_MAX),
    subheaderFontSize: clamp(sizes.subheaderFontSize + delta, TEXT_SIZE_MIN, TEXT_SIZE_MAX),
    terminalFontSize: clamp(sizes.terminalFontSize + delta, TEXT_SIZE_MIN, TEXT_SIZE_MAX),
    editorFontSize: clamp(sizes.editorFontSize + delta, TEXT_SIZE_MIN, TEXT_SIZE_MAX),
  };
}

export type RailSizes = Pick<UiSettings, "leftRailSize" | "rightRailSize" | "topRailSize" | "railSpacing">;
export type RailPreset = "compact" | "standard" | "large";
export const RAIL_PRESETS: readonly RailPreset[] = ["compact", "standard", "large"];

/** A preset moves every rail two size steps and the icon gap one spacing step
 *  away from the defaults; "standard" is the defaults themselves. */
const PRESET_STEPS: Record<RailPreset, number> = { compact: -1, standard: 0, large: 1 };

export function railPresetSizes(preset: RailPreset): RailSizes {
  const steps = PRESET_STEPS[preset];
  const size = (value: number) => clamp(value + steps * 2 * RAIL_SIZE_STEP, RAIL_SIZE_MIN, RAIL_SIZE_MAX);
  return {
    leftRailSize: size(UI_DEFAULTS.leftRailSize),
    rightRailSize: size(UI_DEFAULTS.rightRailSize),
    topRailSize: size(UI_DEFAULTS.topRailSize),
    railSpacing: clamp(UI_DEFAULTS.railSpacing + steps * RAIL_SPACING_STEP, RAIL_SPACING_MIN, RAIL_SPACING_MAX),
  };
}

/** The preset the rails currently match, or null for hand-set sizes. */
export function railPresetOf(sizes: RailSizes): RailPreset | null {
  return RAIL_PRESETS.find((preset) => {
    const target = railPresetSizes(preset);
    return (Object.keys(target) as Array<keyof RailSizes>).every((key) => sizes[key] === target[key]);
  }) ?? null;
}
