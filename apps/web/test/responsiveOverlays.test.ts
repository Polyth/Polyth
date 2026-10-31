import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "./chromium.ts";

const read = async (relative: string): Promise<string> => {
  const content = await readFile(new URL(relative, import.meta.url), "utf8");
  if (relative !== "../src/styles.css") return content;
  const tokens = await readFile(new URL("../src/tokens.css", import.meta.url), "utf8");
  return `${tokens}\n${content}`;
};
const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}

let browser: Browser | null = null;
let page = null as Page | null;

before(async () => {
  if (!CHROME) return;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage({ viewport: { width: 390, height: 720 } });
  await page.emulateMedia({ reducedMotion: "reduce" });
});

after(async () => {
  await browser?.close();
});

test("New Chat keeps its composer within the reading measure and switches keep compact tracks", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = `${await read("../src/styles.css")}\n${await read("../src/moduleContent.css")}`;
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.setContent(`<style>${css}</style>
    <div class="stage-new" style="width:1100px">
      <div class="composer composer-chat"><div class="composer-card">Message</div></div>
    </div>
    <div class="module-view--phone">
      <button class="switch ui-switch" role="switch" aria-checked="true"><span class="switch-track"><i></i></span></button>
    </div>
    <div class="widget-chat-empty" style="width:900px"><p>Start a session</p><div class="composer composer-widget"><div class="composer-card">Message</div></div></div>`);
  const geometry = await page.evaluate(() => ({
    composer: document.querySelector(".composer-card")!.getBoundingClientRect().width,
    inset: getComputedStyle(document.querySelector(".composer-chat")!).paddingInlineStart,
    target: document.querySelector(".switch")!.getBoundingClientRect().height,
    track: document.querySelector(".switch-track")!.getBoundingClientRect().height,
    canvasComposer: document.querySelector(".composer-widget")!.getBoundingClientRect().width,
  }));
  await page.setViewportSize({ width: 390, height: 720 });
  assert.equal(geometry.composer, 768);
  assert.equal(geometry.inset, "166px");
  assert.ok(geometry.target >= 44);
  assert.equal(geometry.track, 22, "a larger hit target never stretches the visible switch");
  assert.ok(geometry.canvasComposer > 700, "the Canvas composer must not shrink-wrap to the empty-state label");
});

test("sheet actions support disabled and busy semantics", async () => {
  const sheet = await read("../src/components/mobile/Sheet.tsx");
  const overlay = await read("../src/components/ui/ResponsiveOverlay.tsx");
  assert.match(sheet, /export interface SheetAction/);
  assert.match(sheet, /disabled\?: boolean;/);
  assert.match(sheet, /busy\?: boolean;/);
  assert.match(sheet, /disabled=\{Boolean\(action\.disabled \|\| action\.busy\)\}/);
  assert.match(sheet, /aria-busy=\{action\.busy \|\| undefined\}/);
  assert.match(sheet, /if \(closing \|\| action\.disabled \|\| action\.busy\) return;/);
  assert.match(overlay, /sheetAction\?: SheetAction/);
});

test("modal primitives lock background scroll and retain touch dismissal", async () => {
  const dialog = await read("../src/components/a11y/Dialog.tsx");
  const settings = await read("../src/components/SettingsView.tsx");
  const palette = await read("../src/components/CommandPalette.tsx");
  const packageTour = await read("../src/components/PackageTourOverlay.tsx");
  const css = await read("../src/styles.css");

  assert.match(dialog, /export function useModalScrollLock/);
  assert.match(dialog, /documentElement\.dataset\.modalSurface = "open"/);
  assert.match(dialog, /useModalScrollLock\(enabled && open\)/);
  assert.match(dialog, /root\?\.parentElement/);
  assert.match(dialog, /\[\.\.\.parent\.children\]\.filter\(\(element\) => element !== root/);
  assert.match(dialog, /createPortal\(surface, document\.body\)/, "dialogs render outside glass containing blocks");
  assert.match(dialog, /onPointerDown=\{\(e\) => \{ if \(e\.target === e\.currentTarget\) onClose\(\); \}\}/);
  assert.match(settings, /useModalSurface\(\{/);
  assert.match(settings, /open:\s*true/);
  assert.match(settings, /className="settings-mobile-nav-head"/);
  assert.match(settings, /className="settings-mobile-title"/);
  assert.match(settings, /<IconButton icon=\{CloseIcon\} label=\{tr\("common\.close"\)\} onClick=\{closeSettings\} \/>/);
  assert.match(palette, /<ResponsiveOverlay[\s\S]*desktop="dialog"/);
  assert.match(palette, /sheetSize="tall"/);
  assert.match(palette, /initialFocus="\.palette-input"/);
  assert.doesNotMatch(palette, /className="scrim palette-overlay"/);
  assert.match(packageTour, /useModalScrollLock\(open\)/);
  assert.match(packageTour, /className="scrim package-tour-scrim"[\s\S]*onPointerDown=/);
  assert.match(css, /html\[data-modal-surface="open"\][\s\S]*overflow:\s*hidden/);
});

test("project and configuration actions remain attached to their handlers", async () => {
  const project = await read("../src/components/ProjectFolderDialog.tsx");
  const worktree = await read("../src/components/WorktreeSessionDialog.tsx");

  assert.match(project, /variant="primary"[\s\S]*className="folder-open-btn"[\s\S]*onClick=\{\(\) => void openProject\(\)\}/);
  assert.match(project, /slot="project\.create\.options"/);
  assert.match(worktree, /onClick=\{submit\}/);
});

test("390px dialogs use an internally scrolling bottom sheet", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = await read("../src/styles.css");
  const fields = Array.from({ length: 24 }, (_, index) =>
    `<label>Field ${index}<input value="value ${index}"></label>`).join("");
  await page.setContent(`
    <style>${css}</style>
    <div class="dialog-backdrop">
      <section class="dialog-panel dialog-md ui-dialog" role="dialog">
        <header class="ui-dialog-head"><h2 class="ui-dialog-title">Configuration</h2><button>Close</button></header>
        <div class="ui-dialog-body">${fields}</div>
        <footer class="ui-dialog-foot"><button>Cancel</button><button class="primary-btn">Save</button></footer>
      </section>
    </div>
  `);

  const geometry = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".dialog-panel")!;
    const body = document.querySelector<HTMLElement>(".ui-dialog-body")!;
    const rect = panel.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      panelHeight: rect.height,
      bodyClientHeight: body.clientHeight,
      bodyScrollHeight: body.scrollHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
    };
  });

  assert.equal(geometry.left, 0);
  assert.equal(geometry.right, 390);
  assert.equal(geometry.bottom, 720);
  assert.ok(geometry.panelHeight < 720, "focused forms remain bottom sheets");
  assert.ok(geometry.bodyScrollHeight > geometry.bodyClientHeight, "the form body owns overflow");
  assert.equal(geometry.documentScrollHeight, 720, "the document does not grow behind the sheet");
});

test("project settings preserves dialog chrome and customer appearance geometry", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = `${await read("../src/styles.css")}\n${await read("../src/components/ProjectSettingsDialog.css")}`;
  // A text size publishes two values: the size and its multiplier. Roles read
  // the multiplier, so a harness that sets only one is not simulating the app.
  const content = (density: "comfortable" | "compact", glass: "matte" | "off", radius: number) => `
    <style>${css} :root { --corner-radius-scale: ${radius}; --ui-font-size: 18px; --ui-font-scale: 1.2; }</style>
    <body data-density="${density}" data-glass="${glass}">
      <div class="dialog-backdrop">
        <section class="dialog-panel dialog-md ui-dialog project-settings-dialog" role="dialog">
          <header class="ui-dialog-head">
            <h2 class="ui-dialog-title">Project settings with a translated long title</h2>
            <button class="ui-icon-btn" aria-label="Close">×</button>
          </header>
          <div class="ui-dialog-body">
            <div class="project-settings-project">
              <span class="project-glyph project-settings-project-glyph">P</span>
              <div><strong>A very long project name that should truncate safely</strong><span class="project-settings-project-path">/data/projects/a/very/long/path/that/must/not/stretch/the/dialog</span></div>
            </div>
            <div class="project-settings-menu">
              <button><span class="project-settings-menu-icon">A</span><span class="project-settings-menu-copy"><strong>Appearance</strong><span>Name, icon and project color.</span></span><svg width="16" height="16"></svg></button>
              <button><span class="project-settings-menu-icon">W</span><span class="project-settings-menu-copy"><strong>Workspace</strong><span>Directions, recommendations and tool visibility.</span></span><svg width="16" height="16"></svg></button>
            </div>
          </div>
        </section>
      </div>
    </body>`;

  await page.setViewportSize({ width: 900, height: 700 });
  await page.setContent(content("comfortable", "matte", 1));
  const comfortable = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".project-settings-dialog")!;
    const body = document.querySelector<HTMLElement>(".ui-dialog-body")!;
    const row = document.querySelector<HTMLElement>(".project-settings-menu button")!;
    const title = document.querySelector<HTMLElement>(".project-settings-menu-copy strong")!;
    const rect = panel.getBoundingClientRect();
    return {
      panelLeft: rect.left,
      panelRight: rect.right,
      panelOverflow: panel.scrollWidth > panel.clientWidth + 1,
      bodyPadding: getComputedStyle(body).paddingTop,
      rowRadius: getComputedStyle(row).borderRadius,
      titleSize: getComputedStyle(title).fontSize,
      headerVisible: document.querySelector<HTMLElement>(".ui-dialog-head")!.getBoundingClientRect().height > 0,
    };
  });
  assert.ok(comfortable.panelLeft >= 0 && comfortable.panelRight <= 900);
  assert.equal(comfortable.panelOverflow, false);
  assert.equal(comfortable.bodyPadding, "16px");
  assert.equal(comfortable.rowRadius, "10px");
  assert.equal(comfortable.titleSize, "18px");
  assert.equal(comfortable.headerVisible, true);

  await page.setContent(content("compact", "off", .6));
  const compact = await page.evaluate(() => ({
    bodyPadding: getComputedStyle(document.querySelector<HTMLElement>(".ui-dialog-body")!).paddingTop,
    rowRadius: getComputedStyle(document.querySelector<HTMLElement>(".project-settings-menu button")!).borderRadius,
    opaqueFallback: getComputedStyle(document.querySelector<HTMLElement>(".project-settings-menu button")!).backgroundImage === "none",
  }));
  assert.equal(compact.bodyPadding, "12px");
  assert.equal(compact.rowRadius, "6px");
  assert.equal(compact.opaqueFallback, true);

  await page.setViewportSize({ width: 320, height: 568 });
  await page.setContent(content("compact", "off", .6));
  const phone = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".project-settings-dialog")!;
    const row = document.querySelector<HTMLElement>(".project-settings-menu button")!;
    const rect = panel.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      overflow: panel.scrollWidth > panel.clientWidth + 1,
      rowHeight: row.getBoundingClientRect().height,
    };
  });
  assert.equal(phone.left, 0);
  assert.equal(phone.right, 320);
  assert.equal(phone.bottom, 568);
  assert.equal(phone.overflow, false);
  assert.ok(phone.rowHeight >= 60, "phone rows retain a generous touch target");
  await page.setViewportSize({ width: 390, height: 720 });
});

