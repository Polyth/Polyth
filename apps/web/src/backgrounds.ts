// Background presets are account preferences. A custom image stays on this
// device so unrelated settings changes never resend a multi-megabyte data URL.
// localStorage is the synchronous cache for both choices.
// `edge` is the raw image's average colour along the bottom 120px of a
// 430×932 phone frame (cover, as painted). The keyboard band below the page
// can only take a flat colour, so it mixes this with the theme tint the same
// way the root wallpaper does (docs/dev/mobile-viewport.md). Re-measure it
// whenever an image changes, together with `tone`.
import { tr, type TranslationKey } from "./i18n/index.ts";

export type BackgroundAppearance = "dark" | "light";

/** A wallpaper's tone as painted, from the relative luminance of its pixels:
 *  "light" when even its darkest parts are light (5th percentile at or above
 *  BACKGROUND_TONE_LIGHT_FLOOR), "dark" when even its glows stay below
 *  mid-grey (95th percentile at or below BACKGROUND_TONE_DARK_CEILING), else
 *  "mixed". Preset tones are measured per painted variant on 430×932 and
 *  1440×900 frames; a custom image is sampled when applied. Published as
 *  html[data-background-tone] (absent for no wallpaper and while a custom
 *  image is unread), so CSS can tell a wallpaper that fights the appearance:
 *  the chat inks (styles.css "Wallpaper wash") and the interface styles'
 *  veils (shellLooks.css) both read it. */
export type BackgroundTone = "dark" | "light" | "mixed";
export const BACKGROUND_TONE_LIGHT_FLOOR = 0.4;
export const BACKGROUND_TONE_DARK_CEILING = 0.25;

export interface BackgroundArt {
  /** Catalog key of the one-line mood under the tile. */
  readonly description: TranslationKey;
  readonly image: string;
  /** Picker tile; defaults to the image itself. */
  readonly preview?: string;
  readonly edge: string | null;
  readonly tone: BackgroundTone | null;
}

interface BackgroundPresetSpec extends BackgroundArt {
  readonly id: string;
  readonly name: string;
  readonly preview: string;
  readonly systemBar: { readonly dark: string; readonly light: string } | null;
  /** A theme-following preset paints this art in that appearance instead. */
  readonly dark?: BackgroundArt;
  readonly light?: BackgroundArt;
}

