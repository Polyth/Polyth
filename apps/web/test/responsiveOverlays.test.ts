import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Browser, Page } from "playwright-core";

const read = async (relative: string): Promise<string> => {
  const content = await readFile(new URL(relative, import.meta.url), "utf8");
  if (relative !== "../src/styles.css") return content;
  const tokens = await readFile(new URL("../src/tokens.css", import.meta.url), "utf8");
  return `${tokens}\n${content}`;
};
const CHROME = [
  process.env.POLYTH_CHROMIUM_PATH,
  "/usr/local/bin/google-chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

let browser: Browser | null = null;
let page: Page | null = null;

before(async () => {
  if (!CHROME) return;
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage({ viewport: { width: 390, height: 720 } });
  await page.emulateMedia({ reducedMotion: "reduce" });
});

after(async () => {
  await browser?.close();
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
  assert.match(dialog, /\[\.\.\.parent\.children\]\.filter\(\(element\) => element !== root\)/);
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
  const profile = await read("../src/components/AgentProfileForm.tsx");
  const widgetLibrary = await read("../src/components/settings/WidgetLibraryOverlay.tsx");

  assert.match(project, /variant="primary"[\s\S]*className="folder-open-btn"[\s\S]*onClick=\{\(\) => void openProject\(\)\}/);
  assert.match(project, /slot="project\.create\.options"/);
  assert.match(worktree, /onClick=\{\(\) => void submit\(\)\}/);
  assert.match(profile, /onClick=\{\(\) => void save\(true\)\}/);
  assert.match(widgetLibrary, /onClick=\{\(\) => onAdd\(widget\)\}/);
  assert.match(widgetLibrary, /onChange=\{setPluginId\}/);
});

test("390px dialogs use an internally scrolling bottom sheet", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = await read("../src/styles.css");
  const fields = Array.from({ length: 24 }, (_, index) =>
    `<label>Field ${index}<input value="value ${index}"></label>`).join("");
  await page.setContent(`
    <style>${css}</style>
    <div class="dialog-backdrop">
      <section class="dialog-panel dialog-md profile-form">
        <header class="dialog-head"><h2>Configuration</h2><button>Close</button></header>
        <main class="profile-form-body">${fields}</main>
        <footer class="dialog-foot"><button>Cancel</button><button class="primary-btn">Save</button></footer>
      </section>
    </div>
  `);

  const geometry = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".dialog-panel")!;
    const body = document.querySelector<HTMLElement>(".profile-form-body")!;
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
      :root { --ui-font-size: 20px; --font-ui: 20px; }
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
      <section class="project-settings-card split-pane">
        <header>
          <div class="set-row-text">
            <div class="set-row-label">polyth</div>
            <div class="set-row-hint mono">/Users/demo/polyth</div>
          </div>
        </header>
        <div class="project-settings-options" data-settings-item="projects.canvas">
          <div>
            <strong>Canvas setup</strong>
            <span>Customize visible widgets and layout for this project.</span>
          </div>
          <button class="ui-btn ui-btn--sm">Widgets &amp; Layout</button>
        </div>
      </section>
    </main>
  `);

  const geometry = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".split-pane")!;
    const row = pane.querySelector<HTMLElement>(".project-settings-options")!;
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
  assert.equal(geometry.overlap, false, "label does not collide with the canvas button");
  assert.ok(geometry.buttonHeight >= 32, "canvas button remains a usable compact control");
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

test("Usage dashboard responds to a docked panel instead of the viewport", { skip: !CHROME }, async () => {
  assert.ok(page);
  const [coreCss, usageCss] = await Promise.all([
    read("../src/styles.css"),
    read("../../../packages/usage/widgets/styles.css"),
  ]);

  for (const width of [280, 344]) {
    await page.setContent(`
      <style>${coreCss}\n${usageCss}</style>
      <main class="usage-dashboard" style="width:${width}px">
        <div class="usage-dashboard-toolbar">
          <div class="usage-view-tabs"><button>Overview</button><button>Providers</button></div>
          <span class="usage-toolbar-spacer"></span>
          <div class="usage-range-control"><button>7d</button><button>30d</button><button>90d</button></div>
          <div class="usage-layout-control"><button>Grid</button></div>
          <button class="usage-refresh-button">R</button>
        </div>
      </main>
    `);

    const layout: {
      clientWidth: number;
      scrollWidth: number;
      toolbarScrollWidth: number;
      toolbarClientWidth: number;
    } = await page.evaluate(() => {
      const dashboard = document.querySelector<HTMLElement>(".usage-dashboard")!;
      const toolbar = document.querySelector<HTMLElement>(".usage-dashboard-toolbar")!;
      return {
        clientWidth: dashboard.clientWidth,
        scrollWidth: dashboard.scrollWidth,
        toolbarScrollWidth: toolbar.scrollWidth,
        toolbarClientWidth: toolbar.clientWidth,
      };
    });

    assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `${width}px dashboard has no horizontal overflow`);
    assert.ok(layout.toolbarScrollWidth <= layout.toolbarClientWidth + 1, `${width}px toolbar has no horizontal overflow`);
  }
});

test("390px package windows cover Chat, clear the shell menu, and preserve the app background", { skip: !CHROME }, async () => {
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
  assert.equal(geometry.mainHeadTop, 60, "main title row starts below the shell menu");
  assert.equal(geometry.railHeadTop, 60, "rail title row starts below the shell menu");
  assert.match(geometry.mainBackground, /linear-gradient/);
  assert.match(geometry.railBackground, /linear-gradient/);
  assert.equal(geometry.mainZ, "101", "main package covers the composer");
  assert.equal(geometry.railZ, "101", "rail package covers the composer");
  assert.equal(geometry.floatZ, "102", "the mobile menu remains above package windows");
  assert.equal(geometry.composerZ, "100", "the chat composer remains below package windows");
});