test("390px settings fill the viewport without horizontal overflow", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = await read("../src/styles.css");
  const rows = Array.from({ length: 18 }, (_, index) => `
    <div class="set-row settings-row">
      <div class="set-row-text"><div class="set-row-label">Setting ${index}</div><div class="set-row-hint">Description</div></div>
      <div class="set-row-control"><select><option>Touch option</option></select></div>
    </div>`).join("");
  await page.setContent(`
    <style>${css}</style>
    <div class="scrim settings-scrim">
      <section class="modal settings-shell settings-mobile-page">
        <nav class="modal-nav settings-nav"></nav>
        <main class="modal-main settings-pane">
          <header class="modal-head settings-pane-head"><div class="settings-pane-head-bar">General</div></header>
          <div class="modal-body settings-pane-body">
            ${rows}
            <table><tbody><tr><td style="min-width: 720px">${"long-value-".repeat(40)}</td></tr></tbody></table>
          </div>
        </main>
      </section>
    </div>
  `);
  await page.evaluate(() => document.getAnimations().forEach((animation) => animation.finish()));

  const geometry = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".settings-shell")!;
    const pane = document.querySelector<HTMLElement>(".settings-pane-body")!;
    const table = document.querySelector<HTMLElement>("table")!;
    const select = document.querySelector<HTMLElement>("select")!;
    const rect = shell.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      paneClientHeight: pane.clientHeight,
      paneScrollHeight: pane.scrollHeight,
      paneClientWidth: pane.clientWidth,
      paneScrollWidth: pane.scrollWidth,
      tableClientWidth: table.clientWidth,
      tableScrollWidth: table.scrollWidth,
      selectHeight: select.getBoundingClientRect().height,
    };
  });

  assert.deepEqual(
    { left: geometry.left, right: geometry.right, top: geometry.top, bottom: geometry.bottom },
    { left: 0, right: 390, top: 0, bottom: 720 },
  );
  assert.ok(geometry.paneScrollHeight > geometry.paneClientHeight, "settings content scrolls inside its pane");
  assert.ok(geometry.paneScrollWidth <= geometry.paneClientWidth + 1, "wide content does not widen settings");
  assert.ok(geometry.tableScrollWidth > geometry.tableClientWidth, "wide tables scroll in their own region");
  assert.ok(geometry.selectHeight >= 44, "native selects retain a touch target");
});

test("mobile Settings follows glass, rounding, density, and text preferences", { skip: !CHROME }, async (t) => {
  assert.ok(page);
  t.after(async () => { await page!.setViewportSize({ width: 390, height: 720 }); });
  const css = await read("../src/styles.css");
  await page.setViewportSize({ width: 390, height: 720 });
  await page.setContent(`
    <style>${css}</style>
    <body data-glass="clear" data-density="comfortable">
      <div class="scrim settings-scrim">
        <section class="modal settings-shell settings-mobile-nav">
          <nav class="modal-nav settings-nav">
            <div class="settings-mobile-nav-head"><strong>Settings</strong></div>
            <div class="settings-nav-search-shell">
              <input class="ui-input ui-input--sm settings-nav-search" placeholder="Search settings" />
              <kbd class="settings-nav-search-shortcut">⌘K</kbd>
            </div>
            <nav class="settings-nav-list">
              <section class="settings-nav-section">
                <div class="settings-nav-group">Workspace</div>
                <div class="settings-nav-group-list">
                  <button class="settings-nav-item">
                    <span class="settings-nav-icon">□</span>
                    <span class="settings-nav-label">General</span>
                    <span class="settings-nav-chevron">›</span>
                  </button>
                </div>
              </section>
            </nav>
          </nav>
        </section>
      </div>
    </body>
  `);

  const readState = () => page!.evaluate(() => {
    const get = (selector: string) => document.querySelector<HTMLElement>(selector)!;
    const style = (selector: string) => getComputedStyle(get(selector));
    return {
      shellBackground: style(".settings-shell").backgroundImage,
      shellFilter: style(".settings-shell").backdropFilter,
      cardBackground: style(".settings-nav-group-list").backgroundImage,
      cardFilter: style(".settings-nav-group-list").backdropFilter,
      cardColor: style(".settings-nav-group-list").backgroundColor,
      headRadius: style(".settings-mobile-nav-head").borderRadius,
      searchRadius: style(".settings-nav-search-shell").borderRadius,
      rowFont: style(".settings-nav-item").fontSize,
      rowGap: style(".settings-nav-item").gap,
    };
  });
  const setState = (next: { glass: string; density: string; radius: string; font: number; lowResource?: boolean }) => page!.evaluate((value) => {
    document.body.dataset.glass = value.glass;
    document.body.dataset.density = value.density;
    document.documentElement.style.setProperty("--corner-radius-scale", value.radius);
    document.documentElement.style.setProperty("--ui-font-size", `${value.font}px`);
    // Roles read the multiplier, not the size (see the type-surface contract).
    document.documentElement.style.setProperty("--ui-font-scale", String(value.font / 15));
    if (value.lowResource) document.body.dataset.desktopLowResource = "true";
    else delete document.body.dataset.desktopLowResource;
  }, next);

  await setState({ glass: "clear", density: "comfortable", radius: "1", font: 15 });
  const clear = await readState();
  assert.match(clear.shellBackground, /radial-gradient/);
  assert.match(clear.shellFilter, /blur/);
  assert.match(clear.cardBackground, /radial-gradient/);

  await setState({ glass: "matte", density: "comfortable", radius: "1", font: 15 });
  const matte = await readState();
  assert.notEqual(matte.cardBackground, clear.cardBackground);

  await setState({ glass: "off", density: "comfortable", radius: "0", font: 10 });
  const off = await readState();
  assert.equal(off.shellFilter, "none");
  assert.equal(off.cardBackground, "none");
  assert.equal(off.cardFilter, "none");
  assert.notEqual(off.cardColor, "rgba(0, 0, 0, 0)");
  assert.equal(off.headRadius, "0px");
  assert.equal(off.rowFont, "10px");

  await setState({ glass: "clear", density: "compact", radius: "2", font: 24 });
  const compact = await readState();
  assert.equal(compact.headRadius, "32px");
  assert.equal(compact.searchRadius, "24px");
  assert.equal(compact.rowFont, "24px");
  assert.ok(Number.parseFloat(compact.rowGap) < Number.parseFloat(clear.rowGap || "0"));

  await setState({ glass: "clear", density: "compact", radius: "2", font: 24, lowResource: true });
  const lowResource = await readState();
  assert.equal(lowResource.cardBackground, "none");
  assert.equal(lowResource.cardFilter, "none");
});

test("390px folder dialog Open control stays reachable without a type picker", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = await read("../src/styles.css");
  await page.setViewportSize({ width: 390, height: 720 });
  await page.setContent(`
    <style>${css}</style>
    <section class="dialog-panel folder-dialog">
      <div class="folder-dialog-body">
        <div class="folder-dialog-head"><div><div class="folder-dialog-title">Open a project</div></div></div>
        <div class="folder-foot">
          <span class="folder-selected">/Users/demo/project</span>
          <button class="ui-btn ui-btn--primary ui-btn--sm folder-open-btn">Open project</button>
        </div>
      </div>
    </section>
  `);

  const geometry = await page.evaluate(() => {
    const open = document.querySelector<HTMLElement>(".folder-open-btn")!;
    const openRect = open.getBoundingClientRect();
    return {
      documentScrollWidth: document.documentElement.scrollWidth,
      documentScrollHeight: document.documentElement.scrollHeight,
      openHeight: openRect.height,
      openBottom: openRect.bottom,
      viewportHeight: window.innerHeight,
      hasTypePicker: Boolean(document.querySelector(".folder-type-row, .project-type-controls, select")),
    };
  });

  assert.equal(geometry.hasTypePicker, false);
  assert.ok(geometry.documentScrollWidth <= 390, "folder dialog does not create horizontal overflow");
  assert.ok(geometry.openBottom <= geometry.viewportHeight + 1, "Open stays inside the viewport");
  assert.ok(geometry.openHeight >= 32, "Open meets the compact control height");
});