export const BACKGROUND_PRESETS = [
  {
    id: "none",
    name: "None",
    description: "backgrounds.none",
    image: "none",
    preview: "linear-gradient(145deg, #17191d, #30343b)",
    systemBar: null,
    edge: null,
    tone: null,
  },
  {
    id: "signal-bloom",
    name: "Signal Bloom",
    description: "backgrounds.signalBloom",
    image: "radial-gradient(circle at 14% 8%, rgba(55, 235, 195, .72) 0, rgba(55, 235, 195, 0) 34%), radial-gradient(circle at 86% 14%, rgba(116, 89, 255, .82) 0, rgba(116, 89, 255, 0) 39%), radial-gradient(circle at 68% 92%, rgba(242, 88, 142, .62) 0, rgba(242, 88, 142, 0) 41%), linear-gradient(145deg, #06191a 0%, #11152c 48%, #271329 100%)",
    preview: "radial-gradient(circle at 14% 8%, #37ebc3 0, transparent 38%), radial-gradient(circle at 86% 14%, #7459ff 0, transparent 42%), radial-gradient(circle at 68% 92%, #f2588e 0, transparent 44%), linear-gradient(#11152c, #11152c)",
    systemBar: { dark: "#173a3b", light: "#dcebe7" },
    edge: "#742f52",
    tone: "dark",
  },
  {
    id: "blue-hour",
    name: "Blue Hour",
    description: "backgrounds.blueHour",
    image: "radial-gradient(circle at 76% 18%, rgba(68, 218, 255, .7) 0, rgba(68, 218, 255, 0) 34%), radial-gradient(circle at 18% 74%, rgba(64, 91, 255, .74) 0, rgba(64, 91, 255, 0) 42%), linear-gradient(135deg, #05111f 0%, #0d2340 48%, #152d50 100%)",
    preview: "radial-gradient(circle at 76% 18%, #44daff 0, transparent 38%), radial-gradient(circle at 18% 74%, #405bff 0, transparent 46%), linear-gradient(#0d2340, #0d2340)",
    systemBar: { dark: "#16364a", light: "#dce8f1" },
    edge: "#1b336c",
    tone: "dark",
  },
  {
    id: "ember-veil",
    name: "Ember Veil",
    description: "backgrounds.emberVeil",
    image: "radial-gradient(circle at 18% 16%, rgba(255, 174, 91, .76) 0, rgba(255, 174, 91, 0) 36%), radial-gradient(circle at 83% 74%, rgba(190, 69, 135, .67) 0, rgba(190, 69, 135, 0) 43%), linear-gradient(140deg, #26120e 0%, #321826 48%, #171226 100%)",
    preview: "radial-gradient(circle at 18% 16%, #ffae5b 0, transparent 40%), radial-gradient(circle at 83% 74%, #be4587 0, transparent 46%), linear-gradient(#321826, #321826)",
    systemBar: { dark: "#4a2d31", light: "#f0e3dc" },
    edge: "#3c1d37",
    tone: "dark",
  },
  {
    id: "moss-circuit",
    name: "Moss Circuit",
    description: "backgrounds.mossCircuit",
    image: "radial-gradient(circle at 22% 14%, rgba(103, 229, 156, .67) 0, rgba(103, 229, 156, 0) 37%), radial-gradient(circle at 78% 82%, rgba(227, 175, 74, .58) 0, rgba(227, 175, 74, 0) 40%), linear-gradient(145deg, #071713 0%, #14251d 50%, #272014 100%)",
    preview: "radial-gradient(circle at 22% 14%, #67e59c 0, transparent 41%), radial-gradient(circle at 78% 82%, #e3af4a 0, transparent 44%), linear-gradient(#14251d, #14251d)",
    systemBar: { dark: "#243a2f", light: "#e2eadf" },
    edge: "#514524",
    tone: "dark",
  },
  {
    id: "paper-prism",
    name: "Paper Prism",
    description: "backgrounds.paperPrism",
    image: "radial-gradient(circle at 12% 12%, rgba(95, 210, 226, .7) 0, rgba(95, 210, 226, 0) 37%), radial-gradient(circle at 86% 20%, rgba(159, 130, 239, .58) 0, rgba(159, 130, 239, 0) 38%), radial-gradient(circle at 62% 92%, rgba(242, 144, 131, .64) 0, rgba(242, 144, 131, 0) 42%), linear-gradient(145deg, #eaf7f5 0%, #eceafb 52%, #faeee9 100%)",
    preview: "radial-gradient(circle at 12% 12%, #5fd2e2 0, transparent 41%), radial-gradient(circle at 86% 20%, #9f82ef 0, transparent 42%), radial-gradient(circle at 62% 92%, #f29083 0, transparent 45%), linear-gradient(#eceafb, #eceafb)",
    systemBar: { dark: "#43595f", light: "#e3eef1" },
    edge: "#f4c5c1",
    tone: "light",
  },
  // Drawn alongside the interface styles (shellLooks.css): Linen Dawn for
  // Paper and Editorial, Drafting Grid for Line, Cloud Drift for Air, Basalt
  // for Monolith, Aurora for Obsidian, Dusk Ridge (inline SVG) for Reverse
  // monolith. Picking a look never sets one; they are ordinary presets.
  // They follow the theme: the top-level art is one appearance's and `dark` /
  // `light` holds the other's, so each stays inside its tone band (`tone`).
  {
    id: "linen-dawn",
    name: "Linen Dawn",
    description: "backgrounds.linenDawn",
    image: "radial-gradient(circle at 16% 10%, rgba(247, 194, 146, .62) 0, rgba(247, 194, 146, 0) 42%), radial-gradient(circle at 86% 90%, rgba(214, 160, 132, .46) 0, rgba(214, 160, 132, 0) 44%), radial-gradient(circle at 70% 18%, rgba(255, 236, 205, .7) 0, rgba(255, 236, 205, 0) 36%), linear-gradient(150deg, #f6eee2 0%, #eee2d1 55%, #e6d7c3 100%)",
    preview: "radial-gradient(circle at 16% 10%, rgba(247, 194, 146, .62) 0, rgba(247, 194, 146, 0) 42%), radial-gradient(circle at 86% 90%, rgba(214, 160, 132, .46) 0, rgba(214, 160, 132, 0) 44%), radial-gradient(circle at 70% 18%, rgba(255, 236, 205, .7) 0, rgba(255, 236, 205, 0) 36%), linear-gradient(150deg, #f6eee2 0%, #eee2d1 55%, #e6d7c3 100%)",
    systemBar: { dark: "#191717", light: "#f6f2ee" },
    edge: "#e4ccb6",
    tone: "light",
    dark: {
      description: "backgrounds.linenDawnDark",
      image: "radial-gradient(circle at 16% 10%, rgba(214, 140, 84, .22) 0, rgba(214, 140, 84, 0) 42%), radial-gradient(circle at 86% 90%, rgba(170, 104, 76, .18) 0, rgba(170, 104, 76, 0) 44%), radial-gradient(circle at 70% 18%, rgba(255, 220, 170, .06) 0, rgba(255, 220, 170, 0) 36%), linear-gradient(150deg, #1f1a15 0%, #1a1611 55%, #16120e 100%)",
      edge: "#261c15",
      tone: "dark",
    },
  },
  {
    id: "drafting-grid",
    name: "Drafting Grid",
    description: "backgrounds.draftingGrid",
    image: "repeating-linear-gradient(0deg, rgba(92, 108, 140, .14) 0 1px, rgba(92, 108, 140, 0) 1px 40px), repeating-linear-gradient(90deg, rgba(92, 108, 140, .14) 0 1px, rgba(92, 108, 140, 0) 1px 40px), radial-gradient(circle at 80% 12%, rgba(120, 156, 220, .32) 0, rgba(120, 156, 220, 0) 40%), linear-gradient(160deg, #eef1f5 0%, #e2e7ee 55%, #d8dee8 100%)",
    preview: "repeating-linear-gradient(0deg, rgba(92, 108, 140, .14) 0 1px, rgba(92, 108, 140, 0) 1px 40px), repeating-linear-gradient(90deg, rgba(92, 108, 140, .14) 0 1px, rgba(92, 108, 140, 0) 1px 40px), radial-gradient(circle at 80% 12%, rgba(120, 156, 220, .32) 0, rgba(120, 156, 220, 0) 40%), linear-gradient(160deg, #eef1f5 0%, #e2e7ee 55%, #d8dee8 100%)",
    systemBar: { dark: "#12151c", light: "#f0f3f7" },
    edge: "#dae0e9",
    tone: "light",
    dark: {
      description: "backgrounds.draftingGridDark",
      image: "repeating-linear-gradient(0deg, rgba(150, 170, 210, .08) 0 1px, rgba(150, 170, 210, 0) 1px 40px), repeating-linear-gradient(90deg, rgba(150, 170, 210, .08) 0 1px, rgba(150, 170, 210, 0) 1px 40px), radial-gradient(circle at 80% 12%, rgba(90, 130, 220, .2) 0, rgba(90, 130, 220, 0) 40%), linear-gradient(160deg, #13171e 0%, #0f131a 55%, #0c1016 100%)",
      edge: "#0d1118",
      tone: "dark",
    },
  },
  {
    id: "cloud-drift",
    name: "Cloud Drift",
    description: "backgrounds.cloudDrift",
    image: "radial-gradient(ellipse at 22% 18%, rgba(255, 255, 255, .95) 0, rgba(255, 255, 255, 0) 38%), radial-gradient(ellipse at 78% 30%, rgba(200, 190, 255, .7) 0, rgba(200, 190, 255, 0) 42%), radial-gradient(ellipse at 40% 86%, rgba(168, 214, 255, .7) 0, rgba(168, 214, 255, 0) 46%), radial-gradient(ellipse at 90% 92%, rgba(255, 206, 226, .6) 0, rgba(255, 206, 226, 0) 40%), linear-gradient(170deg, #eef1fb 0%, #e6e8f8 50%, #f1e9f4 100%)",
    preview: "radial-gradient(ellipse at 22% 18%, rgba(255, 255, 255, .95) 0, rgba(255, 255, 255, 0) 38%), radial-gradient(ellipse at 78% 30%, rgba(200, 190, 255, .7) 0, rgba(200, 190, 255, 0) 42%), radial-gradient(ellipse at 40% 86%, rgba(168, 214, 255, .7) 0, rgba(168, 214, 255, 0) 46%), radial-gradient(ellipse at 90% 92%, rgba(255, 206, 226, .6) 0, rgba(255, 206, 226, 0) 40%), linear-gradient(170deg, #eef1fb 0%, #e6e8f8 50%, #f1e9f4 100%)",
    systemBar: { dark: "#12141a", light: "#f4f5fa" },
    edge: "#e0dff4",
    tone: "light",
    dark: {
      description: "backgrounds.cloudDriftDark",
      image: "radial-gradient(ellipse at 22% 18%, rgba(190, 196, 235, .1) 0, rgba(190, 196, 235, 0) 38%), radial-gradient(ellipse at 78% 30%, rgba(124, 108, 214, .34) 0, rgba(124, 108, 214, 0) 42%), radial-gradient(ellipse at 40% 86%, rgba(70, 120, 200, .26) 0, rgba(70, 120, 200, 0) 46%), radial-gradient(ellipse at 90% 92%, rgba(190, 96, 150, .18) 0, rgba(190, 96, 150, 0) 40%), linear-gradient(170deg, #12131c 0%, #11121f 50%, #16121d 100%)",
      edge: "#242035",
      tone: "dark",
    },
  },
  {
    id: "basalt",
    name: "Basalt",
    description: "backgrounds.basalt",
    image: "radial-gradient(ellipse at 50% 112%, rgba(214, 112, 64, .42) 0, rgba(214, 112, 64, 0) 46%), radial-gradient(circle at 12% 8%, rgba(120, 128, 148, .24) 0, rgba(120, 128, 148, 0) 40%), linear-gradient(165deg, #1c1e22 0%, #15161a 55%, #1d1714 100%)",
    preview: "radial-gradient(ellipse at 50% 112%, rgba(214, 112, 64, .42) 0, rgba(214, 112, 64, 0) 46%), radial-gradient(circle at 12% 8%, rgba(120, 128, 148, .24) 0, rgba(120, 128, 148, 0) 40%), linear-gradient(165deg, #1c1e22 0%, #15161a 55%, #1d1714 100%)",
    systemBar: { dark: "#15171b", light: "#f1f1f3" },
    edge: "#30211a",
    tone: "dark",
    light: {
      description: "backgrounds.basaltLight",
      image: "radial-gradient(ellipse at 50% 112%, rgba(226, 134, 88, .34) 0, rgba(226, 134, 88, 0) 46%), radial-gradient(circle at 12% 8%, rgba(150, 158, 178, .26) 0, rgba(150, 158, 178, 0) 40%), linear-gradient(165deg, #ecebe8 0%, #e5e4e1 55%, #ebe4de 100%)",
      edge: "#e9dbd2",
      tone: "light",
    },
  },
  {
    id: "aurora",
    name: "Aurora",
    description: "backgrounds.aurora",
    image: "radial-gradient(ellipse at 80% 0%, rgba(110, 120, 255, .42) 0, rgba(110, 120, 255, 0) 42%), radial-gradient(ellipse at 18% 34%, rgba(64, 224, 196, .16) 0, rgba(64, 224, 196, 0) 38%), radial-gradient(ellipse at 6% 104%, rgba(176, 86, 255, .34) 0, rgba(176, 86, 255, 0) 44%), linear-gradient(160deg, #070914 0%, #0b0d20 50%, #120a1f 100%)",
    preview: "radial-gradient(ellipse at 80% 0%, rgba(110, 120, 255, .42) 0, rgba(110, 120, 255, 0) 42%), radial-gradient(ellipse at 18% 34%, rgba(64, 224, 196, .16) 0, rgba(64, 224, 196, 0) 38%), radial-gradient(ellipse at 6% 104%, rgba(176, 86, 255, .34) 0, rgba(176, 86, 255, 0) 44%), linear-gradient(160deg, #070914 0%, #0b0d20 50%, #120a1f 100%)",
    systemBar: { dark: "#11141f", light: "#f1f3f9" },
    edge: "#221337",
    tone: "dark",
    light: {
      description: "backgrounds.auroraLight",
      image: "radial-gradient(ellipse at 80% 0%, rgba(126, 136, 255, .3) 0, rgba(126, 136, 255, 0) 42%), radial-gradient(ellipse at 18% 34%, rgba(72, 214, 188, .18) 0, rgba(72, 214, 188, 0) 38%), radial-gradient(ellipse at 6% 104%, rgba(184, 110, 255, .24) 0, rgba(184, 110, 255, 0) 44%), linear-gradient(160deg, #f3f3fb 0%, #eeeffa 50%, #f4eff9 100%)",
      edge: "#eee5fa",
      tone: "light",
    },
  },
  {
    id: "dusk-ridge",
    name: "Dusk Ridge",
    description: "backgrounds.duskRidge",
    image: "url(\"data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%201600%201000'%20preserveAspectRatio%3D'xMidYMid%20slice'%3E%3Cdefs%3E%3ClinearGradient%20id%3D's'%20x1%3D'0'%20y1%3D'0'%20x2%3D'0'%20y2%3D'1'%3E%3Cstop%20offset%3D'0'%20stop-color%3D'%230c1122'%2F%3E%3Cstop%20offset%3D'.55'%20stop-color%3D'%231e1a32'%2F%3E%3Cstop%20offset%3D'1'%20stop-color%3D'%2333233a'%2F%3E%3C%2FlinearGradient%3E%3CradialGradient%20id%3D'g'%20cx%3D'.72'%20cy%3D'.5'%20r%3D'.32'%3E%3Cstop%20offset%3D'0'%20stop-color%3D'%23f0a070'%20stop-opacity%3D'.26'%2F%3E%3Cstop%20offset%3D'1'%20stop-color%3D'%23f0a070'%20stop-opacity%3D'0'%2F%3E%3C%2FradialGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D'1600'%20height%3D'1000'%20fill%3D'url(%23s)'%2F%3E%3Crect%20width%3D'1600'%20height%3D'1000'%20fill%3D'url(%23g)'%2F%3E%3Cpath%20d%3D'M0%20560%20C180%20470%20300%20520%20420%20470%20S640%20360%20760%20400%20S980%20330%201100%20380%20S1360%20450%201600%20420%20V1000%20H0Z'%20fill%3D'%231d2038'%2F%3E%3Cpath%20d%3D'M0%20650%20C160%20600%20260%20640%20400%20590%20S620%20520%20760%20560%20S1000%20500%201160%20560%20S1420%20600%201600%20560%20V1000%20H0Z'%20fill%3D'%23171a30'%2F%3E%3Cpath%20d%3D'M0%20740%20C140%20700%20280%20730%20420%20690%20S660%20640%20820%20690%20S1060%20650%201220%20700%20S1460%20720%201600%20690%20V1000%20H0Z'%20fill%3D'%23121426'%2F%3E%3Cpath%20d%3D'M0%20830%20C200%20800%20320%20820%20480%20790%20S760%20760%20920%20800%20S1220%20780%201380%20810%20S1540%20820%201600%20800%20V1000%20H0Z'%20fill%3D'%230c0d19'%2F%3E%3C%2Fsvg%3E\")",
    preview: "url(\"data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%201600%201000'%20preserveAspectRatio%3D'xMidYMid%20slice'%3E%3Cdefs%3E%3ClinearGradient%20id%3D's'%20x1%3D'0'%20y1%3D'0'%20x2%3D'0'%20y2%3D'1'%3E%3Cstop%20offset%3D'0'%20stop-color%3D'%230c1122'%2F%3E%3Cstop%20offset%3D'.55'%20stop-color%3D'%231e1a32'%2F%3E%3Cstop%20offset%3D'1'%20stop-color%3D'%2333233a'%2F%3E%3C%2FlinearGradient%3E%3CradialGradient%20id%3D'g'%20cx%3D'.72'%20cy%3D'.5'%20r%3D'.32'%3E%3Cstop%20offset%3D'0'%20stop-color%3D'%23f0a070'%20stop-opacity%3D'.26'%2F%3E%3Cstop%20offset%3D'1'%20stop-color%3D'%23f0a070'%20stop-opacity%3D'0'%2F%3E%3C%2FradialGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D'1600'%20height%3D'1000'%20fill%3D'url(%23s)'%2F%3E%3Crect%20width%3D'1600'%20height%3D'1000'%20fill%3D'url(%23g)'%2F%3E%3Cpath%20d%3D'M0%20560%20C180%20470%20300%20520%20420%20470%20S640%20360%20760%20400%20S980%20330%201100%20380%20S1360%20450%201600%20420%20V1000%20H0Z'%20fill%3D'%231d2038'%2F%3E%3Cpath%20d%3D'M0%20650%20C160%20600%20260%20640%20400%20590%20S620%20520%20760%20560%20S1000%20500%201160%20560%20S1420%20600%201600%20560%20V1000%20H0Z'%20fill%3D'%23171a30'%2F%3E%3Cpath%20d%3D'M0%20740%20C140%20700%20280%20730%20420%20690%20S660%20640%20820%20690%20S1060%20650%201220%20700%20S1460%20720%201600%20690%20V1000%20H0Z'%20fill%3D'%23121426'%2F%3E%3Cpath%20d%3D'M0%20830%20C200%20800%20320%20820%20480%20790%20S760%20760%20920%20800%20S1220%20780%201380%20810%20S1540%20820%201600%20800%20V1000%20H0Z'%20fill%3D'%230c0d19'%2F%3E%3C%2Fsvg%3E\")",
    systemBar: { dark: "#0f1118", light: "#f0f2f7" },
    edge: "#0c0d19",
    tone: "dark",
    light: {
      description: "backgrounds.duskRidgeLight",
      image: "url(\"data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%201600%201000'%20preserveAspectRatio%3D'xMidYMid%20slice'%3E%3Cdefs%3E%3ClinearGradient%20id%3D's'%20x1%3D'0'%20y1%3D'0'%20x2%3D'0'%20y2%3D'1'%3E%3Cstop%20offset%3D'0'%20stop-color%3D'%23dde4f2'%2F%3E%3Cstop%20offset%3D'.55'%20stop-color%3D'%23eedde4'%2F%3E%3Cstop%20offset%3D'1'%20stop-color%3D'%23f8e7d8'%2F%3E%3C%2FlinearGradient%3E%3CradialGradient%20id%3D'g'%20cx%3D'.72'%20cy%3D'.5'%20r%3D'.32'%3E%3Cstop%20offset%3D'0'%20stop-color%3D'%23fff2dd'%20stop-opacity%3D'.9'%2F%3E%3Cstop%20offset%3D'1'%20stop-color%3D'%23fff2dd'%20stop-opacity%3D'0'%2F%3E%3C%2FradialGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D'1600'%20height%3D'1000'%20fill%3D'url(%23s)'%2F%3E%3Crect%20width%3D'1600'%20height%3D'1000'%20fill%3D'url(%23g)'%2F%3E%3Cpath%20d%3D'M0%20560%20C180%20470%20300%20520%20420%20470%20S640%20360%20760%20400%20S980%20330%201100%20380%20S1360%20450%201600%20420%20V1000%20H0Z'%20fill%3D'%23d2d6e7'%2F%3E%3Cpath%20d%3D'M0%20650%20C160%20600%20260%20640%20400%20590%20S620%20520%20760%20560%20S1000%20500%201160%20560%20S1420%20600%201600%20560%20V1000%20H0Z'%20fill%3D'%23c6cbdf'%2F%3E%3Cpath%20d%3D'M0%20740%20C140%20700%20280%20730%20420%20690%20S660%20640%20820%20690%20S1060%20650%201220%20700%20S1460%20720%201600%20690%20V1000%20H0Z'%20fill%3D'%23bbc1d8'%2F%3E%3Cpath%20d%3D'M0%20830%20C200%20800%20320%20820%20480%20790%20S760%20760%20920%20800%20S1220%20780%201380%20810%20S1540%20820%201600%20800%20V1000%20H0Z'%20fill%3D'%23b0b6d1'%2F%3E%3C%2Fsvg%3E\")",
      edge: "#b0b6d1",
      tone: "light",
    },
  },
] as const satisfies readonly BackgroundPresetSpec[];

