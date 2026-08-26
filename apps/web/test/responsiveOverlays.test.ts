import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Browser, Page } from "playwright-core";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");
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
  const projectSetup = await read("../src/components/ProjectSetup.tsx");
  const packageTour = await read("../src/components/PackageTourOverlay.tsx");
  const css = await read("../src/styles.css");

  assert.match(dialog, /export function useModalScrollLock/);
  assert.match(dialog, /documentElement\.dataset\.modalSurface = "open"/);
  assert.match(dialog, /useModalScrollLock\(enabled && open\)/);
  assert.match(dialog, /onPointerDown=\{\(e\) => \{ if \(e\.target === e\.currentTarget\) onClose\(\); \}\}/);
  assert.match(settings, /useModalScrollLock\(true\)/);
  assert.match(settings, /className="settings-mobile-nav-head"/);
  assert.match(settings, /className="settings-mobile-title"/);
  assert.match(settings, /className="close-btn" onClick=\{onClose\}/);
  assert.match(palette, /className="scrim palette-overlay" onPointerDown=/);
  assert.match(projectSetup, /className="project-setup-scrim" onPointerDown=/);
  assert.match(packageTour, /useModalScrollLock\(open\)/);
  assert.match(packageTour, /className="scrim package-tour-scrim"[\s\S]*onPointerDown=/);
  assert.match(css, /html\[data-modal-surface="open"\][\s\S]*overflow:\s*hidden/);
});

test("project and configuration actions remain attached to their handlers", async () => {
  const project = await read("../src/components/ProjectFolderDialog.tsx");
  const worktree = await read("../src/components/WorktreeSessionDialog.tsx");
  const profile = await read("../src/components/AgentProfileForm.tsx");
  const widgetLibrary = await read("../src/components/settings/WidgetLibraryOverlay.tsx");

  assert.match(project, /className="primary-btn folder-open-btn"[\s\S]*onClick=\{\(\) => void openProject\(\)\}/);
  assert.match(project, /slot="project\.create\.options"/);
  assert.match(worktree, /onClick=\{\(\) => void submit\(\)\}/);
  assert.match(profile, /onClick=\{\(\) => void save\(true\)\}/);
  assert.match(widgetLibrary, /onClick=\{\(\) => onAdd\(widget\)\}/);
  assert.match(widgetLibrary, /onChange=\{\(event\) => setPluginId\(event\.target\.value\)\}/);
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

test("390px project setup fills the viewport and keeps step scrolling internal", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = await read("../src/styles.css");
  const choices = Array.from({ length: 18 }, (_, index) => `
    <button class="setup-choice"><i>${index + 1}</i><span><strong>Choice ${index + 1}</strong><small>Configuration detail</small></span></button>
  `).join("");
  await page.setContent(`
    <style>${css}</style>
    <div class="project-setup-scrim">
      <section class="project-setup guided-setup">
        <header class="guided-setup-head"><div><h1>Set up this project</h1><p>Choose a starting layout.</p></div><button>Close</button></header>
        <ol class="guided-setup-steps"><li>1</li><li>2</li><li>3</li><li>4</li></ol>
        <main class="guided-setup-body"><div class="guided-widget-grid">${choices}</div></main>
        <footer class="guided-setup-foot"><button>Skip</button><span></span><button>Continue</button></footer>
      </section>
    </div>
  `);

  const geometry = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".guided-setup")!;
    const body = document.querySelector<HTMLElement>(".guided-setup-body")!;
    const rect = panel.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      bodyClientHeight: body.clientHeight,
      bodyScrollHeight: body.scrollHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
    };
  });

  assert.deepEqual(
    { left: geometry.left, right: geometry.right, top: geometry.top, bottom: geometry.bottom },
    { left: 0, right: 390, top: 0, bottom: 720 },
  );
  assert.ok(geometry.bodyScrollHeight > geometry.bodyClientHeight, "only the active setup step scrolls");
  assert.equal(geometry.documentScrollHeight, 720, "project setup does not extend the document");
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
    <style>${css}\n${developerCss}</style>
    <main style="width: 180px">
      <button class="question-copy-btn" data-audit="question-copy">Copy</button>
      <div class="question-tabs" data-audit-scroll>${tabs}</div>
      <label class="question-option" data-audit="question-option"><input type="radio">Option</label>
      <div class="question-actions"><button data-audit="question-action">Next</button></div>
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
        return { name: element.dataset.audit, width: rect.width, height: rect.height };
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