test("folder Open and project settings stay inside representative viewports", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = await read("../src/styles.css");
  const viewports = [
    { width: 320, height: 568, name: "320 phone" },
    { width: 375, height: 667, name: "375 phone" },
    { width: 390, height: 720, name: "390 phone" },
    { width: 430, height: 932, name: "430 phone" },
    { width: 600, height: 800, name: "600 narrow" },
    { width: 768, height: 1024, name: "768 tablet" },
    { width: 820, height: 1180, name: "820 tablet" },
    { width: 1024, height: 768, name: "1024 desktop" },
    { width: 820, height: 360, name: "short landscape" },
  ] as const;

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.setContent(`
      <style>${css}</style>
      <section class="dialog-panel folder-dialog">
        <div class="folder-dialog-body">
          <div class="folder-dialog-head"><div><div class="folder-dialog-title">Open a project</div></div></div>
          <div class="folder-list" style="min-height:80px"></div>
          <div class="folder-foot">
            <span class="folder-selected">/Users/demo/project</span>
            <button class="ui-btn ui-btn--primary ui-btn--sm folder-open-btn">Open project</button>
          </div>
        </div>
      </section>
    `);
    const geometry: {
      pageOverflowX: boolean;
      pageOverflowYClip: boolean;
      dialogOverflowX: boolean;
      openHeight: number;
    } = await page.evaluate((expectedWidth: number) => {
      const open = document.querySelector<HTMLElement>(".folder-open-btn")!;
      const dialog = document.querySelector<HTMLElement>(".folder-dialog")!;
      const openRect = open.getBoundingClientRect();
      return {
        pageOverflowX: document.documentElement.scrollWidth > expectedWidth + 1,
        pageOverflowYClip: openRect.bottom > window.innerHeight + 1,
        dialogOverflowX: dialog.scrollWidth > dialog.clientWidth + 1,
        openHeight: openRect.height,
      };
    }, viewport.width);
    assert.equal(geometry.pageOverflowX, false, `${viewport.name} has no horizontal overflow`);
    assert.equal(geometry.pageOverflowYClip, false, `${viewport.name} keeps Open reachable`);
    assert.equal(geometry.dialogOverflowX, false, `${viewport.name} dialog does not overflow horizontally`);
    assert.ok(geometry.openHeight >= 32, `${viewport.name} Open meets compact control height`);
  }

  await page.setViewportSize({ width: 390, height: 720 });
});

test("coarse pointer folder Open uses the Polyth tap target", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = await read("../src/styles.css");
  await page.setViewportSize({ width: 390, height: 720 });
  await page.setContent(`
    <style>${css}
      html:root { --hit-min: var(--tap); }
    </style>
    <section class="dialog-panel folder-dialog">
      <div class="folder-dialog-body">
        <div class="folder-foot">
          <button class="ui-btn ui-btn--primary ui-btn--sm folder-open-btn">Open project</button>
        </div>
      </div>
    </section>
  `);
  const height = await page.evaluate(() =>
    document.querySelector<HTMLElement>(".folder-open-btn")!.getBoundingClientRect().height);
  assert.ok(height >= 44, "coarse pointer Open meets --tap");
});

test("enlarged interface font keeps folder Open inside a short landscape viewport", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = await read("../src/styles.css");
  await page.setViewportSize({ width: 667, height: 375 });
  await page.setContent(`
    <style>${css}
      html { font-size: 20px; }
      :root { --ui-font-size: 20px; --ui-font-scale: 1.3333; --font-ui: 20px; }
    </style>
    <section class="dialog-panel folder-dialog">
      <div class="folder-dialog-body">
        <div class="folder-dialog-head"><div><div class="folder-dialog-title">Open a project</div></div></div>
        <div class="folder-list" style="min-height:40px"></div>
        <div class="folder-foot">
          <span class="folder-selected">/Users/demo/project</span>
          <button class="ui-btn ui-btn--primary ui-btn--sm folder-open-btn">Open project</button>
        </div>
      </div>
    </section>
  `);
  const geometry = await page.evaluate(() => {
    const open = document.querySelector<HTMLElement>(".folder-open-btn")!;
    return {
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      openBottom: open.getBoundingClientRect().bottom,
      viewportHeight: window.innerHeight,
    };
  });
  assert.equal(geometry.overflowX, false, "enlarged font does not overflow horizontally");
  assert.ok(geometry.openBottom <= geometry.viewportHeight + 1, "Open stays reachable in short landscape");
  await page.setViewportSize({ width: 390, height: 720 });
});

test("360px split pane keeps project settings controls inside the card", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = await read("../src/styles.css");
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.setContent(`
    <style>${css}
      .split-pane { width: 360px; max-width: 360px; margin: 0; }
    </style>
    <main style="width:1024px">
      <div class="projects-settings-page split-pane">
        <section class="settings-section">
          <div class="settings-section-body">
            <div class="set-row settings-row" data-settings-item="projects.executionHarness">
              <div class="set-row-text">
                <div class="set-row-label"><strong>Default harness</strong></div>
                <div class="set-row-hint">Choose an execution engine for new conversations in this project.</div>
              </div>
              <div class="set-row-control"><button class="ui-btn ui-btn--sm">Auto</button></div>
            </div>
          </div>
        </section>
      </div>
    </main>
  `);

  const geometry = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".split-pane")!;
    const row = pane.querySelector<HTMLElement>(".set-row")!;
    const label = pane.querySelector("strong")!;
    const button = pane.querySelector<HTMLElement>(".ui-btn")!;
    const collide = (a: DOMRect, b: DOMRect) =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && b.top < a.bottom;
    const stacked = getComputedStyle(row).flexDirection === "column";
    return {
      paneWidth: pane.getBoundingClientRect().width,
      overflow: pane.scrollWidth > pane.clientWidth + 1,
      overlap: collide(label.getBoundingClientRect(), button.getBoundingClientRect()),
      stacked,
      buttonHeight: button.getBoundingClientRect().height,
      pageOverflow: document.documentElement.scrollWidth > 1024 + 1,
      viewportWidth: window.innerWidth,
    };
  });

  assert.equal(geometry.viewportWidth, 1024, "split-pane test uses a wide viewport so only the container query wraps");
  assert.ok(geometry.paneWidth <= 361, "split pane is actually ~360px");
  assert.equal(geometry.stacked, true, "narrow pane stacks via container query, not a 700px viewport media query");
  assert.equal(geometry.overflow, false, "settings card does not overflow the pane");
  assert.equal(geometry.overlap, false, "label does not collide with the harness control");
  assert.ok(geometry.buttonHeight >= 32, "harness control remains a usable compact control");
  assert.equal(geometry.pageOverflow, false, "1024px viewport has no horizontal overflow");
  await page.setViewportSize({ width: 390, height: 720 });
});

test("390px audited actions expose 44px targets and scrolling question tabs", { skip: !CHROME }, async () => {
  assert.ok(page);
  const [css, developerCss] = await Promise.all([
    read("../src/styles.css"),
    read("../../../packages/files/widgets/styles.css"),
  ]);
  const tabs = Array.from({ length: 8 }, (_, index) =>
    `<button class="question-tab">${index + 1}</button>`).join("");
  await page.setContent(`
    <style>${css}\n${developerCss}\n:root { --hit-min: var(--tap); }</style>
    <main style="width: 180px">
      <button class="ui-icon-btn ui-icon-btn--sm question-copy-btn" data-audit="question-copy">Copy</button>
      <div class="question-tabs" data-audit-scroll>${tabs}</div>
      <label class="question-option" data-audit="question-option"><input type="radio">Option</label>
      <div class="question-actions"><button class="ui-btn ui-btn--sm" data-audit="question-action">Next</button></div>
      <span class="attachment-pill"><button class="att-remove" data-audit="attachment-remove">×</button></span>
      <div class="queue-chip"><span></span><span></span><span></span><span></span><button data-audit="queue-edit">Edit</button><button>×</button></div>
      <article class="msg assistant"><div class="msg-meta"><div class="msg-actions"><button class="msg-action-btn" data-audit="assistant-action">Copy</button></div></div></article>
      <button class="sheet-search-clear" data-audit="sheet-search-clear">×</button>
      <button class="pane-tab-close" data-audit="editor-tab-close">×</button>
    </main>
  `);

  const geometry = await page.evaluate(() => {
    const targets = [...document.querySelectorAll<HTMLElement>("[data-audit]")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const pseudo = getComputedStyle(element, "::after");
        const pseudoWidth = Number.parseFloat(pseudo.width);
        const pseudoHeight = Number.parseFloat(pseudo.height);
        return {
          name: element.dataset.audit,
          width: Math.max(rect.width, Number.isFinite(pseudoWidth) ? pseudoWidth : 0),
          height: Math.max(rect.height, Number.isFinite(pseudoHeight) ? pseudoHeight : 0),
        };
      });
    const tabsElement = document.querySelector<HTMLElement>("[data-audit-scroll]")!;
    return {
      targets,
      tabsClientWidth: tabsElement.clientWidth,
      tabsScrollWidth: tabsElement.scrollWidth,
    };
  });

  for (const target of geometry.targets) {
    assert.ok(target.width >= 44, `${target.name} is at least 44px wide`);
    assert.ok(target.height >= 44, `${target.name} is at least 44px tall`);
  }
  assert.ok(geometry.tabsScrollWidth > geometry.tabsClientWidth, "question tabs scroll instead of clipping");
});

