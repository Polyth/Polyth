// The interface-scale preference must affect every UI text declaration,
// including the historical fixed-pixel rules in styles.css. Code/editor text
// retains its dedicated --editor-font-size variable and is not matched here.
const PIXEL_FONT_SIZE = /(font-size\s*:\s*)(-?(?:\d+|\d*\.\d+)px)(?=\s*(?:!important\b|[;}]))/gi;

export function scaleUiFontSizes(css: string): string {
  return css.replace(PIXEL_FONT_SIZE, (_whole, property: string, size: string) =>
    `${property}calc(${size} * var(--ui-font-scale, 1))`,
  );
}
