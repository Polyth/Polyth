import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Browser, Page } from "playwright-core";
import { findChromiumExecutable } from "@polyth/browser/chromium";

const read = async (relative: string): Promise<string> => {
  const content = await readFile(new URL(relative, import.meta.url), "utf8");
  if (relative !== "../src/styles.css") return content;
  const tokens = await readFile(new URL("../src/tokens.css", import.meta.url), "utf8");
  return `${tokens}\n${content}`;
};
const CHROME = await findChromiumExecutable();

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
                      <span class="ft-name">AGENTS.md</span><span class="file-row-actions"><button>Actions</button></span>
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
    const rowAction = document.querySelector<HTMLElement>(".file-row-actions")!;
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
      rowActionOpacity: getComputedStyle(rowAction).opacity,
      rowActionPointerEvents: getComputedStyle(rowAction).pointerEvents,
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
    assert.equal(wide.rowHeight, 32, `${order}: file rows use the compact control rhythm`);
    assert.equal(wide.tabHeight, 32, `${order}: file tabs use the compact control rhythm`);
    assert.equal(wide.toolbarHeight, 32, `${order}: editor toolbar uses the compact control rhythm`);
    assert.equal(wide.rowFontFamily, wide.tabFontFamily, `${order}: file names share one technical typeface`);
    assert.equal(wide.rowFontSize, wide.tabFontSize, `${order}: file names share one technical type size`);
    assert.equal(wide.rowActionOpacity, "0", `${order}: desktop row actions stay contextual`);
    assert.equal(wide.rowActionPointerEvents, "none", `${order}: hidden row actions do not intercept clicks`);
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