const PRESET_SPECS: readonly BackgroundPresetSpec[] = BACKGROUND_PRESETS;

export type BackgroundPresetId = (typeof BACKGROUND_PRESETS)[number]["id"];
export type BackgroundId = BackgroundPresetId | "custom";

export interface BackgroundState {
  id: BackgroundId;
  customImage: string;
}

export const BACKGROUND_KEY = "polyth.background.v1";
export const DEFAULT_BACKGROUND_ID: BackgroundPresetId = "signal-bloom";
export const MAX_CUSTOM_BACKGROUND_BYTES = 2 * 1024 * 1024;
const MAX_DATA_URL_LENGTH = Math.ceil(MAX_CUSTOM_BACKGROUND_BYTES * 4 / 3) + 128;
const CUSTOM_IMAGE_RE = /^data:image\/(?:png|jpeg|webp|avif);base64,/i;
const PRESET_IDS = new Set<string>(BACKGROUND_PRESETS.map(({ id }) => id));
const subscribers = new Set<() => void>();

function isPresetId(value: unknown): value is BackgroundPresetId {
  return typeof value === "string" && PRESET_IDS.has(value);
}

function isCustomImage(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_DATA_URL_LENGTH && CUSTOM_IMAGE_RE.test(value);
}

export function parseBackgroundState(raw: string | null): BackgroundState {
  try {
    const value = JSON.parse(raw ?? "") as { id?: unknown; customImage?: unknown };
    const customImage = isCustomImage(value.customImage) ? value.customImage : "";
    const id = value.id === "custom" && customImage
      ? "custom"
      : isPresetId(value.id)
        ? value.id
        : DEFAULT_BACKGROUND_ID;
    return { id, customImage };
  } catch {
    return { id: DEFAULT_BACKGROUND_ID, customImage: "" };
  }
}

