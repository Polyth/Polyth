import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright-core";
import { findChromiumExecutable } from "@polyth/browser/chromium";
import { en } from "../src/i18n/en.ts";

const CHROME = await findChromiumExecutable();
const css = [
  "../../../apps/web/src/tokens.css",
  "../../../apps/web/src/styles.css",
  "../../../apps/web/src/moduleContent.css",
  "../../../apps/web/src/components/ui/WorkspaceSurfaceHeader.css",
  "../widgets/styles.css",
  "../widgets/source-control.css",
  "../widgets/repository-scope.css",
  "../../code-hosting/widgets/styles.css",
  "../../files/widgets/styles.css",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n").replace(/@import[^;]+;/g, "");
let browser: Browser | null = null;
let page: Page | null = null;

before(async () => {
  if (!CHROME) return;
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage({ viewport: { width: 320, height: 720 } });
});

after(async () => {
  await browser?.close();
});

test("docked source control reserves a usable scrolling file pane", { skip: !CHROME }, async () => {
  assert.ok(page);
  for (const width of [320, 438, 900]) {
    await page.setViewportSize({ width, height: 720 });
    await page.setContent(`<style>${css}</style>
      <aside class="rail rail-workspace" style="width:100%;height:700px"><section class="module-view">
        <header class="module-view-head">Source control</header>
        <div class="module-view-body"><div class="module-view-content module-view-content--workspace"><div class="rail-body">
          <div class="git-page">
            <div class="source-control-head">Repository</div>
            <div class="source-tabs-frame"><div class="ui-tabs ui-tabs--md source-tabs" role="tablist"><button class="ui-tab" role="tab">Changes</button><button class="ui-tab" role="tab">Log</button></div></div>
            <div class="git-changes-layout"><div class="git-master-detail">
              <section class="git-master-pane">${Array.from({ length: 30 }, (_, i) => `<div class="git-file-row"><button class="git-file-main">File ${i}</button></div>`).join("")}</section>
              <section class="git-detail-pane">Select a file</section>
            </div></div>
          </div>
        </div></div></div>
      </section></aside>`);
    const pane = page.locator(".git-master-pane");
    assert.ok((await pane.boundingBox())!.height > 300, `${width}px: the file pane must not collapse to zero`);
    await pane.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const last = await page.locator(".git-file-row").last().boundingBox();
    const bounds = await pane.boundingBox();
    assert.ok(last!.y + last!.height <= bounds!.y + bounds!.height + 1, "the final change remains reachable");
  }
  await page.setViewportSize({ width: 320, height: 720 });
});

test("desktop Source Control rows stay compact and scan on one line", { skip: !CHROME }, async () => {
  assert.ok(page);
  await page.setViewportSize({ width: 537, height: 295 });
  await page.setContent(`<style>${css}</style>
    <div class="git-page" style="width:537px">
      <div class="git-change-groups">
        <section class="git-change-group">
          <button class="git-change-group-head" type="button"><span>Changes</span><span class="git-count">3</span></button>
          <div class="git-change-group-body">
            <div class="git-file-row selected">
              <div class="git-file-main" role="button" tabindex="0">
                <span class="git-file-letter unstaged">M</span>
                <span class="git-file-identity"><a class="resource-link" href="#workspace">workspace.md</a><span class="git-file-directory">docs/dev/</span></span>
              </div>
              <span class="git-file-linestat"><span class="additions">+9</span><span class="deletions">−4</span></span>
              <span class="git-file-actions"><button class="ui-icon-btn ui-icon-btn--sm" type="button">+</button><button class="ui-icon-btn ui-icon-btn--sm" type="button">↶</button></span>
            </div>
            <div class="git-file-row">
              <button class="git-file-main" type="button">
                <span class="git-file-letter unstaged">M</span>
                <span class="git-file-identity"><span class="git-file-name">TermPane.tsx</span><span class="git-file-directory">packages/terminal/widgets/</span></span>
              </button>
              <span class="git-file-linestat"><span class="additions">+9</span><span class="deletions">−4</span></span>
            </div>
            <div class="git-file-row">
              <button class="git-file-main" type="button">
                <span class="git-file-letter unstaged">M</span>
                <span class="git-file-identity"><span class="git-file-name">styles.css</span><span class="git-file-directory">packages/terminal/widgets/</span></span>
              </button>
              <span class="git-file-linestat"><span class="additions">+9</span><span class="deletions">−9</span></span>
            </div>
          </div>
        </section>
      </div>
    </div>`);

  const geometry = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>(".git-file-row")!;
    const list = document.querySelector<HTMLElement>(".git-change-groups")!;
    const resource = document.querySelector<HTMLElement>(".resource-link")!;
    const name = document.querySelector<HTMLElement>(".git-file-name")!;
    const directory = document.querySelector<HTMLElement>(".git-file-directory")!;
    const rowBox = row.getBoundingClientRect();
    const resourceBox = resource.getBoundingClientRect();
    const directoryBox = directory.getBoundingClientRect();
    return {
      control: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--control-h-sm")),
      rowHeights: [...document.querySelectorAll<HTMLElement>(".git-file-row")].map((item) => item.getBoundingClientRect().height),
      rowWidth: rowBox.width,
      listWidth: list.getBoundingClientRect().width,
      nameDirectoryTopDelta: Math.abs(resourceBox.top - directoryBox.top),
      nameFontSize: Number.parseFloat(getComputedStyle(name).fontSize),
      resourceFontSize: Number.parseFloat(getComputedStyle(resource).fontSize),
    };
  });

  assert.ok(geometry.rowHeights.every((height) => height <= geometry.control + 0.5), `rows must stay at the compact 32px control height: ${geometry.rowHeights.join(", ")}px`);
  assert.ok(geometry.rowWidth >= geometry.listWidth - 24, `the row should use the list width without nesting another card (${geometry.rowWidth}/${geometry.listWidth})`);
  assert.ok(geometry.nameDirectoryTopDelta < 6, "filename and directory should share one scanning line");
  assert.equal(geometry.resourceFontSize, geometry.nameFontSize, "resource and fallback filenames should use the same compact label size");
  await page.setViewportSize({ width: 320, height: 720 });
});

