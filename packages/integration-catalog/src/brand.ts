// The brand mark each entry shows: the service's own glyph or app icon, so a
// person recognizes Linear or Notion before reading a word.
//
// Assets are vendored in `assets/logos/` (see CREDITS.md and sources.json
// there) rather than fetched from a vendor CDN at render time: a page of
// favicon requests would tell two hundred third parties which integrations
// someone is browsing, and it would break on an offline or restricted network.
//
// Every file is a finished square tile — a simple-icons glyph on its brand
// colour, or the vendor's own app icon — so it reads the same on a light and a
// dark theme; the page only rounds and outlines it. `scripts/build-marks.py`
// writes the files and the registry in `brandMarks.ts`.
import { BRAND_MARKS } from "./brandMarks.ts";

export interface BrandMark {
  /** File name inside `assets/logos/`. */
  file: string;
  format: "svg" | "png";
  /** `simple-icons` (CC0 glyph on a brand tile) or `vendor` (the service's
   *  own icon, used only to identify it). */
  source: "simple-icons" | "vendor";
}

export { BRAND_MARKS };

export const brandMarkFor = (id: string): BrandMark | undefined =>
  Object.hasOwn(BRAND_MARKS, id) ? BRAND_MARKS[id] : undefined;