function loadBackgroundState(): BackgroundState {
  try {
    return typeof localStorage === "undefined"
      ? parseBackgroundState(null)
      : parseBackgroundState(localStorage.getItem(BACKGROUND_KEY));
  } catch {
    return parseBackgroundState(null);
  }
}

let state = loadBackgroundState();

/** The appearance the document is painted in (theme.ts sets it before the
 *  first render and announces changes with "polyth:theme"). */
export function documentAppearance(): BackgroundAppearance {
  return typeof document !== "undefined" && document.documentElement.dataset.appearance === "light"
    ? "light"
    : "dark";
}

export function subscribeAppearance(notify: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("polyth:theme", notify);
  return () => window.removeEventListener("polyth:theme", notify);
}

/** The art a preset paints in this appearance; a theme-following preset swaps
 *  to its `dark` / `light` variant. */
export function backgroundPresetArt(id: string, appearance: BackgroundAppearance): BackgroundArt | null {
  const preset = PRESET_SPECS.find((spec) => spec.id === id);
  if (!preset) return null;
  return preset[appearance] ?? preset;
}

export function backgroundCssImage(value: BackgroundState, appearance = documentAppearance()): string {
  if (value.id === "custom" && isCustomImage(value.customImage)) {
    return `url(${JSON.stringify(value.customImage)})`;
  }
  return backgroundPresetArt(value.id, appearance)?.image ?? "none";
}

