// A field well (.ui-field-well) is one field around an icon and a bare
// .ui-input. Every platform style and every Look paints the well, never a
// second field inside it: the phone Settings search once showed a white
// rounded input starting after the magnifier, inside its own card.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "./chromium.ts";
import { DEFAULT_THEME, adaptThemeAppearance, themeCssVars, withThemeStyle } from "../src/theme.ts";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");
const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}

let browser: Browser | null = null;
let page = null as Page | null;

before(async () => {
  if (!CHROME) return;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage({ viewport: { width: 480, height: 320 } });
  // The cascade order main.tsx loads: base, platform styles, then Looks.
  const css = (await Promise.all([
    "../src/tokens.css", "../src/styles.css",
    "../src/fluentTheme.css", "../src/macosTheme.css", "../src/liquidGlassTheme.css",
    "../src/shellLooks.css",
  ].map(read))).join("\n");
  await page.setContent(`<html class="light" data-appearance="light"><head><style>${css}</style></head><body>
    <div class="source-search ui-field-well" id="well"><span>⌕</span><input class="ui-input ui-input--sm" id="bare" placeholder="Search"></div>
    <div class="source-search" id="unmarked"><span>⌕</span><input class="ui-input ui-input--sm" id="nested" placeholder="Search"></div>
    <input class="ui-input" id="field" placeholder="A plain field">
    <form class="ui-field-frame" id="frame"><textarea class="ui-textarea" id="framed" rows="1"></textarea></form>
    <textarea class="ui-textarea" id="area" rows="6"></textarea>
    <div class="ui-field-well" id="areaWell"><textarea class="ui-textarea" rows="5"></textarea></div>
  </body></html>`);
});

after(async () => {
  await browser?.close();
});

const paint = (selector: string) => page!.locator(selector).evaluate((element) => {
  const style = getComputedStyle(element);
  return { background: style.backgroundColor, shadow: style.boxShadow, border: style.borderTopWidth, outline: style.outlineStyle, radius: parseFloat(style.borderTopLeftRadius) };
});

test("platform styles and Looks paint a field well, never the input inside it", { skip: !CHROME }, async () => {
  for (const themeStyle of ["classic", "liquid-glass", "fluent", "macos"] as const) {
    // Theme colours, a style's own included, are runtime variables (theme.ts).
    const vars = themeCssVars(withThemeStyle(adaptThemeAppearance(DEFAULT_THEME, "light"), themeStyle));
    for (const look of ["standard", "obsidian", "air"]) {
      const label = `${themeStyle} × ${look}`;
      await page!.evaluate(({ style, shellLook, vars }) => {
        const root = document.documentElement;
        root.removeAttribute("style");
        for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
        if (style === "classic") delete root.dataset.themeStyle;
        else root.dataset.themeStyle = style;
        document.body.dataset.shellLook = shellLook;
        (document.activeElement as HTMLElement | null)?.blur();
      }, { style: themeStyle, shellLook: look, vars });

      const bare = await paint("#bare");
      assert.equal(bare.background, "rgba(0, 0, 0, 0)", `${label}: the input in a well has no fill`);
      assert.equal(bare.shadow, "none", `${label}: the input in a well has no ring`);
      assert.equal(bare.border, "0px", `${label}: the input in a well has no edge`);
      // A plain field is still the platform's or the Look's field.
      assert.notEqual((await paint("#field")).background, "rgba(0, 0, 0, 0)", `${label}: a plain field keeps its fill`);
      // The well is the field: a platform style or Look paints it exactly like a
      // plain one, so its ring survives Hide interface borders. Classic leaves
      // the well to its owner.
      if (themeStyle !== "classic" || look !== "standard") {
        const well = await paint("#well"), field = await paint("#field");
        assert.equal(well.background, field.background, `${label}: the well takes the field's fill`);
        assert.equal(well.shadow, field.shadow, `${label}: the well takes the field's ring`);
      }

      // A field frame (a package composer card) is not a field: nobody paints
      // it, and its input stays bare.
      const frame = await paint("#frame"), framed = await paint("#framed");
      assert.equal(frame.background, "rgba(0, 0, 0, 0)", `${label}: a frame is not painted as a field`);
      assert.equal(framed.background, "rgba(0, 0, 0, 0)", `${label}: the input in a frame has no fill`);
      assert.equal(framed.shadow, "none", `${label}: the input in a frame has no ring`);
      assert.equal(framed.border, "0px", `${label}: the input in a frame has no edge`);
      // A pill field corner never rounds a text area into an oval.
      assert.ok((await paint("#area")).radius <= 24, `${label}: a text area keeps a card corner`);
      assert.ok((await paint("#areaWell")).radius <= 24, `${label}: a well around a text area keeps a card corner`);

      await page!.focus("#bare");
      const focused = await paint("#bare");
      assert.equal(focused.outline, "none", `${label}: focus rings the well, not the input`);
      assert.equal(focused.shadow, "none", `${label}: focus adds no inner halo`);
    }
  }
});

test("without the marker a platform style still paints the nested input (negative control)", { skip: !CHROME }, async () => {
  const vars = themeCssVars(withThemeStyle(adaptThemeAppearance(DEFAULT_THEME, "light"), "liquid-glass"));
  await page!.evaluate((vars) => {
    for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value);
    document.documentElement.dataset.themeStyle = "liquid-glass";
    document.body.dataset.shellLook = "standard";
  }, vars);
  assert.notEqual((await paint("#nested")).background, "rgba(0, 0, 0, 0)");
});
