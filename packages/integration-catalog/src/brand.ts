// The brand mark each entry shows: the service's own glyph, so a person
// recognizes Linear or Notion before reading a word.
//
// Assets are vendored in `assets/logos/` (see CREDITS.md there) rather than
// fetched from a vendor CDN at render time: a page of favicon requests would
// tell twelve third parties which integrations someone is browsing, and it
// would break on an offline or restricted network. Vector marks are drawn as a
// mask, so the glyph takes its colour from the theme; the two raster marks are
// alpha-only glyphs derived from the vendor icon for the same reason.
export interface BrandMark {
  /** File name inside `assets/logos/`. */
  file: string;
  format: "svg" | "png";
  /** The service's own colour, used for the tile tint and the glyph hue. */
  color: string;
}

export const BRAND_MARKS: Readonly<Record<string, BrandMark>> = {
  linear: { file: "linear.svg", format: "svg", color: "#5E6AD2" },
  // Near-black marks read as disabled tiles on either theme, so the two
  // monochrome brands get a neutral that still says "this is the mark".
  github: { file: "github.svg", format: "svg", color: "#6E7482" },
  notion: { file: "notion.svg", format: "svg", color: "#6E7482" },
  atlassian: { file: "atlassian.svg", format: "svg", color: "#0052CC" },
  sentry: { file: "sentry.svg", format: "svg", color: "#362D59" },
  supabase: { file: "supabase.svg", format: "svg", color: "#3FCF8E" },
  figma: { file: "figma.svg", format: "svg", color: "#F24E1E" },
  stripe: { file: "stripe.svg", format: "svg", color: "#635BFF" },
  cloudflare: { file: "cloudflare.svg", format: "svg", color: "#F38020" },
  playwright: { file: "playwright.svg", format: "svg", color: "#2EAD33" },
  exa: { file: "exa.png", format: "png", color: "#1E40EF" },
  context7: { file: "context7.png", format: "png", color: "#0E7A61" },
};

export const brandMarkFor = (id: string): BrandMark | undefined => BRAND_MARKS[id];
