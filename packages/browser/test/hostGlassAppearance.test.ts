import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import type { Page } from "playwright-core";
import { findChromiumExecutable } from "@polyth/browser/chromium";
import { browserBuildOptions, uiFontScalePlugin } from "../../../apps/web/buildConfig.ts";
import { PRESET_THEMES, resolveTheme, themeCssVars } from "../../../apps/web/src/theme.ts";

const chrome = await findChromiumExecutable();

/** The real bundled shell CSS. Both shell-material tests below read it, so the
 *  expensive esbuild pass is memoized rather than repeated per test. */
const builtCss = (() => {
  let pending: Promise<string> | null = null;
  return (): Promise<string> => {
    pending ??= build({
      ...browserBuildOptions,
      entryPoints: [new URL("../../../apps/web/src/main.tsx", import.meta.url).pathname],
      outdir: "/tmp/polyth-glass-appearance-build",
      write: false, sourcemap: false, minify: false, logLevel: "silent",
      plugins: [uiFontScalePlugin],
    }).then((result) => {
      const css = result.outputFiles.find((file) => file.path.endsWith("/main.css"))?.text;
      assert.ok(css, "the web build still emits a stylesheet");
      return css;
    });
    return pending;
  };
})();

test("glass overlays and transparent session titles obey effect and text settings", { skip: !chrome }, async () => {
  const css = await builtCss();
  const mist = PRESET_THEMES.find((theme) => theme.id === "mist");
  assert.ok(mist);
  const ember = PRESET_THEMES.find((theme) => theme.id === "dark");
  assert.ok(ember);
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: chrome!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 700 } });
    await page.setContent(`<style>${css}</style><main>Conversation beneath the glass</main><div class="ui-popover"><div class="desktop-session-status-popover"><h3>Context</h3><p>Readable session details</p></div></div>`);
    await page.evaluate((vars) => {
      document.documentElement.dataset.appearance = "light";
      for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value);
    }, themeCssVars(mist));
    const surface = async () => page.evaluate(() => {
      const style = getComputedStyle(document.querySelector(".ui-popover")!);
      const alpha = Number(style.backgroundImage.match(/\/\s*([\d.]+)\)/)?.[1] ?? NaN);
      return { alpha, image: style.backgroundImage, filter: style.backdropFilter, color: style.backgroundColor };
    });

    await page.evaluate(() => { document.body.dataset.glass = "matte"; });
    const matte = await surface();
    assert.ok(Number.isFinite(matte.alpha), `Matte lost its gradient: ${matte.image}`);
    assert.match(matte.filter, /blur\(20px\)/);

    await page.evaluate(() => { document.body.dataset.glass = "clear"; });
    const clear = await surface();
    assert.ok(Number.isFinite(clear.alpha), `Clear lost its gradient: ${clear.image}`);
    assert.ok(matte.alpha - clear.alpha >= 0.1, `Matte ${matte.alpha} and Clear ${clear.alpha} look the same`);
    assert.match(clear.filter, /blur\(10px\)/);

    await page.emulateMedia({ reducedMotion: "reduce" });
    const reducedMotion = await surface();
    assert.equal(reducedMotion.alpha, clear.alpha);
    assert.equal(reducedMotion.filter, clear.filter);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => { document.documentElement.dataset.reduceAnimations = "true"; });
    const reducedDesktopMotion = await surface();
    assert.equal(reducedDesktopMotion.alpha, clear.alpha);
    assert.equal(reducedDesktopMotion.filter, clear.filter);

    await page.evaluate(() => { document.body.dataset.desktopLowResource = "true"; });
    const lowResource = await surface();
    assert.equal(lowResource.image, "none");
    assert.equal(lowResource.filter, "none");
    assert.equal(Number.isNaN(lowResource.alpha), true);

    await page.evaluate(() => {
      document.body.dataset.desktopLowResource = "false";
      document.body.dataset.glass = "off";
    });
    const off = await surface();
    assert.equal(off.image, "none");
    assert.equal(off.filter, "none");
    assert.notEqual(off.color, "rgba(0, 0, 0, 0)");

    await page.evaluate((vars) => {
      document.documentElement.dataset.appearance = "dark";
      for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value);
      document.body.dataset.glass = "matte";
    }, themeCssVars(ember));
    const darkMatte = await surface();
    await page.evaluate(() => { document.body.dataset.glass = "clear"; });
    const darkClear = await surface();
    assert.ok(darkMatte.alpha - darkClear.alpha >= 0.1);
    assert.ok(darkClear.alpha > clear.alpha, "dark glass needs more tint over bright wallpaper");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.setContent(`<style>${css}</style>
      <div class="scrim settings-scrim"><section class="modal settings-shell settings-page-usage">
        <nav class="modal-nav settings-nav">Settings</nav>
        <main class="modal-main settings-pane"><header class="modal-head settings-pane-head">Appearance</header></main>
      </section></div>
      <div class="dialog-backdrop"><section class="dialog-panel project-setup-flow-dialog">Add project</section></div>
      <div class="sheet-backdrop"><section class="sheet">Other modal</section></div>
      <div class="scrim package-tour-scrim"><section class="package-tour">Package tour</section></div>`);
    await page.evaluate((vars) => {
      document.documentElement.dataset.appearance = "dark";
      for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value);
    }, themeCssVars(ember));
    const modalState = () => page.evaluate(() => {
      const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
      return {
        settingsBackdrop: style(".settings-scrim").backdropFilter,
        settingsScrim: style(".settings-scrim").backgroundColor,
        dialogBackdrop: style(".dialog-backdrop").backdropFilter,
        sheetBackdrop: style(".sheet-backdrop").backdropFilter,
        shellFilter: style(".settings-shell").backdropFilter,
        shellBackground: style(".settings-shell").backgroundImage,
        navBackground: style(".settings-nav").backgroundColor,
        paneBackground: style(".settings-pane").backgroundColor,
        headBackground: style(".settings-pane-head").backgroundColor,
        projectFilter: style(".project-setup-flow-dialog").backdropFilter,
        tourFilter: style(".package-tour").backdropFilter,
      };
    });
    await page.evaluate(() => { document.body.dataset.glass = "matte"; });
    const modalMatte = await modalState();
    assert.match(modalMatte.settingsBackdrop, /blur\(7px\)/);
    assert.match(modalMatte.dialogBackdrop, /blur\(7px\)/);
    assert.match(modalMatte.sheetBackdrop, /blur\(7px\)/);
    assert.match(modalMatte.shellFilter, /blur\(20px\)/);
    assert.match(modalMatte.projectFilter, /blur\(20px\)/);
    assert.match(modalMatte.tourFilter, /blur\(20px\)/);
    assert.match(modalMatte.shellBackground, /radial-gradient/);
    assert.match(modalMatte.navBackground, /\/ 0\./, "Settings navigation must reveal its glass shell");
    // The content pane stays opaque under glass so the blurred workspace
    // never ghosts through rows; glass remains on the nav and the scrim.
    assert.doesNotMatch(modalMatte.paneBackground, /\/ 0\./, "Settings pane stays readable over glass");
    assert.doesNotMatch(modalMatte.headBackground, /\/ 0\./, "Settings header stays readable over glass");

    await page.evaluate(() => { document.body.dataset.glass = "clear"; });
    const modalClear = await modalState();
    assert.match(modalClear.settingsBackdrop, /blur\(3\.5px\)/);
    assert.match(modalClear.dialogBackdrop, /blur\(3\.5px\)/);
    assert.match(modalClear.sheetBackdrop, /blur\(3\.5px\)/);
    assert.match(modalClear.shellFilter, /blur\(10px\)/);
    assert.match(modalClear.projectFilter, /blur\(10px\)/);
    assert.match(modalClear.tourFilter, /blur\(10px\)/);
    assert.notEqual(modalClear.settingsScrim, modalMatte.settingsScrim);
    assert.notEqual(modalClear.navBackground, modalMatte.navBackground);
    assert.equal(modalClear.paneBackground, modalMatte.paneBackground, "glass strength never thins the content pane");

    await page.evaluate(() => { document.body.dataset.desktopLowResource = "true"; });
    const modalLowResource = await modalState();
    assert.equal(modalLowResource.settingsBackdrop, "none");
    assert.equal(modalLowResource.dialogBackdrop, "none");
    assert.equal(modalLowResource.sheetBackdrop, "none");
    assert.equal(modalLowResource.shellFilter, "none");
    assert.equal(modalLowResource.tourFilter, "none");
    assert.equal(modalLowResource.shellBackground, "none");
    assert.doesNotMatch(modalLowResource.navBackground, /\/ 0\./);
    assert.doesNotMatch(modalLowResource.paneBackground, /\/ 0\./);

    await page.evaluate(() => {
      delete document.body.dataset.desktopLowResource;
      document.body.dataset.glass = "off";
    });
    const modalOff = await modalState();
    assert.equal(modalOff.settingsBackdrop, "none");
    assert.equal(modalOff.dialogBackdrop, "none");
    assert.equal(modalOff.sheetBackdrop, "none");
    assert.equal(modalOff.shellFilter, "none");
    assert.equal(modalOff.tourFilter, "none");
    assert.doesNotMatch(modalOff.navBackground, /\/ 0\./);
    assert.doesNotMatch(modalOff.paneBackground, /\/ 0\./);

    await page.evaluate((vars) => {
      document.documentElement.dataset.appearance = "light";
      for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value);
      document.body.dataset.glass = "matte";
    }, themeCssVars(mist));
    const lightMatte = await modalState();
    await page.evaluate(() => { document.body.dataset.glass = "clear"; });
    const lightClear = await modalState();
    assert.match(lightClear.shellBackground, /radial-gradient/);
    assert.match(lightClear.navBackground, /\/ 0\./);
    assert.doesNotMatch(lightClear.paneBackground, /\/ 0\./);
    assert.notEqual(lightClear.shellBackground, lightMatte.shellBackground);
    assert.notEqual(lightClear.settingsScrim, lightMatte.settingsScrim);

    await page.setViewportSize({ width: 390, height: 720 });
    const mobile = await modalState();
    assert.equal(mobile.settingsBackdrop, "none", "full-screen Settings has no exposed backdrop");
    assert.equal(mobile.settingsScrim, "rgba(0, 0, 0, 0)");
    assert.equal(mobile.dialogBackdrop, "none", "full-screen project setup has no exposed backdrop");
    assert.match(mobile.sheetBackdrop, /blur\(3\.5px\)/, "partial-height sheets still soften the workspace");


    await page.setContent(`<style>${css}</style>
      <section class="mobile-navigator">Session navigation</section>
      <div class="sheet-backdrop"><section class="sheet workspace-panel-sheet">Workspace widgets</section></div>`);
    const navigationState = () => page.evaluate(() => {
      const material = (selector: string) => {
        const style = getComputedStyle(document.querySelector(selector)!);
        return { color: style.backgroundColor, image: style.backgroundImage, filter: style.backdropFilter };
      };
      return {
        navigator: material(".mobile-navigator"),
        workspace: material(".workspace-panel-sheet"),
        backdrop: material(".sheet-backdrop"),
      };
    });
    for (const [appearance, theme] of [["light", mist], ["dark", ember]] as const) {
      await page.evaluate(({ appearance, vars }) => {
        document.documentElement.dataset.appearance = appearance;
        for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value);
      }, { appearance, vars: themeCssVars(theme) });
      for (const glass of ["matte", "clear", "off"] as const) {
        await page.evaluate((glass) => { document.body.dataset.glass = glass; }, glass);
        const state = await navigationState();
        assert.deepEqual(state.workspace, state.navigator, `${appearance}/${glass}: navigation destinations share their material`);
        assert.deepEqual(state.backdrop, { color: "rgba(0, 0, 0, 0)", image: "none", filter: "none" },
          `${appearance}/${glass}: full-screen Workspace must not add another glass layer`);
      }
      await page.evaluate(() => {
        document.body.dataset.glass = "matte";
        document.body.dataset.desktopLowResource = "true";
      });
      const lowResourceNavigation = await navigationState();
      assert.deepEqual(lowResourceNavigation.workspace, lowResourceNavigation.navigator);
      assert.equal(lowResourceNavigation.workspace.image, "none");
      assert.equal(lowResourceNavigation.workspace.filter, "none");
      assert.equal(lowResourceNavigation.backdrop.color, "rgba(0, 0, 0, 0)");
      assert.equal(lowResourceNavigation.backdrop.filter, "none");
      await page.evaluate(() => { delete document.body.dataset.desktopLowResource; });
    }

    // Shell clearance must follow menu text, even when the transcript uses
    // its own independent chat size. This fixture uses the actual built CSS.
    await page.setContent(`<style>${css}</style>
      <div class="app mode-chat view-session">
        <div class="mobile-session-floats">
          <div class="mobile-float-navigation"></div>
          <div class="mobile-session-title-island"><div class="mobile-session-title-row">
            <button class="mobile-session-selector">
              <span class="mobile-island-text"><span class="mobile-island-title-text">Компактний прозорий заголовок поточної сесії з повною назвою</span></span>
              <span class="mobile-session-selector-arrow">⌄</span>
            </button>
          </div></div>
          <div class="mobile-float-actions"><button>+</button><button>⌘</button></div>
        </div>
        <main class="stage"><div class="focus-conversation"><div class="timeline-viewport"><div class="timeline">Conversation</div></div></div></main>
      </div>`);
    await page.keyboard.press("Tab");
    const focus = await page.locator(".mobile-session-selector").evaluate((button) => {
      const style = getComputedStyle(button);
      return { visible: button.matches(":focus-visible"), width: style.outlineWidth, style: style.outlineStyle };
    });
    assert.equal(focus.visible, true, "keyboard navigation focuses the transparent title");
    assert.equal(focus.width, "2px");
    assert.equal(focus.style, "solid");
    for (const [menuScale, chatScale, height] of [[2, 1, 80], [1, 2, 46]]) {
      await page.evaluate(({ menuScale, chatScale }) => {
        document.documentElement.style.setProperty("--ui-font-scale", String(menuScale));
        document.documentElement.style.setProperty("--chat-font-scale", String(chatScale));
      }, { menuScale, chatScale });
      const title = await page.evaluate(() => {
        const button = document.querySelector(".mobile-session-selector")!;
        const text = document.querySelector(".mobile-island-title-text")!;
        const style = getComputedStyle(button);
        return {
          height: button.getBoundingClientRect().height,
          textHeight: text.getBoundingClientRect().height,
          lineHeight: parseFloat(getComputedStyle(text).lineHeight),
          background: style.backgroundColor,
          filter: getComputedStyle(button.parentElement!.parentElement!).backdropFilter,
          clearance: parseFloat(getComputedStyle(document.querySelector(".stage")!).paddingTop),
          runway: parseFloat(getComputedStyle(document.querySelector(".timeline")!, "::before").flexBasis),
        };
      });
      assert.equal(title.height, height, `menu ${menuScale}, chat ${chatScale}: header follows menu size`);
      assert.equal(title.textHeight, title.lineHeight * 2, "long title stays at two complete lines");
      assert.ok(title.clearance >= title.height, "transcript reserves the taller header's space");
      assert.ok(title.runway >= title.height, "chat text scaling does not shrink the transcript's top runway");
      assert.equal(title.background, "rgba(0, 0, 0, 0)");
      assert.equal(title.filter, "none");
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await page.locator(".mobile-island-text").evaluate((text) => getComputedStyle(text).animationName), "none");
  } finally {
    await browser.close();
  }
});