export function backgroundSystemBarColor(
  value: BackgroundState,
  appearance: BackgroundAppearance,
): string | null {
  if (value.id === "custom") return null;
  const preset = PRESET_SPECS.find(({ id }) => id === value.id);
  return preset?.systemBar?.[appearance] ?? null;
}

export function backgroundEdgeColor(value: BackgroundState, appearance = documentAppearance()): string | null {
  if (value.id === "custom") return null;
  return backgroundPresetArt(value.id, appearance)?.edge ?? null;
}

/** A preset's measured tone as the appearance paints it; a custom image is
 *  sampled when applied (null here). */
export function backgroundTone(value: BackgroundState, appearance = documentAppearance()): BackgroundTone | null {
  if (value.id === "custom") return null;
  return backgroundPresetArt(value.id, appearance)?.tone ?? null;
}

/** Classify relative luminances (0..1) the way the preset tones were measured. */
export function classifyBackgroundTone(luminances: readonly number[]): BackgroundTone | null {
  if (!luminances.length) return null;
  const sorted = [...luminances].sort((a, b) => a - b);
  const at = (share: number) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!;
  if (at(0.05) >= BACKGROUND_TONE_LIGHT_FLOOR) return "light";
  if (at(0.95) <= BACKGROUND_TONE_DARK_CEILING) return "dark";
  return "mixed";
}