test("Files keeps its editor beside the tree regardless of package style load order", { skip: !CHROME }, async (t) => {
  assert.ok(page);
  t.after(async () => { await page!.setViewportSize({ width: 390, height: 720 }); });
  const [coreCss, filesCss] = await Promise.all([
    read("../src/styles.css"),
    read("../../../packages/files/widgets/styles.css"),
  ]);
  await page.setViewportSize({ width: 1247, height: 951 });
  const content = (styles: string) => `
    <style>${styles}</style>
    <aside class="rail rail-workspace" style="width: 1158px; height: 850px">
      <section class="module-view">
        <div class="module-view-body">
          <div class="module-view-content module-view-content--workspace">
            <div class="rail-body">
              <div class="editor-view mobile-editor">
                <div class="editor-mobile-tabs">Files / AGENTS.md</div>
                <aside class="editor-tree">
                  <div class="files-search"><input class="ui-input ui-input--sm" placeholder="Search files…"></div>
                  <div class="ft-tree">
                    <div class="ft-row" style="padding-inline-start: 8px">
                      <span class="ft-name">AGENTS.md</span>
                    </div>
                  </div>
                </aside>
                <section class="editor-pane">
                  <div class="pane-tabs"><div class="pane-tab-group active"><button class="pane-tab">AGENTS.md</button></div></div>
                  <div class="pane-body"><div class="editor-toolbar">Edit <span>Preview</span></div><div class="editor-body">Editor</div></div>
                </section>
              </div>
            </div>
          </div>
        </div>
      </section>
    </aside>
  `;

  const geometry = async () => page!.evaluate(() => {
    const root = document.querySelector<HTMLElement>(".editor-view")!;
    const mobileTabs = document.querySelector<HTMLElement>(".editor-mobile-tabs")!;
    const tree = document.querySelector<HTMLElement>(".editor-tree")!;
    const editor = document.querySelector<HTMLElement>(".editor-pane")!;
    const row = document.querySelector<HTMLElement>(".ft-row")!;
    const rowName = document.querySelector<HTMLElement>(".ft-name")!;
    const tab = document.querySelector<HTMLElement>(".pane-tab")!;
    const toolbar = document.querySelector<HTMLElement>(".editor-toolbar")!;
    return {
      direction: getComputedStyle(root).flexDirection,
      mobileTabsDisplay: getComputedStyle(mobileTabs).display,
      treeDisplay: getComputedStyle(tree).display,
      treeWidth: tree.getBoundingClientRect().width,
      editorDisplay: getComputedStyle(editor).display,
      editorWidth: editor.getBoundingClientRect().width,
      editorHeight: editor.getBoundingClientRect().height,
      rowHeight: row.getBoundingClientRect().height,
      tabHeight: tab.getBoundingClientRect().height,
      toolbarHeight: toolbar.getBoundingClientRect().height,
      rowFontFamily: getComputedStyle(rowName).fontFamily,
      rowFontSize: getComputedStyle(rowName).fontSize,
      tabFontFamily: getComputedStyle(tab).fontFamily,
      tabFontSize: getComputedStyle(tab).fontSize,
    };
  });

  for (const [order, styles] of [
    ["package-before-core", `${filesCss}\n${coreCss}`],
    ["core-before-package", `${coreCss}\n${filesCss}`],
  ] as const) {
    await page.setContent(content(styles));
    const wide = await geometry();
    assert.equal(wide.direction, "row", `${order}: the host does not override the Files wide split axis`);
    assert.equal(wide.mobileTabsDisplay, "none");
    assert.notEqual(wide.treeDisplay, "none");
    assert.ok(wide.treeWidth > 0);
    assert.equal(wide.editorDisplay, "flex");
    assert.ok(wide.editorWidth > 0, "the editor owns the width left beside the tree");
    assert.ok(wide.editorHeight > 0, "the editor fills the workspace pane height");
    // Tree rows are denser than tabs on a fine pointer: control-h-sm − space-2.
    assert.equal(wide.rowHeight, 24, `${order}: file rows use the compact tree rhythm`);
    assert.equal(wide.tabHeight, 32, `${order}: file tabs use the compact control rhythm`);
    assert.equal(wide.toolbarHeight, 32, `${order}: editor toolbar uses the compact control rhythm`);
    // Tree labels use the UI label role; editor tabs keep the technical face.
    assert.match(wide.rowFontFamily, /system-ui/, `${order}: tree labels use the UI typeface`);
    assert.match(wide.tabFontFamily, /monospace/, `${order}: file tabs keep the technical typeface`);
  }

  await page.locator(".rail-workspace").evaluate((element) => { element.style.width = "805px"; });
  const compact = await geometry();
  assert.equal(compact.direction, "column");
  assert.equal(compact.mobileTabsDisplay, "flex");
  assert.equal(compact.treeDisplay, "none", "the selected editor replaces the tree in compact mode");
  assert.equal(compact.editorDisplay, "flex");
  assert.ok(compact.editorWidth > 0);
  assert.ok(compact.editorHeight > 0);
});

test("Files tree fills the compact surface instead of leaving the editor drop below", { skip: !CHROME }, async (t) => {
  assert.ok(page);
  t.after(async () => { await page!.setViewportSize({ width: 390, height: 720 }); });
  const [coreCss, filesCss] = await Promise.all([
    read("../src/styles.css"),
    read("../../../packages/files/widgets/styles.css"),
  ]);
  const rows = Array.from({ length: 40 }, (_, index) =>
    `<div class="ft-row"><span class="ft-name">file-${index + 1}.ts</span></div>`).join("");
  await page.setViewportSize({ width: 390, height: 720 });
  await page.setContent(`
    <style>${coreCss}\n${filesCss}</style>
    <div class="module-view-content module-view-content--workspace" style="width:390px;height:720px">
      <div class="editor-view mobile-tree">
        <div class="editor-mobile-tabs">Files / CLAUDE.md</div>
        <aside class="editor-tree"><div class="ft-tree">${rows}</div></aside>
        <div class="editor-pane-drop"></div>
      </div>
    </div>
  `);

  const geometry = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(".editor-view")!;
    const tree = document.querySelector<HTMLElement>(".editor-tree")!;
    return {
      dropDisplay: getComputedStyle(document.querySelector<HTMLElement>(".editor-pane-drop")!).display,
      rootHeight: root.getBoundingClientRect().height,
      treeHeight: tree.getBoundingClientRect().height,
      treeClientHeight: tree.clientHeight,
      treeScrollHeight: tree.scrollHeight,
    };
  });

  assert.equal(geometry.dropDisplay, "none", "the empty editor drop cannot occupy the tree stage");
  assert.ok(geometry.treeHeight > geometry.rootHeight * 0.8, "the tree consumes the compact surface height");
  assert.ok(geometry.treeScrollHeight > geometry.treeClientHeight, "long file lists scroll inside the visible tree");
});

test("390px package windows cover Chat and the session menu, and preserve the app background", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = await read("../src/styles.css");
  await page.setContent(`
    <style>${css}</style>
    <div class="app">
      <header class="header"></header>
      <section class="module-view module-view--main">
        <header class="module-view-head"><h1 class="module-view-title">Main package</h1></header>
        <div class="module-view-body"><div class="module-view-content"></div></div>
      </section>
      <aside class="rail rail-workspace rail-fullscreen">
        <section class="module-view module-view--rail">
          <header class="module-view-head"><h1 class="module-view-title">Rail package</h1></header>
          <div class="module-view-body"><div class="module-view-content"></div></div>
        </section>
      </aside>
      <div class="mobile-session-floats"></div>
      <div class="conversation-composer-dock"></div>
    </div>
  `);
  await page.evaluate(() => {
    document.documentElement.dataset.background = "blue-hour";
    document.documentElement.style.setProperty("--app-background-image", "linear-gradient(red, blue)");
  });

  const geometry = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".module-view--main")!;
    const rail = document.querySelector<HTMLElement>(".rail-fullscreen")!;
    const mainHead = main.querySelector<HTMLElement>(".module-view-head")!;
    const railHead = rail.querySelector<HTMLElement>(".module-view-head")!;
    const floats = document.querySelector<HTMLElement>(".mobile-session-floats")!;
    const composer = document.querySelector<HTMLElement>(".conversation-composer-dock")!;
    return {
      main: main.getBoundingClientRect().toJSON(),
      rail: rail.getBoundingClientRect().toJSON(),
      mainHeadTop: mainHead.getBoundingClientRect().top,
      railHeadTop: railHead.getBoundingClientRect().top,
      mainBackground: getComputedStyle(main).backgroundImage,
      railBackground: getComputedStyle(rail).backgroundImage,
      mainZ: getComputedStyle(main).zIndex,
      railZ: getComputedStyle(rail).zIndex,
      floatZ: getComputedStyle(floats).zIndex,
      composerZ: getComputedStyle(composer).zIndex,
    };
  });

  for (const name of ["main", "rail"] as const) {
    assert.deepEqual(
      { left: geometry[name].left, top: geometry[name].top, right: geometry[name].right, bottom: geometry[name].bottom },
      { left: 0, top: 0, right: 390, bottom: 720 },
      `${name} package window fills the viewport`,
    );
  }
  assert.equal(geometry.mainHeadTop, 0, "main title row is the top row (no strip left for the session menu)");
  assert.equal(geometry.railHeadTop, 0, "rail title row is the top row (no strip left for the session menu)");
  assert.match(geometry.mainBackground, /linear-gradient/);
  assert.match(geometry.railBackground, /linear-gradient/);
  assert.equal(geometry.mainZ, "104", "main package covers the composer and the Workspace");
  assert.equal(geometry.railZ, "104", "rail package covers the composer and the Workspace");
  assert.equal(geometry.floatZ, "102", "the session menu stays below package windows");
  assert.equal(geometry.composerZ, "100", "the chat composer remains below package windows");
});