test("context selectors give a long label room and shrink instead of overflowing", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = `${await read("../src/styles.css")}\n${await read("../src/moduleContent.css")}`;
  const chip = (id: string, text: string) =>
    `<div class="context-selector context-selector-${id}"><button class="chip picker-chip">` +
    `<span class="picker-trigger-icon">•</span><span class="picker-chip-text">${text}</span>` +
    `<span class="picker-caret">v</span></button></div>`;
  const phoneSelector = (id: string, text: string) =>
    `<div class="context-selector context-selector-${id}"><button class="context-trigger">` +
    `<span class="context-trigger-icon">•</span><span class="context-trigger-name">${text}</span>` +
    `<span class="context-trigger-caret">v</span></button></div>`;
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
      ${phoneSelector("project", short)}<span class="context-sep"></span>${phoneSelector("branch", long)}
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

test("compact model catalog sizes the list to unfiltered rows with the full chrome", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = `${await read("../src/styles.css")}\n${await read("../../../packages/models/widgets/styles.css")}`;
  const pop = (id: string, rows: number, renderedRows: number, empty = false) => `
    <div class="model-pop model-pop--compact${empty ? " model-pop--empty" : ""}" id="${id}" style="width:360px">
      <div class="model-picker-shell" style="--model-pop-rows:${rows}">
        <div class="model-picker-header"><span>Harness header</span></div>
        <div class="model-pop-content">
          <div class="model-pop-search"><input class="ui-input" id="${id}-search" /></div>
          <div class="model-picker-list ui-scroll" id="${id}-list">
            ${empty
              ? `<div class="palette-empty">No models found</div>`
              : Array.from({ length: renderedRows }, (_, index) => `<div class="model-picker-row"><span class="model-picker-copy"><strong>Model ${index}</strong></span></div>`).join("")}
          </div>
          <footer class="model-picker-shortcuts"><span>Enter</span></footer>
        </div>
      </div>
    </div>`;
  const rect = (selector: string) => page!.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel)!;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height, client: el.clientHeight, scroll: el.scrollHeight };
  }, selector);

  await page.setViewportSize({ width: 1440, height: 720 });
  await page.setContent(`<style>${css}</style><div style="display:flex;gap:20px;align-items:flex-start">${pop("sparse", 2, 2)}${pop("dense", 8, 8)}</div>`);
  const sparse = await rect("#sparse-list");
  const dense = await rect("#dense-list");
  assert.ok(sparse.height < dense.height, `sparse list shorter than dense (${sparse.height} < ${dense.height})`);
  assert.ok(sparse.height < 200, `a 1-2 model list must not reserve a full-height menu (${sparse.height}px)`);
  const lastRow = await rect("#sparse-list .model-picker-row:last-child");
  assert.ok(lastRow.bottom <= sparse.bottom + 0.5, "both rows are fully visible when the viewport has room");
  const header = await rect("#sparse .model-picker-header");
  const search = await rect("#sparse-search");
  const shortcuts = await rect("#sparse .model-picker-shortcuts");
  assert.ok(header.bottom <= search.top + 0.5, "the harness header does not overlap the search field");
  assert.ok(search.bottom <= sparse.top + 0.5, "the search field does not overlap the list");
  assert.ok(sparse.bottom <= shortcuts.top + 0.5, "shortcuts stay below the list");

  // Filtering rows out must not move the search input or resize the list.
  await page.setContent(`<style>${css}</style><div style="display:flex;gap:20px;align-items:flex-start">${pop("full", 8, 8)}${pop("filtered", 8, 2)}</div>`);
  const fullSearch = await rect("#full-search");
  const filteredSearch = await rect("#filtered-search");
  const fullList = await rect("#full-list");
  const filteredList = await rect("#filtered-list");
  assert.equal(filteredSearch.top, fullSearch.top, "filtering must not jump the search field");
  assert.equal(filteredList.height, fullList.height, "the list keeps one height when a search filters rows");

  // An empty catalog keeps its message visible.
  await page.setContent(`<style>${css}</style>${pop("empty", 2, 2, true)}`);
  const emptyList = await rect("#empty-list");
  const emptyMsg = await rect("#empty-list .palette-empty");
  assert.ok(emptyList.height >= emptyMsg.height, "the empty message is not clipped");
  assert.ok(emptyList.height >= 44, "empty compact catalogs keep a usable floor");

  // Short viewport: the surface caps and the list scrolls rather than pushing chrome out.
  await page.setViewportSize({ width: 1440, height: 300 });
  await page.setContent(`<style>${css}</style>${pop("short", 8, 8)}`);
  const shortPop = await rect("#short");
  const shortList = await rect("#short-list");
  const shortHeader = await rect("#short .model-picker-header");
  const shortSearch = await rect("#short-search");
  const shortShortcuts = await rect("#short .model-picker-shortcuts");
  assert.ok(shortPop.height <= 300 * 0.72 + 1, `compact surface caps at 72vh (${shortPop.height}px)`);
  assert.ok(shortList.scroll > shortList.client + 1, "the list owns overflow on a short viewport");
  assert.ok(shortHeader.bottom <= shortSearch.top + 0.5, "chrome still does not overlap on a short viewport");
  assert.ok(shortSearch.bottom <= shortList.top + 0.5, "search stays above the scrolling list");
  assert.ok(shortList.bottom <= shortShortcuts.top + 0.5, "shortcuts remain reachable below the list");
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
  display: string; borderBottom: number; flexDirection: string;
}