test("the phone's top islands wear the composer's material in every style and glass mode", { skip: !chrome }, async () => {
  const css = await builtCss();
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: chrome!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
    // The real markup: GlassIsland/GlassDock classes and the composer identity.
    // Transitions are off so a theme switch is read settled, not mid-ease.
    await page.setContent(`<style>${css}</style><style>*{transition:none!important}</style>
      <div class="app mode-chat view-session">
        <div class="mobile-session-floats" data-title-mode="hidden">
          <div class="ui-glass-island ui-glass-island--chrome mobile-float-navigation"><button class="ui-icon-btn ui-icon-btn--lg ui-icon-btn--ghost">=</button></div>
          <div class="ui-glass-island ui-glass-island--chrome mobile-float-actions"><button class="ui-icon-btn ui-icon-btn--lg ui-icon-btn--ghost">+</button></div>
        </div>
        <div class="composer composer-chat composer-simple composer-mobile composer-collapsed">
          <div class="ui-glass-dock ui-glass-dock--strong composer-card"><textarea></textarea></div>
        </div>
      </div>`);
    const material = () => page.evaluate(() => {
      const read = (selector: string) => {
        const style = getComputedStyle(document.querySelector(selector)!);
        return {
          image: style.backgroundImage, color: style.backgroundColor, clip: style.backgroundClip,
          filter: style.backdropFilter, border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
          shadow: style.boxShadow,
        };
      };
      return { navigation: read(".mobile-float-navigation"), actions: read(".mobile-float-actions"), composer: read(".composer-card") };
    });
    for (const [palette, appearance] of [["liquid-glass", "light"], ["liquid-glass", "dark"], ["mist", "light"], ["dark", "dark"], ["big-sur", "light"], ["fluent", "light"]] as const) {
      const spec = resolveTheme(palette, appearance);
      await page.evaluate(({ vars, appearance, style }) => {
        const html = document.documentElement;
        html.removeAttribute("style");
        for (const [name, value] of Object.entries(vars)) html.style.setProperty(name, value);
        html.dataset.appearance = appearance;
        if (style) html.dataset.themeStyle = style;
        else delete html.dataset.themeStyle;
      }, { vars: themeCssVars(spec), appearance, style: spec.style });
      for (const glass of ["matte", "clear", "off"] as const) {
        for (const hideBorders of [false, true]) {
          await page.evaluate(({ glass, hideBorders }) => {
            document.body.dataset.glass = glass;
            if (hideBorders) document.body.dataset.hideBorders = "true";
            else delete document.body.dataset.hideBorders;
          }, { glass, hideBorders });
          const state = await material();
          const label = `${palette}/${appearance}/${glass}${hideBorders ? "/borderless" : ""}`;
          assert.deepEqual(state.actions, state.composer, `${label}: the action island wears the composer's material`);
          assert.deepEqual(state.navigation, state.composer, `${label}: the menu island wears the composer's material`);
          assert.doesNotMatch(state.composer.border, /rgba\(0, 0, 0, 0\)$/, `${label}: the shared material keeps its contour`);
        }
      }
    }
  } finally {
    await browser.close();
  }
});