const linearChannel = (channel: number): number => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

let lastSample: { source: string; sampled: { edge: string; tone: BackgroundTone | null } } | null = null;
let sampleRequest = 0;

/** The average colour of a custom image's bottom rows (the keyboard band) and
 *  its tone, or null when this engine cannot decode or read it back (fake
 *  DOMs, tainted canvases). The last image's result is kept, so a theme
 *  change does not decode it again. */
export async function sampleImageColors(source: string): Promise<{ edge: string; tone: BackgroundTone | null } | null> {
  if (lastSample?.source === source) return lastSample.sampled;
  if (typeof Image === "undefined" || typeof document === "undefined") return null;
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    const width = 32;
    const height = Math.max(1, Math.round(width * image.naturalHeight / Math.max(1, image.naturalWidth)));
    const rows = Math.max(1, Math.round(height * 0.12));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const luminances: number[] = [];
    let red = 0;
    let green = 0;
    let blue = 0;
    const edgeStart = (height - rows) * width * 4;
    for (let index = 0; index < pixels.length; index += 4) {
      const r = pixels[index] ?? 0;
      const g = pixels[index + 1] ?? 0;
      const b = pixels[index + 2] ?? 0;
      luminances.push(0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b));
      if (index < edgeStart) continue;
      red += r;
      green += g;
      blue += b;
    }
    const count = Math.max(1, rows * width);
    const edge = `#${[red, green, blue].map((channel) => Math.round(channel / count).toString(16).padStart(2, "0")).join("")}`;
    const sampled = { edge, tone: classifyBackgroundTone(luminances) };
    lastSample = { source, sampled };
    return sampled;
  } catch {
    return null;
  }
}