test("320px source-control layout keeps repository metadata clear of tabs", { skip: !CHROME }, async () => {
  assert.ok(page);
  await page.setContent(`
    <style>${css}</style>
    <div class="module-view-content module-view-content--page" style="width: 320px">
    <main class="view-page github-page">
      <section class="gh-repo-card">
        <span class="gh-repo-icon">GH</span>
        <div class="gh-repo-copy">
          <a class="gh-repo-name"><span>extremely-long-organization-name/extremely-long-repository-name</span><svg></svg></a>
          <span class="muted">A repository description that is intentionally much wider than a phone viewport.</span>
        </div>
        <div class="gh-repo-meta">
          <span class="tag">Private</span>
          <span class="tag mono gh-default-branch"><svg></svg><span>feature/a-very-long-default-branch-reference</span></span>
        </div>
      </section>
      <div class="gh-list-controls">
        <nav class="source-tabs gh-tabs"><button>Issues <span>12</span></button><button>Pull requests <span>8</span></button></nav>
      </div>
    </main>
    </div>
  `);
  const geometry = await page.evaluate(() => {
    const card = document.querySelector(".gh-repo-card")!.getBoundingClientRect();
    const tabs = document.querySelector(".gh-list-controls")!.getBoundingClientRect();
    const descendants = [...document.querySelectorAll<HTMLElement>(".gh-repo-card *")]
      .map((element) => element.getBoundingClientRect());
    return {
      cardLeft: card.left,
      cardRight: card.right,
      cardBottom: card.bottom,
      tabsTop: tabs.top,
      minLeft: Math.min(...descendants.map((rect) => rect.left)),
      maxRight: Math.max(...descendants.map((rect) => rect.right)),
    };
  });
  assert.ok(geometry.cardLeft >= 0);
  assert.ok(geometry.cardRight <= 320);
  assert.ok(geometry.minLeft >= geometry.cardLeft);
  assert.ok(geometry.maxRight <= geometry.cardRight);
  assert.ok(geometry.tabsTop >= geometry.cardBottom, "repository metadata must not overlap the tabs");
});

test("320px source controls expose 44px tabs, copy actions, and chips", { skip: !CHROME }, async () => {
  assert.ok(page);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.setContent(`
    <style>${css}</style>
    <div class="module-view-content module-view-content--page" style="width: 320px">
    <main class="view-page git-page">
      <div class="source-tabs-frame"><div class="ui-tabs ui-tabs--md source-tabs" role="tablist">
        <button class="ui-tab" role="tab">Changes 12</button><button id="log-tab">Log</button><button class="ui-tab" role="tab">Branches 4</button><button class="ui-tab" role="tab">Stashes 2</button>
      </div></div>
      <div class="copy-wrap"><button class="copy-btn" aria-label="Copy">C</button></div>
      <div class="gh-filter-chips"><button class="ui-btn ui-btn--ghost ui-btn--sm" id="all-chip">All</button></div>
      <p>Open <button class="file-ref" id="file-ref">a.ts</button> now.</p>
    </main>
    </div>
  `);
  const targets = await page.evaluate(() => {
    const rect = (selector: string) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return { width: box.width, height: box.height, left: box.left, top: box.top };
    };
    const file = rect("#file-ref");
    const fileStyle = getComputedStyle(document.querySelector("#file-ref")!);
    return {
      log: rect("#log-tab"),
      copy: rect(".copy-btn"),
      chip: rect("#all-chip"),
      file,
      viewport: window.innerWidth,
      phoneMedia: matchMedia("(max-width: 480px)").matches,
      fileMinWidth: fileStyle.minWidth,
      fileMinHeight: fileStyle.minHeight,
      fileDisplay: fileStyle.display,
    };
  });
  for (const [name, target] of Object.entries({
    log: targets.log,
    copy: targets.copy,
    chip: targets.chip,
    file: targets.file,
  })) {
    const detail = name === "file"
      ? ` (viewport=${targets.viewport}, media=${targets.phoneMedia}, min=${targets.fileMinWidth}×${targets.fileMinHeight}, display=${targets.fileDisplay})`
      : "";
    assert.ok(target.width >= 44, `${name} width is ${target.width}px${detail}`);
    assert.ok(target.height >= 44, `${name} height is ${target.height}px${detail}`);
  }
});

