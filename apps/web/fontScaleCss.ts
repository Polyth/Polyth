// The interface-scale preference must affect every UI text declaration,
// including the historical fixed-pixel rules in styles.css. Code/editor text
// retains its dedicated --editor-font-size variable and is not matched here.
//
// Rules multiply by `--text-scale`, the *current text surface's* multiplier:
// the menu scale everywhere (including agent activity blocks), and the chat scale
// inside a conversation message surface (see the type-surface contract in tokens.css).
// `--ui-font-scale` remains the published fallback so a sheet this transform never
// processed still scales.
const PIXEL_FONT_SIZE = /(font-size\s*:\s*)(-?(?:\d+|\d*\.\d+)px)(?=\s*(?:!important\b|[;}]))/gi;

export function scaleUiFontSizes(css: string): string {
  return css.replace(PIXEL_FONT_SIZE, (_whole, property: string, size: string) =>
    `${property}calc(${size} * var(--text-scale, var(--ui-font-scale, 1)))`,
  );
}