/** Publish the wallpaper's bottom-edge colour for the keyboard band and its
 *  tone. A custom image is sampled asynchronously; until then (or if it
 *  cannot be read) both stay unset: the band falls back to the theme colour
 *  and CSS treats the unknown tone as one that fights the appearance. */
function applyBackgroundSample(html: HTMLElement, value: BackgroundState, appearance: BackgroundAppearance): void {
  const request = ++sampleRequest;
  const edge = backgroundEdgeColor(value, appearance);
  if (edge) html.style.setProperty("--app-background-edge-color", edge);
  else html.style.removeProperty("--app-background-edge-color");
  const tone = backgroundTone(value, appearance);
  if (tone) html.dataset.backgroundTone = tone;
  else delete html.dataset.backgroundTone;
  if (value.id !== "custom" || !value.customImage) return;
  void sampleImageColors(value.customImage).then((sampled) => {
    if (!sampled || request !== sampleRequest) return;
    html.style.setProperty("--app-background-edge-color", sampled.edge);
    if (sampled.tone) html.dataset.backgroundTone = sampled.tone;
  });
}

export function applyBackgroundToDom(value = state): void {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  const appearance = documentAppearance();
  html.dataset.background = value.id;
  html.style.setProperty("--app-background-image", backgroundCssImage(value, appearance));
  applyBackgroundSample(html, value, appearance);

  // iOS 26 standalone PWAs can expose a system-owned strip above the web
  // viewport. DOM cannot paint into it, so make the browser-owned fallback
  // color follow the selected workspace atmosphere instead of theme white.
  const themeFallback = getComputedStyle(html).getPropertyValue("--bg").trim();
  const systemBar = backgroundSystemBarColor(value, appearance) || themeFallback;
  if (systemBar) {
    html.style.setProperty("--app-system-bar-color", systemBar);
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute("content", systemBar);
  }
}

