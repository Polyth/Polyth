import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const base = process.env.POLYTH_LIVE_URL ?? "http://127.0.0.1:4453";
const project = process.env.POLYTH_LIVE_PROJECT_ID ?? "a390-project";
const session = process.env.POLYTH_LIVE_SESSION_LOADED ?? "a390-loaded";
const artifacts = process.env.POLYTH_LIVE_ARTIFACTS ?? "/opt/cursor/artifacts/qa";
const executablePath = process.env.POLYTH_CHROMIUM_PATH ?? "/usr/bin/google-chrome-stable";
const persona = JSON.stringify({ persona: "engineer", plugins: [] });

await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--disable-extensions", "--disable-background-networking"],
});

const views = [
  { id: "portrait_375x812", width: 375, height: 812, coarse: true },
  { id: "landscape_812x375", width: 812, height: 375, coarse: true },
  { id: "desktop_1280x800", width: 1280, height: 800, coarse: false },
];

const reports = {};

for (const view of views) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    hasTouch: view.coarse,
    isMobile: view.coarse,
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  await context.addInitScript(({ persona, project }) => {
    localStorage.setItem("polyth.prefs", persona);
    localStorage.setItem(`polyth.projectSetup.v1.${project}`, "completed");
  }, { persona, project });
  const page = await context.newPage();
  const runtimeErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.goto(`${base}/p/${project}/s/${session}`, { waitUntil: "load" });
  await page.waitForSelector(".timeline .msg", { state: "visible", timeout: 15_000 });
  await page.waitForSelector(".composer-input textarea", { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(120);

  const beforeDraft = await page.evaluate(() => {
    const rectOf = (element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
        display: style.display,
        visibility: style.visibility,
      };
    };
    const labels = [
      ".composer-add-trigger",
      ".composer-auto-approve",
      ".composer-goals",
      ".composer-workflow",
      ".mic-btn",
    ];
    return labels.flatMap((selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return [];
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== "none"
        ? [{ selector, ...rectOf(element) }]
        : [];
    });
  });

  let touchAnswerActions = null;
  if (view.coarse) {
    const actionBars = page.locator(".agent-reply-actions");
    assert.ok(await actionBars.count() > 0, `${view.id}: fixture has no answer actions`);
    await actionBars.last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(20);
    touchAnswerActions = await actionBars.last().evaluate((bar) => {
      const style = getComputedStyle(bar);
      return {
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        buttons: Array.from(bar.querySelectorAll("button")).map((button) => {
          const box = button.getBoundingClientRect();
          const center = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return {
            name: button.getAttribute("aria-label"),
            width: box.width,
            height: box.height,
            hit: center === button || button.contains(center),
          };
        }),
      };
    });
    assert.equal(touchAnswerActions.opacity, "1", `${view.id}: answer actions remain visually suppressed`);
    assert.notEqual(touchAnswerActions.pointerEvents, "none", `${view.id}: answer actions reject touch input`);
    assert.ok(touchAnswerActions.buttons.length > 0, `${view.id}: answer action bar is empty`);
    assert.deepEqual(
      touchAnswerActions.buttons.filter((button) => button.width < 43.5 || button.height < 43.5 || !button.hit),
      [],
      `${view.id}: answer actions are undersized or not hittable`,
    );
    if (view.id === "portrait_375x812") {
      await page.screenshot({ path: `${artifacts}/critic_recheck_portrait_answer_actions_375x812.png` });
    }
  }

  await page.locator(".composer-input textarea").fill("Headless critic recheck");
  await page.waitForTimeout(50);
  const report = await page.evaluate(({ coarse, beforeDraft, touchAnswerActions }) => {
    const rectOf = (element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
        display: style.display,
        visibility: style.visibility,
      };
    };
    const visible = (element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (!(box.width > 0
        && box.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && style.opacity !== "0"
        && style.pointerEvents !== "none"
        && box.bottom > 0
        && box.top < innerHeight
        && box.right > 0
        && box.left < innerWidth)) return false;
      const centerX = box.left + box.width / 2;
      const centerY = box.top + box.height / 2;
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const ancestorStyle = getComputedStyle(ancestor);
        if (ancestorStyle.display === "none"
          || ancestorStyle.visibility === "hidden"
          || ancestorStyle.opacity === "0"
          || ancestorStyle.pointerEvents === "none") {
          return false;
        }
        const clipsX = ["auto", "clip", "hidden", "scroll"].includes(ancestorStyle.overflowX);
        const clipsY = ["auto", "clip", "hidden", "scroll"].includes(ancestorStyle.overflowY);
        if (!clipsX && !clipsY) continue;
        const ancestorBox = ancestor.getBoundingClientRect();
        if ((clipsX && (centerX < ancestorBox.left || centerX > ancestorBox.right))
          || (clipsY && (centerY < ancestorBox.top || centerY > ancestorBox.bottom))) {
          return false;
        }
      }
      return true;
    };
    const actionableSelector = 'button:not(.file-ref), summary, select, textarea, '
      + 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), '
      + '[role="button"], [role="menuitem"], [role="tab"], [role="option"], [role="switch"]';
    const controls = Array.from(document.querySelectorAll(actionableSelector))
      .filter((element) => element instanceof HTMLElement && visible(element)).map((element) => {
      const box = element.getBoundingClientRect();
      const center = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        name: element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.className,
        ...rectOf(element),
        hit: center === element || element.contains(center),
      };
    });
    const undersized = coarse
      ? Array.from(document.querySelectorAll(actionableSelector))
        .filter((element) => element instanceof HTMLElement && visible(element)).flatMap((element) => {
          const box = element.getBoundingClientRect();
          return box.width < 43.5 || box.height < 43.5
            ? [{ name: element.getAttribute("aria-label") ?? element.className, width: box.width, height: box.height }]
            : [];
        })
      : [];
    const composer = document.querySelector(".composer");
    const textarea = document.querySelector(".composer-input textarea");
    const send = document.querySelector(".send");
    const nav = document.querySelector(".session-bottom-nav");
    const intersects = (a, b) => !!a && !!b
      && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5
      && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
    const modelName = document.querySelector(".composer-model-header .model-trigger-name");
    const modelMeta = document.querySelector(".composer-model-header .composer-model-meta");
    const thinking = document.querySelector(".composer-model-header .composer-thinking-badge");
    const thinkingTrack = document.querySelector(".composer-model-header .thinking-slider-track");
    const mode = document.querySelector(".composer-model-header .composer-agent-badge");
    const modelNameRect = modelName ? rectOf(modelName) : null;
    const modelMetaRect = modelMeta ? rectOf(modelMeta) : null;
    const thinkingRect = thinking ? rectOf(thinking) : null;
    const thinkingTrackRect = thinkingTrack ? rectOf(thinkingTrack) : null;
    const modeRect = mode ? rectOf(mode) : null;
    const rail = document.querySelector(".rail-icon-col.plugin-strip");
    const railButtons = rail
      ? Array.from(rail.querySelectorAll(".strip-btn")).map((button) => {
          const style = getComputedStyle(button);
          const columns = style.gridTemplateColumns;
          const textColumnWidth = Number.parseFloat(columns.split(/\s+/).at(-1) ?? "0");
          return {
            name: button.getAttribute("aria-label"),
            clientWidth: button.clientWidth,
            scrollWidth: button.scrollWidth,
            gridTemplateColumns: columns,
            textColumnWidth,
          };
        })
      : [];
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
      composer: composer ? rectOf(composer) : null,
      textarea: textarea ? rectOf(textarea) : null,
      send: send ? rectOf(send) : null,
      nav: nav && visible(nav) ? rectOf(nav) : null,
      controls,
      beforeDraft,
      undersized,
      touchAnswerActions,
      portraitComposer: {
        modelName: modelNameRect,
        modelMeta: modelMetaRect,
        thinking: thinkingRect,
        thinkingTrack: thinkingTrackRect,
        mode: modeRect,
        overlap: {
          thinkingModelName: intersects(thinkingRect, modelNameRect),
          thinkingModelMeta: intersects(thinkingRect, modelMetaRect),
          trackModelName: intersects(thinkingTrackRect, modelNameRect),
          trackModelMeta: intersects(thinkingTrackRect, modelMetaRect),
          thinkingMode: intersects(thinkingRect, modeRect),
        },
      },
      desktopRail: rail ? {
        clientWidth: rail.clientWidth,
        scrollWidth: rail.scrollWidth,
        overflowX: getComputedStyle(rail).overflowX,
        buttons: railButtons,
      } : null,
      errors: window.__errs ?? [],
    };
  }, { coarse: view.coarse, beforeDraft, touchAnswerActions });
  report.errors = [...report.errors, ...runtimeErrors];

  assert.equal(report.document.scrollWidth, report.document.clientWidth, `${view.id}: horizontal document overflow`);
  assert.ok(report.composer && report.composer.bottom <= view.height + 0.5, `${view.id}: composer leaves viewport`);
  assert.ok(report.textarea && report.textarea.bottom <= view.height + 0.5, `${view.id}: textarea leaves viewport`);
  assert.ok(report.send && report.send.bottom <= view.height + 0.5, `${view.id}: Send leaves viewport`);
  if (report.nav) {
    assert.ok(report.composer.bottom <= report.nav.top + 0.5, `${view.id}: composer overlaps navigation`);
  }
  assert.deepEqual(report.controls.filter((control) => !control.hit), [], `${view.id}: failed center hit`);
  assert.deepEqual(report.errors, [], `${view.id}: uncaught page error`);
  if (view.coarse) {
    assert.deepEqual(report.undersized, [], `${view.id}: undersized coarse targets`);
    assert.ok(report.touchAnswerActions, `${view.id}: answer actions were not checked`);
  }
  if (view.id === "portrait_375x812") {
    assert.ok(report.portraitComposer.modelName, "portrait: model name is missing");
    assert.ok(report.portraitComposer.modelMeta, "portrait: model metadata is missing");
    assert.ok(report.portraitComposer.thinking, "portrait: thinking control is missing");
    assert.ok(report.portraitComposer.thinkingTrack, "portrait: thinking track is missing");
    assert.deepEqual(
      report.portraitComposer.overlap,
      {
        thinkingModelName: false,
        thinkingModelMeta: false,
        trackModelName: false,
        trackModelMeta: false,
        thinkingMode: false,
      },
      "portrait: model identity intersects thinking or mode controls",
    );
  }
  if (view.id === "desktop_1280x800") {
    assert.ok(report.desktopRail, "desktop: labelled capability rail is missing");
    assert.ok(
      report.desktopRail.scrollWidth <= report.desktopRail.clientWidth,
      `desktop: rail overflows horizontally (${report.desktopRail.scrollWidth}/${report.desktopRail.clientWidth})`,
    );
    assert.deepEqual(
      report.desktopRail.buttons.filter((button) => button.textColumnWidth <= 0.5),
      [],
      "desktop: labelled rail button has a zero-width text column",
    );
  }

  reports[view.id] = report;
  await page.screenshot({ path: `${artifacts}/critic_recheck_${view.id}.png` });

  if (view.id === "landscape_812x375") {
    await page.evaluate(() => {
      document.body.dataset.keyboard = "open";
      document.body.dataset.band = "short";
      document.documentElement.style.setProperty("--visual-vh", "220px");
      document.documentElement.style.setProperty("--visual-bottom", "220px");
      document.documentElement.style.setProperty("--keyboard-inset", "155px");
    });
    await page.waitForTimeout(50);
    const keyboard = await page.evaluate(() => {
      const visualHeight = 220;
      const rectOf = (element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
          display: style.display,
          visibility: style.visibility,
        };
      };
      const visible = (element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (!(box.width > 0
          && box.height > 0
          && style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
          && style.pointerEvents !== "none"
          && box.bottom > 0
          && box.top < visualHeight
          && box.right > 0
          && box.left < innerWidth)) return false;
        const centerX = box.left + box.width / 2;
        const centerY = box.top + box.height / 2;
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const ancestorStyle = getComputedStyle(ancestor);
          if (ancestorStyle.display === "none"
            || ancestorStyle.visibility === "hidden"
            || ancestorStyle.opacity === "0"
            || ancestorStyle.pointerEvents === "none") {
            return false;
          }
          const clipsX = ["auto", "clip", "hidden", "scroll"].includes(ancestorStyle.overflowX);
          const clipsY = ["auto", "clip", "hidden", "scroll"].includes(ancestorStyle.overflowY);
          if (!clipsX && !clipsY) continue;
          const ancestorBox = ancestor.getBoundingClientRect();
          if ((clipsX && (centerX < ancestorBox.left || centerX > ancestorBox.right))
            || (clipsY && (centerY < ancestorBox.top || centerY > ancestorBox.bottom))) {
            return false;
          }
        }
        return true;
      };
      const actionableSelector = 'button:not(.file-ref), summary, select, textarea, '
        + 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), '
        + '[role="button"], [role="menuitem"], [role="tab"], [role="option"], [role="switch"]';
      const controls = Array.from(document.querySelectorAll(actionableSelector))
        .filter((element) => element instanceof HTMLElement && visible(element)).map((element) => {
          const box = element.getBoundingClientRect();
          const center = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return {
            name: element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.className,
            ...rectOf(element),
            hit: center === element || element.contains(center),
          };
        });
      const composer = document.querySelector(".composer");
      const textarea = document.querySelector(".composer-input textarea");
      const send = document.querySelector(".send");
      const nav = document.querySelector(".session-bottom-nav");
      const timeline = document.querySelector(".timeline");
      const pendingChanges = document.querySelector(".pending-changes-bar");
      const pendingRect = pendingChanges ? pendingChanges.getBoundingClientRect() : null;
      const clipRect = (a, b) => {
        const left = Math.max(a.left, b.left);
        const top = Math.max(a.top, b.top);
        const right = Math.min(a.right, b.right);
        const bottom = Math.min(a.bottom, b.bottom);
        return right - left > 0.5 && bottom - top > 0.5
          ? { left, top, right, bottom, width: right - left, height: bottom - top }
          : null;
      };
      const intersects = (a, b) => !!a && !!b
        && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5
        && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
      const visibleTextRects = [];
      if (timeline) {
        const walker = document.createTreeWalker(timeline, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent?.trim() ?? "";
          const parent = node.parentElement;
          if (!text || !parent) continue;
          const parentStyle = getComputedStyle(parent);
          if (parentStyle.display === "none" || parentStyle.visibility === "hidden" || parentStyle.opacity === "0") continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const fragment of range.getClientRects()) {
            let clipped = clipRect(fragment, {
              left: 0, top: 0, right: innerWidth, bottom: visualHeight,
            });
            if (!clipped) continue;
            for (let ancestor = parent; ancestor && clipped; ancestor = ancestor.parentElement) {
              const style = getComputedStyle(ancestor);
              const clipsX = ["auto", "clip", "hidden", "scroll"].includes(style.overflowX);
              const clipsY = ["auto", "clip", "hidden", "scroll"].includes(style.overflowY);
              if (clipsX || clipsY) {
                const box = ancestor.getBoundingClientRect();
                clipped = clipRect(clipped, {
                  left: clipsX ? box.left : -Infinity,
                  top: clipsY ? box.top : -Infinity,
                  right: clipsX ? box.right : Infinity,
                  bottom: clipsY ? box.bottom : Infinity,
                });
              }
              if (ancestor === timeline) break;
            }
            if (clipped) visibleTextRects.push({ text: text.slice(0, 80), ...clipped });
          }
        }
      }
      return {
        visualHeight,
        document: {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        },
        composer: composer ? rectOf(composer) : null,
        textarea: textarea ? rectOf(textarea) : null,
        send: send ? rectOf(send) : null,
        navDisplay: nav ? getComputedStyle(nav).display : null,
        controls,
        timeline: timeline ? rectOf(timeline) : null,
        pendingChanges: pendingChanges ? {
          ...rectOf(pendingChanges),
          backgroundColor: getComputedStyle(pendingChanges).backgroundColor,
        } : null,
        intersectingText: pendingRect
          ? visibleTextRects.filter((rect) => intersects(rect, pendingRect))
          : visibleTextRects,
        undersized: controls.flatMap((control) => control.width < 43.5 || control.height < 43.5
          ? [{ name: control.name, width: control.width, height: control.height }]
          : []),
        errors: window.__errs ?? [],
      };
    });
    keyboard.errors = [...keyboard.errors, ...runtimeErrors];
    assert.equal(keyboard.document.scrollWidth, keyboard.document.clientWidth, "keyboard: horizontal document overflow");
    assert.ok(keyboard.composer && keyboard.composer.bottom <= 220.5, "keyboard: composer leaves visual viewport");
    assert.ok(keyboard.textarea && keyboard.textarea.bottom <= 220.5, "keyboard: textarea leaves visual viewport");
    assert.ok(keyboard.send && keyboard.send.bottom <= 220.5, "keyboard: Send leaves visual viewport");
    assert.equal(keyboard.navDisplay, "none", "keyboard: bottom navigation remains over composer");
    assert.ok(keyboard.timeline, "keyboard: timeline is missing");
    assert.ok(keyboard.pendingChanges, "keyboard: changed-files bar is missing");
    assert.ok(
      keyboard.timeline.bottom <= keyboard.pendingChanges.top + 0.5,
      `keyboard: timeline overlaps changed-files bar (${keyboard.timeline.bottom}/${keyboard.pendingChanges.top})`,
    );
    assert.deepEqual(
      keyboard.intersectingText,
      [],
      "keyboard: visible transcript text intersects changed-files bar",
    );
    assert.deepEqual(
      keyboard.controls.filter((control) => !control.hit),
      [],
      "keyboard: visible control failed center hit",
    );
    assert.deepEqual(keyboard.undersized, [], "keyboard: undersized coarse target");
    assert.deepEqual(
      keyboard.controls.filter((control) => control.top < -0.5 || control.bottom > 220.5),
      [],
      "keyboard: visible control leaves visual viewport",
    );
    assert.deepEqual(keyboard.errors, [], "keyboard: uncaught page error");
    reports.landscape_keyboard_812x220 = keyboard;
    await page.screenshot({
      path: `${artifacts}/critic_recheck_landscape_keyboard_812x220.png`,
      clip: { x: 0, y: 0, width: 812, height: 220 },
    });
  }
  await context.close();
}

await browser.close();
await writeFile(`${artifacts}/critic_recheck_measurements.json`, `${JSON.stringify(reports, null, 2)}\n`);
console.log(JSON.stringify({
  views: Object.keys(reports),
  summaries: Object.fromEntries(Object.entries(reports).map(([id, report]) => [
    id,
    "document" in report
      ? {
          document: `${report.document.scrollWidth}/${report.document.clientWidth}`,
          controls: report.controls.length,
          failedHits: report.controls.filter((control) => !control.hit).length,
          undersized: report.undersized.length,
          composerBottom: report.composer?.bottom,
          navTop: report.nav?.top ?? null,
        }
      : report,
  ])),
}, null, 2));
