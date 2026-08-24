import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { Browser, Page } from "playwright-core";

const CHROME = [
  process.env.POLYTH_CHROMIUM_PATH,
  "/usr/local/bin/google-chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
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

test("320px source-control layout keeps repository metadata clear of tabs", { skip: !CHROME }, async () => {
  assert.ok(page);
  await page.setContent(`
    <style>${css}</style>
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
  await page.setContent(`
    <style>${css}</style>
    <main class="view-page git-page">
      <nav class="source-tabs">
        <button>Changes 12</button><button id="log-tab">Log</button><button>Branches 4</button><button>Stashes 2</button>
      </nav>
      <div class="copy-wrap"><button class="copy-btn" aria-label="Copy">C</button></div>
      <div class="gh-filter-chips"><button id="all-chip">All</button></div>
      <p>Open <button class="file-ref" id="file-ref">a.ts</button> now.</p>
    </main>
  `);
  const targets = await page.evaluate(() => {
    const rect = (selector: string) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return { width: box.width, height: box.height, left: box.left, top: box.top };
    };
    const file = rect("#file-ref");
    const hit = document.elementFromPoint(file.left + file.width / 2, file.top - 8);
    return {
      log: rect("#log-tab"),
      copy: rect(".copy-btn"),
      chip: rect("#all-chip"),
      expandedFileRefHit: Boolean(hit?.closest("#file-ref")),
    };
  });
  for (const [name, target] of Object.entries({ log: targets.log, copy: targets.copy, chip: targets.chip })) {
    assert.ok(target.width >= 44, `${name} width is ${target.width}px`);
    assert.ok(target.height >= 44, `${name} height is ${target.height}px`);
  }
  assert.equal(targets.expandedFileRefHit, true, "file reference has an expanded 44px hit area");
});

test("320px commit composer stays out of changed-file tap targets", { skip: !CHROME }, async () => {
  assert.ok(page);
  await page.setContent(`
    <style>${css}</style>
    <main class="view-page git-page">
      <div class="git-master-detail">
        <section class="git-master-pane">
          <button id="disclosure" class="git-change-group-head" aria-expanded="true">Staged Changes</button>
          <div class="git-change-group-body">
            <div class="git-file-row">
              <button id="staged-file" class="git-file-main"><span class="git-file-path">src/staged.ts</span></button>
            </div>
          </div>
        </section>
        <section class="git-detail-pane"></section>
      </div>
      <section id="composer" class="git-commit-composer">
        <div class="git-commit-heading">Commit staged changes</div>
        <textarea class="commit-msg">message</textarea>
        <div class="commit-row"><button>Commit</button></div>
      </section>
    </main>
    <script>
      document.querySelector('#disclosure').addEventListener('click', () => document.body.dataset.disclosure = 'clicked');
      document.querySelector('#staged-file').addEventListener('click', () => document.body.dataset.file = 'clicked');
    </script>
  `);

  const geometry = await page.evaluate(() => {
    const master = document.querySelector(".git-master-detail")!.getBoundingClientRect();
    const composer = document.querySelector("#composer")!.getBoundingClientRect();
    return {
      composerPosition: getComputedStyle(document.querySelector("#composer")!).position,
      masterBottom: master.bottom,
      composerTop: composer.top,
    };
  });
  assert.equal(geometry.composerPosition, "static");
  assert.ok(geometry.composerTop >= geometry.masterBottom, "composer must remain below the changed-files panel");

  await page.click("#disclosure");
  await page.click("#staged-file");
  assert.deepEqual(await page.evaluate(() => ({ ...document.body.dataset })), {
    disclosure: "clicked",
    file: "clicked",
  });
});