function commit(next: BackgroundState): boolean {
  state = next;
  let saved = true;
  try {
    localStorage.setItem(BACKGROUND_KEY, JSON.stringify(next));
  } catch {
    saved = false;
  }
  applyBackgroundToDom(next);
  for (const notify of [...subscribers]) notify();
  return saved;
}

export function getBackground(): BackgroundState {
  return state;
}

export function subscribeBackground(notify: () => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

export function setBackground(id: BackgroundId): boolean {
  if (id === "custom" && !state.customImage) return false;
  return commit({ ...state, id });
}

export function setCustomBackground(customImage: string): boolean {
  if (!isCustomImage(customImage)) return false;
  return commit({ id: "custom", customImage });
}

export function validateBackgroundFile(file: Pick<File, "size" | "type">): string | null {
  if (!/^image\/(?:png|jpeg|webp|avif)$/i.test(file.type)) {
    return tr("backgrounds.chooseFormat");
  }
  if (file.size > MAX_CUSTOM_BACKGROUND_BYTES) return tr("backgrounds.chooseSmaller");
  return null;
}

export function readBackgroundFile(file: File): Promise<string> {
  const invalid = validateBackgroundFile(file);
  if (invalid) return Promise.reject(new Error(invalid));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(tr("backgrounds.couldNotRead")));
    reader.onload = () => {
      if (isCustomImage(reader.result)) resolve(reader.result);
      else reject(new Error(tr("backgrounds.couldNotUse")));
    };
    reader.readAsDataURL(file);
  });
}


if (typeof window !== "undefined") {
  window.addEventListener("polyth:theme", () => applyBackgroundToDom());
}