test("desktop fullscreen package panes stop at the persistent left rail", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = await read("../src/styles.css");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(`
    <style>${css}</style>
    <style>
      body { margin: 0; }
      .app-shell { height: 800px; }
      .sidebar { width: 332px; min-width: 332px; }
      .workspace { min-width: 0; }
    </style>
    <div class="app">
      <header class="header"></header>
      <div class="app-shell">
        <nav class="sidebar"></nav>
        <section class="workspace"></section>
        <aside class="railbar railbar-open">
          <div class="rail rail-workspace rail-fullscreen"><div class="module-view"></div></div>
          <div class="rail-icon-col plugin-strip"></div>
        </aside>
      </div>
    </div>
  `);
  await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".app-shell")!;
    const workspace = document.querySelector<HTMLElement>(".workspace")!;
    const railbar = document.querySelector<HTMLElement>(".railbar")!;
    railbar.style.setProperty("--package-window-inline-start", `${Math.ceil(workspace.getBoundingClientRect().left - shell.getBoundingClientRect().left)}px`);
  });
  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return {
      sidebar: rect(".sidebar"),
      workspace: rect(".workspace"),
      pane: rect(".rail-fullscreen"),
      railbar: rect(".railbar"),
    };
  });
  assert.ok(geometry.pane.left >= geometry.sidebar.right, "fullscreen pane must not cover the left rail");
  assert.ok(Math.abs(geometry.pane.left - geometry.workspace.left) <= 1, "fullscreen pane starts at the workspace seam");
  assert.ok(Math.abs(geometry.railbar.left - geometry.workspace.left) <= 1, "the fullscreen host follows the workspace seam");
});

test("context selectors give a long label room and shrink instead of overflowing", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = `${await read("../src/styles.css")}\n${await read("../src/moduleContent.css")}`;
  const chip = (id: string, text: string) =>
    `<div class="context-selector context-selector-${id}"><button class="chip picker-chip">` +
    `<span class="picker-trigger-icon">•</span><span class="picker-chip-text">${text}</span>` +
    `<span class="picker-caret">v</span></button></div>`;
  const short = "Polyth";
  const long = "feature/a-rather-long-branch-name-for-testing-and-verifying-the-compact-context-bar";

  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 720 });
    const barWidth = Math.min(width - 16, 900);
    await page.setContent(`<style>${css}</style>
      <div class="session-context-bar" id="bar" style="width:${barWidth}px">
      ${chip("project", short)}<span class="context-sep"></span>${chip("branch", long)}
      </div>`);
    const oneLong = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>("#bar")!;
      const shortEl = document.querySelector<HTMLElement>(".context-selector-project")!;
      const longEl = document.querySelector<HTMLElement>(".context-selector-branch")!;
      return {
        bar: bar.getBoundingClientRect().width,
        scroll: bar.scrollWidth,
        short: shortEl.getBoundingClientRect().width,
        long: longEl.getBoundingClientRect().width,
        longRight: longEl.getBoundingClientRect().right,
        barRight: bar.getBoundingClientRect().right,
      };
    });
    assert.ok(oneLong.long > oneLong.short + 20, `${width}px: a long label must use more space than a short one`);
    assert.ok(
      oneLong.long > oneLong.bar / 2 + 5,
      `${width}px: a long label must not be capped at half the bar (${oneLong.long} vs ${oneLong.bar / 2})`,
    );
    assert.ok(oneLong.scroll <= oneLong.bar + 1, `${width}px: one-long pair fits the bar`);
    assert.ok(oneLong.longRight <= oneLong.barRight + 1, `${width}px: selectors stay inside the bar`);

    await page.setContent(`<style>${css}</style>
      <div class="session-context-bar" id="bar" style="width:${barWidth}px">
        ${chip("project", long)}<span class="context-sep"></span>${chip("branch", long)}
      </div>`);
    const twoLong = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>("#bar")!;
      const project = document.querySelector<HTMLElement>(".context-selector-project")!.getBoundingClientRect().width;
      const branch = document.querySelector<HTMLElement>(".context-selector-branch")!.getBoundingClientRect().width;
      return { bar: bar.getBoundingClientRect().width, scroll: bar.scrollWidth, project, branch };
    });
    assert.ok(twoLong.scroll <= twoLong.bar + 1, `${width}px: two long labels must not overflow`);
    assert.ok(twoLong.project >= 44 && twoLong.branch >= 44, `${width}px: both selectors keep a usable hit area`);
    assert.ok(twoLong.project < twoLong.bar * 0.75 && twoLong.branch < twoLong.bar * 0.75, `${width}px: neither collapses into a full-width field`);
  }

  await page.setViewportSize({ width: 390, height: 720 });
  await page.setContent(`<style>${css}</style>
    <div class="session-context-bar" id="bar" style="width:374px">
        ${chip("project", short)}<span class="context-sep"></span>${chip("branch", long)}
    </div>`);
  const phone = await page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>("#bar")!;
    return {
      scroll: bar.scrollWidth,
      bar: bar.getBoundingClientRect().width,
      project: document.querySelector<HTMLElement>(".context-selector-project")!.getBoundingClientRect().width,
      branch: document.querySelector<HTMLElement>(".context-selector-branch")!.getBoundingClientRect().width,
    };
  });
  assert.ok(phone.scroll <= phone.bar + 1, "phone context bar does not overflow");
  assert.ok(phone.branch > phone.project, "phone branch label uses more space than the short project label");
  await page.setViewportSize({ width: 390, height: 720 });
});

test("standalone isolation switch shares the context row without entering the worktree picker", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = `${await read("../src/styles.css")}\n${await read("../src/moduleContent.css")}`;
  const selector = (kind: string, text: string) =>
    `<div class="context-selector context-selector-${kind}"><button class="chip picker-chip">` +
    `<span class="picker-trigger-icon">•</span><span class="picker-chip-text">${text}</span>` +
    `<span class="picker-caret">v</span></button></div>`;
  const isolation = `<span class="context-isolation-control" data-active="true">` +
    `<span class="context-isolation-label">Isolate</span>` +
    `<button class="switch ui-switch" role="switch" aria-checked="true">` +
    `<span class="switch-track"><i></i></span></button></span>`;

  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 720 });
    const barWidth = Math.min(width - 16, 900);
    await page.setContent(`<style>${css}</style>
      <div class="session-context-bar" id="bar" style="width:${barWidth}px">
        ${selector("project", "Polyth")}${selector("branch", "feature/a-rather-long-branch-name")}${isolation}
      </div>`);
    const geometry: {
      bar: number; scroll: number; project: number; branch: number;
      control: number; controlRight: number; barRight: number;
      background: string; trackBackground: string;
    } = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>("#bar")!;
      const project = document.querySelector<HTMLElement>(".context-selector-project")!;
      const branch = document.querySelector<HTMLElement>(".context-selector-branch")!;
      const control = document.querySelector<HTMLElement>(".context-isolation-control")!;
      return {
        bar: bar.getBoundingClientRect().width,
        scroll: bar.scrollWidth,
        project: project.getBoundingClientRect().width,
        branch: branch.getBoundingClientRect().width,
        control: control.getBoundingClientRect().width,
        controlRight: control.getBoundingClientRect().right,
        barRight: bar.getBoundingClientRect().right,
        background: getComputedStyle(control).backgroundColor,
        trackBackground: getComputedStyle(control.querySelector<HTMLElement>(".switch-track")!).backgroundColor,
      };
    });
    assert.ok(geometry.scroll <= geometry.bar + 1, `${width}px: the context row does not overflow`);
    assert.ok(
      geometry.project >= 32 && geometry.branch >= 32,
      `${width}px: selectors remain operable (${JSON.stringify(geometry)})`,
    );
    assert.ok(geometry.control <= 96, `${width}px: isolation yields space to the location names`);
    assert.ok(geometry.controlRight <= geometry.barRight + 1, `${width}px: isolation stays beside the selectors`);
    assert.equal(geometry.background, "rgba(0, 0, 0, 0)", `${width}px: isolation does not add another heavy card`);
    assert.notEqual(geometry.trackBackground, "rgba(0, 0, 0, 0)", `${width}px: the switch still shows its active state`);
  }
  await page.setViewportSize({ width: 390, height: 720 });
});