test("narrow source-control shell keeps every change group above the commit composer", { skip: !CHROME }, async () => {
  assert.ok(page);
  const changeGroups = [
    { id: "staged", title: "Staged Changes" },
    { id: "changes", title: "Changes" },
    { id: "untracked", title: "Untracked" },
  ];

  for (const width of [320, 390, 428]) {
    await page.setViewportSize({ width, height: 720 });
    const groups = changeGroups.map((group) => `
      <section class="git-change-group">
        <button id="${group.id}-disclosure" data-tap class="git-change-group-head" aria-expanded="true">
          ${group.title}<span class="git-count">4</span>
        </button>
        <div class="git-change-group-body">
          ${Array.from({ length: 4 }, (_, index) => `
            <div class="git-file-row">
              <button id="${group.id}-file-${index}" data-tap class="git-file-main">
                <span class="git-file-letter">M</span>
                <span class="git-file-path">src/${group.id}-${index}.ts</span>
              </button>
            </div>
          `).join("")}
        </div>
      </section>
    `).join("");

    await page.setContent(`
      <style>${css}</style>
      <div class="app">
        <header class="header">Polyth</header>
        <div class="app-shell">
          <aside class="rail rail-workspace rail-fullscreen">
            <div class="rail-head"><span class="rail-title">Source control</span></div>
            <div class="module-view-content module-view-content--workspace">
            <div class="rail-body">
              <main class="view-page git-page">
                <header class="source-control-head">
                  <div class="source-control-title">
                    <h1 class="view-title">Source Control</h1>
                    <span class="source-branch">feature/mobile-layout</span>
                  </div>
                  <div class="source-remote-actions">
                    <button class="ui-btn ui-btn--quiet ui-btn--sm source-action-btn">Fetch</button>
                    <button class="ui-btn ui-btn--quiet ui-btn--sm source-action-btn">Pull</button>
                    <button class="ui-btn ui-btn--quiet ui-btn--sm source-action-btn">Push</button>
                    <button class="ui-icon-btn ui-icon-btn--ghost ui-icon-btn--sm source-refresh-btn" aria-label="Refresh">R</button>
                  </div>
                </header>
                <div class="source-tabs-frame"><div class="ui-tabs ui-tabs--md source-tabs" role="tablist">
                  <button class="ui-tab ui-tab--selected" role="tab">Changes 12</button>
                  <button class="ui-tab" role="tab">Log</button>
                  <button class="ui-tab" role="tab">Branches 3</button>
                  <button class="ui-tab" role="tab">Stashes 1</button>
                </div></div>
                <div class="git-changes-layout">
                  <div class="git-master-detail">
                    <section class="git-master-pane" aria-label="Changed files">
                      <div class="git-pane-toolbar">
                        <div><strong>Working tree</strong><span class="muted">12 changed files</span></div>
                      </div>
                      <div class="git-change-groups">${groups}</div>
                    </section>
                    <section class="git-detail-pane" aria-label="Change details"></section>
                  </div>
                  <section id="composer" class="git-commit-composer" aria-label="Commit staged changes">
                    <textarea class="ui-textarea git-commit-msg">message</textarea>
                    <div class="git-commit-rail">
                      <div class="git-commit-heading">
                        <strong>Commit 4 staged files</strong>
                        <span class="git-commit-branch"><span class="mono">feature/mobile-layout</span></span>
                      </div>
                      <div class="git-commit-actions">
                        <button class="ui-btn ui-btn--ghost ui-btn--sm">Generate</button>
                        <button class="ui-btn ui-btn--primary ui-btn--sm git-commit-submit">Commit</button>
                        <button class="ui-btn ui-btn--quiet ui-btn--sm">Sync</button>
                      </div>
                    </div>
                  </section>
                </div>
              </main>
            </div>
            </div>
          </aside>
        </div>
      </div>
      <script>
        document.querySelectorAll("[data-tap]").forEach((target) => {
          target.addEventListener("click", () => { document.body.dataset.lastTap = target.id; });
        });
      </script>
    `);

    const geometry = await page.evaluate(() => {
      const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const shell = bounds(".rail-body");
      const sourcePage = bounds(".git-page");
      const master = bounds(".git-master-detail");
      const pane = document.querySelector<HTMLElement>(".git-master-pane")!;
      const paneBounds = pane.getBoundingClientRect();
      const composer = bounds("#composer");
      return {
        shellBottom: shell.bottom,
        pageBottom: sourcePage.bottom,
        masterBottom: master.bottom,
        paneBottom: paneBounds.bottom,
        paneClientHeight: pane.clientHeight,
        paneScrollHeight: pane.scrollHeight,
        composerTop: composer.top,
        composerBottom: composer.bottom,
      };
    });
    assert.ok(geometry.pageBottom <= geometry.shellBottom + 0.5, `${width}px page must stay inside the flex shell`);
    assert.ok(geometry.composerBottom <= geometry.pageBottom + 0.5, `${width}px composer must stay inside the page`);
    assert.ok(geometry.masterBottom <= geometry.composerTop + 0.5, `${width}px master panel overlaps the composer`);
    assert.ok(geometry.paneBottom <= geometry.composerTop + 0.5, `${width}px changed-file pane overlaps the composer`);
    assert.ok(geometry.paneScrollHeight > geometry.paneClientHeight, `${width}px changed-file pane must own overflow`);

    for (const group of changeGroups) {
      const selector = `#${group.id}-file-3`;
      await page.locator(selector).scrollIntoViewIfNeeded();
      const targetHit: { id?: string; insidePane: boolean; aboveComposer: boolean } = await page.evaluate((targetSelector) => {
        const target = document.querySelector<HTMLElement>(targetSelector)!;
        const pane = document.querySelector(".git-master-pane")!.getBoundingClientRect();
        const composer = document.querySelector("#composer")!.getBoundingClientRect();
        const targetBounds = target.getBoundingClientRect();
        const x = targetBounds.left + targetBounds.width / 2;
        const y = targetBounds.top + targetBounds.height / 2;
        return {
          id: document.elementFromPoint(x, y)?.closest("button")?.id,
          insidePane: targetBounds.top >= pane.top && targetBounds.bottom <= pane.bottom,
          aboveComposer: targetBounds.bottom <= composer.top,
        };
      }, selector);
      assert.equal(targetHit.id, `${group.id}-file-3`, `${width}px ${group.title} row must own its hit target`);
      assert.equal(targetHit.insidePane, true, `${width}px ${group.title} row must scroll inside the list`);
      assert.equal(targetHit.aboveComposer, true, `${width}px ${group.title} row must remain above the composer`);
      await page.click(selector);
      assert.equal(await page.evaluate(() => document.body.dataset.lastTap), `${group.id}-file-3`);
    }

    await page.locator("#untracked-disclosure").scrollIntoViewIfNeeded();
    await page.click("#untracked-disclosure");
    assert.equal(await page.evaluate(() => document.body.dataset.lastTap), "untracked-disclosure");
  }
});