/** Layout and own-surface reading for the rail fixture, shared by the checks
 *  below so the surface choice is never confused with a layout change. */
const layoutOf = (page: Page) => page.evaluate(() => {
  const box = (el: Element) => {
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  };
  // In glass mode these controls paint through background-image, so "still has
  // its own surface" means any background paint, not a background-color.
  const painted = (selector: string) => {
    const style = getComputedStyle(document.querySelector(selector)!);
    return style.backgroundImage !== "none" || style.backgroundColor !== "rgba(0, 0, 0, 0)";
  };
  return {
    header: box(document.querySelector(".header")!),
    railHeight: box(document.querySelector(".view-switcher-pill")!).height,
    menuHeight: box(document.querySelector(".workspace-mode-switch")!).height,
    pillPainted: painted(".view-switcher-pill"),
    menuPainted: painted(".workspace-mode-switch"),
  };
});

test("the top rail surface setting really removes the rail's bottom edge", { skip: !chrome }, async () => {
  const css = await builtCss();
  const ember = PRESET_THEMES.find((theme) => theme.id === "dark");
  assert.ok(ember);
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: chrome!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent(`<style>${css}</style>
      <div class="app mode-chat view-session">
        <header class="header">
          <div class="header-left-cluster">
            <div class="workspace-mode-switch"><button class="active">Chat</button><button>Canvas</button></div>
            <nav class="view-switcher"><div class="view-switcher-pill"><button class="view-icon active"></button></div></nav>
          </div>
          <div class="header-trailing-cluster"><div class="header-user-menu"><button class="header-profile"></button></div></div>
        </header>
        <main class="stage"><div class="focus-conversation"><div class="timeline">Workspace below the rail</div></div></main>
      </div>`);
    await page.evaluate((vars) => {
      document.documentElement.dataset.appearance = "dark";
      for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value);
      document.body.dataset.glass = "matte";
      // Borders stay on so the rail's own bottom edge is observable at all;
      // the borderless default hides it independently of this setting.
      document.body.dataset.hideBorders = "false";
    }, themeCssVars(ember));

    const rail = () => page.evaluate(() => {
      const style = getComputedStyle(document.querySelector(".header")!);
      return {
        backgroundImage: style.backgroundImage,
        backgroundColor: style.backgroundColor,
        filter: style.backdropFilter,
        boxShadow: style.boxShadow,
        edge: `${style.borderBottomWidth} ${style.borderBottomStyle} ${style.borderBottomColor}`,
      };
    });

    // Shadow is the current rail. Flat drops the bottom edge and the shadow but
    // keeps the rail's own material. Floating drops the material too.
    const setSurface = (surface: string) => page.evaluate((surface) => {
      // Header renders the choice onto the rail element itself.
      document.querySelector<HTMLElement>(".header")!.dataset.topRailSurface = surface;
    }, surface);
    // The rail paints from two different shell rules: the wide composition's
    // card at >=961px and the compact strip below it. Both must honour the
    // setting, and both are skipped by the same opt-out selector.
    for (const width of [1280, 800]) {
      await page.setViewportSize({ width, height: 800 });
      for (const [surface, expectEdge, expectShadow, expectSurface] of [
      ["shadow", true, true, true],
      ["flat", false, false, true],
      ["floating", false, false, false],
    ] as const) {
      await setSurface(surface);
      for (const glass of ["matte", "clear", "off"] as const) {
        await page.evaluate((glass) => { document.body.dataset.glass = glass; }, glass);
        const state = await rail();
        const where = `${surface}/${glass}@${width}`;
        const hasEdge = !(state.edge.startsWith("0px") || state.edge.startsWith("0px solid rgba(0, 0, 0, 0)"));
        assert.equal(hasEdge, expectEdge, `${where}: bottom edge is ${state.edge}`);
        assert.equal(state.boxShadow !== "none", expectShadow, `${where}: rail shadow is ${state.boxShadow}`);
        if (expectSurface) {
          assert.ok(
            state.backgroundImage !== "none" || state.backgroundColor !== "rgba(0, 0, 0, 0)",
            `${where}: the rail keeps its own material`,
          );
        } else {
          // Floating has to out-specify the shared glass rules, which set both
          // the gradient and the blur filter with !important.
          assert.equal(state.backgroundImage, "none", `${where}: gradient`);
          assert.equal(state.backgroundColor, "rgba(0, 0, 0, 0)", `${where}: color`);
          assert.equal(state.filter, "none", `${where}: the rail stops blurring the workspace`);
        }
      }
    }
    }

    // Low-resource mode swaps in the opaque fallbacks; floating still wins there.
    await page.evaluate(() => {
      document.body.dataset.desktopLowResource = "true";
      document.body.dataset.glass = "matte";
    });
    const lowResource = await rail();
    assert.equal(lowResource.backgroundImage, "none");
    assert.equal(lowResource.filter, "none");

    // Switching back must restore the rail exactly, not merely un-hide it.
    await page.evaluate(() => { delete document.body.dataset.desktopLowResource; });
    const floatingBox = (await layoutOf(page)).header;
    await setSurface("shadow");
    const restored = await rail();
    assert.match(restored.filter, /blur\(/, "switching back to Shadow restores the rail's glass");
    assert.notEqual(restored.boxShadow, "none");
    const shadowBox = (await layoutOf(page)).header;
    assert.deepEqual(shadowBox, floatingBox, "the choice is visual only; the rail keeps its box");

    // A rail with no surface must not stop laying out or lose its own controls.
    await setSurface("floating");
    const layout = await layoutOf(page);
    assert.ok(layout.header.height > 0, "the rail still occupies its row");
    assert.ok(layout.railHeight > 0 && layout.menuHeight > 0, "floating controls keep their size");
    // The controls are what the user asked to see float, so they keep their own
    // surfaces even though the rail around them lost its own.
    assert.notEqual(layout.pillPainted, false, "the launcher pill keeps its own surface");
    assert.notEqual(layout.menuPainted, false, "the workspace menu keeps its own surface");
  } finally {
    await browser.close();
  }
});