test("multi-repository scope shares one context row and folds to a count on phones", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = `${await read("../src/styles.css")}\n${await read("../src/moduleContent.css")}`;
  const selector = (kind: string, text: string, extra = "") =>
    `<div class="context-selector context-selector-${kind}${extra}"><button class="chip picker-chip">` +
    `<span class="picker-trigger-icon">•</span><span class="picker-chip-text">${text}</span>` +
    `<span class="picker-caret">v</span></button></div>`;
  const repos = `<span class="context-repos-full">frontend-web, backend-api +2</span><span class="context-repos-short">3/5</span>`;
  const branch = `<span class="context-checkout-repo">frontend-web</span><span class="context-checkout-slash">/</span>feature/a-long-branch-name`;
  const isolation = `<span class="context-isolation-control"><span class="context-isolation-icon">•</span>` +
    `<span class="context-isolation-label">Isolate</span>` +
    `<button class="switch ui-switch" role="switch" aria-checked="false"><span class="switch-track"><i></i></span></button></span>`;

  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 720 });
    const barWidth = Math.min(width - 16, 900);
    await page.setContent(`<style>${css}</style>
      <div class="session-context-bar session-context-bar-repos" id="bar" style="width:${barWidth}px">
        ${selector("project", "Polyth")}${selector("repos", repos, " is-subset")}${selector("branch", branch)}${isolation}
      </div>`);
    const geometry: {
      bar: number; scroll: number; oneRow: boolean; project: number; repos: number; branch: number;
      fullRepos: boolean; shortRepos: boolean; checkoutRepo: boolean; isolationLabel: boolean;
    } = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      const visible = (selector: string) => getComputedStyle(document.querySelector<HTMLElement>(selector)!).display !== "none";
      const bar = document.querySelector<HTMLElement>("#bar")!;
      return {
        bar: rect("#bar").width,
        scroll: bar.scrollWidth,
        // One row: every visible control overlaps the others vertically.
        oneRow: (() => {
          const boxes = [...bar.children].map((child) => child.getBoundingClientRect()).filter((box) => box.width > 0);
          return Math.max(...boxes.map((box) => box.top)) < Math.min(...boxes.map((box) => box.bottom));
        })(),
        project: rect(".context-selector-project").width,
        repos: rect(".context-selector-repos").width,
        branch: rect(".context-selector-branch").width,
        fullRepos: visible(".context-repos-full"),
        shortRepos: visible(".context-repos-short"),
        checkoutRepo: visible(".context-checkout-repo"),
        isolationLabel: visible(".context-isolation-label"),
      };
    });
    const phone = width <= 480;
    assert.ok(geometry.scroll <= geometry.bar + 1, `${width}px: four location controls do not overflow (${JSON.stringify(geometry)})`);
    assert.ok(geometry.oneRow, `${width}px: the repository scope never wraps onto its own row`);
    assert.ok(geometry.project >= 32 && geometry.repos >= 32 && geometry.branch >= 32, `${width}px: every selector stays operable`);
    assert.equal(geometry.fullRepos, !phone, `${width}px: alias summary only where there is room`);
    assert.equal(geometry.shortRepos, phone, `${width}px: phones show the compact count`);
    assert.equal(geometry.checkoutRepo, !phone, `${width}px: the checkout's repository prefix yields on phones`);
    assert.equal(geometry.isolationLabel, !phone, `${width}px: the isolate caption yields to names on phones`);
    if (!phone) assert.ok(geometry.branch > geometry.repos, `${width}px: the branch keeps more room than the scope`);
  }
  await page.setViewportSize({ width: 390, height: 720 });
});

test("model picker keeps one height across sparse, dense, filtered, and empty harness catalogs", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = `${await read("../src/styles.css")}\n${await read("../../../packages/models/widgets/provider-logo-styles.css")}\n${await read("../../../packages/models/widgets/model-picker-styles.css")}`;
  const pop = (
    id: string,
    renderedRows: number,
    options: { empty?: boolean; header?: string; maxHeight?: number; query?: boolean } = {},
  ) => `
    <div class="ui-popover model-pop" id="${id}" style="width:360px${options.maxHeight ? `;max-height:${options.maxHeight}px` : ""}">
      <div class="model-picker-shell">
        <div class="model-picker-bar" id="${id}-bar">
          <div class="model-picker-header">${options.header ?? "<span>Harness header</span>"}</div>
        </div>
        <div class="model-pop-content search-end">
          <div class="model-pop-search"><input class="ui-input ui-input--sm model-pop-search-input" id="${id}-search" />${options.query ? `<button class="model-pop-search-clear">x</button>` : ""}</div>
          <div class="model-picker-list ui-scroll" id="${id}-list">
            ${options.empty
              ? `<div class="palette-empty">No models found</div>`
              : Array.from({ length: renderedRows }, (_, index) => `<div class="model-picker-row"><span class="model-picker-copy"><strong>Model ${index}</strong></span></div>`).join("")}
          </div>
        </div>
      </div>
    </div>`;
  const rect = (selector: string) => page!.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel)!;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height, client: el.clientHeight, scroll: el.scrollHeight };
  }, selector);

  await page.setViewportSize({ width: 1440, height: 720 });
  await page.setContent(`<style>${css}</style><div style="display:flex;gap:20px;align-items:flex-start">${pop("sparse", 2)}${pop("dense", 8)}</div>`);
  const sparsePop = await rect("#sparse");
  const densePop = await rect("#dense");
  const sparse = await rect("#sparse-list");
  const dense = await rect("#dense-list");
  assert.equal(sparsePop.height, densePop.height, "switching between sparse and dense harnesses keeps the surface height");
  assert.equal(sparse.height, dense.height, "catalog content changes only the list's overflow, not its geometry");
  const lastRow = await rect("#sparse-list .model-picker-row:last-child");
  assert.ok(lastRow.bottom <= sparse.bottom + 0.5, "both rows are fully visible when the viewport has room");
  const header = await rect("#sparse .model-picker-header");
  const field = await rect("#sparse-search");
  assert.ok(header.bottom <= sparse.top + 0.5, "the harness header does not overlap the list");
  assert.ok(field.top >= sparse.bottom - 0.5, "the search field sits below the list, nearest the composer trigger");
  assert.ok(field.bottom <= sparsePop.bottom + 0.5, "and inside the surface");

  // Harness controls and transition/error notices may make the header taller,
  // but the outer surface remains fixed and gives the list the remaining room.
  const statusHeader = `<div><div>Codex · Claude · OpenCode</div><p style="margin:8px 0">Switching runtime…</p><div role="alert">Runtime unavailable. Retry.</div></div>`;
  await page.setContent(`<style>${css}</style><div style="display:flex;gap:20px;align-items:flex-start">${pop("plain-header", 8)}${pop("status-header", 8, { header: statusHeader })}</div>`);
  const plainHeaderPop = await rect("#plain-header");
  const statusHeaderPop = await rect("#status-header");
  const plainHeaderList = await rect("#plain-header-list");
  const statusHeaderList = await rect("#status-header-list");
  const statusHeaderRect = await rect("#status-header .model-picker-header");
  const statusSearch = await rect("#status-header .model-picker-header");
  assert.equal(statusHeaderPop.height, plainHeaderPop.height, "transition and error headers do not resize the picker");
  assert.ok(statusHeaderList.height < plainHeaderList.height, "a taller harness header takes space from the scrolling list");
  assert.ok(statusHeaderRect.bottom <= statusHeaderList.top + 0.5 && statusSearch.height > 0, "multi-line harness status does not overlap the list");

  // Typing a query (which brings the clear button) and filtering rows out
  // must not move the search input, the harness header or resize the list.
  await page.setContent(`<style>${css}</style><div style="display:flex;gap:20px;align-items:flex-start">${pop("full", 8, { query: true })}${pop("filtered", 2, { query: true })}${pop("closed", 8)}</div>`);
  assert.equal((await rect("#full-list")).top, (await rect("#closed-list")).top, "a query does not jump the list");
  assert.equal((await rect("#full-search")).top, (await rect("#closed-search")).top, "the clear button does not move the field");
  assert.equal((await rect("#full .model-picker-header")).height, (await rect("#closed .model-picker-header")).height, "the harness header stays while searching");
  const fullSearch = await rect("#full-search");
  const filteredSearch = await rect("#filtered-search");
  const fullList = await rect("#full-list");
  const filteredList = await rect("#filtered-list");
  assert.equal(filteredSearch.top, fullSearch.top, "filtering must not jump the search field");
  assert.equal(filteredList.height, fullList.height, "the list keeps one height when a search filters rows");

  // Many runnable harnesses scroll sideways in one row instead of wrapping.
  const tabsCss = await read("../../../packages/harness-runtime/widgets/styles.css");
  const tabs = `<section class="pkg-harnesses pkg-harnesses-picker-tabs"><div class="pkg-harnesses-picker-tabs-head"><div class="ui-tabs pkg-harnesses-tablist" role="tablist" style="display:flex">${Array.from({ length: 9 }, (_, index) => `<button class="ui-tab" role="tab">H${index}</button>`).join("")}</div></div></section>`;
  await page.setContent(`<style>${css}\n${tabsCss}</style>${pop("many", 8, { header: tabs })}`);
  const tops = await page.evaluate(() => [...document.querySelectorAll("#many .ui-tab")].map((tab) => Math.round(tab.getBoundingClientRect().top)));
  assert.equal(new Set(tops).size, 1, `harness tabs stay on one row (${tops.join(",")})`);

  // An empty catalog keeps its message visible.
  await page.setContent(`<style>${css}</style>${pop("empty", 0, { empty: true })}`);
  const emptyList = await rect("#empty-list");
  const emptyMsg = await rect("#empty-list .palette-empty");
  assert.ok(emptyList.height >= emptyMsg.height, "the empty message is not clipped");
  assert.equal((await rect("#empty")).height, densePop.height, "an empty or loading harness keeps the same surface height");

  // Short viewport: the surface caps and the list scrolls rather than pushing chrome out.
  await page.setViewportSize({ width: 1440, height: 300 });
  await page.setContent(`<style>${css}</style>${pop("short", 8, { maxHeight: 180 })}`);
  const shortPop = await rect("#short");
  const shortList = await rect("#short-list");
  const shortHeader = await rect("#short .model-picker-header");
  const shortSearch = await rect("#short-bar");
  assert.ok(shortPop.height <= 181, `Popover's inline collision cap overrides the preferred picker height (${shortPop.height}px)`);
  assert.ok(shortList.scroll > shortList.client + 1, "the list owns overflow on a short viewport");
  assert.ok(shortHeader.bottom <= shortList.top + 0.5, "chrome still does not overlap on a short viewport");
  assert.ok(shortSearch.bottom <= shortList.top + 0.5, "the bar stays above the scrolling list");

  // Chromium's default page has a fine pointer even at a phone-sized
  // viewport. Use a touch context and emulate the actual coarse-pointer
  // media features so the phone geometry and its user-scaled radius are
  // exercised, not just parsed.
  assert.ok(browser);
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 720 }, hasTouch: true });
  const mobilePage = await mobileContext.newPage();
  const cdp = await mobileContext.newCDPSession(mobilePage);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "pointer", value: "coarse" },
      { name: "any-pointer", value: "coarse" },
      { name: "hover", value: "none" },
      { name: "any-hover", value: "none" },
    ],
  });
  try {
    await mobilePage.setContent(`<style>${css}</style><div style="display:flex;gap:20px;align-items:flex-start">${pop("mobile-sparse", 2)}${pop("mobile-dense", 8)}</div>`);
    const mobileGeometry = await mobilePage.evaluate(() => {
      const sparse = document.querySelector<HTMLElement>("#mobile-sparse")!;
      const dense = document.querySelector<HTMLElement>("#mobile-dense")!;
      const defaultRadius = getComputedStyle(sparse).borderRadius;
      document.documentElement.style.setProperty("--corner-radius-scale", "0.5");
      const scaledRadius = getComputedStyle(sparse).borderRadius;
      return {
        sparseHeight: sparse.getBoundingClientRect().height,
        denseHeight: dense.getBoundingClientRect().height,
        defaultRadius,
        scaledRadius,
      };
    });
    assert.ok(Math.abs(mobileGeometry.sparseHeight - 720 * 0.52) < 1,
      `phone picker uses the compact visual-viewport height (${mobileGeometry.sparseHeight}px)`);
    assert.equal(mobileGeometry.denseHeight, mobileGeometry.sparseHeight,
      "phone harness catalogs keep the same outer height");
    assert.equal(mobileGeometry.defaultRadius, "12px", "phone picker uses the surface radius token");
    assert.equal(mobileGeometry.scaledRadius, "6px", "phone picker follows the selected rounding scale");

    // Touch rows: one inline inset for strip, headings and rows; every row a
    // tap tall (with or without an effort menu); the star a full tap target;
    // the current row's check never shifts effort/star off their columns.
    const logo = `<span class="provider-logo provider-logo--md model-row-provider-logo"></span>`;
    const effort = `<span class="model-thinking-control"><button class="model-thinking-trigger"><span>Auto</span><svg></svg></button></span>`;
    const star = `<button class="ui-icon-btn ui-icon-btn--ghost ui-icon-btn--sm model-star-btn"><svg></svg></button>`;
    const touchRow = (id: string, extra: string, current = false) => `<div class="model-picker-row${current ? " current" : ""}" id="${id}"><span class="model-picker-grip spacer"></span>${logo}<span class="model-picker-copy"><strong>Model</strong></span>${extra}${current ? `<span class="model-row-selected"><svg></svg></span>` : ""}</div>`;
    await mobilePage.setContent(`<style>${css}</style>
      <div class="ui-popover model-pop" id="touch" style="width:360px">
        <div class="model-picker-shell">
          <div class="model-picker-bar"><div class="model-picker-header"><div class="pkg-harnesses-tablist" id="touch-strip" role="tablist">tabs</div></div></div>
          <div class="model-pop-content">
            <div class="model-picker-list ui-scroll">
              ${touchRow("touch-current", `${effort}${star}`, true)}
              ${touchRow("touch-plain", `${effort}${star}`)}
              ${touchRow("touch-bare", star)}
              <section class="model-provider-section"><button class="model-provider-head" id="touch-head"><span class="model-provider-grip">⠿</span><span class="provider-logo model-provider-logo"></span><strong>Provider</strong><small>3</small></button></section>
            </div>
          </div>
        </div>
      </div>`);
    const touch = await mobilePage.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return {
        strip: box("#touch-strip").left,
        rowLeft: box("#touch-plain").left,
        heights: ["#touch-current", "#touch-plain", "#touch-bare", "#touch-head"].map((selector) => box(selector).height),
        star: box("#touch-plain .model-star-btn"),
        currentStar: box("#touch-current .model-star-btn").left,
        bareStar: box("#touch-bare .model-star-btn").left,
        currentEffort: box("#touch-current .model-thinking-trigger").right,
        plainEffort: box("#touch-plain .model-thinking-trigger").right,
        rowLogo: box("#touch-plain .model-row-provider-logo").left,
        headLogo: box("#touch-head .model-provider-logo").left,
        grip: getComputedStyle(document.querySelector("#touch-head .model-provider-grip")!).display,
      };
    });
    assert.equal(touch.strip, touch.rowLeft, "the harness strip and the rows share one inline inset");
    for (const height of touch.heights) assert.ok(height >= 44, `touch rows and headings are a tap tall (${touch.heights.join(",")})`);
    assert.ok(touch.star.width >= 44 && touch.star.height >= 44, "the favourite star is a full tap target");
    assert.equal(touch.currentStar, touch.star.left, "the current row's check does not shift its star");
    assert.equal(touch.bareStar, touch.star.left, "a row without an effort menu keeps the star column");
    assert.equal(touch.currentEffort, touch.plainEffort, "effort menus end on one column");
    assert.equal(touch.headLogo, touch.rowLogo, "provider headings align with their rows");
    assert.equal(touch.grip, "none", "touch has no drag grip");
  } finally {
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    await mobileContext.close();
  }
  await page.setViewportSize({ width: 390, height: 720 });
});

