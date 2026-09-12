import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Browser, Page } from "playwright-core";
import { findChromiumExecutable } from "@polyth/browser/chromium";

const CHROME = await findChromiumExecutable();
const css = [
  "../../../apps/web/src/tokens.css",
  "../../../apps/web/src/styles.css",
  "../../../apps/web/src/moduleContent.css",
  "../widgets/styles.css",
  "../../code-hosting/widgets/styles.css",
  "../../files/widgets/styles.css",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
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
            <nav class="source-tabs"><button>Changes</button><button>Log</button></nav>
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
      <nav class="source-tabs">
        <button>Changes 12</button><button id="log-tab">Log</button><button>Branches 4</button><button>Stashes 2</button>
      </nav>
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
                <nav class="source-tabs">
                  <button class="active">Changes 12</button>
                  <button>Log</button>
                  <button>Branches 3</button>
                  <button>Stashes 1</button>
                </nav>
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
                    <div class="git-commit-heading"><strong>Commit 4 staged files</strong></div>
                    <textarea class="ui-textarea commit-msg">message</textarea>
                    <div class="commit-row"><button class="ui-btn ui-btn--quiet ui-btn--sm">Generate</button><button class="ui-btn ui-btn--primary ui-btn--sm">Commit</button></div>
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
