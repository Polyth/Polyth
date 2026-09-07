import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { Browser, Page } from "playwright-core";

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
  page = await browser.newPage({ viewport: { width: 800, height: 400 } });
});

after(async () => {
  await browser?.close();
});

test("wrapped textarea ArrowUp moves the caret natively before history can fire", { skip: !CHROME }, async () => {
  assert.ok(page);
  await page.setContent(`
    <textarea id="composer" style="
      width: 80px;
      height: 200px;
      font: 16px/20px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      padding: 0;
      border: 0;
      margin: 0;
      resize: none;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    "></textarea>
  `);
  await page.evaluate(() => {
    const ta = document.getElementById("composer") as HTMLTextAreaElement;
    const history: string[] = [];
    (window as unknown as { __history: string[] }).__history = history;
    ta.value = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    // Same keydown → macrotask algorithm as AdaptiveTextInput.onKeyDown.
    ta.addEventListener("keydown", (e) => {
      if (
        (e.key !== "ArrowUp" && e.key !== "ArrowDown")
        || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey
      ) return;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const key = e.key;
      // Same post-default-action timing as AdaptiveTextInput.onKeyDown.
      setTimeout(() => {
        if (ta.selectionStart === start && ta.selectionEnd === end) history.push(key);
      }, 0);
    });
  });

  const layout = await page.evaluate(() => {
    const ta = document.getElementById("composer") as HTMLTextAreaElement;
    const caretTop = (offset: number): number => {
      const cs = getComputedStyle(ta);
      const probe = document.createElement("div");
      probe.style.cssText = [
        "position:absolute", "visibility:hidden", "white-space:pre-wrap", "overflow-wrap:anywhere",
        `font:${cs.font}`, `line-height:${cs.lineHeight}`, `letter-spacing:${cs.letterSpacing}`,
        `width:${ta.clientWidth}px`, "padding:0", `box-sizing:${cs.boxSizing}`,
      ].join(";");
      const marker = document.createElement("span");
      marker.textContent = "\u200b";
      probe.append(ta.value.slice(0, offset), marker, ta.value.slice(offset));
      document.body.append(probe);
      const top = marker.getBoundingClientRect().top;
      probe.remove();
      return top;
    };
    const tops = new Map<number, number[]>();
    for (let i = 0; i <= ta.value.length; i++) {
      const top = Math.round(caretTop(i));
      const list = tops.get(top) ?? [];
      list.push(i);
      tops.set(top, list);
    }
    const rows = [...tops.entries()].sort((a, b) => a[0] - b[0]);
    const middle = rows[1];
    const midOffset = middle
      ? middle[1][Math.floor(middle[1].length / 2)] ?? middle[1][0]!
      : 0;
    return { rows: rows.length, midOffset };
  });
  assert.ok(layout.rows >= 3, `expected wrapped visual rows, got ${layout.rows}`);
  assert.ok(layout.midOffset > 0);

  await page.focus("#composer");
  await page.evaluate((offset) => {
    const ta = document.getElementById("composer") as HTMLTextAreaElement;
    (window as unknown as { __history: string[] }).__history.length = 0;
    ta.focus();
    ta.setSelectionRange(offset, offset);
  }, layout.midOffset);
  const before = await page.evaluate(() => (
    document.getElementById("composer") as HTMLTextAreaElement
  ).selectionStart);
  await page.keyboard.press("ArrowUp");
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const afterWrapUp = await page.evaluate(() => {
    const ta = document.getElementById("composer") as HTMLTextAreaElement;
    return {
      start: ta.selectionStart,
      history: [...(window as unknown as { __history: string[] }).__history],
    };
  });
  assert.notEqual(afterWrapUp.start, before, "ArrowUp on a middle wrapped row must move the native caret");
  assert.deepEqual(afterWrapUp.history, [], "history must not fire when native wrap movement happened");

  await page.evaluate(() => {
    const ta = document.getElementById("composer") as HTMLTextAreaElement;
    (window as unknown as { __history: string[] }).__history.length = 0;
    ta.setSelectionRange(0, 0);
  });
  await page.keyboard.press("ArrowUp");
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const atStart = await page.evaluate(() => {
    const ta = document.getElementById("composer") as HTMLTextAreaElement;
    return {
      start: ta.selectionStart,
      history: [...(window as unknown as { __history: string[] }).__history],
    };
  });
  assert.equal(atStart.start, 0);
  assert.deepEqual(atStart.history, ["ArrowUp"], "ArrowUp at the first visual line may recall history");
});