test("commit composer stays visible below an open file diff", { skip: !CHROME }, async () => {
  assert.ok(page);
  const composerMarkup = `
    <section id="composer" class="git-commit-composer" aria-label="Commit staged changes">
      <textarea class="ui-textarea git-commit-msg" placeholder="Commit message…">Polish the source-control commit composer</textarea>
      <div class="git-commit-rail">
        <div class="git-commit-heading">
          <strong>Commit 4 staged files</strong>
          <span class="git-commit-branch"><span class="mono">feature/commit-composer</span></span>
        </div>
        <div class="git-commit-actions">
          <button class="ui-btn ui-btn--ghost ui-btn--sm">Generate</button>
          <button class="ui-btn ui-btn--primary ui-btn--sm git-commit-submit">Commit</button>
          <button class="ui-btn ui-btn--quiet ui-btn--sm">Sync</button>
        </div>
      </div>
    </section>`;

  for (const width of [320, 900]) {
    await page.setViewportSize({ width, height: 720 });
    await page.setContent(`
      <style>${css}</style>
      <div class="app">
        <header class="header">Polyth</header>
        <div class="app-shell">
          <aside class="rail rail-workspace rail-fullscreen" style="width:100%;height:700px">
            <div class="rail-head"><span class="rail-title">Source control</span></div>
            <div class="module-view-content module-view-content--workspace" style="height:640px">
            <div class="rail-body" style="height:640px">
              <main class="view-page git-page">
                <header class="source-control-head">
                  <div class="source-control-title"><span class="source-branch">feature/commit-composer</span></div>
                </header>
                <div class="source-tabs-frame"><div class="ui-tabs ui-tabs--md source-tabs" role="tablist"><button class="ui-tab ui-tab--selected" role="tab">Changes 4</button><button class="ui-tab" role="tab">Log</button></div></div>
                <div class="git-changes-layout">
                  <div class="git-master-detail detail-open">
                    <section class="git-master-pane" aria-label="Changed files">
                      ${Array.from({ length: 8 }, (_, index) => `<div class="git-file-row"><button class="git-file-main">src/file-${index}.ts</button></div>`).join("")}
                    </section>
                    <section id="detail" class="git-detail-pane" aria-label="Change details">
                      <div class="git-detail-title"><strong>apps/web/src/components/Sidebar.tsx</strong></div>
                      <pre class="git-diff git-diff-page">${Array.from({ length: 40 }, (_, index) => `+ line ${index}`).join("\n")}</pre>
                    </section>
                  </div>
                  ${composerMarkup}
                </div>
              </main>
            </div>
            </div>
          </aside>
        </div>
      </div>
    `);

    const geometry = await page.evaluate(() => {
      const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const pageBox = bounds(".git-page");
      const layout = bounds(".git-changes-layout");
      const detail = bounds("#detail");
      const composer = bounds("#composer");
      const field = bounds(".git-commit-msg");
      const rail = bounds(".git-commit-rail");
      const submit = bounds(".git-commit-submit");
      const style = getComputedStyle(document.querySelector("#composer")!);
      return {
        pageBottom: pageBox.bottom,
        layoutBottom: layout.bottom,
        detailTop: detail.top,
        detailBottom: detail.bottom,
        composerTop: composer.top,
        composerBottom: composer.bottom,
        composerHeight: composer.height,
        composerWidth: composer.width,
        fieldHeight: field.height,
        railHeight: rail.height,
        submitWidth: submit.width,
        display: style.display,
        visibility: style.visibility,
      };
    });

    assert.notEqual(geometry.display, "none", `${width}px composer must render`);
    assert.notEqual(geometry.visibility, "hidden", `${width}px composer must stay visible`);
    assert.ok(geometry.composerHeight > 72, `${width}px composer height is ${geometry.composerHeight}px`);
    assert.ok(geometry.composerWidth > 200, `${width}px composer width is ${geometry.composerWidth}px`);
    assert.ok(geometry.fieldHeight > 24, `${width}px message field must remain usable`);
    assert.ok(geometry.railHeight > 24, `${width}px action rail must remain usable`);
    assert.ok(geometry.submitWidth > 0, `${width}px commit action must keep a hit area`);
    assert.ok(geometry.detailBottom <= geometry.composerTop + 1, `${width}px diff overlaps the composer`);
    assert.ok(geometry.composerBottom <= geometry.pageBottom + 0.5, `${width}px composer must stay inside the page`);
    assert.ok(geometry.composerBottom <= geometry.layoutBottom + 0.5, `${width}px composer must stay inside the changes layout`);
  }
  await page.setViewportSize({ width: 320, height: 720 });
});