test("switch hover keeps the 44px outer target transparent and the track cue intact", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = `${await read("../src/styles.css")}\n${await read("../src/moduleContent.css")}`;
  await page.setViewportSize({ width: 390, height: 720 });
  await page.setContent(`<style>${css}</style>
    <div class="module-view--phone">
      <button class="switch ui-switch" id="off" role="switch" aria-checked="false"><span class="switch-track"><i></i></span></button>
      <button class="switch ui-switch" id="on" role="switch" aria-checked="true"><span class="switch-track"><i></i></span></button>
      <button class="switch ui-switch" id="dis" role="switch" aria-checked="false" disabled><span class="switch-track"><i></i></span></button>
    </div>`);
  const readSwitch = (selector: string) => page!.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel)!;
    const after = getComputedStyle(el, "::after");
    const track = getComputedStyle(el.querySelector(".switch-track")!);
    const knob = getComputedStyle(el.querySelector("i")!);
    return {
      outerBg: getComputedStyle(el).backgroundColor,
      hitWidth: parseFloat(after.width),
      hitHeight: parseFloat(after.height),
      trackW: track.width,
      trackH: track.height,
      trackBg: track.backgroundColor,
      trackBorder: track.borderTopColor,
      knobTransform: knob.transform,
    };
  }, selector);

  const offBefore = await readSwitch("#off");
  const onBefore = await readSwitch("#on");
  await page.hover("#off");
  const offHover = await readSwitch("#off");
  assert.equal(offHover.outerBg, "rgba(0, 0, 0, 0)", "hover must not repaint the outer hit box");
  assert.ok(offHover.hitHeight >= 44, `the coarse hit box stays 44px tall on hover (${offHover.hitHeight}px)`);
  assert.ok(offHover.hitWidth >= 38, `the hit box is at least the 38px track (${offHover.hitWidth}px)`);
  assert.equal(offHover.trackW, "38px", "the track never grows for touch");
  assert.equal(offHover.trackH, "22px", "the track never grows for touch");

  await page.hover("#on");
  const onHover = await readSwitch("#on");
  assert.equal(onHover.outerBg, "rgba(0, 0, 0, 0)", "checked hover keeps the outer hit box transparent");
  assert.equal(onHover.trackW, "38px");
  assert.equal(onHover.trackH, "22px");
  assert.notEqual(onHover.trackBg, "rgba(0, 0, 0, 0)", "the checked accent fill persists on hover");
  assert.equal(onHover.trackBg, onBefore.trackBg, "hover does not replace the checked fill");
  assert.equal(onHover.knobTransform, onBefore.knobTransform, "hover does not move the checked knob");
  assert.equal(offBefore.trackBg, offHover.trackBg, "the unchecked track keeps its base fill; only the border cue changes");
  assert.notEqual(offHover.trackBorder, offBefore.trackBorder, "hover adds a visible track-border cue");
  assert.equal(onHover.trackBorder, onBefore.trackBorder, "the checked track keeps its accent border on hover");

  const disBefore = await readSwitch("#dis");
  await page.hover("#dis");
  const disHover = await readSwitch("#dis");
  assert.equal(disHover.outerBg, "rgba(0, 0, 0, 0)", "a disabled switch hover stays transparent");
  assert.equal(disHover.trackBorder, disBefore.trackBorder, "a disabled switch does not get the hover cue");
  assert.equal(disHover.trackBg, disBefore.trackBg, "a disabled switch keeps its base fill");
  await page.setViewportSize({ width: 390, height: 720 });
});