test("package and plugin management rows measure as compact stacked rows", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = `${await read("../src/styles.css")}\n${await read("../../../packages/plugins/widgets/styles.css")}`;
  const fixture = (width: number) => `
    <style>${css}</style>
    <div class="settings-pane-body" style="width:${width}px">
      <div class="packages-list">
        <section class="package-group">
          <div class="package-group-head"><strong>Optional</strong></div>
          <div class="package-grid" id="pkg-grid">
            <article class="package-tile enabled" id="tile-1">
              <span class="package-icon">A</span>
              <div class="package-copy"><strong>Alpha</strong><p>First package description.</p></div>
              <div class="package-tile-control"><button class="ui-btn ui-btn--ghost ui-btn--sm">Tour</button><button class="switch ui-switch" role="switch" aria-checked="true"><span class="switch-track"><i></i></span></button></div>
            </article>
            <article class="package-tile disabled" id="tile-2">
              <span class="package-icon">B</span>
              <div class="package-copy"><strong>Beta</strong><p>Second package description.</p></div>
              <div class="package-tile-control"><button class="ui-btn ui-btn--ghost ui-btn--sm">Tour</button><button class="switch ui-switch" role="switch" aria-checked="false"><span class="switch-track"><i></i></span></button></div>
            </article>
          </div>
        </section>
      </div>
    </div>
    <div class="pkg-plugins" style="width:${width}px">
      <div class="plugin-card-grid" id="plugin-grid">
        <article class="plugin-card disabled" id="plugin-1"><button class="plugin-card-main"><span class="plugin-card-icon">P</span><span class="plugin-card-copy">Plugin one</span></button></article>
        <article class="plugin-card disabled" id="plugin-2"><button class="plugin-card-main"><span class="plugin-card-icon">Q</span><span class="plugin-card-copy">Plugin two</span></button></article>
      </div>
    </div>`;

  for (const width of [720, 360]) {
    await page.setViewportSize({ width: width + 40, height: 900 });
    await page.setContent(fixture(width));
    const m = JSON.parse(await page.evaluate(() => {
      const box = (selector: string): MeasuredBox => {
        const el = document.querySelector<HTMLElement>(selector)!;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return {
          x: r.x, y: r.y, width: r.width, height: r.height,
          display: s.display,
          borderBottom: parseFloat(s.borderBottomWidth),
          flexDirection: s.flexDirection,
        };
      };
      return JSON.stringify({
        grid: box("#pkg-grid"),
        gridColumns: getComputedStyle(document.querySelector<HTMLElement>("#pkg-grid")!).gridTemplateColumns,
        tile1: box("#tile-1"),
        tile2: box("#tile-2"),
        copy: box("#tile-1 .package-copy"),
        control: box("#tile-1 .package-tile-control"),
        icon: box("#tile-1 .package-icon"),
        pluginGrid: box("#plugin-grid"),
        plugin1: box("#plugin-1"),
        plugin2: box("#plugin-2"),
        pluginMain: box("#plugin-1 .plugin-card-main"),
      });
    })) as {
      grid: MeasuredBox; gridColumns: string; tile1: MeasuredBox; tile2: MeasuredBox;
      copy: MeasuredBox; control: MeasuredBox; icon: MeasuredBox;
      pluginGrid: MeasuredBox; plugin1: MeasuredBox; plugin2: MeasuredBox; pluginMain: MeasuredBox;
    };

    assert.equal(m.gridColumns.trim().split(/\s+/).length, 1, `${width}px: packages are a single column, not a card grid`);
    assert.ok(m.tile2.y >= m.tile1.y + m.tile1.height - 0.5, `${width}px: package rows stack vertically`);
    assert.ok(Math.abs(m.tile1.width - m.grid.width) <= 1, `${width}px: a package row spans its list width`);
    assert.ok(Math.abs(m.icon.width - 32) <= 1 && Math.abs(m.icon.height - 32) <= 1, `${width}px: package icon is control-sized, not oversized`);
    assert.equal(m.tile1.borderBottom, 1, `${width}px: rows keep a 1px separator`);
    assert.equal(m.tile2.borderBottom, 0, `${width}px: the last row must not hang a divider`);

    if (width <= 480) {
      assert.ok(m.control.y >= m.copy.y + 8, `${width}px: controls move below the description on a phone-width pane`);
    } else {
      assert.ok(m.control.y <= m.copy.y + 8, `${width}px: controls stay on the row at wide widths`);
    }

    assert.equal(m.pluginGrid.flexDirection, "column", `${width}px: plugins render as a vertical list`);
    assert.ok(m.plugin2.y >= m.plugin1.y + m.plugin1.height - 0.5, `${width}px: plugin rows stack vertically`);
    assert.equal(m.plugin1.borderBottom, 1, `${width}px: plugin rows retain a separator`);
    assert.equal(m.pluginMain.display, "grid", `${width}px: plugin rows use the shared row grid`);
    assert.ok(Math.abs(m.plugin1.width - m.pluginGrid.width) <= 1, `${width}px: a plugin row spans its list width`);
  }
  await page.setViewportSize({ width: 390, height: 720 });
});