test("compact git.recent summary keeps its action reachable in a small card", { skip: !CHROME }, async () => {
  assert.ok(page);
  const fileRow = (index: number) => `
    <button type="button" class="git-recent-file">
      <span class="git-file-letter unstaged">M</span>
      <span class="git-recent-path">packages/git/widgets/some/deeply/nested/file-${index}.tsx</span>
    </button>`;
  for (const size of [{ width: 300, height: 220 }, { width: 210, height: 170 }]) {
    await page.setViewportSize({ width: 640, height: 720 });
    await page.setContent(`
      <style>${css}</style>
      <div id="card" class="git-recent-widget" style="width:${size.width}px;height:${size.height}px">
        <div class="git-recent-head">
          <span class="source-branch"><span class="mono">feature/a-rather-long-branch-name</span></span>
          <span class="git-recent-summary">12 changed files</span>
        </div>
        <div class="git-recent-list">${Array.from({ length: 12 }, (_, index) => fileRow(index)).join("")}</div>
        <div class="git-recent-foot">
          <button type="button" class="git-recent-open"><span>Source control</span></button>
        </div>
      </div>
    `);
    const geometry = await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>("#card")!;
      const list = document.querySelector<HTMLElement>(".git-recent-list")!;
      const open = document.querySelector<HTMLElement>(".git-recent-open")!;
      const head = document.querySelector<HTMLElement>(".git-recent-head")!;
      const cardRect = card.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      const openRect = open.getBoundingClientRect();
      const headRect = head.getBoundingClientRect();
      return {
        openBottom: openRect.bottom,
        cardBottom: cardRect.bottom,
        openWidth: openRect.width,
        headBottom: headRect.bottom,
        listTop: listRect.top,
        listScrollHeight: list.scrollHeight,
        listClientHeight: list.clientHeight,
      };
    });
    assert.ok(geometry.openBottom <= geometry.cardBottom + 0.5, `${size.width}x${size.height}: the action must stay inside the card`);
    assert.ok(geometry.openWidth > 0, `${size.width}x${size.height}: the action must keep a hit area`);
    assert.ok(geometry.headBottom <= geometry.listTop + 1, `${size.width}x${size.height}: the header must not overlap the list`);
    assert.ok(geometry.listScrollHeight > geometry.listClientHeight, `${size.width}x${size.height}: the preview must own overflow instead of stretching the card`);
  }
  await page.setViewportSize({ width: 320, height: 720 });
});

test("edited-files card keeps compact technical paths on a phone-width dock", { skip: !CHROME }, async () => {
  assert.ok(page);
  await page.setViewportSize({ width: 390, height: 720 });
  await page.setContent(`
    <style>${css}</style>
    <section class="ui-glass-dock ui-glass-dock--strong pending-changes-bar" style="width: min(100% - 24px, 420px); margin: 12px auto;">
      <div class="pending-changes-head">
        <div class="pending-changes-lead">
          <span class="pending-changes-icon"></span>
          <div class="pending-changes-copy">
            <span class="pending-changes-title">Edited 3 files</span>
            <span class="pending-change-stats"><span class="additions">+68</span><span class="deletions">-24</span></span>
          </div>
        </div>
      </div>
      <div class="pending-changes-list">
        <button type="button" class="pending-changes-file">
          <span class="pending-changes-file-name">apps/web/src/components/Timeline.tsx</span>
          <span class="pending-change-stats"><span class="additions">+29</span><span class="deletions">-8</span></span>
        </button>
        <button type="button" class="pending-changes-file">
          <span class="pending-changes-file-name">apps/web/src/styles.css</span>
        </button>
        <button type="button" class="pending-changes-file">
          <span class="pending-changes-file-name">apps/web/test/composerChatStyle.test.ts</span>
        </button>
      </div>
    </section>
  `);
  const metrics = await page.evaluate(() => {
    const tokenPx = (value: string) => {
      const probe = document.createElement("span");
      probe.style.fontSize = value;
      document.body.append(probe);
      const px = Number.parseFloat(getComputedStyle(probe).fontSize);
      probe.remove();
      return px;
    };
    const file = document.querySelector<HTMLElement>(".pending-changes-file")!;
    const name = document.querySelector<HTMLElement>(".pending-changes-file-name")!;
    const nameStyle = getComputedStyle(name);
    return {
      fileHeight: file.getBoundingClientRect().height,
      fontSize: Number.parseFloat(nameStyle.fontSize),
      fontFamily: nameStyle.fontFamily,
      meta: tokenPx("var(--font-meta)"),
      code: tokenPx("var(--font-code)"),
      control: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--control-h-sm")),
    };
  });
  assert.ok(metrics.fileHeight <= metrics.control + 2, `visible row is ${metrics.fileHeight}px, expected ~${metrics.control}px`);
  assert.ok(
    Math.abs(metrics.fontSize - metrics.meta) <= 0.5,
    `path size is ${metrics.fontSize}px, expected meta ${metrics.meta}px not code ${metrics.code}px`,
  );
  assert.match(metrics.fontFamily, /mono|Menlo|Consolas|Courier|ui-monospace/i);
});