test("compact contextual panel sheet spans the viewport instead of collapsing to the rail strip", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = `${await read("../src/styles.css")}\n${await read("../src/moduleContent.css")}`;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`<style>${css}</style>
    <div class="app"><div class="app-shell">
      <div class="railbar railbar-open">
        <div class="panel-sheet" id="sheet" role="dialog" aria-modal="true" aria-label="Context">
          <div class="rail-head" style="min-height:56px">Context</div>
          <div class="rail-body"><button id="sheet-close" aria-label="Close panel">×</button>Body</div>
        </div>
      </div>
    </div></div>`);
  const g = await page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>("#sheet")!;
    const close = document.querySelector<HTMLElement>("#sheet-close")!;
    const sr = sheet.getBoundingClientRect();
    const cr = close.getBoundingClientRect();
    return { x: sr.x, width: sr.width, right: sr.right, closeX: cr.x, closeRight: cr.right, vw: window.innerWidth };
  });
  assert.ok(g.width >= 360, `the compact sheet must span the viewport, got width ${g.width}`);
  assert.ok(g.x >= -1 && g.right <= g.vw + 1, `the sheet must sit inside the viewport (x=${g.x}, right=${g.right}, vw=${g.vw})`);
  assert.ok(g.closeX >= -1 && g.closeRight <= g.vw + 1, `a sheet control must be reachable (x=${g.closeX}, right=${g.closeRight})`);
  await page.setViewportSize({ width: 390, height: 720 });
});

interface MeasuredBox {
  x: number; y: number; width: number; height: number;
  display: string; borderBottom: number; borderRadius: number; flexDirection: string;
}

test("package and plugin management rows measure as one aligned list", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = `${await read("../src/styles.css")}\n${await read("../../../packages/plugins/widgets/styles.css")}`;
  const switchControl = (id: string, on: boolean) =>
    `<button class="switch ui-switch" role="switch" id="${id}" aria-checked="${on}"><span class="switch-track"><i></i></span></button>`;
  const fixture = (width: number) => `
    <style>${css}</style>
    <div class="settings-pane-body" style="width:${width}px">
      <div class="packages-page">
        <div class="settings-list" role="list" id="list">
          <div class="settings-list-row is-actionable" role="listitem" id="row-1">
            <button type="button" class="settings-list-hit" aria-label="Open Alpha settings"></button>
            <span class="settings-list-tile" id="tile-1">A</span>
            <div class="settings-list-title" id="title-1"><strong>Alpha</strong></div>
            <p class="settings-list-desc" id="desc-1">First package description that is long enough to wrap on a phone-width settings pane.</p>
            <div class="settings-list-trailing" id="trail-1"><button class="ui-icon-btn ui-icon-btn--ghost ui-icon-btn--sm">?</button>${switchControl("switch-1", true)}</div>
            <span class="settings-list-chevron" id="chev-1"><svg width="16" height="16"></svg></span>
          </div>
          <div class="settings-list-row" role="listitem" id="row-2">
            <span class="settings-list-tile">B</span>
            <div class="settings-list-title"><strong>Beta</strong></div>
            <p class="settings-list-desc">Second package description.</p>
            <div class="settings-list-trailing">${switchControl("switch-2", false)}</div>
            <span class="settings-list-chevron"></span>
          </div>
        </div>
      </div>
    </div>`;

  for (const width of [720, 360]) {
    await page.setViewportSize({ width: width + 40, height: 900 });
    await page.setContent(fixture(width));
    const m = JSON.parse(await page.evaluate(() => {
      const box = (selector: string) => {
        const el = document.querySelector<HTMLElement>(selector)!;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return { x: r.x, y: r.y, width: r.width, height: r.height, borderTop: parseFloat(s.borderTopWidth) };
      };
      return JSON.stringify({
        list: box("#list"), row1: box("#row-1"), row2: box("#row-2"),
        tile: box("#tile-1"), title: box("#title-1"), desc: box("#desc-1"), trail: box("#trail-1"),
        switch1: box("#switch-1"), switch2: box("#switch-2"), hit: box("#row-1 .settings-list-hit"),
      });
    })) as Record<string, { x: number; y: number; width: number; height: number; borderTop: number }>;
    const right = (key: string) => m[key]!.x + m[key]!.width;
    const middle = (key: string) => m[key]!.y + m[key]!.height / 2;

    assert.ok(m.row2!.y >= m.row1!.y + m.row1!.height - 0.5, `${width}px: rows stack vertically`);
    assert.ok(Math.abs(m.row1!.width - (m.list!.width - 2)) <= 1, `${width}px: a row spans its list`);
    assert.ok(Math.abs(m.tile!.width - 36) <= 1 && Math.abs(m.tile!.height - 36) <= 1, `${width}px: the mark sits on a 36px tile`);
    assert.equal(m.row1!.borderTop, 0, `${width}px: the first row hangs no divider`);
    assert.equal(m.row2!.borderTop, 1, `${width}px: following rows keep a 1px separator`);
    // A reserved chevron column keeps every switch in one column, whether or
    // not its row opens something.
    assert.ok(Math.abs(right("switch1") - right("switch2")) <= 0.5, `${width}px: switches share one column`);
    assert.ok(Math.abs(m.hit!.width - m.row1!.width) <= 1 && Math.abs(m.hit!.height - m.row1!.height) <= 1,
      `${width}px: an opening row is one full-size target`);
    if (width > 520) {
      // Wide: the controls centre on the text block; the description keeps
      // to its own column instead of running under them.
      assert.ok(Math.abs(middle("trail") - middle("row1")) <= 2, `${width}px: controls centre on the row`);
      assert.ok(right("desc") <= m.trail!.x + 0.5, `${width}px: the description stays beside the controls`);
    } else {
      // Narrow: the controls share the title line and the description runs
      // under them, so a long description does not squeeze into a sliver.
      assert.ok(Math.abs(middle("trail") - middle("title")) <= 2, `${width}px: controls sit on the title line`);
      assert.ok(m.desc!.y >= m.title!.y + m.title!.height - 0.5, `${width}px: the description starts under the title`);
      assert.ok(right("desc") > m.trail!.x + 1, `${width}px: the description runs under the controls`);
    }
  }
  await page.setViewportSize({ width: 390, height: 720 });
});

test("activity is a bare thread in every glass mode, and an open summary pins without a slab", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = await read("../src/styles.css");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 900, height: 720 });
  await page.setContent(`<style>${css}</style>
    <div class="app" style="min-height:100vh;padding:32px;background:
      repeating-linear-gradient(135deg, #3a2a1c 0 18px, #1a4a5c 18px 36px, #4a1a3c 36px 54px)">
      <div class="timeline" style="width:640px">
        <div class="activity-group">
          <button type="button" class="ui-run-summary" data-state="completed">
            <span class="ui-run-summary-mark">●</span>
            <span class="ui-run-summary-copy"><strong>Read styles.css</strong></span>
          </button>
        </div>
        <div class="activity-group open">
          <button type="button" class="ui-run-summary" data-state="completed">
            <span class="ui-run-summary-mark">●</span>
            <span class="ui-run-summary-copy"><strong>Activity</strong></span>
          </button>
          <div class="activity-group-expand-shell">
            <div class="activity-group-items"><div class="execution-row">Read styles.css</div></div>
          </div>
        </div>
      </div>
    </div>`);
  const probe = () => page!.evaluate(() => {
    const surface = (element: Element, pseudo?: string) => {
      const style = getComputedStyle(element, pseudo);
      return {
        content: style.content,
        bg: `${style.backgroundColor} ${style.backgroundImage}`,
        shadow: style.boxShadow,
        border: style.borderTopStyle,
        filter: style.backdropFilter || (style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter || "none",
      };
    };
    const folded = document.querySelector<HTMLElement>(".activity-group:not(.open)")!;
    const open = document.querySelector<HTMLElement>(".activity-group.open")!;
    const header = open.querySelector<HTMLElement>(".ui-run-summary")!;
    return {
      folded: surface(folded),
      foldedPlate: surface(folded, "::before"),
      open: surface(open),
      header: surface(header),
      headerPosition: getComputedStyle(header).position,
      headerZ: getComputedStyle(header).zIndex,
      headerGlassOpacity: getComputedStyle(header, "::before").opacity,
      thread: getComputedStyle(open.querySelector(".activity-group-items")!, "::before").backgroundColor,
      copyWidth: folded.querySelector<HTMLElement>(".ui-run-summary-copy strong")!.getBoundingClientRect().width,
    };
  });
  const bare = (s: { bg: string; shadow: string; filter: string }, label: string) => {
    assert.equal(s.bg, "rgba(0, 0, 0, 0) none", `${label}: no fill`);
    assert.equal(s.shadow, "none", `${label}: no shadow`);
    assert.match(s.filter, /none/, `${label}: no glass blur`);
  };
  for (const glass of [undefined, "clear", "off"]) {
    await page.evaluate((mode) => {
      if (mode) document.body.dataset.glass = mode;
      else delete document.body.dataset.glass;
    }, glass);
    const state = await probe();
    const mode = glass ?? "default";
    bare(state.folded, `${mode} folded block`);
    bare(state.open, `${mode} open block`);
    bare(state.header, `${mode} open summary`);
    assert.equal(state.foldedPlate.content, "none", `${mode}: no plate pseudo-element`);
    assert.equal(state.folded.border, "none", `${mode}: no outline`);
    assert.notEqual(state.thread, "rgba(0, 0, 0, 0)", `${mode}: the steps hang from a visible thread`);
    assert.equal(state.headerPosition, "sticky", "the open summary stays reachable while its steps scroll");
    assert.equal(state.headerZ, "2", "pinned summary stays above scrolling steps");
    assert.equal(state.headerGlassOpacity, "0", "an unpinned summary shows no glass");
    assert.ok(state.copyWidth > 40);
  }
  await page.evaluate(() => { document.body.dataset.hideBorders = "true"; });
  const borderless = await probe();
  assert.notEqual(borderless.thread, "rgba(0, 0, 0, 0)", "the thread survives Borderless appearance");
  await page.evaluate(() => { delete document.body.dataset.hideBorders; delete document.body.dataset.glass; });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 720 });
});