test("phone Source Control keeps the clean card, transport and tabs readable in workspace mode", { skip: !CHROME }, async () => {
  assert.ok(browser);
  const { build } = await import("esbuild");
  const gitView = readFileSync(new URL("../widgets/GitView.tsx", import.meta.url), "utf8");
  const tabsComponent = gitView.slice(gitView.indexOf("function SourceControlTabs("), gitView.indexOf("const remoteProviderLabel"));
  const tabItems = [
    { id: "changes", label: `${en["gitview.tabChanges"]} 0` },
    { id: "log", label: en["gitview.tabLog"] },
    { id: "branches", label: `${en["gitview.tabBranches"]} 429` },
    { id: "stashes", label: `${en["gitview.tabStashes"]} 3` },
  ];
  // Execute the current package wrapper and shared Tabs, rather than a second
  // implementation of overflow detection in the fixture.
  const client = await build({
    stdin: {
      contents: `import {useEffect,useRef,useState} from "react";
        import {createRoot} from "react-dom/client";
        import Tabs from ${JSON.stringify(fileURLToPath(new URL("../../../apps/web/src/components/ui/Tabs.tsx", import.meta.url)))};
        type GitTab = "changes" | "log" | "branches" | "stashes";
        const tr = () => ${JSON.stringify(en["gitview.sourceControlViews"])};
        ${tabsComponent}
        const root = createRoot(document.querySelector("#tabs-mount")!);
        const render = (tabs: {id: GitTab; label: string}[]) => root.render(<SourceControlTabs tabs={tabs} value="changes" onChange={()=>{}} />);
        document.addEventListener("fixture-tabs", event => render((event as CustomEvent).detail));
        render(${JSON.stringify(tabItems)});`,
      loader: "tsx",
      resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
    },
    nodePaths: [fileURLToPath(new URL("../", import.meta.resolve("react")))],
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const phone = await browser.newPage({ viewport: { width: 430, height: 932 }, hasTouch: true, isMobile: true });
  const icon = '<svg class="ui-icon ui-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 3v12a3 3 0 0 0 6 0V9l6-3"/></svg>';
  // The default (bare) variant, as GitView renders it: a Look repaints
  // compact/panel states as cards, which would nest one inside the pane.
  const empty = `<div class="empty-state empty-state--page"><span class="empty-state-mark" aria-hidden>${icon}</span><h2 class="empty-state-title">${en["gitview.workingTreeClean"]}</h2><p class="empty-state-desc">${en["gitview.localEditsWillAppearHere"]}</p></div>`;
  const fixture = (wallpaper: boolean, glass: boolean) => `<html data-background="${wallpaper ? "fixture" : "none"}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>
    <style>html,body{height:100%;margin:0} :root{--app-background-image:${wallpaper ? "linear-gradient(125deg,#b7a185,#b0a5bd)" : "none"}} #tabs-mount{display:contents}</style></head><body data-glass="${glass ? "on" : "off"}">
    <aside class="rail rail-workspace" style="width:100%;height:100%"><section class="module-view module-view--phone"><header class="module-view-head">Source control</header>
    <div class="module-view-body"><div class="module-view-content module-view-content--workspace"><div class="rail-body"><div class="git-page">
      <header class="workspace-surface-header source-control-head"><div class="workspace-surface-header-context"><div class="source-control-title">
        <span class="source-branch">${icon}<span class="mono">polyth/isolate/61b6188499eb</span></span>
        <div class="source-control-identity"><button class="ui-btn ui-btn--ghost ui-btn--sm source-control-identity-trigger" aria-haspopup="menu"><span class="ui-btn-label"><span class="source-control-identity-value">System Git · GitHub</span><span class="source-control-identity-compact-label">${en["gitview.identity"]}</span></span><svg class="ui-icon ui-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="m6 9 6 6 6-6"/></svg></button></div>
      </div></div><div class="workspace-surface-header-actions"><div class="source-remote-actions">
        <div class="git-remote-context"><span class="git-remote-name">origin</span></div>
        <div class="source-remote-buttons"><button class="ui-btn ui-btn--quiet ui-btn--sm source-action-btn source-sync-btn">${icon}<span class="ui-btn-label">${en["gitview.syncRepository"]}</span></button>
        <button class="ui-icon-btn ui-icon-btn--sm" aria-label="Remote actions">${icon}</button><button class="ui-icon-btn ui-icon-btn--sm source-refresh-btn" aria-label="Refresh">${icon}</button></div>
      </div></div></header><div id="tabs-mount"></div>
      <div class="git-changes-layout"><div class="git-master-detail is-clean"><section class="git-master-pane"><div class="git-change-groups">${empty}</div></section></div></div>
    </div></div></div></div></section></aside></body></html>`;
  const evidence: unknown[] = [];
  try {
    for (const width of [375, 390, 430]) for (const wallpaper of [false, true]) for (const glass of [false, true]) {
      await phone.setViewportSize({ width, height: 932 });
      await phone.setContent(fixture(wallpaper, glass));
      await phone.addScriptTag({ content: client.outputFiles[0]!.text });
      await phone.waitForFunction(() => document.querySelectorAll(".source-tabs .ui-tab").length === 4);
      await phone.locator(".empty-state").first().evaluate(element => element.getAnimations().forEach(animation => animation.finish()));
      const metrics = await phone.evaluate(() => {
        const element = (selector: string) => document.querySelector<HTMLElement>(selector)!;
        const box = (selector: string) => { const r = element(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }; };
        const style = (selector: string) => getComputedStyle(element(selector));
        const remote = box(".git-remote-name"), sync = box(".source-sync-btn"), head = box(".source-control-head"), refresh = box(".source-refresh-btn"), branch = box(".source-branch"), identity = box(".source-control-identity-trigger");
        const center = (rect: { y: number; height: number }) => rect.y + rect.height / 2;
        const pane = style(".git-master-pane"), empty = style(".git-change-groups > .empty-state");
        return {
          coarse: matchMedia("(pointer: coarse)").matches,
          header: box(".source-control-head"), pane: box(".git-master-pane"), empty: box(".git-change-groups > .empty-state"),
          border: style(".git-master-detail").borderLeftWidth, blur: pane.backdropFilter,
          emptyBorder: empty.borderWidth, emptyBackground: empty.backgroundColor,
          syncFont: parseFloat(style(".source-sync-btn").fontSize), tabFont: parseFloat(style(".ui-tab").fontSize), metaFont: parseFloat(style(".git-remote-name").fontSize),
          identityBorder: style(".source-control-identity-trigger").borderColor,
          mask: style(".source-tabs").maskImage, scrollWidth: element(".source-tabs").scrollWidth, clientWidth: element(".source-tabs").clientWidth,
          // Row 1: branch capsule … Sync; row 2: identity … remote, its menu, refresh.
          statusRowDelta: Math.abs(center(branch) - center(sync)), contextRowDelta: Math.max(Math.abs(center(identity) - center(remote)), Math.abs(center(remote) - center(refresh))),
          leftEdges: [branch.x - head.x, identity.x - head.x], rightEdges: [head.x + head.width - sync.x - sync.width, head.x + head.width - refresh.x - refresh.width],
          rowsStack: identity.y >= branch.bottom && remote.y >= sync.bottom && remote.x + remote.width <= refresh.x,
          headerHeight: head.height,
          lefts: [box(".source-control-head").x, box(".source-tabs").x, box(".git-master-detail").x],
          remoteClipped: element(".git-remote-name").scrollWidth > element(".git-remote-name").clientWidth,
          identityClipped: element(".source-control-identity-trigger .ui-btn-label").scrollWidth > element(".source-control-identity-trigger .ui-btn-label").clientWidth,
          targets: [...document.querySelectorAll<HTMLElement>(".source-control-head button, .source-tabs button")].map(e => {
            const r=e.getBoundingClientRect(), hit=getComputedStyle(e, "::after");
            return [Math.max(r.width, parseFloat(hit.width) || 0), Math.max(r.height, parseFloat(hit.height) || 0)];
          }),
          overflow: document.documentElement.scrollWidth - innerWidth,
        };
      });
      const label = `${width}px wallpaper=${wallpaper} glass=${glass}`;
      assert.equal(metrics.coarse, true, label);
      assert.equal(metrics.overflow, 0, label);
      assert.equal(metrics.emptyBorder, "0px", label);
      assert.equal(metrics.emptyBackground, "rgba(0, 0, 0, 0)", label);
      assert.ok(metrics.pane.height < 300, `${label}: clean card must hug its content`);
      assert.equal(metrics.border, "1px", label);
      if (!glass) assert.equal(metrics.blur, "none", label);
      assert.ok(metrics.statusRowDelta <= 1 && metrics.contextRowDelta <= 1, `${label}: each header row shares one centre line`);
      assert.ok([...metrics.leftEdges, ...metrics.rightEdges].every((edge) => Math.abs(edge) <= 1), `${label}: identity under the branch, the remote row under Sync`);
      assert.ok(metrics.rowsStack && metrics.headerHeight <= 96, `${label}: two compact header rows (${metrics.headerHeight}px)`);
      assert.ok(Math.max(...metrics.lefts) - Math.min(...metrics.lefts) <= 1, `${label}: header, tabs and card share one content edge`);
      // Header controls share the metadata size (Sync stands out by its button
      // plate, not a larger label); the tabs outrank the header.
      assert.ok(metrics.syncFont === metrics.metaFont && metrics.tabFont > metrics.metaFont, `${label}: type hierarchy`);
      assert.notEqual(metrics.identityBorder, "rgba(0, 0, 0, 0)", label);
      assert.equal(metrics.remoteClipped, false, `${label}: the remote target stays readable`);
      assert.equal(metrics.identityClipped, false, `${label}: compact identity caption stays readable`);
      assert.ok(metrics.targets.every(([w,h]) => w! >= 44 && h! >= 44), `${label}: coarse targets`);
      const hasOverflow = metrics.scrollWidth > metrics.clientWidth + 1;
      assert.equal(metrics.mask === "none", !hasOverflow, `${label}: fade reflects actual overflow`);
      evidence.push({ width, wallpaper, glass, ...metrics });
      if (process.env.POLYTH_CAPTURE_SOURCE_CONTROL === "1" && wallpaper && glass) {
        mkdirSync(".scratch/mobile-source-control", { recursive: true });
        await phone.screenshot({ path: `.scratch/mobile-source-control/after-${width}.png` });
      }
    }
    // Exercise the actual ResizeObserver when labels grow and shrink, with a
    // constant strip width. Padding keeps the first selected label outside the fade.
    await phone.evaluate(items => document.dispatchEvent(new CustomEvent("fixture-tabs", { detail: items })), tabItems.map(item => ({ ...item, label: `${item.label} — an intentionally long translated label` })));
    await phone.waitForFunction(() => document.querySelector(".source-tabs")!.classList.contains("ui-scroll-tabs"));
    assert.notEqual(await phone.locator(".source-tabs").evaluate(e => getComputedStyle(e).maskImage), "none");
    const textInset = await phone.locator(".source-tabs").evaluate(e => { const r=document.createRange();r.selectNodeContents(e.firstElementChild!);return r.getBoundingClientRect().left-e.getBoundingClientRect().left; });
    assert.ok(textInset >= 12, "first tab text stays clear of the host fade");
    await phone.evaluate(items => document.dispatchEvent(new CustomEvent("fixture-tabs", { detail: items })), tabItems);
    await phone.waitForFunction(() => !document.querySelector(".source-tabs")!.classList.contains("ui-scroll-tabs"));
    // The scroll mode adds edge padding. A strip that fits only without it
    // must still leave the mode: grow one label until it just overflows, then
    // step back one character.
    const scrolling = () => phone.locator(".source-tabs").evaluate(e => e.classList.contains("ui-scroll-tabs"));
    const withLast = (label: string) => tabItems.map((item, index) => index === tabItems.length - 1 ? { ...item, label } : item);
    let grown = tabItems[tabItems.length - 1]!.label;
    for (let step = 0; step < 120 && !(await scrolling()); step++) {
      grown += "x";
      await phone.evaluate(items => document.dispatchEvent(new CustomEvent("fixture-tabs", { detail: items })), withLast(grown));
      await phone.waitForTimeout(20);
    }
    assert.equal(await scrolling(), true, "the grown label overflows the strip");
    await phone.evaluate(items => document.dispatchEvent(new CustomEvent("fixture-tabs", { detail: items })), withLast(grown.slice(0, -1)));
    await phone.waitForFunction(() => !document.querySelector(".source-tabs")!.classList.contains("ui-scroll-tabs"), undefined, { timeout: 2000 });
    await phone.evaluate(items => document.dispatchEvent(new CustomEvent("fixture-tabs", { detail: items })), tabItems);
    await phone.emulateMedia({ reducedMotion: "reduce" });
    // Replace the clean card with a dirty one: sticky toolbar over a genuinely long list.
    await phone.locator(".git-master-pane").evaluate(e => {
      e.closest(".git-master-detail")!.classList.remove("is-clean");
      e.innerHTML=`<div class="git-pane-toolbar"><div class="git-pane-summary"><strong>40 changed files</strong><span class="muted">0 staged</span></div><div class="git-pane-actions"></div></div><div class="git-change-groups">${Array.from({length:40},(_,i)=>`<div class="git-file-row"><button class="git-file-main">File ${i}</button></div>`).join("")}</div>`;
    });
    const pane = phone.locator(".git-master-pane");
    const toolbarTop = (await phone.locator(".git-pane-toolbar").boundingBox())!.y;
    const overflow = await pane.evaluate(e => e.scrollHeight > e.clientHeight);
    assert.ok(overflow, "long lists scroll inside the card");
    await pane.evaluate(e => { e.scrollTop=e.scrollHeight; });
    const last = (await phone.locator(".git-file-row").last().boundingBox())!, bounds=(await pane.boundingBox())!;
    assert.ok(last.y+last.height <= bounds.y+bounds.height+1, "last file remains reachable");
    assert.ok(Math.abs((await phone.locator(".git-pane-toolbar").boundingBox())!.y-toolbarTop) <= 1, "toolbar remains sticky");
    assert.equal(await phone.locator(".git-pane-toolbar").evaluate(e => {const r=e.getBoundingClientRect();return document.elementFromPoint(r.x+16,r.y+16)?.closest(".git-pane-toolbar") === e;}), true, "toolbar occludes scrolled rows");
    assert.equal(await phone.locator(".git-file-row").first().evaluate(e => getComputedStyle(e).transitionDuration), "0s");
    assert.ok((await phone.locator(".git-pane-toolbar").evaluate(e => parseFloat(getComputedStyle(e).paddingLeft))) >= 12, "toolbar keeps its inset");
    assert.equal(
      await phone.locator(".git-pane-toolbar").evaluate(e => getComputedStyle(e).backgroundColor),
      await phone.locator(".git-master-pane").evaluate(e => getComputedStyle(e).backgroundColor),
      "toolbar and pane share one material",
    );
    await phone.evaluate(() => { document.body.dataset.desktopLowResource="true"; });
    assert.equal(await phone.locator(".git-pane-toolbar").evaluate(e => getComputedStyle(e).backdropFilter), "none");
    if (process.env.POLYTH_CAPTURE_SOURCE_CONTROL === "1") {
      writeFileSync(".scratch/mobile-source-control/after.json", JSON.stringify(evidence, null, 2));
      console.log("phone fixture px", JSON.stringify(evidence.filter((item) => (item as {wallpaper:boolean;glass:boolean}).wallpaper && (item as {glass:boolean}).glass)));
    }
  } finally {
    await phone.close();
  }
});
